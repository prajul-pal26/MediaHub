import { TRPCError } from "@trpc/server";
import type { drive_v3 } from "googleapis";

const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FILE_FIELDS = "id,mimeType,parents,trashed,webViewLink,modifiedTime,appProperties,capabilities(canEdit)";
const escaped = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
type Properties = Record<string, string>;
type Pointer = { get(): Promise<string | null>; set(value: string): Promise<unknown>; clear(): Promise<unknown> };
interface TargetInput { folderId: string; profileName: string; properties: Properties; pointer: Pointer }

/** Missing/revoked individual files can be replaced; connection and quota errors cannot. */
export function isUnavailableSheetError(error: unknown): boolean {
  const value = error as { code?: unknown; response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } } };
  const status = value?.response?.status ?? value?.code;
  if (status === 404 || status === 410) return true;
  const reasons = value?.response?.data?.error?.errors?.map((item) => item.reason) ?? [];
  return status === 403 && reasons.length > 0 && reasons.every((reason) => reason === "insufficientFilePermissions" || reason === "forbidden");
}

export function isUsableMediaSheet(file: drive_v3.Schema$File, folderId: string, properties: Properties): boolean {
  return Boolean(file.id && !file.trashed && file.mimeType === SHEET_MIME && file.parents?.includes(folderId)
    && file.capabilities?.canEdit !== false
    && Object.entries(properties).every(([key, value]) => file.appProperties?.[key] === value));
}

/** A cached ID is a hint, not proof the user kept that Sheet in the export folder. */
export async function resolveMediaSheetTarget(drive: drive_v3.Drive, input: TargetInput): Promise<{ file: drive_v3.Schema$File; fresh: boolean }> {
  const { folderId, profileName, properties, pointer } = input;
  let cached = await pointer.get();
  if (cached && cached !== "creating") {
    let file: drive_v3.Schema$File | undefined;
    try { file = (await drive.files.get({ fileId: cached, fields: FILE_FIELDS, supportsAllDrives: true })).data; }
    catch (error) { if (!isUnavailableSheetError(error)) throw error; }
    if (file && isUsableMediaSheet(file, folderId, properties)) return { file, fresh: false };
    // Never restore, move or alter a file the user removed. Drop only our pointer.
    await pointer.clear();
    cached = null;
  }

  // Redis may be stale or have expired. Reuse an existing matching Sheet before
  // creating, under the caller's organization/brand lock.
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const found = await drive.files.list({
      q: `'${escaped(folderId)}' in parents and mimeType='${SHEET_MIME}' and trashed=false and ${Object.entries(properties).map(([key, value]) => `appProperties has { key='${escaped(key)}' and value='${escaped(value)}' }`).join(" and ")}`,
      fields: `nextPageToken,files(${FILE_FIELDS})`, orderBy: "createdTime", pageSize: 100,
      pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    for (const candidate of found.data.files ?? []) {
      if (!isUsableMediaSheet(candidate, folderId, properties)) continue;
      // Drive search can briefly retain an old parent/trashed state. Read the
      // candidate itself before treating that search hit as available.
      const file = await verifyMediaSheetTarget(drive, candidate.id!, folderId, properties);
      if (file) { await pointer.set(file.id!); return { file, fresh: false }; }
    }
    pageToken = found.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }
  if (pageToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The existing profile Sheets could not all be checked; retry before creating another." });
  if (cached === "creating") throw new TRPCError({ code: "CONFLICT", message: "Google Sheet creation is still being verified. Retry this run shortly; a duplicate will not be created." });

  await pointer.set("creating");
  let file: drive_v3.Schema$File;
  try {
    file = (await drive.files.create({
      requestBody: { name: `${profileName.slice(0, 120)} — Facebook`, mimeType: SHEET_MIME, parents: [folderId], appProperties: properties },
      fields: FILE_FIELDS, supportsAllDrives: true,
    }, { retry: false })).data;
  } catch (error) {
    // Only a definite rejection proves creation did not happen. Keep the marker
    // on timeouts/rate limits/server errors so retries search rather than duplicate.
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) await pointer.clear();
    throw error;
  }
  if (!isUsableMediaSheet(file, folderId, properties)) throw new Error("The created Google Sheet could not be verified.");
  await pointer.set(file.id!);
  return { file, fresh: true };
}

export async function verifyMediaSheetTarget(drive: drive_v3.Drive, fileId: string, folderId: string, properties: Properties): Promise<drive_v3.Schema$File | null> {
  try {
    const file = (await drive.files.get({ fileId, fields: FILE_FIELDS, supportsAllDrives: true })).data;
    return isUsableMediaSheet(file, folderId, properties) && file.webViewLink ? file : null;
  } catch (error) {
    if (isUnavailableSheetError(error)) return null;
    throw error;
  }
}

/** Retry only a confirmed destination loss, under the caller's existing brand lock. */
export async function writeResolvedMediaSheetTarget(drive: drive_v3.Drive, input: TargetInput & {
  write(fileId: string, fresh: boolean): Promise<void>;
}): Promise<drive_v3.Schema$File> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { file, fresh } = await resolveMediaSheetTarget(drive, input);
    try { await input.write(file.id!, fresh); }
    catch (error) {
      if (!isUnavailableSheetError(error) || attempt > 0) throw error;
      await input.pointer.clear();
      continue;
    }
    const verified = await verifyMediaSheetTarget(drive, file.id!, input.folderId, input.properties);
    if (verified) return verified;
    await input.pointer.clear();
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The destination Sheet changed again while saving. The scraped data is retained; retry saving." });
}
