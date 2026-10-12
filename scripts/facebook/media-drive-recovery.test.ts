import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import type { drive_v3 } from "googleapis";
import { writeResolvedMediaSheetTarget } from "../../src/server/services/facebook/media-drive-target";

function fixture() {
  const properties = { mh_org: "org", mh_brand: "brand", mh_fb_profile: "profile" };
  const make = (id: string): drive_v3.Schema$File => ({ id, mimeType: "application/vnd.google-apps.spreadsheet", parents: ["folder"], appProperties: properties, webViewLink: `https://docs.google.com/spreadsheets/d/${id}/edit`, capabilities: { canEdit: true } });
  const files = new Map([["old", make("old")]]);
  let pointer: string | null = "old";
  let created = 0;
  const drive = { files: {
    get: async ({ fileId }: { fileId: string }) => {
      const file = files.get(fileId);
      if (!file) throw { response: { status: 404 } };
      return { data: file };
    },
    list: async () => ({ data: { files: [...files.values()].filter(file => !file.trashed && file.parents?.includes("folder")) } }),
    create: async () => { const file = make(`new-${++created}`); files.set(file.id!, file); return { data: file }; },
  } } as unknown as drive_v3.Drive;
  const input = { folderId: "folder", profileName: "Owner", properties, pointer: {
    get: async () => pointer, set: async (value: string) => { pointer = value; }, clear: async () => { pointer = null; },
  } };
  return { drive, input, files, make, created: () => created };
}

test("a deleted Sheet during write is recreated once and the full snapshot is replayed", async () => {
  const f = fixture();
  const calls: [string, boolean][] = [];
  const result = await writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async (id, fresh) => {
    calls.push([id, fresh]);
    if (id === "old") { f.files.delete(id); throw { response: { status: 404 } }; }
  } });
  assert.equal(result.id, "new-1");
  assert.deepEqual(calls, [["old", false], ["new-1", true]]);
  assert.equal(f.created(), 1);
});

test("final verification of a moved Sheet recovers to an existing correct Sheet without creating", async () => {
  const f = fixture();
  const calls: [string, boolean][] = [];
  const result = await writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async (id, fresh) => {
    calls.push([id, fresh]);
    if (id === "old") { f.files.set(id, { ...f.make(id), parents: ["user-moved-folder"] }); f.files.set("replacement", f.make("replacement")); }
  } });
  assert.equal(result.id, "replacement");
  assert.deepEqual(calls, [["old", false], ["replacement", false]]);
  assert.equal(f.created(), 0);
  assert.deepEqual(f.files.get("old")?.parents, ["user-moved-folder"]);
});

test("repeated removal stops after one recovery instead of creating unbounded Sheets", async () => {
  const f = fixture();
  await assert.rejects(writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async id => {
    f.files.set(id, { ...f.make(id), trashed: true });
  } }), /changed again/);
  assert.equal(f.created(), 1);
});

test("transient writes and malformed existing data never fork an empty replacement", async () => {
  for (const error of [{ response: { status: 429 } }, { response: { status: 503 } }, new TRPCError({ code: "PRECONDITION_FAILED", message: "Managed headers changed" })]) {
    const f = fixture();
    await assert.rejects(writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async () => { throw error; } }), value => value === error);
    assert.equal(f.created(), 0);
    assert.equal(await f.input.pointer.get(), "old");
  }
});

test("after a partial write, a normal retry merges into the existing Sheet", async () => {
  const f = fixture();
  const error = { response: { status: 503 } };
  await assert.rejects(writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async () => { throw error; } }));
  const calls: [string, boolean][] = [];
  const result = await writeResolvedMediaSheetTarget(f.drive, { ...f.input, write: async (id, fresh) => { calls.push([id, fresh]); } });
  assert.equal(result.id, "old");
  assert.deepEqual(calls, [["old", false]]);
  assert.equal(f.created(), 0);
});
