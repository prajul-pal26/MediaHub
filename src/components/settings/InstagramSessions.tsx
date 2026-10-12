"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import {
  CheckCircle2,
  XCircle,
  Key,
  AlertTriangle,
  Trash2,
  Plus,
  Loader2,
} from "lucide-react";

/** Inline Instagram glyph (lucide dropped brand icons). */
export function InstagramGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Instagram session manager — lives in Settings. Saved sessions are consumed
 * server-side by the /instagram fetcher (no session UI is shown there).
 */
export function InstagramSessions() {
  const [addOpen, setAddOpen] = useState(false);
  const [pasteSession, setPasteSession] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");

  const utils = trpc.useUtils();
  const sessionsQuery = trpc.instaFetcher.listSessions.useQuery();
  const sessions = sessionsQuery.data ?? [];

  const saveMutation = trpc.instaFetcher.saveSession.useMutation({
    onSuccess: () => {
      toast.success("Session saved");
      setAddOpen(false);
      setPasteSession("");
      setPasteLabel("");
      utils.instaFetcher.listSessions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.instaFetcher.deleteSession.useMutation({
    onSuccess: () => {
      toast.success("Session removed");
      utils.instaFetcher.listSessions.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const loginMutation = trpc.instaFetcher.login.useMutation({
    onSuccess: (d) => {
      if (d.ok) {
        toast.success(`Logged in as @${d.username} — session saved`);
        setLoginOpen(false);
        setLoginPass("");
        utils.instaFetcher.listSessions.invalidate();
      } else {
        toast.error(d.message);
      }
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] flex items-center justify-center text-white shrink-0">
              <InstagramGlyph className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Instagram Sessions</h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
                Saved logins that unlock followers/following &amp; full content in the Instagram
                fetcher. Instagram expires these — dead ones are flagged automatically.
              </p>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Add session
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLoginOpen(true)}>
              <Key className="h-4 w-4 mr-1.5" /> Login
            </Button>
          </div>
        </div>

        {sessionsQuery.isLoading ? (
          <div className="h-10 rounded-lg bg-muted/60 animate-pulse" />
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No sessions yet. Add your Instagram <code className="text-xs">sessionid</code> cookie to
            unlock followers &amp; following.
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s: any) => (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2"
              >
                {s.status === "active" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                ) : (
                  <XCircle className="h-4 w-4 text-destructive shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{s.label || "Unnamed session"}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {s.status === "dead" && s.last_error
                      ? s.last_error
                      : `Added ${new Date(s.created_at).toLocaleDateString()}`}
                  </p>
                </div>
                <Badge variant={s.status === "active" ? "secondary" : "outline"} className="capitalize">
                  {s.status}
                </Badge>
                <button
                  type="button"
                  onClick={() => deleteMutation.mutate({ id: s.id })}
                  className="text-muted-foreground hover:text-destructive transition-colors"
                  aria-label="Delete session"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-md p-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Use a <strong>throwaway</strong> account. Instagram blocks scripted logins, so pasting a
            session id from your browser is the reliable method. Scraping violates Instagram&apos;s
            ToS and accounts can be banned.
          </span>
        </div>
      </CardContent>

      {/* Add-session dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" /> Add a session
            </DialogTitle>
            <DialogDescription>
              Log into Instagram in your browser, then paste its complete Cookie header here. It must
              include <code className="text-xs">sessionid</code>; keeping <code className="text-xs">csrftoken</code> too
              lets MediaHub make the same authenticated request shape as the browser.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Label (e.g. the account username)"
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
            />
            <Input
              type="password"
              placeholder="Complete Cookie header (must include sessionid)"
              value={pasteSession}
              onChange={(e) => setPasteSession(e.target.value)}
              className="font-mono text-sm"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                saveMutation.mutate({ sessionId: pasteSession, label: pasteLabel || undefined })
              }
              disabled={saveMutation.isPending || !pasteSession.trim()}
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
                </>
              ) : (
                "Save session"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Login dialog */}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="h-5 w-5" /> Login to Instagram
            </DialogTitle>
            <DialogDescription>
              Instagram now blocks most scripted logins (you&apos;ll often get a checkpoint). If it
              fails, use <strong>Add session</strong> instead. Use a throwaway account.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Instagram username"
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              autoComplete="off"
            />
            <Input
              type="password"
              placeholder="Password"
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value)}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLoginOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => loginMutation.mutate({ username: loginUser, password: loginPass })}
              disabled={loginMutation.isPending || !loginUser || !loginPass}
            >
              {loginMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Logging in…
                </>
              ) : (
                "Login & Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
