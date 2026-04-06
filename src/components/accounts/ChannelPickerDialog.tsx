"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, CheckCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";

interface ChannelPickerDialogProps {
  pendingId: string;
  platform: string;
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

export function ChannelPickerDialog({
  pendingId,
  platform,
  open,
  onClose,
  onConnected,
}: ChannelPickerDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading, error } = trpc.socialAccounts.getPendingChannels.useQuery(
    { pendingId },
    { enabled: open && !!pendingId }
  );

  const connectMutation = trpc.socialAccounts.connectSelectedChannels.useMutation({
    onSuccess: (result) => {
      toast.success(`Connected ${result.connected} ${platform} account${result.connected > 1 ? "s" : ""}`);
      onConnected();
    },
    onError: (err) => toast.error(err.message),
  });

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!data) return;
    if (selectedIds.size === data.channels.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(data.channels.map((ch) => ch.id)));
    }
  };

  const platformLabel = platform.charAt(0).toUpperCase() + platform.slice(1);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select {platformLabel} Accounts</DialogTitle>
          <DialogDescription>
            Multiple {platform === "instagram" ? "pages/accounts" : platform === "youtube" ? "channels" : "pages"} were
            found. Choose which ones to connect.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="py-4 text-sm text-destructive text-center">
            {error.message}
          </div>
        )}

        {data && (
          <div className="space-y-3">
            {data.channels.length > 2 && (
              <button
                onClick={selectAll}
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              >
                {selectedIds.size === data.channels.length ? "Deselect all" : "Select all"}
              </button>
            )}

            <div className="max-h-64 overflow-y-auto space-y-2">
              {data.channels.map((ch) => (
                <label
                  key={ch.id}
                  className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-zinc-50 transition-colors"
                >
                  <Checkbox
                    checked={selectedIds.has(ch.id)}
                    onCheckedChange={() => toggle(ch.id)}
                  />
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {ch.thumbnail && (
                      <img
                        src={ch.thumbnail}
                        alt=""
                        className="h-8 w-8 rounded-full object-cover"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{ch.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">ID: {ch.id}</p>
                    </div>
                  </div>
                  {selectedIds.has(ch.id) && (
                    <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={connectMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => connectMutation.mutate({
              pendingId,
              selectedChannelIds: Array.from(selectedIds),
            })}
            disabled={selectedIds.size === 0 || connectMutation.isPending}
          >
            {connectMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : null}
            Connect {selectedIds.size > 0 ? `(${selectedIds.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
