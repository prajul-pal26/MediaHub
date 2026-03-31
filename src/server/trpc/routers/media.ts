import { z } from "zod";
import { router, protectedProcedure, assertBrandAccess } from "../index";
import { TRPCError } from "@trpc/server";
import { uploadFile, deleteFile } from "@/server/services/drive/client";

export const mediaRouter = router({
  // List media groups with pagination
  list: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid().optional(),
        search: z.string().optional(),
        type: z.enum(["image", "video", "all"]).default("all"),
        status: z.string().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const brandId = input.brandId || profile.brand_id;
      if (brandId) {
        assertBrandAccess(profile, brandId);
      }
      const offset = (input.page - 1) * input.limit;

      let query = db
        .from("media_groups")
        .select("*, media_assets(*)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(offset, offset + input.limit - 1);

      // Filter by brand based on role
      if (brandId) {
        query = query.eq("brand_id", brandId);
      } else {
        // Fetch org brands and filter by them
        const { data: orgBrands } = await db.from("brands").select("id").eq("org_id", profile.org_id);
        const orgBrandIds = (orgBrands || []).map((b: any) => b.id);
        if (orgBrandIds.length > 0) {
          query = query.in("brand_id", orgBrandIds);
        } else {
          // No brands in org — return empty
          return { groups: [], total: 0, page: input.page, limit: input.limit, totalPages: 0 };
        }
      }

      if (input.search) {
        query = query.or(
          `title.ilike.%${input.search}%,caption.ilike.%${input.search}%`
        );
      }

      if (input.status) {
        query = query.eq("status", input.status);
      }

      const { data, error, count } = await query;

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });

      // Filter by type if specified
      let groups = data || [];
      if (input.type !== "all") {
        groups = groups.filter((g: any) => {
          const assets = g.media_assets || [];
          if (assets.length === 0) return true;
          const firstType = assets[0].file_type || "";
          return input.type === "image"
            ? firstType.startsWith("image/")
            : firstType.startsWith("video/");
        });
      }

      return {
        groups,
        total: count || 0,
        page: input.page,
        limit: input.limit,
        totalPages: Math.ceil((count || 0) / input.limit),
      };
    }),

  // Get a single media group with all assets
  get: protectedProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      const { data, error } = await db
        .from("media_groups")
        .select("*, media_assets(*)")
        .eq("id", input.groupId)
        .single();

      if (error || !data) throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });
      assertBrandAccess(profile, data.brand_id);
      return data;
    }),

  // Create a media group
  createGroup: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        title: z.string().min(1).max(200),
        caption: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("media_groups")
        .insert({
          brand_id: input.brandId,
          uploaded_by: profile.id,
          title: input.title,
          caption: input.caption || null,
          description: input.description || null,
          tags: input.tags || [],
          notes: input.notes || null,
          variant_count: 0,
          status: "available",
        })
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  // Add a variant (file) to a media group
  addVariant: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        brandId: z.string().uuid(),
        driveFileId: z.string(),
        fileName: z.string(),
        fileType: z.string(),
        fileSize: z.number(),
        width: z.number().optional(),
        height: z.number().optional(),
        aspectRatio: z.string().optional(),
        durationSeconds: z.number().optional(),
        taggedPlatform: z.enum(["instagram", "youtube", "linkedin", "facebook", "tiktok", "twitter", "snapchat"]).optional(),
        taggedAccountId: z.string().uuid().optional(),
        taggedAction: z.enum(["post", "reel", "short", "story", "video", "carousel", "article"]).optional(),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      assertBrandAccess(profile, input.brandId);

      const { data: asset, error: assetError } = await db
        .from("media_assets")
        .insert({
          group_id: input.groupId,
          drive_file_id: input.driveFileId,
          file_name: input.fileName,
          file_type: input.fileType,
          file_size: input.fileSize,
          width: input.width || null,
          height: input.height || null,
          aspect_ratio: input.aspectRatio || null,
          duration_seconds: input.durationSeconds || null,
          tagged_platform: input.taggedPlatform || null,
          tagged_account_id: input.taggedAccountId || null,
          tagged_action: input.taggedAction || null,
          sort_order: input.sortOrder,
        })
        .select()
        .single();

      if (assetError) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: assetError.message });

      // Update variant count
      const { data: group } = await db
        .from("media_assets")
        .select("id", { count: "exact" })
        .eq("group_id", input.groupId);

      await db
        .from("media_groups")
        .update({ variant_count: group?.length || 1 })
        .eq("id", input.groupId);

      return asset;
    }),

  // Update media group details
  updateGroup: protectedProcedure
    .input(
      z.object({
        groupId: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        caption: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      const { groupId, ...updates } = input;

      // Verify brand access via the group
      const { data: group } = await db
        .from("media_groups")
        .select("brand_id")
        .eq("id", groupId)
        .single();

      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });
      assertBrandAccess(profile, group.brand_id);

      const { data, error } = await db
        .from("media_groups")
        .update(updates)
        .eq("id", groupId)
        .select()
        .single();

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data;
    }),

  // Delete a media group and all its variants from Drive
  deleteGroup: protectedProcedure
    .input(z.object({ groupId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get all assets to delete from Drive
      const { data: group } = await db
        .from("media_groups")
        .select("brand_id, media_assets(drive_file_id)")
        .eq("id", input.groupId)
        .single();

      if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "Media group not found" });
      assertBrandAccess(profile, group.brand_id);

      if (group) {
        // Delete files from Drive (best effort)
        for (const asset of group.media_assets || []) {
          try {
            await deleteFile(asset.drive_file_id, group.brand_id, profile.org_id);
          } catch {
            // Continue even if Drive delete fails
          }
        }
      }

      // Cascade deletes media_assets
      const { error } = await db
        .from("media_groups")
        .delete()
        .eq("id", input.groupId);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return { success: true };
    }),

  // Remove a single variant
  removeVariant: protectedProcedure
    .input(z.object({ assetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Get asset info before deleting
      const { data: asset } = await db
        .from("media_assets")
        .select("group_id, drive_file_id, group:media_groups(brand_id)")
        .eq("id", input.assetId)
        .single();

      if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
      assertBrandAccess(profile, asset.group?.brand_id);

      // Delete from Drive
      try {
        await deleteFile(asset.drive_file_id, asset.group?.brand_id, profile.org_id);
      } catch {
        // Continue
      }

      // Delete from DB
      await db.from("media_assets").delete().eq("id", input.assetId);

      // Update variant count
      const { data: remaining } = await db
        .from("media_assets")
        .select("id", { count: "exact" })
        .eq("group_id", asset.group_id);

      await db
        .from("media_groups")
        .update({ variant_count: remaining?.length || 0 })
        .eq("id", asset.group_id);

      return { success: true };
    }),

  // Search media
  search: protectedProcedure
    .input(
      z.object({
        brandId: z.string().uuid(),
        query: z.string().min(1),
      })
    )
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      const { data, error } = await db
        .from("media_groups")
        .select("*, media_assets(*)")
        .eq("brand_id", input.brandId)
        .or(
          `title.ilike.%${input.query}%,caption.ilike.%${input.query}%`
        )
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
      return data || [];
    }),

  // Get stats for a brand
  getStats: protectedProcedure
    .input(z.object({ brandId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      assertBrandAccess(profile, input.brandId);

      // Media counts
      const { data: groups } = await db
        .from("media_groups")
        .select("id, variant_count")
        .eq("brand_id", input.brandId);

      const all = groups || [];
      const totalMedia = all.reduce((sum: number, g: any) => sum + (g.variant_count || 0), 0);

      // Publish job counts (each action+account = 1 publish)
      const { data: jobs, error: jobsErr } = await db
        .from("publish_jobs")
        .select("status, content_posts!inner(brand_id)")
        .eq("content_posts.brand_id", input.brandId);

      const allJobs = jobsErr ? [] : (jobs || []);

      return {
        total: totalMedia,
        groups: all.length,
        published: allJobs.filter((j: any) => j.status === "completed").length,
        scheduled: allJobs.filter((j: any) => j.status === "queued" || j.status === "processing").length,
        failed: allJobs.filter((j: any) => j.status === "failed" || j.status === "dead").length,
      };
    }),
});
