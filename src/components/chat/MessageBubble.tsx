"use client";

import { cn } from "@/lib/utils";
import { User, Bot, Wrench } from "lucide-react";

interface MessageBubbleProps {
  role: string;
  content: string;
  metadata?: any;
  isLoading?: boolean;
}

export function MessageBubble({ role, content, metadata, isLoading }: MessageBubbleProps) {
  if (role === "tool_call" || role === "tool_result") return null; // Hidden from UI

  const isUser = role === "user";

  return (
    <div className={cn("flex gap-3", isUser ? "flex-row-reverse" : "flex-row")}>
      <div className={cn(
        "h-8 w-8 rounded-full flex items-center justify-center shrink-0",
        isUser ? "bg-primary text-primary-foreground" : "bg-zinc-200 text-zinc-600"
      )}>
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>

      <div className={cn(
        "max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
        isUser
          ? "bg-primary text-primary-foreground rounded-tr-md"
          : "bg-white border border-zinc-200 text-zinc-800 rounded-tl-md shadow-sm"
      )}>
        {isLoading ? (
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "0ms" }} />
            <div className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "150ms" }} />
            <div className="h-2 w-2 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: "300ms" }} />
          </div>
        ) : (
          <div className="whitespace-pre-wrap">{content}</div>
        )}

        {metadata?.toolsUsed?.length > 0 && (
          <div className="flex items-center gap-1 mt-2 pt-2 border-t border-zinc-100">
            <Wrench className="h-3 w-3 text-zinc-400" />
            <span className="text-[10px] text-zinc-400">
              Used: {metadata.toolsUsed.join(", ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
