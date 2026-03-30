"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2 } from "lucide-react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ChatInput({ onSend, disabled, loading }: ChatInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Re-focus the input whenever loading finishes (LLM responded)
  useEffect(() => {
    if (!loading && !disabled) {
      textareaRef.current?.focus();
    }
  }, [loading, disabled]);

  function handleSubmit() {
    const trimmed = message.trim();
    if (!trimmed || disabled || loading) return;
    onSend(trimmed);
    setMessage("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  return (
    <div className="flex items-end gap-2 p-4 border-t bg-white">
      <Textarea
        ref={textareaRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about your media, schedule posts, check analytics..."
        className="min-h-[44px] max-h-[120px] resize-none"
        rows={1}
        disabled={disabled || loading}
      />
      <Button
        onClick={handleSubmit}
        disabled={!message.trim() || disabled || loading}
        size="sm"
        className="h-[44px] px-4"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
  );
}
