"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MessageBubble } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { trpc } from "@/lib/trpc/client";
import { useBrand } from "@/lib/hooks/use-brand";
import { toast } from "sonner";
import { MessageSquare, Plus, Trash2, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { LlmStatusBadge } from "@/components/common/LlmStatusBadge";

export function ChatInterface() {
  const { activeBrandId } = useBrand();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { data: config } = trpc.chat.getConfig.useQuery();
  const { data: conversations = [], refetch: refetchConvs } = trpc.chat.getConversations.useQuery();
  const { data: messages = [], refetch: refetchMessages } = trpc.chat.getMessages.useQuery(
    { conversationId: conversationId! },
    { enabled: !!conversationId }
  );

  const sendMutation = trpc.chat.sendMessage.useMutation({
    onSuccess: (data) => {
      setConversationId(data.conversationId ?? null);
      refetchMessages();
      refetchConvs();
      setIsThinking(false);
    },
    onError: (error) => {
      toast.error(error.message);
      setIsThinking(false);
    },
  });

  const deleteMutation = trpc.chat.deleteConversation.useMutation({
    onSuccess: () => {
      if (conversationId) setConversationId(null);
      refetchConvs();
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isThinking]);

  function handleSend(message: string) {
    setIsThinking(true);
    sendMutation.mutate({
      conversationId: conversationId || undefined,
      message,
      brandId: activeBrandId || undefined,
    });
  }

  function startNewChat() {
    setConversationId(null);
  }

  if (!config?.configured) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-md">
          <AlertCircle className="h-12 w-12 mx-auto text-muted-foreground opacity-50" />
          <h2 className="text-lg font-semibold">Chat not configured</h2>
          <p className="text-sm text-muted-foreground">
            Ask your admin to set up the LLM provider (OpenRouter) in Settings → Platform Credentials.
          </p>
        </div>
      </div>
    );
  }

  // Visible messages (hide tool_call and tool_result)
  const visibleMessages = messages.filter((m: any) => m.role === "user" || m.role === "assistant");

  return (
    <div className="flex h-full">
      {/* Sidebar — conversation list */}
      {showSidebar && (
        <div className="w-64 border-r bg-white flex flex-col shrink-0">
          <div className="p-3 border-b">
            <Button size="sm" className="w-full" onClick={startNewChat}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New chat
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {conversations.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center p-4">No conversations yet</p>
            ) : (
              conversations.map((conv: any) => (
                <div
                  key={conv.id}
                  className={cn(
                    "flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-zinc-50 border-b border-zinc-100 group",
                    conversationId === conv.id && "bg-zinc-100"
                  )}
                  onClick={() => setConversationId(conv.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{conv.title || "Untitled"}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {conv.message_count} msg{conv.message_count !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMutation.mutate({ conversationId: conv.id });
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col bg-zinc-50">
        {/* Header with LLM status */}
        <div className="flex items-center justify-end px-4 py-2 border-b bg-white">
          <LlmStatusBadge />
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {visibleMessages.length === 0 && !isThinking ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground opacity-30" />
                <h3 className="font-medium text-muted-foreground">How can I help?</h3>
                <div className="grid gap-2 max-w-sm mx-auto">
                  {["Show me my media library", "What's in my queue?", "List my connected accounts"].map((q) => (
                    <button
                      key={q}
                      onClick={() => handleSend(q)}
                      className="text-xs text-left px-3 py-2 border rounded-lg hover:bg-white hover:shadow-sm transition-all text-muted-foreground"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <>
              {visibleMessages.map((msg: any) => (
                <MessageBubble
                  key={msg.id}
                  role={msg.role}
                  content={msg.content}
                  metadata={msg.metadata}
                />
              ))}
              {isThinking && (
                <MessageBubble role="assistant" content="" isLoading />
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        <ChatInput
          onSend={handleSend}
          loading={isThinking}
          disabled={!config?.configured}
        />
      </div>
    </div>
  );
}
