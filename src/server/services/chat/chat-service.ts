import { getDb } from "@/lib/supabase/db";
import { chatCompletion } from "@/lib/llm";
import { buildSystemPrompt } from "./system-prompt";
import { getToolsForRole } from "./tools";
import { executeTool } from "./executor";

interface UserContext {
  userId: string;
  role: string;
  brandId: string;
  orgId: string;
  name: string;
}

export async function processMessage(
  conversationId: string,
  userMessage: string,
  ctx: UserContext
): Promise<{ message: string; toolsUsed: string[] }> {
  const db = getDb();

  // Load conversation history (last 50 messages)
  const { data: history } = await db
    .from("chat_messages")
    .select("role, content, metadata")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(50);

  // Build messages array — keep last 10 full, compress older ones to save tokens
  const allHistory = (history || []).map((m: any) => {
    if (m.role === "tool_call") {
      return { role: "assistant", content: null, tool_calls: m.metadata?.tool_calls || [] };
    }
    if (m.role === "tool_result") {
      return { role: "tool", tool_call_id: m.metadata?.tool_call_id, content: m.content };
    }
    return { role: m.role, content: m.content };
  });

  const KEEP_FULL = 10;
  let messages: any[];

  if (allHistory.length > KEEP_FULL) {
    // Compress older messages: keep only user/assistant text messages, truncate content
    const older = allHistory.slice(0, -KEEP_FULL);
    const recent = allHistory.slice(-KEEP_FULL);

    const summary = older
      .filter((m: any) => m.role === "user" || (m.role === "assistant" && m.content))
      .map((m: any) => `${m.role}: ${(m.content || "").slice(0, 80)}`)
      .join("\n");

    messages = [
      { role: "user", content: `[Previous conversation summary]\n${summary}\n[End summary]` },
      { role: "assistant", content: "Understood, I have context from our earlier conversation." },
      ...recent,
    ];
  } else {
    messages = allHistory;
  }

  messages.push({ role: "user", content: userMessage });

  // Get brand info for system prompt
  let brand = null;
  if (ctx.brandId) {
    const { data } = await db.from("brands").select("id, name").eq("id", ctx.brandId).single();
    brand = data;
  }

  const systemPrompt = buildSystemPrompt({ name: ctx.name, role: ctx.role }, brand);
  const tools = getToolsForRole(ctx.role);
  const toolsUsed: string[] = [];

  // Agentic loop
  let response;
  let loopCount = 0;
  const MAX_LOOPS = 10;

  while (loopCount < MAX_LOOPS) {
    loopCount++;

    response = await chatCompletion({
      systemPrompt,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      orgId: ctx.orgId,
      userId: ctx.userId,
      brandId: ctx.brandId,
    });

    const choice = response.choices?.[0];
    if (!choice) break;

    // Tool calls
    if (choice.finish_reason === "tool_calls" || choice.message?.tool_calls?.length) {
      const toolCalls = choice.message.tool_calls || [];

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: choice.message.content || null,
        tool_calls: toolCalls,
      });

      // Execute each tool
      for (const tc of toolCalls) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {}

        const result = await executeTool(tc.function.name, args, ctx);
        toolsUsed.push(tc.function.name);

        // Save tool call to DB
        await db.from("chat_messages").insert({
          conversation_id: conversationId,
          role: "tool_call",
          content: `Called ${tc.function.name}`,
          metadata: { tool_calls: [tc] },
        });

        await db.from("chat_messages").insert({
          conversation_id: conversationId,
          role: "tool_result",
          content: JSON.stringify(result),
          metadata: { tool_call_id: tc.id },
        });

        // Add to messages for next LLM call
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      }

      continue; // Loop back to LLM with tool results
    }

    // No tool calls — final response
    break;
  }

  const assistantMessage = response?.choices?.[0]?.message?.content || "I couldn't generate a response.";

  // Save user message
  await db.from("chat_messages").insert({
    conversation_id: conversationId,
    role: "user",
    content: userMessage,
  });

  // Save assistant response
  await db.from("chat_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: assistantMessage,
    metadata: {
      model: response?.model,
      usage: response?.usage,
      toolsUsed,
    },
  });

  // Update conversation
  const msgCount = (history?.length || 0) + 2;
  await db.from("chat_conversations").update({
    message_count: msgCount,
    last_message_at: new Date().toISOString(),
    title: msgCount <= 2 ? userMessage.slice(0, 80) : undefined,
  }).eq("id", conversationId);

  return { message: assistantMessage, toolsUsed };
}
