"use client";

import { cn } from "@/lib/utils";
import { CheckCircle2, Circle, Lock } from "lucide-react";
import { PLATFORM_RULES } from "@/server/services/media/rules-engine";

interface Account {
  id: string;
  platform: string;
  platform_username: string;
}

interface PublishedCombo {
  action: string;
  accountId: string;
}

interface AccountSelectorProps {
  accounts: Record<string, Account[]>;
  selectedAccountIds: string[];
  selectedActions: string[];
  onToggle: (accountId: string) => void;
  publishedCombos?: PublishedCombo[];
}

const platformColors: Record<string, string> = {
  instagram: "border-pink-200 bg-pink-50",
  youtube: "border-red-200 bg-red-50",
  linkedin: "border-blue-200 bg-blue-50",
};

export function AccountSelector({
  accounts,
  selectedAccountIds,
  selectedActions,
  onToggle,
  publishedCombos = [],
}: AccountSelectorProps) {
  if (selectedActions.length === 0) return null;

  // Check if a specific action+account is already published
  function isDone(action: string, accountId: string): boolean {
    return publishedCombos.some((pc) => pc.action === action && pc.accountId === accountId);
  }

  // Get accounts for a platform
  function getAccounts(platform: string): Account[] {
    return accounts[platform] || [];
  }

  // No accounts at all?
  const hasAnyAccounts = selectedActions.some((a) => {
    const rule = PLATFORM_RULES[a];
    return rule && (accounts[rule.platform]?.length || 0) > 0;
  });

  if (!hasAnyAccounts) {
    return (
      <p className="text-sm text-muted-foreground">
        No connected accounts for selected platforms. Connect accounts in the Accounts page.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {selectedActions.map((actionKey) => {
        const rule = PLATFORM_RULES[actionKey];
        if (!rule) return null;

        const actionAccounts = getAccounts(rule.platform);
        if (actionAccounts.length === 0) return null;

        return (
          <div key={actionKey}>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              {rule.label}
            </p>
            <div className="flex flex-wrap gap-2">
              {actionAccounts.map((account) => {
                const isSelected = selectedAccountIds.includes(account.id);
                const alreadyDone = isDone(actionKey, account.id);

                if (alreadyDone) {
                  return (
                    <div
                      key={`${actionKey}-${account.id}`}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-md border border-green-200 bg-green-50 text-green-600 opacity-60 cursor-not-allowed"
                    >
                      <Lock className="h-3 w-3" />
                      @{account.platform_username || "unknown"}
                      <span className="text-[10px]">— already published</span>
                    </div>
                  );
                }

                return (
                  <button
                    key={`${actionKey}-${account.id}`}
                    onClick={() => onToggle(account.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-2 text-xs rounded-md border transition-colors",
                      isSelected
                        ? platformColors[rule.platform] || "border-primary bg-primary/5"
                        : "border-input bg-background hover:bg-accent"
                    )}
                  >
                    {isSelected ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Circle className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    @{account.platform_username || "unknown"}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
