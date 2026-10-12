import { z } from "zod";
import sharp from "sharp";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { getRenderQueue, getAudioImportQueue } from "@/server/queue/queues";
import { downloadFile, deleteFile } from "@/server/services/drive/client";
import {
  MAX_INSTAGRAM_URL_LENGTH,
  instagramTrackName,
  parseInstagramMediaUrl,
} from "@/lib/editor/instagram-audio";
import {
  editDocSchema,
  createEmptyDoc,
  toTemplate,
  applyTemplate,
  reduceRatio,
  RATIO_KEYS,
  type EditDoc,
  type RatioKey,
} from "@/lib/editor/doc";

/**
 * Editor backend.
 *
 * Two authorisation facts drive the shape of everything here:
 *
 * 1. `ctx.db` is the service-role client, which bypasses RLS entirely. The
 *    migration's policies are defense in depth only — every statement below has
 *    to carry its own brand/org filter.
 * 2. `assertBrandAccess` answers "can this profile see this brand", not "can it
 *    write". It lets `brand_viewer` through, so mutations go through
 *    `requireBrand(..., { write: true })` as well (same shape as
 *    `DRIVE_MANAGE_ROLES` in routers/drive.ts).
 *
 * It also never trusts a client-supplied (child, brand) pairing: the brand of a
 * draft/template/sticker/track is always read back from the row, and the brand
 * of a source asset is always read through its media_group. `media.addVariant`
 * takes both `groupId` and `brandId` from the client and checks only the latter,
 * which lets a caller write an asset into another brand's group; that bug is
 * deliberately not reproduced here.
 */

// Everyone except brand_viewer, which is read-only by definition.
const EDITOR_WRITE_ROLES = [
  "super_admin",
  "agency_admin",
  "agency_editor",
  "brand_owner",
  "brand_editor",
];

type Db = { from: (table: string) => any };
type Profile = {
  id: string;
  role: string;
  org_id: string;
  brand_id: string | null;
  assigned_brands?: string[];
};

/**
 * The single gate. `assertBrandAccess` returns early for super_admin /
 * agency_admin without ever looking at the brand, so a brand id from a different
 * organisation would sail through — the org lookup closes that.
 */
async function requireBrand(
  db: Db,
  profile: Profile,
  brandId: string,
  opts: { write?: boolean } = {}
): Promise<void> {
  assertBrandAccess(profile, brandId);

  if (opts.write && !EDITOR_WRITE_ROLES.includes(profile.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your role is read-only in the editor",
    });
  }

  const { data: brand } = await db
    .from("brands")
    .select("id")
    .eq("id", brandId)
    .eq("org_id", profile.org_id)
    .maybeSingle();

  if (!brand) throw new TRPCError({ code: "NOT_FOUND", message: "Brand not found" });
}

/** Columns the list view needs. `doc` is excluded — it is the heavy column. */
const DRAFT_LIST_COLUMNS = [
  "id",
  "brand_id",
  "source_asset_id",
  // The Editor's own uploaded original. The drafts gallery needs the file name
  // to label a card, and `source_drive_file_id` is what tells it the preview
  // bytes come from /api/editor/asset/<id>?kind=source rather than from
  // /api/media/<assetId>.  Deliberately NOT selecting source_file_size etc. —
  // only what a card renders.
  "source_drive_file_id",
  "source_file_name",
  "source_file_type",
  "source_width",
  "source_height",
  "source_duration_ms",
  "kind",
  "title",
  "doc_version",
  "render_status",
  "render_progress",
  "render_error",
  "preview_thumb",
  "rendered_drive_file_id",
  "rendered_width",
  "rendered_height",
  "rendered_aspect_ratio",
  "rendered_duration_ms",
  "rendered_file_size",
  "rendered_mime_type",
  "overlay_drive_file_id",
  "transferred_asset_id",
  "created_by",
  "created_at",
  "updated_at",
].join(", ");

/** Load a row by id and authorise against the brand stored ON THE ROW. */
async function loadOwned(
  db: Db,
  profile: Profile,
  table: "media_edits" | "editor_templates" | "sticker_packs" | "stickers" | "audio_tracks",
  id: string,
  columns: string,
  opts: { write?: boolean } = {}
): Promise<any> {
  const { data: row, error } = await db.from(table).select(columns).eq("id", id).maybeSingle();
  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
  await requireBrand(db, profile, row.brand_id, opts);
  return row;
}

/** A source asset plus the brand that actually owns it (via its group). */
async function loadSourceAsset(db: Db, assetId: string) {
  const { data: asset, error } = await db
    .from("media_assets")
    .select(
      "id, drive_file_id, file_name, file_type, file_size, width, height, duration_seconds, group:media_groups(id, brand_id)"
    )
    .eq("id", assetId)
    .maybeSingle();

  if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
  if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "Source asset not found" });

  const brandId: string | undefined = (asset as any).group?.brand_id;
  if (!brandId) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Source asset has no brand" });
  }

  return { asset, brandId };
}

function sourceDimensions(asset: { width: number | null; height: number | null }) {
  return asset.width && asset.height ? { w: asset.width, h: asset.height } : undefined;
}

/** The columns `resolveDraftSource` needs, for callers building a select. */
const DRAFT_SOURCE_COLUMNS =
  "source_asset_id, source_drive_file_id, source_width, source_height, source_duration_ms";

/**
 * A draft's source media, from either model.
 *
 * Two shapes exist. The primary one is an Editor upload
 * (`source_drive_file_id`): the user pasted or picked a fresh file, it lives in
 * Drive Originals and has NO `media_assets` row, which is the whole point —
 * a draft must not appear in the Media Library. The legacy one is a draft
 * started from a library asset (`source_asset_id`).
 *
 * Resolved in one place so the two cannot drift: every caller only needs
 * "is there a source" plus its dimensions and duration.
 */
async function resolveDraftSource(
  db: Db,
  draft: {
    brand_id: string;
    source_asset_id?: string | null;
    source_drive_file_id?: string | null;
    source_width?: number | null;
    source_height?: number | null;
    source_duration_ms?: number | null;
  }
): Promise<{
  assetId: string | null;
  source: { w: number; h: number } | undefined;
  durationSeconds: number | null;
}> {
  if (draft.source_drive_file_id) {
    return {
      // Null on purpose: with no library asset the preview resolves bytes from
      // the draft itself (/api/editor/asset/<editId>?kind=source).
      assetId: null,
      source:
        draft.source_width && draft.source_height
          ? { w: draft.source_width, h: draft.source_height }
          : undefined,
      // Float seconds. The document keeps fractional time so a trim point
      // survives; only `media_assets.duration_seconds` is a rounded integer.
      durationSeconds: draft.source_duration_ms != null ? draft.source_duration_ms / 1000 : null,
    };
  }

  if (draft.source_asset_id) {
    const { asset, brandId } = await loadSourceAsset(db, draft.source_asset_id);
    if (brandId !== draft.brand_id) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Source asset brand mismatch" });
    }
    return {
      assetId: draft.source_asset_id,
      source: sourceDimensions(asset),
      durationSeconds: asset.duration_seconds ?? null,
    };
  }

  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "This draft has no source media yet. Add a photo or video first.",
  });
}

/**
 * Do two documents describe the same render?
 *
 * `overlayDriveFileId` is excluded, and that exclusion is load-bearing rather
 * than cosmetic. The render flow rasterises the layer stack in the browser,
 * uploads the PNG, and `updateDraft` mirrors the returned id INTO the stored
 * document. The client's in-memory copy never learns that id, so its very next
 * autosave looks like a real edit and flips a freshly-'ready' render back to
 * 'idle' — which also blocks transferToLibrary. Observed on a real render: the
 * file uploaded fine, then the draft reported itself as never rendered.
 *
 * It is also correct on the merits: the overlay is an OUTPUT of the layer
 * stack, regenerated on every render, not an input a user can edit. A change
 * that matters always shows up in `layers` as well.
 */
function sameRenderInput(a: EditDoc, b: EditDoc): boolean {
  const strip = (doc: EditDoc) => {
    const { overlayDriveFileId: _ignored, ...rest } = doc as EditDoc & {
      overlayDriveFileId?: string | null;
    };
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

/** Parse a stored document. Drafts default to '{}' in SQL, so this can fail. */
function parseDoc(raw: unknown, what = "document"): EditDoc {
  const parsed = editDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Invalid edit ${what}: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    });
  }
  return parsed.data;
}

function fileSafe(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

function extensionFor(mimeType: string | null | undefined): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "video/quicktime":
      return "mov";
    default:
      return "jpg";
  }
}

export const editorRouter = router({
  // ── Drafts ────────────────────────────────────────────────────────────────
  listDrafts: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId);

      const { data, error } = await db
        .from("media_edits")
        .select(DRAFT_LIST_COLUMNS)
        .eq("brand_id", input.brandId)
        .order("created_at", { ascending: false });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data ?? [];
    }),

  getDraft: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      return await loadOwned(db, profile, "media_edits", input.id, "*");
    }),

  createDraft: protectedProcedure
    .input(
      z
        .object({
          brandId: z.string().uuid(),
          kind: z.enum(["image", "video"]),
          ratio: z.enum(RATIO_KEYS as [RatioKey, ...RatioKey[]]),
          title: z.string().min(1).max(200).optional(),
          /**
           * The Editor's OWN upload — the descriptor `POST /api/editor/asset`
           * returns for `kind=source`. This is the primary path: the Editor
           * starts from a freshly pasted or picked file, because Media Library
           * media is already processed or published. The upload lands in the
           * brand's Drive Originals folder and gets NO `media_assets` row, so
           * a draft never shows up in the library until it is transferred.
           */
          source: z
            .object({
              driveFileId: z.string().min(1).max(200),
              fileName: z.string().min(1).max(500),
              fileType: z.string().min(1).max(200),
              width: z.number().int().positive().max(100000).nullish(),
              height: z.number().int().positive().max(100000).nullish(),
              // int4 column; a value past the cap is dropped rather than
              // overflowing the insert.
              durationMs: z.number().int().nonnegative().max(2147483647).nullish(),
              fileSize: z.number().int().nonnegative().nullish(),
            })
            .optional(),
          /** Legacy: a draft started from an existing Media Library asset. */
          sourceAssetId: z.string().uuid().optional(),
        })
        .refine((v) => Boolean(v.source) !== Boolean(v.sourceAssetId), {
          message: "Provide exactly one of `source` (an Editor upload) or `sourceAssetId`",
        })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId, { write: true });

      // A mismatched kind is permanently broken rather than merely wrong: the
      // render worker branches on `kind`, so an image marked 'video' takes the
      // ffmpeg path and fails on every retry.
      function assertKindMatches(fileType: string) {
        if (fileType.startsWith("image/") && input.kind !== "image") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That file is an image" });
        }
        if (fileType.startsWith("video/") && input.kind !== "video") {
          throw new TRPCError({ code: "BAD_REQUEST", message: "That file is a video" });
        }
        if (!fileType.startsWith("image/") && !fileType.startsWith("video/")) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `${fileType || "That file"} cannot be edited`,
          });
        }
      }

      let row: Record<string, unknown>;
      let doc;

      if (input.source) {
        const s = input.source;
        assertKindMatches(s.fileType);

        doc = createEmptyDoc({
          ratio: input.ratio,
          kind: input.kind,
          // No library asset exists, so the preview resolves bytes from the
          // draft itself (`/api/editor/asset/<editId>?kind=source`) rather than
          // from an id embedded in the document.
          assetId: null,
          source: s.width && s.height ? { w: s.width, h: s.height } : undefined,
        });

        row = {
          brand_id: input.brandId,
          source_drive_file_id: s.driveFileId,
          source_file_name: s.fileName,
          source_file_type: s.fileType,
          source_width: s.width ?? null,
          source_height: s.height ?? null,
          source_duration_ms: s.durationMs ?? null,
          source_file_size: s.fileSize ?? null,
          title: input.title?.trim() || s.fileName || "Untitled edit",
        };
      } else {
        const { asset, brandId: assetBrandId } = await loadSourceAsset(db, input.sourceAssetId!);
        // The asset's real owner, not the pairing the client sent.
        if (assetBrandId !== input.brandId) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "That asset belongs to a different brand",
          });
        }
        assertKindMatches(asset.file_type || "");

        doc = createEmptyDoc({
          ratio: input.ratio,
          kind: input.kind,
          assetId: input.sourceAssetId!,
          source: sourceDimensions(asset),
        });

        row = {
          brand_id: input.brandId,
          source_asset_id: input.sourceAssetId,
          title: input.title?.trim() || asset.file_name || "Untitled edit",
        };
      }

      const { data, error } = await db
        .from("media_edits")
        .insert({
          ...row,
          kind: input.kind,
          doc,
          doc_version: doc.version,
          render_status: "idle",
          render_progress: 0,
          created_by: profile.id,
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  updateDraft: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        doc: z.unknown().optional(),
        title: z.string().min(1).max(200).optional(),
        overlayDriveFileId: z.string().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(
        db,
        profile,
        "media_edits",
        input.id,
        "id, brand_id, doc, render_status, overlay_drive_file_id",
        { write: true }
      );

      const updates: Record<string, unknown> = {
        // There is no updated_at trigger anywhere in this schema — every write
        // path has to set it explicitly or the column freezes at insert time.
        updated_at: new Date().toISOString(),
      };

      if (input.title !== undefined) updates.title = input.title.trim();

      let nextDoc: EditDoc | null = input.doc !== undefined ? parseDoc(input.doc) : null;

      if (input.overlayDriveFileId !== undefined) {
        updates.overlay_drive_file_id = input.overlayDriveFileId;
        // The renderer reads `doc.overlayDriveFileId`, so the column alone would
        // be ignored.  Mirror it into whichever document is about to be stored.
        const base = nextDoc ?? editDocSchema.safeParse(existing.doc).data ?? null;
        if (base) nextDoc = { ...base, overlayDriveFileId: input.overlayDriveFileId };
      } else if (nextDoc) {
        // Keep the convenience column in step with the document.
        updates.overlay_drive_file_id = nextDoc.overlayDriveFileId;
      }

      if (nextDoc) {
        updates.doc = nextDoc;
        updates.doc_version = nextDoc.version;
      }

      // A 'ready' render belongs to the document that produced it.  Leaving the
      // status alone would let transferToLibrary push a file into the Media
      // Library that does not match what the user is looking at — the rendered_*
      // columns are kept (the file still exists) but the draft goes back to
      // needing a render.  Compared through the schema because jsonb round-trips
      // reorder keys, so a raw stringify would report every save as a change.
      // A title-only rename leaves nextDoc null and must not invalidate anything.
      if (existing.render_status === "ready" && nextDoc != null) {
        const before = editDocSchema.safeParse(existing.doc);
        if (!before.success || !sameRenderInput(before.data, nextDoc)) {
          updates.render_status = "idle";
        }
      }

      const { data, error } = await db
        .from("media_edits")
        .update(updates)
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  deleteDraft: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(
        db,
        profile,
        "media_edits",
        input.id,
        "id, brand_id, source_drive_file_id, overlay_drive_file_id, rendered_drive_file_id, transferred_asset_id",
        { write: true }
      );

      const { error } = await db
        .from("media_edits")
        .delete()
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Drive cleanup, best effort and strictly after the row is gone: a file
      // the user already removed by hand (404) or an expired token must never
      // block the delete.
      //
      // Which files have no other owner once this row is gone:
      //  - source_drive_file_id  — the original the user pasted INTO the editor.
      //    It has no media_assets row at all (that is the whole point: a draft
      //    must not appear in the Media Library), so nothing else will ever
      //    collect it.
      //  - overlay_drive_file_id — a derived rasterisation, never referenced
      //    anywhere else.
      //  - rendered_drive_file_id — ONLY when this draft was never transferred.
      //    transferToLibrary points BOTH drive_file_id and
      //    processed_drive_file_id at the rendered file, so after a transfer the
      //    Media Library asset owns it and media.deleteGroup will collect it.
      const orphans = new Set<string>();
      if (existing.source_drive_file_id) orphans.add(existing.source_drive_file_id);
      if (existing.overlay_drive_file_id) orphans.add(existing.overlay_drive_file_id);
      if (!existing.transferred_asset_id && existing.rendered_drive_file_id) {
        orphans.add(existing.rendered_drive_file_id);
      }

      for (const fileId of orphans) {
        try {
          await deleteFile(fileId, existing.brand_id, profile.org_id);
        } catch (e) {
          console.warn(`[editor.deleteDraft] Drive delete failed for ${fileId}:`, e);
        }
      }

      return { success: true, id: input.id };
    }),

  requestRender: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(
        db,
        profile,
        "media_edits",
        input.id,
        `id, brand_id, kind, doc, render_status, ${DRAFT_SOURCE_COLUMNS}`,
        { write: true }
      );

      // Throws when the draft has no source in EITHER model. An Editor upload
      // has no source_asset_id, so checking that column alone would reject
      // every draft the Editor itself created.
      await resolveDraftSource(db, existing);
      // Fail fast on a document the worker could not parse anyway.
      parseDoc(existing.doc);

      const { data, error } = await db
        .from("media_edits")
        .update({
          render_status: "queued",
          render_progress: 0,
          render_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id)
        .select(DRAFT_LIST_COLUMNS)
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      try {
        // ID ONLY.  Never the document or any base64 — see getRenderQueue().
        await getRenderQueue().add(
          `render-${input.id}`,
          { editId: input.id },
          { jobId: `render-${input.id}-${Date.now()}` }
        );
      } catch (e: any) {
        const message = e?.message || "Could not queue the render";
        await db
          .from("media_edits")
          .update({
            render_status: "failed",
            render_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", input.id)
          .eq("brand_id", existing.brand_id);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
      }

      return data;
    }),

  transferToLibrary: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const edit = await loadOwned(db, profile, "media_edits", input.id, "*", { write: true });

      if (edit.render_status !== "ready" || !edit.rendered_drive_file_id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Render this draft before transferring it to the library",
        });
      }

      // Idempotent: a double click (or a retried mutation) must not leave an
      // orphaned group behind, and must not silently repoint transferred_asset_id.
      if (edit.transferred_asset_id) {
        const { data: already } = await db
          .from("media_assets")
          .select("*, group:media_groups(id, brand_id, title, status)")
          .eq("id", edit.transferred_asset_id)
          .maybeSingle();
        if (already) {
          return { asset: already, groupId: already.group?.id ?? null, alreadyTransferred: true };
        }
      }

      const title = input.title?.trim() || edit.title || "Edited media";

      // Measure the real file rather than trusting the render columns.  Every
      // publisher reads `processed_drive_file_id || drive_file_id`, and
      // rules-engine.getValidActions gates each platform action on an EXACT
      // string match of aspect_ratio — a stale or rounded value here silently
      // removes every publish action from the asset.
      let width: number | null = edit.rendered_width ?? null;
      let height: number | null = edit.rendered_height ?? null;
      let fileSize: number | null = edit.rendered_file_size ?? null;
      const durationSeconds: number | null =
        edit.rendered_duration_ms != null ? Math.round(edit.rendered_duration_ms / 1000) : null;

      /**
       * Branch on what the worker ACTUALLY produced, never on `edit.kind`.
       *
       * A photo draft with background music renders as an MP4 — a still frame
       * wrapped with the audio — so `kind` stays 'image' while the file is
       * video/mp4. Keying the re-measure off `kind` would download the whole
       * video only for sharp to throw on it, and would label it image/jpeg.
       */
      const renderedIsImage = edit.rendered_mime_type
        ? edit.rendered_mime_type.startsWith("image/")
        : edit.kind === "image" && edit.rendered_duration_ms == null;

      let mimeType: string =
        edit.rendered_mime_type || (renderedIsImage ? "image/jpeg" : "video/mp4");

      if (renderedIsImage) {
        try {
          const buffer = await downloadFile(
            edit.rendered_drive_file_id,
            edit.brand_id,
            profile.org_id
          );
          const meta = await sharp(buffer).metadata();
          if (meta.width && meta.height) {
            width = meta.width;
            height = meta.height;
          }
          fileSize = buffer.length;
          if (meta.format === "png") mimeType = "image/png";
          else if (meta.format === "webp") mimeType = "image/webp";
          else if (meta.format === "jpeg" || meta.format === "jpg") mimeType = "image/jpeg";
        } catch (e: any) {
          // A Drive hiccup must not strand the user with an un-transferable
          // render; fall back to what the worker measured at render time.
          console.warn(`[editor] transfer ${input.id}: could not re-measure:`, e?.message);
        }
      }

      if (!width || !height) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The rendered file has no usable dimensions",
        });
      }

      const aspectRatio = reduceRatio(width, height);

      const { data: group, error: groupError } = await db
        .from("media_groups")
        .insert({
          brand_id: edit.brand_id,
          uploaded_by: profile.id,
          title,
          caption: null,
          description: null,
          tags: [],
          notes: null,
          variant_count: 1,
          status: "available",
        })
        .select()
        .single();

      if (groupError) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: groupError.message });
      }

      const fileName = `${fileSafe(title, "edit")}-${aspectRatio.replace(":", "x")}.${extensionFor(mimeType)}`;

      const { data: asset, error: assetError } = await db
        .from("media_assets")
        .insert({
          group_id: group.id,
          // BOTH ids point at the rendered file.  processed_* is what the
          // publishers prefer; drive_file_id is what the media proxy and every
          // "original" code path reads.  A new row, never a mutation of the
          // source asset.
          drive_file_id: edit.rendered_drive_file_id,
          processed_drive_file_id: edit.rendered_drive_file_id,
          file_name: fileName,
          file_type: mimeType,
          // Nullable INTEGER in the schema: an unknown size stays unknown
          // rather than becoming a zero-byte claim.
          file_size: fileSize ?? null,
          width,
          height,
          aspect_ratio: aspectRatio,
          duration_seconds: durationSeconds,
          sort_order: 0,
          metadata: {
            source: "editor",
            editId: edit.id,
            // Exactly one of these is set. An Editor-uploaded original has no
            // media_assets row of its own and lives only in Drive Originals,
            // so the Drive id is the only way back to it.
            ...(edit.source_asset_id ? { sourceAssetId: edit.source_asset_id } : {}),
            ...(edit.source_drive_file_id
              ? {
                  sourceDriveFileId: edit.source_drive_file_id,
                  sourceFileName: edit.source_file_name,
                }
              : {}),
            ratio: edit.rendered_aspect_ratio || aspectRatio,
            ...(edit.preview_thumb ? { thumbnail: edit.preview_thumb } : {}),
          },
        })
        .select()
        .single();

      if (assetError) {
        // Do not leave an empty group in the library.
        await db.from("media_groups").delete().eq("id", group.id);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: assetError.message });
      }

      const { error: linkError } = await db
        .from("media_edits")
        .update({ transferred_asset_id: asset.id, updated_at: new Date().toISOString() })
        .eq("id", edit.id)
        .eq("brand_id", edit.brand_id);

      if (linkError) {
        console.warn(`[editor] transfer ${input.id}: could not link asset:`, linkError.message);
      }

      return { asset, groupId: group.id, alreadyTransferred: false };
    }),

  // ── Templates ─────────────────────────────────────────────────────────────
  listTemplates: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId);

      const { data, error } = await db
        .from("editor_templates")
        .select("*")
        .eq("brand_id", input.brandId)
        .order("created_at", { ascending: false });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data ?? [];
    }),

  saveTemplate: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        name: z.string().min(1).max(120),
        docFromEditId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId, { write: true });

      const edit = await loadOwned(
        db,
        profile,
        "media_edits",
        input.docFromEditId,
        "id, brand_id, kind, doc, preview_thumb",
        { write: true }
      );
      if (edit.brand_id !== input.brandId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That draft belongs to a different brand",
        });
      }

      // Strips base.assetId / crop / trim / overlay, which are source-specific.
      const templateDoc = toTemplate(parseDoc(edit.doc));

      const { data, error } = await db
        .from("editor_templates")
        .insert({
          brand_id: input.brandId,
          name: input.name.trim(),
          kind: edit.kind,
          doc: templateDoc,
          doc_version: templateDoc.version,
          thumb: edit.preview_thumb ?? null,
          created_by: profile.id,
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  applyTemplateToDraft: protectedProcedure
    .input(
      z.object({
        templateId: z.string().uuid(),
        draftId: z.string().uuid(),
        ratio: z.enum(RATIO_KEYS as [RatioKey, ...RatioKey[]]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const draft = await loadOwned(
        db,
        profile,
        "media_edits",
        input.draftId,
        `id, brand_id, kind, render_status, ${DRAFT_SOURCE_COLUMNS}`,
        { write: true }
      );
      const template = await loadOwned(
        db,
        profile,
        "editor_templates",
        input.templateId,
        "id, brand_id, kind, doc"
      );

      if (template.brand_id !== draft.brand_id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "That template belongs to a different brand",
        });
      }
      if (template.kind !== "any" && template.kind !== draft.kind) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `That template is for ${template.kind} drafts`,
        });
      }

      // Works for an Editor upload and a library asset alike, and throws if the
      // draft has no source at all.
      const resolved = await resolveDraftSource(db, draft);

      // The template's stored crop refers to the OLD source, so applyTemplate
      // recomputes it from the real dimensions of THIS draft's media.
      const nextDoc = applyTemplate(
        parseDoc(template.doc, "template"),
        {
          assetId: resolved.assetId,
          kind: draft.kind,
          source: resolved.source,
          durationSeconds: resolved.durationSeconds,
        },
        input.ratio
      );

      const { data, error } = await db
        .from("media_edits")
        .update({
          doc: nextDoc,
          doc_version: nextDoc.version,
          // applyTemplate clears the overlay: the rasterised PNG belongs to the
          // old layer stack and frame.
          overlay_drive_file_id: null,
          // The document definitely changed, so any existing render is stale and
          // must not stay transferable.  rendered_* columns are left in place.
          ...(draft.render_status === "ready" ? { render_status: "idle" } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", draft.id)
        .eq("brand_id", draft.brand_id)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  deleteTemplate: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(db, profile, "editor_templates", input.id, "id, brand_id", {
        write: true,
      });

      const { error } = await db
        .from("editor_templates")
        .delete()
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true, id: input.id };
    }),

  // ── Sticker packs ─────────────────────────────────────────────────────────
  listStickerPacks: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId);

      const { data: packs, error: packError } = await db
        .from("sticker_packs")
        .select("*")
        .eq("brand_id", input.brandId)
        .order("created_at", { ascending: false });

      if (packError) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: packError.message });
      }
      if (!packs?.length) return [];

      // Two queries rather than an embedded select: ordering an embedded
      // relation needs a supabase-js-version-specific option name, and the
      // sticker order inside a pack is load-bearing for the picker.
      const { data: stickers, error: stickerError } = await db
        .from("stickers")
        .select("*")
        .eq("brand_id", input.brandId)
        .in(
          "pack_id",
          packs.map((p: any) => p.id)
        )
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });

      if (stickerError) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: stickerError.message });
      }

      const byPack = new Map<string, any[]>();
      for (const sticker of stickers ?? []) {
        const list = byPack.get(sticker.pack_id) ?? [];
        list.push(sticker);
        byPack.set(sticker.pack_id, list);
      }

      return packs.map((pack: any) => ({ ...pack, stickers: byPack.get(pack.id) ?? [] }));
    }),

  createStickerPack: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        name: z.string().min(1).max(120),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId, { write: true });

      const { data, error } = await db
        .from("sticker_packs")
        .insert({
          brand_id: input.brandId,
          name: input.name.trim(),
          created_by: profile.id,
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { ...data, stickers: [] };
    }),

  deleteSticker: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(db, profile, "stickers", input.id, "id, brand_id, pack_id", {
        write: true,
      });

      const { error } = await db
        .from("stickers")
        .delete()
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true, id: input.id, packId: existing.pack_id };
    }),

  // ── Audio library ─────────────────────────────────────────────────────────
  listAudio: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId);

      const { data, error } = await db
        .from("audio_tracks")
        .select("*")
        .eq("brand_id", input.brandId)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data ?? [];
    }),

  /**
   * Import the audio from an Instagram reel/post into this brand's track
   * library.
   *
   * Nothing is fetched here. ffmpeg and ffprobe exist only in the `worker` and
   * `dev` images (the production `app` stage in the Dockerfile installs
   * neither), so extraction CANNOT happen in a route handler or a tRPC
   * mutation. This creates the row in `importing`, hands the worker an id, and
   * returns immediately; the Music panel polls `listAudio` for the outcome.
   *
   * The URL is validated by `parseInstagramMediaUrl`, not by a substring match.
   * This mutation causes the SERVER to fetch on the user's behalf, so accepting
   * an arbitrary URL would make it a general-purpose fetch-anything endpoint
   * reachable by any brand editor.
   */
  importAudioFromUrl: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        url: z.string().min(1).max(MAX_INSTAGRAM_URL_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await requireBrand(db, profile, input.brandId, { write: true });

      const parsed = parseInstagramMediaUrl(input.url);
      if (!parsed.ok) {
        throw new TRPCError({ code: "BAD_REQUEST", message: parsed.reason });
      }

      const { data: track, error } = await db
        .from("audio_tracks")
        .insert({
          brand_id: input.brandId,
          name: instagramTrackName(parsed.value.shortcode),
          // No Drive file yet — migration 00043 made the column nullable for
          // exactly this state, and its check constraint still forbids a
          // 'ready' row without one.
          drive_file_id: null,
          import_status: "importing",
          // Canonical, so the `?igsh=` tracking parameters on a share link are
          // not what gets stored.
          source_url: parsed.value.canonicalUrl,
          created_by: profile.id,
        })
        .select("*")
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      try {
        // ID ONLY. The worker re-reads source_url — see getAudioImportQueue().
        await getAudioImportQueue().add(
          `audio-import-${track.id}`,
          { trackId: track.id },
          { jobId: `audio-import-${track.id}` }
        );
      } catch (e: any) {
        const message = e?.message || "Could not queue the audio import";
        // Leave the row behind rather than deleting it: the panel shows failed
        // rows with their reason and a way to remove them, and a row that
        // vanished would look like the paste silently did nothing.
        const { data: failed } = await db
          .from("audio_tracks")
          .update({
            import_status: "failed",
            import_error: message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", track.id)
          .eq("brand_id", input.brandId)
          .select("*")
          .single();
        return failed ?? { ...track, import_status: "failed", import_error: message };
      }

      return track;
    }),

  deleteAudio: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const existing = await loadOwned(db, profile, "audio_tracks", input.id, "id, brand_id", {
        write: true,
      });

      const { error } = await db
        .from("audio_tracks")
        .delete()
        .eq("id", input.id)
        .eq("brand_id", existing.brand_id);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true, id: input.id };
    }),
});
