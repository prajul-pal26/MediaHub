"use client";

import { Badge } from "@/components/ui/badge";
import { Brain, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

const scopeLabels: Record<string, string> = {
  user: "Personal Key",
  brand: "Brand (via Org)",
  org: "Org Default",
};

export function LlmStatusBadge() {
  const { data: activeConfig, isLoading } = trpc.llm.getActiveConfig.useQuery(
    undefined,
    { refetchOnWindowFocus: false }
  );

  if (isLoading) {
    return (
      <Badge variant="outline" className="gap-1 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        LLM
      </Badge>
    );
  }

  if (!activeConfig) {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <Brain className="h-3 w-3" />
        No LLM
      </Badge>
    );
  }

  const label = scopeLabels[activeConfig.scope] || "LLM";

  return (
    <Badge variant="outline" className="gap-1 text-xs bg-green-50 text-green-700 border-green-200">
      <Brain className="h-3 w-3" />
      {label}
    </Badge>
  );
}
