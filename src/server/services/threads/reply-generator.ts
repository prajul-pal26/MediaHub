import { chatCompletion } from "@/lib/llm";

export async function generateCommentReply(params: {
  comment: { text: string; author: string; platform: string; sentiment?: string };
  postCaption?: string;
  brandName: string;
  tone?: string;
  customInstructions?: string;
  userId: string;
  orgId: string;
  brandId: string;
}): Promise<string> {
  const systemPrompt = `You are a social media manager for ${params.brandName}.
Generate a ${params.tone || "friendly"} reply to a ${params.comment.platform} comment.
${params.customInstructions ? `Additional instructions: ${params.customInstructions}` : ""}
Keep the reply concise, authentic, and on-brand. Do not use hashtags in replies.
Reply in the same language as the comment.`;

  const messages = [
    {
      role: "user" as const,
      content: `Post caption: ${params.postCaption || "N/A"}
Comment by @${params.comment.author}: "${params.comment.text}"
Generate a reply:`,
    },
  ];

  const result = await chatCompletion({
    systemPrompt,
    messages,
    userId: params.userId,
    orgId: params.orgId,
    brandId: params.brandId,
  });

  return result.choices?.[0]?.message?.content?.trim() || "Thank you for your comment!";
}
