import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getDb } from "@/lib/supabase/db";
import { uploadFile, deleteFile, getAuthenticatedDrive } from "@/server/services/drive/client";
import {
  EDITOR_ASSET_KINDS,
  EDITOR_ASSET_KIND_LIST,
  EditorAssetError,
  assertAllowed,
  extensionFor,
  maxBytesFor,
  mediaKindFor,
  normaliseMime,
  type EditorAssetKind,
} from "@/lib/editor/asset-kinds";

/**
 * POST /api/editor/asset — upload a sticker, an audio track, a render overlay,
 * or the source photo/video being edited.
 *
 * None of these is library media, and none of them gets a `media_assets` row:
 *
 *   sticker → `stickers`      (needs a trustworthy aspect, see below)
 *   audio   → `audio_tracks`
 *   overlay → no row at all; the edit document holds the drive file id
 *   source  → no row at all either, and for a different reason: the draft does
 *             not exist yet. This returns a descriptor and the client hands it
 *             to tRPC `editor.createDraft`, which writes it into the
 *             `media_edits.source_*` columns as it creates the draft. Same
 *             row-less shape as `overlay`, so the two read alike.
 *
 * Why this is a route handler and not a tRPC mutation: tRPC speaks JSON, and
 * pushing a 50MB track through a base64 JSON body would triple it in memory.
 * The cost is that `src/proxy.ts` deliberately excludes `/api/*` from its
 * matcher — multipart bodies get corrupted if middleware touches them — so
 * there is no session handling in front of this handler and it must do its own
 * auth, exactly like `/api/upload` and `/api/media/[assetId]`.
 *
 * Note that the Supabase client here is the service role one: it bypasses RLS
 * entirely, so the checks below are the only gate, not a second line of defence.
 */

// Refuse an obviously oversized body before `formData()` buffers it. The kind
// (and therefore the real cap) only becomes known after parsing, so this is the
// largest cap plus room for multipart framing.
const MAX_ANY_BODY_BYTES =
  Math.max(...EDITOR_ASSET_KIND_LIST.map(maxBytesFor)) + 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `numeric(10, 6)` holds four integer digits. An aspect outside this cannot be
// stored at all, and a 10000:1 sliver is not a sticker.
const MAX_ASPECT = 9999.999999;
const MIN_ASPECT = 0.000001;

// `audio_tracks.duration_ms` is int4.
const MAX_DURATION_MS = 2_147_483_647;

// So are `media_edits.source_width`, `source_height` and `source_duration_ms`.
// This request writes no row, but the descriptor it returns for a `source` is
// persisted verbatim into those columns by `editor.createDraft`, so the bound
// belongs here rather than one hop later where the number is no longer suspect.
const MAX_INT4 = MAX_DURATION_MS;

interface Profile {
  id: string;
  org_id: string;
  brand_id: string | null;
  role: string;
  assigned_brands?: string[] | null;
}

function fail(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Read access, identical to `/api/media/[assetId]` and `/api/upload`. */
function hasBrandAccess(profile: Profile, brandId: string): boolean {
  if (["super_admin", "agency_admin"].includes(profile.role)) return true;
  if (profile.role === "agency_editor") return (profile.assigned_brands || []).includes(brandId);
  return profile.brand_id === brandId;
}

/**
 * Write access. Uploading is a write and the plain brand-access check above does
 * not distinguish read from write: a `brand_viewer` passes it because their
 * `brand_id` matches. They must not be able to add stickers or tracks.
 */
function canWriteBrand(profile: Profile, brandId: string): boolean {
  if (["super_admin", "agency_admin"].includes(profile.role)) return true;
  if (profile.role === "agency_editor") return (profile.assigned_brands || []).includes(brandId);
  if (["brand_owner", "brand_editor"].includes(profile.role)) return profile.brand_id === brandId;
  return false;
}

/** Thrown for conditions the user can act on; anything else becomes a 502. */
class EditorUploadError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "EditorUploadError";
    this.status = status;
  }
}

/**
 * A 404/410, or a 403 that is only about this one file, means the file itself is
 * gone — not that the connection is broken. Same reading as
 * `isUnavailableSheetError` in services/facebook/media-drive-target.ts.
 */
function isMissingDriveFile(error: unknown): boolean {
  const value = error as {
    code?: unknown;
    response?: { status?: number; data?: { error?: { errors?: { reason?: string }[] } } };
  };
  const status = value?.response?.status ?? value?.code;
  if (status === 404 || status === 410) return true;
  const reasons = value?.response?.data?.error?.errors?.map((e) => e.reason) ?? [];
  return (
    status === 403 &&
    reasons.length > 0 &&
    reasons.every((r) => r === "insufficientFilePermissions" || r === "forbidden")
  );
}

type DriveFolder = "originals" | "processed";

/**
 * Confirm the brand's target MediaHub folder is still a writable folder.
 *
 * `drive_connections.folder_ids` is written once at connect time and never
 * re-verified. If the user emptied it into the trash, Drive still accepts
 * `files.create` into a trashed parent — the upload "succeeds" and the file is
 * in the bin. Verifying first turns that into an actionable error instead of a
 * sticker that renders as a broken image a week later.
 *
 * Parameterised by folder because `source` uploads land in `Originals` and the
 * other three in `Processed`; see the upload call for why.
 */
async function verifyDriveFolder(
  brandId: string,
  orgId: string,
  folder: DriveFolder
): Promise<void> {
  const label = folder === "originals" ? "Originals" : "Processed";
  const db = getDb();
  const { data: conn } = await db
    .from("drive_connections")
    .select("folder_ids")
    .eq("brand_id", brandId)
    .eq("is_active", true)
    .maybeSingle();

  const folderId: string | undefined = conn?.folder_ids?.[folder];
  if (!folderId) {
    throw new EditorUploadError(
      "Google Drive is not connected for this brand, or its MediaHub folders were never created. Reconnect Drive for this brand and try again.",
      409
    );
  }

  const drive = await getAuthenticatedDrive(brandId, orgId);
  let target;
  try {
    target = (
      await drive.files.get({
        fileId: folderId,
        fields: "id,mimeType,trashed,capabilities(canAddChildren)",
        supportsAllDrives: true,
      })
    ).data;
  } catch (e) {
    if (isMissingDriveFile(e)) {
      throw new EditorUploadError(
        `This brand's MediaHub '${label}' folder no longer exists in Google Drive. Reconnect Drive for this brand to recreate it.`,
        409
      );
    }
    throw e;
  }

  const isFolder = target.mimeType === "application/vnd.google-apps.folder";
  if (target.trashed || !isFolder || target.capabilities?.canAddChildren === false) {
    throw new EditorUploadError(
      target.trashed
        ? `This brand's MediaHub '${label}' folder is in the Google Drive trash, so uploads would land in the bin. Restore it from the trash, or reconnect Drive for this brand.`
        : `This brand's MediaHub '${label}' folder is not a writable Drive folder any more. Reconnect Drive for this brand.`,
      409
    );
  }
}

/** Keep a user-supplied name usable as a Drive file name and a display label. */
function sanitiseName(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/\.[A-Za-z0-9]{1,8}$/, "") // strip the extension; we re-add the real one
    // Anything that is not a letter, digit or plain punctuation becomes a dash.
    // That also removes control characters, newlines and path separators, so the
    // result is safe as a Drive file name and as a display label.
    .replace(/[^\p{L}\p{N} ._()[\]\-]/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** An integer the `integer` column can hold, or null. Never a guess. */
function parseDurationMs(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_DURATION_MS) return null;
  return Math.round(value);
}

/**
 * A pixel dimension the client measured, or null — same contract as
 * `parseDurationMs` and used for the same reason: a `source` video's width and
 * height cannot be measured in this process.
 *
 * Zero is not a dimension, so unlike a duration this rejects it rather than
 * keeping it: a 0-wide source would divide by zero the moment the editor laid
 * out a canvas. Null says "unknown" and the editor can ask the browser, which
 * has the decoded video in front of it.
 */
function parseDimension(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_INT4) return null;
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

interface Measurement {
  width: number;
  height: number;
  aspect: number;
}

/**
 * Measure an image server-side and derive the aspect from the real pixels.
 *
 * The client sends its own width/height, but a wrong aspect is exactly what
 * makes a pasted logo render stretched, and the client's numbers come from
 * whatever the browser decoded (or from a hand-written request). sharp reads the
 * header only — no pixel decode — so this is cheap even for a 10MB animation.
 */
async function measureImage(buffer: Buffer, label: string): Promise<Measurement> {
  let width: number | undefined;
  let height: number | undefined;
  try {
    const meta = await sharp(buffer).metadata();
    width = meta.width;
    // For an animated GIF/WebP, `height` can describe the whole frame strip;
    // `pageHeight` is the height of one frame, which is what gets composited.
    height = meta.pageHeight ?? meta.height;
  } catch {
    // Fall through to the shared error below; never surface sharp's internals.
  }

  if (!width || !height || width <= 0 || height <= 0) {
    throw new EditorUploadError(
      `The ${label} could not be read as an image. Its dimensions are unknown, and without them it would render stretched.`,
      415
    );
  }

  const aspect = Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, height / width));
  return { width, height, aspect: Number(aspect.toFixed(6)) };
}

export async function POST(request: NextRequest) {
  // ── Auth ───────────────────────────────────────────────────────────────────
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return fail("Unauthorized", 401);

  const db = getDb();
  const { data: profileRow } = await db.from("users").select("*").eq("id", user.id).single();
  if (!profileRow) return fail("Profile not found", 401);
  const profile = profileRow as Profile;

  // The authoritative kind lives in the form body, which cannot be read without
  // buffering the whole upload — so a `?kind=` hint is accepted for this gate
  // ALONE, to pick a tighter cap than "the largest of any kind".
  //
  // This matters for an honest mistake, not just abuse: dropping a 400MB video
  // onto the Audio panel would otherwise buffer all 400MB in the `app`
  // container (which, unlike `worker`, has no mem_limit) only to reject it at
  // the 50MB audio cap a moment later. The hint is never trusted for anything
  // else: `assertAllowed` re-checks the real kind, MIME and size after parsing,
  // so a wrong or absent hint can only make this check looser, never permissive.
  const kindHint = new URL(request.url).searchParams.get("kind");
  const gateBytes =
    kindHint && (EDITOR_ASSET_KIND_LIST as readonly string[]).includes(kindHint)
      ? maxBytesFor(kindHint as EditorAssetKind) + 1024 * 1024
      : MAX_ANY_BODY_BYTES;

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > gateBytes) {
    return fail("The uploaded file is larger than this kind of editor asset may be.", 413);
  }

  let uploadedDriveFileId: string | null = null;
  let brandIdForCleanup: string | null = null;

  // A body that is not multipart at all is the caller's mistake, not a storage
  // failure, so it must not fall through to the 502 below.
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail(
      "Expected a multipart/form-data body with a 'file' part. Send the upload as FormData.",
      400
    );
  }

  try {
    const file = formData.get("file");
    const brandId = (formData.get("brandId") as string | null)?.trim() ?? "";
    const rawKind = (formData.get("kind") as string | null)?.trim() ?? "";
    const rawName = formData.get("name") as string | null;
    const packId = (formData.get("packId") as string | null)?.trim() || null;

    if (!(file instanceof File) || !brandId || !rawKind) {
      return fail("Missing required fields: file, brandId, kind", 400);
    }
    if (!UUID_RE.test(brandId)) return fail("brandId is not a valid id", 400);

    // ── Authorization ────────────────────────────────────────────────────────
    if (!hasBrandAccess(profile, brandId)) {
      return fail("You don't have access to this brand", 403);
    }
    if (!canWriteBrand(profile, brandId)) {
      return fail("Your role can view this brand but not add editor assets to it", 403);
    }

    // The service role client bypasses RLS, so organization scoping has to be
    // explicit: without this an admin of one organization would satisfy the role
    // check for another organization's brand, and we would then pair this
    // organization's OAuth client with that brand's Drive tokens.
    const { data: brand } = await db
      .from("brands")
      .select("id, org_id")
      .eq("id", brandId)
      .maybeSingle();
    if (!brand) return fail("Brand not found", 404);
    if (brand.org_id !== profile.org_id) {
      return fail("You don't have access to this brand", 403);
    }

    // ── Kind / type / size, before reading the body into memory ──────────────
    const declaredMime = file.type || "";
    assertAllowed(rawKind, declaredMime, undefined, file.size);
    const kind: EditorAssetKind = rawKind;

    if (kind === "sticker") {
      if (!packId) return fail("packId is required for a sticker", 400);
      if (!UUID_RE.test(packId)) return fail("packId is not a valid id", 400);
      // Never trust a client-supplied pack/brand pairing: the pack id arrives in
      // the same form body as the brand id, so one is not evidence for the other.
      const { data: pack } = await db
        .from("sticker_packs")
        .select("id, brand_id")
        .eq("id", packId)
        .maybeSingle();
      if (!pack || pack.brand_id !== brandId) {
        return fail("That sticker pack does not exist for this brand", 404);
      }
    }

    // ── Bytes ────────────────────────────────────────────────────────────────
    const buffer = Buffer.from(await file.arrayBuffer());
    // Re-check against what actually arrived, and against the magic bytes. The
    // declared MIME is attacker-controlled; these files are replayed to a
    // browser by GET /api/editor/asset/[id].
    assertAllowed(kind, declaredMime, buffer);

    const spec = EDITOR_ASSET_KINDS[kind];

    // `source` is the one kind that carries both images and videos, so its
    // kind-level `measurable` is false and the real decision is made per MIME
    // here — see the note on the kind in asset-kinds.ts. This is also what the
    // response reports as `kind`, so the two can never disagree.
    const mediaKind = kind === "source" ? mediaKindFor(declaredMime) : null;
    if (kind === "source" && !mediaKind) {
      // Unreachable: every MIME in the `source` table is an image/ or a video/
      // and `assertAllowed` rejected the rest. Checked before the upload rather
      // than asserted at the response, so a MIME added to that table later
      // cannot quietly return `kind: null` or orphan a Drive file.
      return fail("A source file must be an image or a video.", 415);
    }

    let measurement: Measurement | null = null;
    if (spec.measurable || mediaKind === "image") {
      measurement = await measureImage(
        buffer,
        mediaKind === "image" ? "source image" : spec.label.toLowerCase()
      );
    }
    // A video reaches here unmeasured either way: ffprobe is in the worker and
    // dev images, not in `app`, so the client's number is the only one there is.
    const durationMs =
      kind === "audio" || mediaKind === "video"
        ? parseDurationMs(formData.get("durationMs") as string | null)
        : null;

    // ── Drive ────────────────────────────────────────────────────────────────
    // A `source` is the user's own untouched original, so it belongs in
    // `Originals` — the folder that means exactly that in a brand's Drive — and
    // only a finished render ever lands in `Processed`. The other three kinds go
    // the other way deliberately: `Originals` is the Media Library's folder and
    // a sticker or an overlay sitting in it would read as library media. A
    // source is library-shaped and simply has no `media_assets` row yet, which
    // is what keeps it out of the Library listing.
    const targetFolder: DriveFolder = kind === "source" ? "originals" : "processed";
    await verifyDriveFolder(brandId, profile.org_id, targetFolder);

    const displayName = sanitiseName(rawName ?? file.name, spec.label);
    // The prefix keeps editor uploads identifiable in a brand's Drive without a
    // second folder level to verify — which matters most for a `source`, since
    // that one is filed next to the Library's own originals.
    const driveName = `editor/${kind}/${randomUUID()}-${displayName}.${extensionFor(kind, declaredMime)}`;
    brandIdForCleanup = brandId;
    uploadedDriveFileId = await uploadFile(
      brandId,
      profile.org_id,
      buffer,
      driveName,
      declaredMime,
      targetFolder
    );

    // ── Row (overlays and sources get none) ──────────────────────────────────
    const fileSize = buffer.length;

    if (kind === "source") {
      // A descriptor, not a row — there is no draft to attach it to yet. The
      // client passes this straight to tRPC `editor.createDraft`, which creates
      // the `media_edits` row and its `source_*` columns together. Writing a row
      // here instead would mean a draft-less source every time the user closed
      // the tab on the ratio picker, and `transferToLibrary` is still the only
      // thing that ever creates a `media_assets` row.
      //
      // Response shape is a contract with the editor client; it deliberately
      // does not match the sticker/audio/overlay shape, which is keyed on a row
      // id and an `aspect` this does not compute.
      const sourceWidth = measurement
        ? measurement.width
        : parseDimension(formData.get("width") as string | null);
      const sourceHeight = measurement
        ? measurement.height
        : parseDimension(formData.get("height") as string | null);

      const driveFileId = uploadedDriveFileId;
      uploadedDriveFileId = null; // committed: nothing left to clean up
      return NextResponse.json({
        driveFileId,
        // The sanitised name with the canonical extension, not `file.name`: this
        // is persisted and then rendered as the draft's title, so the raw
        // client-supplied name never reaches a column or the DOM.
        fileName: `${displayName}.${extensionFor(kind, declaredMime)}`,
        // Normalised, not the raw `File.type`: this lands in
        // `media_edits.source_file_type` and the render path branches on it with
        // `.startsWith("image/")`, which a browser-supplied
        // "image/png; charset=binary" would fail. The other kinds keep storing
        // the raw type, so this is not a behaviour change for them.
        fileType: normaliseMime(declaredMime),
        // An image's dimensions are sharp's and the client's are discarded — a
        // wrong aspect is exactly what makes a photo render stretched. A video's
        // can only be the client's, bounded above. Either way unknown stays
        // null rather than becoming a 0 that collapses the canvas.
        width: sourceWidth,
        height: sourceHeight,
        durationMs,
        fileSize,
        // The MEDIA kind — `media_edits.kind`'s domain — not the asset kind.
        // Non-null by the guard before the upload.
        kind: mediaKind!,
      });
    }

    if (kind === "overlay") {
      // The overlay is referenced from the edit document and read back by the
      // worker straight from Drive; a row would only be a second thing to keep
      // in sync and a second way for it to leak into a library listing.
      const driveFileId = uploadedDriveFileId;
      uploadedDriveFileId = null; // committed: nothing left to clean up
      return NextResponse.json({
        id: null,
        driveFileId,
        kind,
        width: measurement?.width ?? null,
        height: measurement?.height ?? null,
        aspect: measurement?.aspect ?? null,
        durationMs: null,
        fileSize,
        mimeType: declaredMime,
      });
    }

    if (kind === "sticker") {
      const { data: last } = await db
        .from("stickers")
        .select("sort_order")
        .eq("pack_id", packId)
        .order("sort_order", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: sticker, error } = await db
        .from("stickers")
        .insert({
          pack_id: packId,
          brand_id: brandId,
          name: displayName,
          drive_file_id: uploadedDriveFileId,
          mime_type: declaredMime,
          width: measurement!.width,
          height: measurement!.height,
          aspect: measurement!.aspect,
          file_size: fileSize,
          sort_order: (last?.sort_order ?? -1) + 1,
        })
        .select("id, drive_file_id, width, height, aspect, file_size, mime_type")
        .single();

      if (error || !sticker) {
        throw new EditorUploadError(
          `The sticker was uploaded to Drive but could not be saved: ${error?.message ?? "insert returned no row"}`,
          500
        );
      }

      const driveFileId = uploadedDriveFileId;
      uploadedDriveFileId = null; // committed
      return NextResponse.json({
        id: sticker.id,
        driveFileId,
        kind,
        width: measurement!.width,
        height: measurement!.height,
        aspect: measurement!.aspect,
        durationMs: null,
        fileSize,
        mimeType: declaredMime,
      });
    }

    // kind === "audio"
    const { data: track, error } = await db
      .from("audio_tracks")
      .insert({
        brand_id: brandId,
        name: displayName,
        drive_file_id: uploadedDriveFileId,
        mime_type: declaredMime,
        // Kept as the client measured it: ffprobe exists in the worker and dev
        // images, not in the `app` image, so there is nothing to verify it
        // against here. Unknown stays null rather than becoming a guessed 0,
        // which would silently truncate every trim and fade built on it.
        duration_ms: durationMs,
        file_size: fileSize,
        created_by: profile.id,
      })
      .select("id")
      .single();

    if (error || !track) {
      throw new EditorUploadError(
        `The audio file was uploaded to Drive but could not be saved: ${error?.message ?? "insert returned no row"}`,
        500
      );
    }

    const driveFileId = uploadedDriveFileId;
    uploadedDriveFileId = null; // committed
    return NextResponse.json({
      id: track.id,
      driveFileId,
      kind,
      width: null,
      height: null,
      aspect: null,
      durationMs,
      fileSize,
      mimeType: declaredMime,
    });
  } catch (e: unknown) {
    // Everything past the Drive upload failed, so the file this request just
    // created is litter in the user's Drive. Remove that one file — never
    // anything that was already there — and never let the cleanup mask the
    // original failure.
    if (uploadedDriveFileId && brandIdForCleanup) {
      try {
        await deleteFile(uploadedDriveFileId, brandIdForCleanup, profile.org_id);
      } catch (cleanupError) {
        console.warn(
          "[editor-asset] could not remove the orphaned Drive upload:",
          (cleanupError as Error)?.message
        );
      }
    }

    if (e instanceof EditorAssetError) return fail(e.message, e.status);
    if (e instanceof EditorUploadError) return fail(e.message, e.status);

    // Drive/Gaxios errors carry the request config — including the bearer token —
    // on the error object. Only ever touch `.message`.
    const message = (e as Error)?.message ?? "Unknown error";
    console.error("[editor-asset] upload failed:", message.slice(0, 500));
    return fail("The file could not be stored in Google Drive. Please try again.", 502);
  }
}
