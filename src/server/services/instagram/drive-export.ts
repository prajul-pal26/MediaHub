import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { google, type drive_v3 } from "googleapis";
import { getDb } from "@/lib/supabase/db";
import { getAuthenticatedDrive } from "@/server/services/drive/client";
import { assertBrandAccess } from "@/server/trpc/index";

const FOLDER_NAME = "Instagram scraper";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CSV_MIME = "text/csv";
const MAX_CSV_BYTES = 32 * 1024 * 1024;

export type InstagramMediaExport = {
  id: string;
  shortcode: string;
  url: string;
  kind: string;
  likes: number;
  comments: number;
  views?: number | null;
  caption?: string;
  takenAt?: number | null;
};

type ExportProfile = {
  org_id: string;
  role: string;
  brand_id: string | null;
  assigned_brands?: string[];
};
type CsvResult = { id: string; url: string; name: string };
type SheetResult = { id: string; url: string; name: string; folderUrl: string };

const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const filenamePart = (value: string) => value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "instagram";
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Prevent spreadsheet formula execution when the CSV is opened locally. */
function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(columns: string[], rows: Record<string, unknown>[]) {
  const output = [columns.map(csvCell).join(",")];
  for (const row of rows) output.push(columns.map((column) => csvCell(row[column])).join(","));
  const data = `\ufeff${output.join("\r\n")}\r\n`;
  if (Buffer.byteLength(data, "utf8") > MAX_CSV_BYTES) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "The Instagram CSV exceeds the 32 MB safe export limit. Narrow the collection and export again." });
  }
  return data;
}

async function authorizedFolder(profile: ExportProfile, brandId: string) {
  assertBrandAccess(profile, brandId);
  const db = getDb();
  const { data: connection } = await db
    .from("drive_connections")
    .select("root_folder_id")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .maybeSingle();
  if (!connection?.root_folder_id || !/^[A-Za-z0-9_-]+$/.test(connection.root_folder_id)) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Connect Google Drive for the selected brand before exporting Instagram results." });
  }
  const drive = await getAuthenticatedDrive(brandId, profile.org_id);
  const root = await drive.files.get({
    fileId: connection.root_folder_id,
    fields: "id,mimeType,trashed,capabilities(canAddChildren)",
    supportsAllDrives: true,
  });
  if (root.data.trashed || root.data.mimeType !== FOLDER_MIME || root.data.capabilities?.canAddChildren === false) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The selected brand's Drive root is not a writable folder." });
  }
  const found = await drive.files.list({
    q: `'${escapeQuery(connection.root_folder_id)}' in parents and name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id,webViewLink)",
    orderBy: "createdTime",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  let folder = found.data.files?.[0];
  if (!folder) {
    folder = (await drive.files.create({
      requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME, parents: [connection.root_folder_id] },
      fields: "id,webViewLink",
      supportsAllDrives: true,
    }, { retry: false })).data;
  }
  if (!folder.id || !folder.webViewLink) throw new Error("Instagram export folder could not be verified.");
  return { drive, folderId: folder.id, folderUrl: folder.webViewLink };
}

async function writeCsv(
  drive: drive_v3.Drive,
  folderId: string,
  name: string,
  content: string,
  properties: Record<string, string>,
): Promise<CsvResult> {
  const propertyQuery = Object.entries(properties)
    .map(([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`)
    .join(" and ");
  const existing = await drive.files.list({
    q: `'${escapeQuery(folderId)}' in parents and trashed=false and mimeType='${CSV_MIME}' and ${propertyQuery}`,
    fields: "files(id,name,webViewLink,parents,trashed,mimeType)",
    pageSize: 2,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const current = existing.data.files?.[0];
  const media = { mimeType: CSV_MIME, body: Readable.from([Buffer.from(content, "utf8")]) };
  const saved = current?.id
    ? await drive.files.update({ fileId: current.id, media, requestBody: { name, appProperties: properties }, fields: "id,name,webViewLink,parents,mimeType,trashed", supportsAllDrives: true }, { retry: false })
    : await drive.files.create({ requestBody: { name, parents: [folderId], appProperties: properties }, media, fields: "id,name,webViewLink,parents,mimeType,trashed", supportsAllDrives: true }, { retry: false });
  const file = saved.data;
  if (!file.id || file.trashed || file.mimeType !== CSV_MIME || !file.parents?.includes(folderId) || !file.webViewLink) {
    throw new Error("Instagram CSV could not be verified after saving.");
  }
  return { id: file.id, url: file.webViewLink, name: file.name ?? name };
}

export async function assertInstagramDriveDestination(profile: ExportProfile, brandId: string) {
  await authorizedFolder(profile, brandId);
}

const SHEETS_MIME = "application/vnd.google-apps.spreadsheet";
const POSTS_TAB = "Posts";
const REELS_TAB = "Reels";
const COMMENTS_TAB = "Comments";
const MEDIA_COLUMNS = [
  "Media ID", "Shortcode", "Instagram URL", "Content Type", "Likes Count",
  "Comments Count (Reported)", "Comments Scraped Count", "Top-level Comments",
  "Replies", "Comments Status", "Comments Stop Reason", "Comments Error", "Updated At",
] as const;
const COMMENTS_JSON_PREFIX = "Comments JSON";
// Google Sheets rejects values at 50,000 characters. Leave a margin rather
// than truncating a saved comment tree; continuation cells are concatenated on
// readback and use the identical headers on Posts and Reels.
const SHEET_CELL_SAFE_CHARS = 48_000;
const COMMENT_COLUMNS = [
  "Media ID", "Shortcode", "Comment ID", "Comment Depth", "Parent Comment ID", "Comment Text",
  "Comment Likes", "Replies Count", "Created At", "Commenter Username", "Commenter Full Name",
  "Commenter ID", "Commenter Verified",
] as const;

function sheetCell(value: unknown) {
  if (value == null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function commentsJsonChunks(value: unknown) {
  const encoded = JSON.stringify(value ?? []);
  const chunks: string[] = [];
  for (let start = 0; start < encoded.length; start += SHEET_CELL_SAFE_CHARS) {
    chunks.push(encoded.slice(start, start + SHEET_CELL_SAFE_CHARS));
  }
  return chunks.length ? chunks : ["[]"];
}

function mediaColumns(jsonWidth: number) {
  return [
    ...MEDIA_COLUMNS,
    ...Array.from({ length: Math.max(1, jsonWidth) }, (_, index) => `${COMMENTS_JSON_PREFIX} ${index + 1}`),
  ];
}

async function profileSheetTarget(profile: ExportProfile, brandId: string, username: string) {
  const { drive, folderId, folderUrl } = await authorizedFolder(profile, brandId);
  const profileKey = createHash("sha256").update(username.toLowerCase()).digest("hex");
  const properties = { mh_org: profile.org_id, mh_brand: brandId, mh_ig_profile: profileKey };
  const propertyQuery = Object.entries(properties)
    .map(([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`)
    .join(" and ");
  const found = await drive.files.list({
    q: `'${escapeQuery(folderId)}' in parents and trashed=false and mimeType='${SHEETS_MIME}' and ${propertyQuery}`,
    fields: "files(id,name,webViewLink,parents,mimeType,trashed)", pageSize: 3,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if ((found.data.files?.length ?? 0) > 1) {
    throw new TRPCError({ code: "CONFLICT", message: "More than one managed Instagram Sheet matches this profile. Resolve the duplicate in Drive before syncing." });
  }
  let file = found.data.files?.[0];
  if (!file) {
    file = (await drive.files.create({
      requestBody: { name: `Instagram — ${username}`, mimeType: SHEETS_MIME, parents: [folderId], appProperties: properties },
      fields: "id,name,webViewLink,parents,mimeType,trashed", supportsAllDrives: true,
    }, { retry: false })).data;
  }
  if (!file.id || !file.webViewLink || file.trashed || file.mimeType !== SHEETS_MIME || !file.parents?.includes(folderId)) {
    throw new Error("Instagram profile Sheet could not be verified.");
  }
  return { drive, file: { id: file.id, name: file.name ?? `Instagram — ${username}`, url: file.webViewLink }, folderUrl };
}

/** Find only an existing managed profile Sheet.  Unlike sync, this never
 * creates a replacement when a user has removed a file from Drive. */
async function existingProfileSheet(profile: ExportProfile, brandId: string, username: string) {
  const { drive, folderId } = await authorizedFolder(profile, brandId);
  const profileKey = createHash("sha256").update(username.toLowerCase()).digest("hex");
  const properties = { mh_org: profile.org_id, mh_brand: brandId, mh_ig_profile: profileKey };
  const propertyQuery = Object.entries(properties)
    .map(([key, value]) => `appProperties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`)
    .join(" and ");
  const found = await drive.files.list({
    q: `'${escapeQuery(folderId)}' in parents and trashed=false and mimeType='${SHEETS_MIME}' and ${propertyQuery}`,
    fields: "files(id,name,webViewLink,parents,mimeType,trashed)", pageSize: 3,
    supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  if ((found.data.files?.length ?? 0) > 1) {
    throw new TRPCError({ code: "CONFLICT", message: "More than one managed Instagram Sheet matches this profile. Resolve the duplicate in Drive before loading." });
  }
  const file = found.data.files?.[0];
  if (!file?.id || file.trashed || file.mimeType !== SHEETS_MIME || !file.parents?.includes(folderId)) return null;
  return { drive, file: { id: file.id, name: file.name ?? `Instagram — ${username}`, url: file.webViewLink ?? "" } };
}

async function ensureTabs(sheets: ReturnType<typeof google.sheets>, spreadsheetId: string) {
  const metadata = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties(sheetId,title))" });
  const existing = new Set((metadata.data.sheets ?? []).map((sheet) => sheet.properties?.title));
  const requests: any[] = [];
  if (!existing.has(POSTS_TAB)) requests.push({ addSheet: { properties: { title: POSTS_TAB } } });
  if (!existing.has(REELS_TAB)) requests.push({ addSheet: { properties: { title: REELS_TAB } } });
  if (!existing.has(COMMENTS_TAB)) requests.push({ addSheet: { properties: { title: COMMENTS_TAB } } });
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, { retry: false });
}

/** Grow managed tabs before a write. Google Sheets creates a new tab with only
 * 1,000 rows, which is not enough for a complete comment-level export. */
async function ensureTabCapacity(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  capacities: Array<{ title: string; rows: number; columns: number }>,
) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))",
  });
  const requests: any[] = [];
  for (const capacity of capacities) {
    const sheet = (metadata.data.sheets ?? []).find((item) => item.properties?.title === capacity.title);
    const properties = sheet?.properties;
    if (!properties || properties.sheetId == null) throw new Error(`Instagram Sheet tab ${capacity.title} could not be prepared.`);
    const currentRows = properties.gridProperties?.rowCount ?? 0;
    const currentColumns = properties.gridProperties?.columnCount ?? 0;
    const rowCount = Math.max(currentRows, capacity.rows);
    const columnCount = Math.max(currentColumns, capacity.columns);
    if (rowCount !== currentRows || columnCount !== currentColumns) {
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: properties.sheetId, gridProperties: { rowCount, columnCount } },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      });
    }
  }
  if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }, { retry: false });
}

async function replaceTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tab: string,
  columns: readonly string[],
  rows: string[][],
): Promise<number> {
  // Clear every managed value column, not only A:Z.  A large comment tree is
  // represented by several `Comments JSON N` columns and leaving an old
  // continuation behind would make a later local-cache refresh reject the
  // otherwise valid managed header row.
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tab}'!A:ZZZ`, requestBody: {} });
  // Large comment workspaces can contain hundreds of thousands of rows.  One
  // values.update request for all of them is vulnerable to request-size and
  // proxy timeouts, leaving the managed tab only partly written.  Write the
  // header once and use modest row batches; verification below still makes the
  // sync all-or-explicitly-failed from the caller's perspective.
  const header = await sheets.spreadsheets.values.update({
    spreadsheetId, range: `'${tab}'!A1`, valueInputOption: "RAW",
    requestBody: { majorDimension: "ROWS", values: [columns as unknown as string[]] },
  });
  if (header.data.updatedRows !== 1) throw new Error(`Instagram Sheet ${tab} header could not be written.`);
  const batchSize = 5_000;
  let written = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const result = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `'${tab}'!A${start + 2}`,
      valueInputOption: "RAW",
      requestBody: { majorDimension: "ROWS", values: batch },
    });
    if (result.data.updatedRows !== batch.length) throw new Error(`Instagram Sheet ${tab} batch ${start / batchSize + 1} was only partly written.`);
    written += result.data.updatedRows;
  }
  return written;
}

/**
 * One native Google Sheet per organization, brand and Instagram profile.
 * Repeated discovery/harvests rebuild the two managed tabs from the durable
 * workspace, so newly found media creates rows but existing media/comment IDs
 * never create duplicate files or duplicate rows.
 */
export async function syncInstagramProfileSheet(
  profile: ExportProfile,
  input: { brandId: string; username: string },
): Promise<SheetResult> {
  const username = input.username.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,64}$/.test(username)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid Instagram profile name." });
  const db = getDb();
  const { data: media, error: mediaError } = await db
    .from("insta_comment_media")
    .select("media_id,shortcode,media_url,media_kind,likes_count,comments_count_reported,comments_scraped_count,comments_top_level_count,comments_reply_count,comments_status,comments_stop_reason,comments_error,comments_json,updated_at")
    .eq("org_id", profile.org_id).eq("target_username", username).order("updated_at", { ascending: false }).limit(2_000);
  if (mediaError) throw new Error(mediaError.message);
  if (!media?.length) throw new TRPCError({ code: "NOT_FOUND", message: "No saved Instagram links exist for this profile yet." });

  const preparedMedia: Array<{ row: any; json: string[] }> = media.map((row: any) => ({ row, json: commentsJsonChunks(row.comments_json) }));
  const jsonWidth = Math.max(1, ...preparedMedia.map(({ json }) => json.length));
  const columns = mediaColumns(jsonWidth);
  const mediaRow = ({ row, json }: { row: any; json: string[] }) => [
    row.media_id, row.shortcode, row.media_url, row.media_kind, row.likes_count,
    row.comments_count_reported, row.comments_scraped_count, row.comments_top_level_count,
    row.comments_reply_count, row.comments_status, row.comments_stop_reason, row.comments_error,
    row.updated_at,
    ...Array.from({ length: jsonWidth }, (_, index) => json[index] ?? ""),
  ].map(sheetCell);
  const postRows = preparedMedia.filter(({ row }: any) => row.media_kind !== "reel").map(mediaRow);
  const reelRows = preparedMedia.filter(({ row }: any) => row.media_kind === "reel").map(mediaRow);
  const comments = new Map<string, any>();
  for (const row of media as any[]) {
    for (const comment of Array.isArray(row.comments_json) ? row.comments_json : []) {
      const id = String(comment?.id ?? "");
      if (!id) continue;
      comments.set(`${row.media_id}:${id}`, { media: row, comment });
    }
  }
  const commentRows = [...comments.values()].map(({ media, comment }) => [
    media.media_id, media.shortcode, comment.id, Number(comment.depth) === 0 ? "Top-level" : "Reply",
    comment.parentId ?? comment.parent_id, comment.text, comment.likeCount ?? comment.like_count,
    comment.replyCount ?? comment.reply_count, comment.createdAt ?? comment.created_at,
    comment.username ?? comment.commenter_username, comment.fullName ?? comment.commenter_full_name,
    comment.userId ?? comment.commenter_user_id, comment.isVerified ? "Yes" : "No",
  ].map(sheetCell));

  const target = await profileSheetTarget(profile, input.brandId, username);
  const sheets = google.sheets({ version: "v4", auth: (target.drive as any).context._options.auth });
  await ensureTabs(sheets, target.file.id);
  await ensureTabCapacity(sheets, target.file.id, [
    { title: POSTS_TAB, rows: postRows.length + 1, columns: columns.length },
    { title: REELS_TAB, rows: reelRows.length + 1, columns: columns.length },
    { title: COMMENTS_TAB, rows: commentRows.length + 1, columns: COMMENT_COLUMNS.length },
  ]);
  const postWritten = await replaceTab(sheets, target.file.id, POSTS_TAB, columns, postRows);
  const reelWritten = await replaceTab(sheets, target.file.id, REELS_TAB, columns, reelRows);
  const commentsWritten = await replaceTab(sheets, target.file.id, COMMENTS_TAB, COMMENT_COLUMNS, commentRows);
  const [postsCheck, reelsCheck, commentsCheck] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: target.file.id, range: `'${POSTS_TAB}'!A1:A1000`, valueRenderOption: "UNFORMATTED_VALUE" }),
    sheets.spreadsheets.values.get({ spreadsheetId: target.file.id, range: `'${REELS_TAB}'!A1:A1000`, valueRenderOption: "UNFORMATTED_VALUE" }),
    // Each large comment batch is verified through the Sheets API's
    // `updatedRows` response above. Read only the managed header here; reading
    // 145k values back in one response can exceed proxy deadlines.
    sheets.spreadsheets.values.get({ spreadsheetId: target.file.id, range: `'${COMMENTS_TAB}'!A1:A1`, valueRenderOption: "UNFORMATTED_VALUE" }),
  ]);
  const postCount = Math.max(0, (postsCheck.data.values?.length ?? 0) - 1);
  const reelCount = Math.max(0, (reelsCheck.data.values?.length ?? 0) - 1);
  if (
    postsCheck.data.values?.[0]?.[0] !== "Media ID"
    || reelsCheck.data.values?.[0]?.[0] !== "Media ID"
    || commentsCheck.data.values?.[0]?.[0] !== "Media ID"
    || postCount !== postRows.length || postWritten !== postRows.length
    || reelCount !== reelRows.length || reelWritten !== reelRows.length
    || commentsWritten !== commentRows.length
  ) {
    throw new Error("Instagram Sheet verification failed; the existing Sheet was not marked synced.");
  }
  return { id: target.file.id, url: target.file.url, name: target.file.name, folderUrl: target.folderUrl };
}

/**
 * Refresh a profile's local cache from its one managed Sheet.  Only rows that
 * are actually present in the valid managed Media tab are upserted; absent
 * rows never delete local history, including rows belonging to other profiles.
 */
export async function loadInstagramProfileSheet(
  profile: ExportProfile,
  input: { brandId: string; username: string },
) {
  const username = input.username.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,64}$/.test(username)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid Instagram profile name." });
  const target = await existingProfileSheet(profile, input.brandId, username);
  if (!target) return { found: false, refreshed: 0, sheetName: null };
  const sheets = google.sheets({ version: "v4", auth: (target.drive as any).context._options.auth });
  const metadata = await sheets.spreadsheets.get({ spreadsheetId: target.file.id, fields: "sheets(properties(title))" });
  const tabNames = new Set((metadata.data.sheets ?? []).map((sheet) => sheet.properties?.title));
  // "Media" is recognized only as the first rollout's managed legacy tab.
  // All newly synced workspaces use separate Posts and Reels tabs.
  const tabs = [POSTS_TAB, REELS_TAB].filter((tab) => tabNames.has(tab));
  if (!tabs.length && tabNames.has("Media")) tabs.push("Media");
  if (!tabs.length) return { found: true, refreshed: 0, sheetName: target.file.name };
  const int = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
  };
  const rows: Record<string, unknown>[] = [];
  for (const tab of tabs) {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: target.file.id, range: `'${tab}'!A:ZZZ`, valueRenderOption: "UNFORMATTED_VALUE" });
    const values = response.data.values ?? [];
    const header = values[0]?.map((value) => String(value ?? "")) ?? [];
    if (MEDIA_COLUMNS.some((column, index) => header[index] !== column)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Instagram Sheet's managed Media headers were changed. Local cache was preserved." });
    }
    const trailing = header.slice(MEDIA_COLUMNS.length);
    const legacySingleJson = trailing.length === 1 && trailing[0] === COMMENTS_JSON_PREFIX;
    const jsonColumns = legacySingleJson
      ? [COMMENTS_JSON_PREFIX]
      : trailing.filter((column) => /^Comments JSON [1-9]\d*$/.test(column));
    if (!jsonColumns.length || (!legacySingleJson && jsonColumns.length !== trailing.length)) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The Instagram Sheet's managed Comments JSON headers were changed. Local cache was preserved." });
    }
    const byColumn = (row: unknown[], name: string) => row[header.indexOf(name)] ?? "";
    for (const row of values.slice(1)) {
    const mediaId = String(byColumn(row, "Media ID") ?? "").trim();
    if (!mediaId) continue;
    let commentsJson: unknown[] = [];
    const rawJson = jsonColumns.map((column) => String(byColumn(row, column) ?? "")).join("");
    if (typeof rawJson === "string" && rawJson.trim()) {
      try {
        const parsed = JSON.parse(rawJson);
        if (Array.isArray(parsed)) commentsJson = parsed;
      } catch {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The managed Comments JSON contains invalid data. Local cache was preserved." });
      }
    }
    rows.push({
      org_id: profile.org_id, target_username: username, media_id: mediaId,
      shortcode: String(byColumn(row, "Shortcode") || "") || null,
      media_url: String(byColumn(row, "Instagram URL") || "") || null,
      media_kind: String(byColumn(row, "Content Type") || "") || null,
      likes_count: int(byColumn(row, "Likes Count")),
      comments_count_reported: int(byColumn(row, "Comments Count (Reported)")),
      comments_scraped_count: int(byColumn(row, "Comments Scraped Count")),
      comments_top_level_count: int(byColumn(row, "Top-level Comments")),
      comments_reply_count: int(byColumn(row, "Replies")),
      comments_status: String(byColumn(row, "Comments Status") || "pending"),
      comments_stop_reason: String(byColumn(row, "Comments Stop Reason") || "") || null,
      comments_error: String(byColumn(row, "Comments Error") || "") || null,
      comments_json: commentsJson,
      drive_sheet_id: target.file.id,
      drive_sheet_url: target.file.url || null,
      drive_synced_at: new Date().toISOString(),
      updated_at: String(byColumn(row, "Updated At") || "") || new Date().toISOString(),
    });
    }
  }
  if (rows.length) {
    // A local row with no sync marker is newer than the last Sheet snapshot
    // (for example, a completed scraper run awaiting an explicit sync). Never
    // let opening a profile silently overwrite that durable local cache with
    // older Sheet data.
    const mediaIds = [...new Set(rows.map((row) => String(row.media_id)))];
    const { data: localRows, error: localError } = await getDb()
      .from("insta_comment_media")
      .select("media_id,drive_synced_at")
      .eq("org_id", profile.org_id)
      .eq("target_username", username)
      .in("media_id", mediaIds);
    if (localError) throw new Error(localError.message);
    const unsynced = new Set((localRows ?? [])
      .filter((row: any) => !row.drive_synced_at)
      .map((row: any) => String(row.media_id)));
    const sheetRows = rows.filter((row) => !unsynced.has(String(row.media_id)));
    if (!sheetRows.length) return { found: true, refreshed: 0, sheetName: target.file.name };
    const { error } = await getDb().from("insta_comment_media").upsert(sheetRows, { onConflict: "org_id,target_username,media_id" });
    if (error) throw new Error(error.message);
    return { found: true, refreshed: sheetRows.length, sheetName: target.file.name };
  }
  return { found: true, refreshed: rows.length, sheetName: target.file.name };
}

/** Connected Drive targets the current user is authorized to export into. */
export async function instagramExportDestinations(profile: ExportProfile) {
  const db = getDb();
  const { data: brands, error } = await db
    .from("brands")
    .select("id,name")
    .eq("org_id", profile.org_id)
    .order("name");
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not load Instagram export destinations." });
  const allowed = (brands ?? []).filter((brand: any) => {
    try { assertBrandAccess(profile, brand.id); return true; } catch { return false; }
  });
  if (!allowed.length) return [];
  const { data: connections, error: connectionError } = await db
    .from("drive_connections")
    .select("brand_id,root_folder_id")
    .eq("is_active", true)
    .in("brand_id", allowed.map((brand: any) => brand.id));
  if (connectionError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Could not load connected Google Drive destinations." });
  return (connections ?? []).flatMap((connection: any) => {
    const brand = allowed.find((candidate: any) => candidate.id === connection.brand_id);
    return brand && /^[A-Za-z0-9_-]+$/.test(connection.root_folder_id)
      ? [{ brandId: brand.id, brandName: brand.name, rootFolderUrl: `https://drive.google.com/drive/folders/${connection.root_folder_id}` }]
      : [];
  });
}

/** A profile search writes a distinct snapshot CSV; it never replaces an older search. */
export async function saveInstagramDiscoveryCsv(
  profile: ExportProfile,
  input: { brandId: string; searchId?: string; username: string; media: InstagramMediaExport[] },
) {
  const { drive, folderId, folderUrl } = await authorizedFolder(profile, input.brandId);
  const searchId = input.searchId ?? randomUUID();
  const username = input.username.toLowerCase();
  const mediaRows = input.media.map((post, index) => ({
    Index: index + 1,
    "Media ID": post.id,
    Shortcode: post.shortcode,
    "Instagram URL": post.url,
    "Content Type": post.kind,
    "Likes Count": post.likes,
    "Comments Count (Reported)": post.comments,
    "Views / Play Count": post.views ?? "",
    "Published At": post.takenAt ? new Date(post.takenAt * 1000).toISOString() : "",
    Caption: post.caption ?? "",
  }));
  const content = csv(Object.keys(mediaRows[0] ?? { Index: "" }), mediaRows);
  const file = await writeCsv(
    drive,
    folderId,
    `instagram_${filenamePart(username)}_media_${stamp()}.csv`,
    content,
    { mh_org: profile.org_id, mh_brand: input.brandId, mh_ig_search: searchId, mh_ig_kind: "media" },
  );
  return { folderUrl, files: [file] };
}

/** Completion export for a durable comment run.  It creates separate media
 * and comments CSVs, then updates those same files if that run is retried. */
export async function saveInstagramRunCsv(orgId: string, brandId: string, runId: string) {
  const db = getDb();
  const { data: run, error: runError } = await db
    .from("insta_comment_runs")
    .select("target_username, posts")
    .eq("id", runId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (runError || !run) throw new Error(runError?.message ?? "Instagram run not found for Drive export.");
  // The worker already owns this run and its brand was validated when queued.
  const profile = { org_id: orgId, role: "admin", brand_id: brandId, assigned_brands: [brandId] } as ExportProfile;
  const { drive, folderId, folderUrl } = await authorizedFolder(profile, brandId);
  const mediaIds = (Array.isArray(run.posts) ? run.posts : []).map((post: any) => String(post?.mediaId ?? "")).filter(Boolean);
  const { data: media, error: mediaError } = mediaIds.length
    ? await db.from("insta_comment_media").select("media_id,shortcode,media_url,media_kind,likes_count,comments_count_reported,comments_scraped_count,comments_top_level_count,comments_reply_count,comments_status,comments_stop_reason,comments_error,updated_at").eq("org_id", orgId).eq("target_username", run.target_username).in("media_id", mediaIds)
    : { data: [], error: null };
  if (mediaError) throw new Error(mediaError.message);
  const mediaRows = (media ?? []).map((post: any, index: number) => ({
    Index: index + 1,
    "Media ID": post.media_id,
    Shortcode: post.shortcode ?? "",
    "Instagram URL": post.media_url ?? "",
    "Content Type": post.media_kind ?? "",
    "Likes Count": post.likes_count ?? "",
    "Comments Count (Reported)": post.comments_count_reported ?? "",
    "Comments Scraped Count": post.comments_scraped_count,
    "Top-level Comments": post.comments_top_level_count,
    Replies: post.comments_reply_count,
    "Comments Status": post.comments_status,
    "Comments Stop Reason": post.comments_stop_reason ?? "",
    "Comments Error": post.comments_error ?? "",
    "Updated At": post.updated_at,
  }));
  const files: CsvResult[] = [];
  files.push(await writeCsv(
    drive, folderId, `instagram_${filenamePart(run.target_username)}_media_${runId}.csv`,
    csv(Object.keys(mediaRows[0] ?? { Index: "" }), mediaRows),
    { mh_org: orgId, mh_brand: brandId, mh_ig_run: runId, mh_ig_kind: "media" },
  ));

  const comments: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await db
      .from("insta_comments")
      .select("post_media_id,post_shortcode,comment_id,comment_text,comment_created_at,comment_likes,depth,parent_comment_id,reply_count,commenter_username,commenter_full_name,commenter_user_id,commenter_verified")
      .eq("run_id", runId)
      .eq("org_id", orgId)
      .order("id", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(error.message);
    comments.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  if (comments.length) {
    const commentRows = comments.map((comment) => ({
      "Media ID": comment.post_media_id,
      Shortcode: comment.post_shortcode ?? "",
      "Comment ID": comment.comment_id,
      "Comment Depth": comment.depth === 0 ? "Top-level" : "Reply",
      "Parent Comment ID": comment.parent_comment_id ?? "",
      "Comment Text": comment.comment_text ?? "",
      "Comment Likes": comment.comment_likes,
      "Replies Count": comment.reply_count,
      "Created At": comment.comment_created_at ?? "",
      "Commenter Username": comment.commenter_username ?? "",
      "Commenter Full Name": comment.commenter_full_name ?? "",
      "Commenter ID": comment.commenter_user_id ?? "",
      "Commenter Verified": comment.commenter_verified ? "Yes" : "No",
    }));
    files.push(await writeCsv(
      drive, folderId, `instagram_${filenamePart(run.target_username)}_comments_${runId}.csv`,
      csv(Object.keys(commentRows[0]), commentRows),
      { mh_org: orgId, mh_brand: brandId, mh_ig_run: runId, mh_ig_kind: "comments" },
    ));
  }
  return { folderUrl, files };
}
