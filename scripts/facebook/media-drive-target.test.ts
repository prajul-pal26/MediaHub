import assert from "node:assert/strict";
import { test } from "node:test";
import type { drive_v3 } from "googleapis";
import { isUnavailableSheetError, resolveMediaSheetTarget, verifyMediaSheetTarget } from "../../src/server/services/facebook/media-drive-target";

const folderId = "facebook-scraper-folder";
const properties = { mh_org: "org-a", mh_brand: "brand-a", mh_fb_profile: "profile-hash" };
const file = (id: string, changes: Partial<drive_v3.Schema$File> = {}): drive_v3.Schema$File => ({
  id, mimeType: "application/vnd.google-apps.spreadsheet", parents: [folderId], trashed: false,
  appProperties: { ...properties }, capabilities: { canEdit: true }, webViewLink: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  ...changes,
});
const failure = (status: number, reason?: string) => Object.assign(new Error(`Fixture Google error ${status}`), {
  response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } },
});
type Page = { files?: drive_v3.Schema$File[]; nextPageToken?: string };

function fixture(options: {
  cached?: string | null; files?: Record<string, drive_v3.Schema$File | Error>; pages?: Page[];
  listError?: Error; createError?: Error; created?: drive_v3.Schema$File;
} = {}) {
  let pointerValue = options.cached ?? null;
  const calls: { get: string[]; list: string[]; create: number; pointers: (string | null)[] } = { get: [], list: [], create: 0, pointers: [] };
  const pointer = {
    get: async () => pointerValue,
    set: async (value: string) => { pointerValue = value; calls.pointers.push(value); },
    clear: async () => { pointerValue = null; calls.pointers.push(null); },
  };
  const drive = { files: {
    get: async ({ fileId, fields }: { fileId: string; fields: string }) => {
      calls.get.push(fileId); assert.match(fields, /trashed/); assert.match(fields, /canEdit/);
      const value = options.files?.[fileId] ?? options.pages?.flatMap((page) => page.files ?? []).find((candidate) => candidate.id === fileId);
      if (value instanceof Error) throw value;
      if (!value) throw failure(404);
      return { data: value };
    },
    list: async ({ q, pageToken }: { q: string; pageToken?: string }) => {
      calls.list.push(pageToken ?? "first");
      assert.ok(q.includes(`'${folderId}' in parents`));
      assert.match(q, /trashed=false/);
      for (const [key, value] of Object.entries(properties)) assert.ok(q.includes(`key='${key}' and value='${value}'`));
      if (options.listError) throw options.listError;
      return { data: options.pages?.[calls.list.length - 1] ?? { files: [] } };
    },
    create: async ({ requestBody }: { requestBody: drive_v3.Schema$File }, requestOptions: { retry: boolean }) => {
      calls.create++;
      assert.equal(pointerValue, "creating", "reserve before a non-idempotent create");
      assert.deepEqual(requestBody.parents, [folderId]);
      assert.deepEqual(requestBody.appProperties, properties);
      assert.equal(requestBody.mimeType, "application/vnd.google-apps.spreadsheet");
      assert.equal(requestOptions.retry, false);
      if (options.createError) throw options.createError;
      return { data: options.created ?? file("new-sheet") };
    },
  } } as unknown as drive_v3.Drive;
  const input = { folderId, profileName: "Fixture Profile", properties, pointer };
  return { drive, input, calls, pointerValue: () => pointerValue, resolve: () => resolveMediaSheetTarget(drive, input) };
}

test("valid cached profile Sheet is reused without discovery or creation", async () => {
  const f = fixture({ cached: "saved", files: { saved: file("saved") } });
  const result = await f.resolve();
  assert.equal(result.file.id, "saved"); assert.equal(result.fresh, false);
  assert.deepEqual(f.calls.get, ["saved"]); assert.equal(f.calls.list.length, 0); assert.equal(f.calls.create, 0);
});

test("trashed, moved and missing cached Sheets reuse an available match before recreating", async () => {
  for (const unavailable of [file("old", { trashed: true }), file("old", { parents: ["elsewhere"] }), failure(404)]) {
    for (const existing of [true, false]) {
      const f = fixture({ cached: "old", files: { old: unavailable }, pages: [{ files: existing ? [file("available")] : [] }] });
      const result = await f.resolve();
      assert.equal(result.file.id, existing ? "available" : "new-sheet");
      assert.equal(result.fresh, !existing);
      assert.equal(f.calls.pointers[0], null);
      assert.equal(f.calls.create, existing ? 0 : 1);
      assert.equal(f.pointerValue(), result.file.id);
    }
  }
});

test("ineligible candidates are skipped and a later writable matching Sheet is reused", async () => {
  const f = fixture({ pages: [{ files: [
    file("read-only", { capabilities: { canEdit: false } }),
    file("wrong-profile", { appProperties: { ...properties, mh_fb_profile: "other" } }),
    file("wrong-kind", { mimeType: "application/vnd.google-apps.document" }), file("valid"),
  ] }] });
  const result = await f.resolve();
  assert.equal(result.file.id, "valid"); assert.equal(result.fresh, false); assert.equal(f.calls.create, 0);
});

test("cached ownership mismatches never overwrite another organization's file", async () => {
  const f = fixture({ cached: "foreign", files: { foreign: file("foreign", { appProperties: { ...properties, mh_org: "other-org" } }) }, pages: [{ files: [file("owned")] }] });
  assert.equal((await f.resolve()).file.id, "owned");
  assert.deepEqual(f.calls.pointers, [null, "owned"]); assert.equal(f.calls.create, 0);
});

test("file-specific permission loss can recover but auth, quota and transient errors cannot fork Sheets", async () => {
  for (const reason of ["insufficientFilePermissions", "forbidden"]) {
    const f = fixture({ cached: "revoked", files: { revoked: failure(403, reason) } });
    assert.equal((await f.resolve()).file.id, "new-sheet"); assert.equal(f.calls.create, 1);
  }
  for (const error of [failure(401, "authError"), failure(403, "insufficientPermissions"), failure(403, "dailyLimitExceeded"), failure(429), failure(500), failure(503), new Error("Connection reset")]) {
    const f = fixture({ cached: "saved", files: { saved: error } });
    await assert.rejects(f.resolve, (actual) => actual === error);
    assert.equal(f.calls.create, 0); assert.equal(f.calls.list.length, 0); assert.equal(f.pointerValue(), "saved");
  }
  assert.equal(isUnavailableSheetError({ code: 404 }), true);
  assert.equal(isUnavailableSheetError(failure(410)), true);
  assert.equal(isUnavailableSheetError(failure(403)), false);
});

test("a listed candidate is revalidated after stale search results and missing candidates are skipped", async () => {
  for (const changed of [failure(404), failure(403, "insufficientFilePermissions"), file("stale", { trashed: true }), file("stale", { parents: ["elsewhere"] })]) {
    const f = fixture({ files: { stale: changed }, pages: [{ files: [file("stale"), file("valid")] }] });
    assert.equal((await f.resolve()).file.id, "valid");
    assert.ok(f.calls.get.includes("stale")); assert.ok(f.calls.get.includes("valid")); assert.equal(f.calls.create, 0);
  }
});

test("candidate revalidation auth or quota failure is propagated without creation", async () => {
  for (const error of [failure(401), failure(429), failure(500)]) {
    const f = fixture({ files: { candidate: error }, pages: [{ files: [file("candidate")] }] });
    await assert.rejects(f.resolve, (actual) => actual === error);
    assert.equal(f.calls.create, 0); assert.equal(f.pointerValue(), null);
  }
});

test("discovery follows pages and stops without creating if the search bound is exhausted", async () => {
  const found = fixture({ pages: [{ files: [], nextPageToken: "page-two" }, { files: [file("later-page")] }] });
  assert.equal((await found.resolve()).file.id, "later-page");
  assert.deepEqual(found.calls.list, ["first", "page-two"]); assert.equal(found.calls.create, 0);
  const bounded = fixture({ pages: Array.from({ length: 10 }, (_, index) => ({ files: [], nextPageToken: `page-${index + 2}` })) });
  await assert.rejects(bounded.resolve, /could not all be checked/);
  assert.equal(bounded.calls.list.length, 10); assert.equal(bounded.calls.create, 0);
});

test("creating reservations recover a discoverable file but do not duplicate ambiguous creates", async () => {
  const recovered = fixture({ cached: "creating", pages: [{ files: [file("created-earlier")] }] });
  const result = await recovered.resolve();
  assert.equal(result.file.id, "created-earlier"); assert.equal(result.fresh, false); assert.equal(recovered.calls.create, 0);
  const unresolved = fixture({ cached: "creating" });
  await assert.rejects(unresolved.resolve, /still being verified/);
  assert.equal(unresolved.pointerValue(), "creating"); assert.equal(unresolved.calls.create, 0);
  const listError = failure(503);
  const interrupted = fixture({ cached: "creating", listError });
  await assert.rejects(interrupted.resolve, (error) => error === listError);
  assert.equal(interrupted.pointerValue(), "creating"); assert.equal(interrupted.calls.create, 0);
});

test("definite create rejection clears the reservation while ambiguous failure retains it", async () => {
  for (const [status, expected] of [[400, null], [403, null], [408, "creating"], [429, "creating"], [500, "creating"]] as const) {
    const error = failure(status); const f = fixture({ createError: error });
    await assert.rejects(f.resolve, (actual) => actual === error);
    assert.equal(f.pointerValue(), expected); assert.equal(f.calls.create, 1);
  }
});

test("unverifiable newly created metadata never returns success or permits a blind second create", async () => {
  const f = fixture({ created: file("new-sheet", { appProperties: {} }) });
  await assert.rejects(f.resolve, /could not be verified/);
  assert.equal(f.pointerValue(), "creating");
  await assert.rejects(f.resolve, /still being verified/);
  assert.equal(f.calls.create, 1);
});

test("final verification rejects trash, moves, wrong ownership, missing URLs and revoked files", async () => {
  for (const unavailable of [file("saved", { trashed: true }), file("saved", { parents: ["elsewhere"] }), file("saved", { appProperties: {} }), file("saved", { webViewLink: undefined }), file("saved", { capabilities: { canEdit: false } }), failure(404), failure(403, "insufficientFilePermissions")]) {
    const f = fixture({ files: { saved: unavailable } });
    assert.equal(await verifyMediaSheetTarget(f.drive, "saved", folderId, properties), null);
    assert.equal(f.calls.create, 0);
  }
  const good = fixture({ files: { saved: file("saved") } });
  assert.equal((await verifyMediaSheetTarget(good.drive, "saved", folderId, properties))?.id, "saved");
  const error = failure(429); const transient = fixture({ files: { saved: error } });
  await assert.rejects(() => verifyMediaSheetTarget(transient.drive, "saved", folderId, properties), (actual) => actual === error);
});
