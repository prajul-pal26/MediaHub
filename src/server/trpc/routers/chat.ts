import { z } from "zod";
import { router, protectedProcedure } from "../index";
import { TRPCError } from "@trpc/server";
import { processMessage } from "@/server/services/chat/chat-service";
import { getLLMConfig, resolveLlmConfig } from "@/lib/llm";

export const chatRouter = router({
  getConfig: protectedProcedure
    .input(z.object({ brandId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const { profile } = ctx;
      // Use client-provided brandId (from brand switcher) or fall back to profile
      const brandId = input?.brandId || profile.brand_id;
      // Validate brand access if a specific brandId was provided
      if (input?.brandId) {
        const { assertBrandAccess } = await import("../index");
        assertBrandAccess(profile, input.brandId);
      }
      // Try multi-level resolution first (user > brand > org)
      const resolved = await resolveLlmConfig(profile.id, profile.org_id, brandId);
      if (resolved) return { configured: true, model: resolved.model };
      // Fall back to legacy platform_credentials
      const config = await getLLMConfig(profile.org_id);
      return { configured: config.configured, model: config.model };
    }),

  getConversations: protectedProcedure.query(async ({ ctx }) => {
    const { db, profile } = ctx;
    const { data } = await db
      .from("chat_conversations")
      .select("id, title, message_count, last_message_at, created_at")
      .eq("user_id", profile.id)
      .order("last_message_at", { ascending: false })
      .limit(50);
    return data || [];
  }),

  getMessages: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      // Verify ownership
      const { data: conv } = await db
        .from("chat_conversations")
        .select("user_id")
        .eq("id", input.conversationId)
        .single();

      if (!conv || conv.user_id !== profile.id) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const { data } = await db
        .from("chat_messages")
        .select("id, role, content, metadata, created_at")
        .eq("conversation_id", input.conversationId)
        .order("created_at", { ascending: true });

      return data || [];
    }),

  sendMessage: protectedProcedure
    .input(z.object({
      conversationId: z.string().uuid().optional(),
      message: z.string().min(1).max(5000),
      brandId: z.string().uuid().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;

      let conversationId = input.conversationId;
      const brandId = input.brandId || profile.brand_id || null;

      // Create new conversation if needed
      if (!conversationId) {
        const { data: conv, error } = await db
          .from("chat_conversations")
          .insert({
            user_id: profile.id,
            brand_id: brandId,
            title: input.message.slice(0, 80),
            message_count: 0,
          })
          .select()
          .single();

        if (error) {
          console.error("[chat] Conversation create error:", error);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
        }
        conversationId = conv.id;
      }

      // Process message through LLM
      try {
        const result = await processMessage(conversationId!, input.message, {
          userId: profile.id,
          role: profile.role,
          brandId: brandId || "",
          orgId: profile.org_id,
          name: profile.name,
        });

        return {
          conversationId,
          message: result.message,
          toolsUsed: result.toolsUsed,
        };
      } catch (e: any) {
        console.error("[chat.sendMessage] Error:", e.message);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: e.message });
      }
    }),

  deleteConversation: protectedProcedure
    .input(z.object({ conversationId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { db, profile } = ctx;
      await db
        .from("chat_conversations")
        .delete()
        .eq("id", input.conversationId)
        .eq("user_id", profile.id);
      return { success: true };
    }),
});
