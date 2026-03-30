"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { CheckCircle2 } from "lucide-react";
import type { ActionAvailability } from "@/server/services/media/rules-engine";

interface PublishedAction {
  action: string;
  accountId: string;
}

interface ActionSelectorProps {
  actions: ActionAvailability[];
  selectedActions: string[];
  onToggle: (actionKey: string) => void;
  publishedActions?: PublishedAction[];
}

export function ActionSelector({ actions, selectedActions, onToggle, publishedActions = [] }: ActionSelectorProps) {
  // Count how many accounts this action was already published to
  function getPublishedCount(actionKey: string): number {
    return publishedActions.filter((pa) => pa.action === actionKey).length;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => {
        const isSelected = selectedActions.includes(action.key);
        const publishedCount = getPublishedCount(action.key);
        const isFullyPublished = publishedCount > 0;

        // Unavailable action (wrong file type, duration, etc.)
        if (!action.available) {
          return (
            <Tooltip key={action.key}>
              <TooltipTrigger
                className="px-3 py-1.5 text-xs rounded-md border border-dashed border-muted text-muted-foreground line-through opacity-50 cursor-not-allowed"
              >
                {action.label}
              </TooltipTrigger>
              <TooltipContent>{action.reason}</TooltipContent>
            </Tooltip>
          );
        }

        // Already published to some accounts — still clickable for new accounts
        if (isFullyPublished && !isSelected) {
          return (
            <Tooltip key={action.key}>
              <TooltipTrigger
                className="px-3 py-1.5 text-xs rounded-md border font-medium bg-green-50 text-green-700 border-green-200 cursor-pointer hover:bg-green-100 transition-colors"
                onClick={() => onToggle(action.key)}
              >
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" />
                  {action.label}
                  <span className="text-[10px] opacity-70">({publishedCount})</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Already published to {publishedCount} account{publishedCount !== 1 ? "s" : ""}. Click to publish to additional accounts.
              </TooltipContent>
            </Tooltip>
          );
        }

        // Normal available action
        return (
          <button
            key={action.key}
            onClick={() => onToggle(action.key)}
            className={cn(
              "px-3 py-1.5 text-xs rounded-md border font-medium transition-colors",
              isSelected
                ? "bg-green-500 text-white border-green-500"
                : "bg-background text-foreground border-input hover:bg-accent"
            )}
          >
            {action.label}
            {isFullyPublished && (
              <CheckCircle2 className="inline h-3 w-3 ml-1" />
            )}
            {action.needsResize && isSelected && (
              <span className="ml-1 text-[10px] opacity-75">(resize)</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
