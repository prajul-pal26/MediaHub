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
  AlertTriangle,
  Trash2,
  Plus,
  Loader2,
  RefreshCw,
  Pencil,
  Activity,
} from "lucide-react";

/** Inline Facebook glyph (lucide dropped brand icons). */
export function FacebookGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z" />
    </svg>
  );
}

/** The two cookies that actually matter — used for the paste-quality hint. */
function inspectCookieBundle(raw: string): { cUser: string | null; hasXs: boolean; count: number } {
  const text = raw.trim();
  return {
    cUser: /c_user=(\d+)/.exec(text)?.[1] ?? null,
    hasXs: /\bxs=/.test(text),
    count: text.split(/;\s*/).filter((p) => p.includes("=")).length,
  };
}

/**
 * The cookie slots we ask for by name. `c_user` + `xs` are the two the server
 * enforces (see assertUsableCookies); the rest are optional but make a session
 * look like a real browser and survive longer.
 */
const COOKIE_FIELDS = [
  {
    name: "c_user",
    required: true,
    hint: "Your numeric account ID",
    placeholder: "61577402775322",
  },
  {
    name: "xs",
    required: true,
    hint: "The session secret — this is what actually logs you in",
    placeholder: "26:dGh5lgFSD_Rjgg:2:1784762497:-1:-1::Acze…",
  },
  {
    name: "datr",
    required: false,
    hint: "Browser fingerprint — helps avoid re-checkpoints",
    placeholder: "Gqs-amvSkNvGpbkKJ6Y6SLlu",
  },
  {
    name: "sb",
    required: false,
    hint: "Secure-browsing token",
    placeholder: "Gqs-angIO8n2kTN5fgkGvKlD",
  },
  {
    name: "fr",
    required: false,
    hint: "Optional — sent by most logged-in browsers",
    placeholder: "1yJI5x0uTqxna5oWZ.AWdzzsVA3VyN0Xc…",
  },
] as const;

type CookieValues = Record<string, string>;

const EMPTY_COOKIES: CookieValues = { c_user: "", xs: "", datr: "", sb: "", fr: "" };

/** Assemble the per-field values back into the `k=v; k=v` string the server wants. */
function buildCookieString(values: CookieValues): string {
  return COOKIE_FIELDS.map((f) => [f.name, values[f.name]?.trim() ?? ""] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Accept a full pasted bundle in any field and split it across the slots, so
 * pasting the whole `document.cookie` string still works — it just fills the
 * boxes instead of forcing the user to hand-separate the values.
 */
function explodeCookieString(raw: string): CookieValues | null {
  if (!/=/.test(raw) || !/;|c_user=/.test(raw)) return null;
  let text = raw.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const pairs = Array.isArray(parsed)
        ? parsed.map((c: any) => `${c.name}=${c.value}`)
        : Object.entries(parsed as Record<string, string>).map(([k, v]) => `${k}=${v}`);
      text = pairs.join("; ");
    } catch {
      /* fall through and treat as a raw string */
    }
  }
  const out: CookieValues = { ...EMPTY_COOKIES };
  let matched = 0;
  for (const part of text.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k in out) {
      out[k] = v;
      matched++;
    }
  }
  return matched ? out : null;
}

/** The labelled cookie boxes, shared by the add and replace dialogs. */
function CookieFields({
  values,
  onChange,
}: {
  values: CookieValues;
  onChange: (next: CookieValues) => void;
}) {
  const setField = (name: string, raw: string) => {
    // A full bundle pasted into any one box fans out across all of them.
    const exploded = explodeCookieString(raw);
    if (exploded) {
      onChange({ ...values, ...exploded });
      toast.success("Pasted bundle split across the fields");
      return;
    }
    onChange({ ...values, [name]: raw });
  };

  return (
    <div className="space-y-3">
      {COOKIE_FIELDS.map((f) => {
        const filled = !!values[f.name]?.trim();
        return (
          <div key={f.name} className="space-y-1">
            <div className="flex items-center gap-2">
              <label
                htmlFor={`fb-cookie-${f.name}`}
                className="font-mono text-xs font-semibold w-16 shrink-0"
              >
                {f.name}
              </label>
              {f.required ? (
                <Badge variant={filled ? "secondary" : "destructive"} className="text-[10px]">
                  {filled ? "✓ set" : "required"}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  {filled ? "✓ set" : "optional"}
                </Badge>
              )}
            </div>
            <Input
              id={`fb-cookie-${f.name}`}
              value={values[f.name] ?? ""}
              onChange={(e) => setField(f.name, e.target.value)}
              placeholder={f.placeholder}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">{f.hint}</p>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Facebook session manager — lives in Settings, mirroring InstagramSessions.
 * Saved cookie bundles are consumed server-side by the Facebook scraper stack
 * (mbasic, GraphQL, and browser paths all read from here).
 */
export function FacebookSessions() {
  const [addOpen, setAddOpen] = useState(false);
  const [addFields, setAddFields] = useState<CookieValues>({ ...EMPTY_COOKIES });
  const [pasteLabel, setPasteLabel] = useState("");
  const pasteCookies = buildCookieString(addFields);

  const [refreshFor, setRefreshFor] = useState<{ id: string; label: string } | null>(null);
  const [refreshFields, setRefreshFields] = useState<CookieValues>({ ...EMPTY_COOKIES });
  const refreshCookies = buildCookieString(refreshFields);

  const [renameFor, setRenameFor] = useState<{ id: string; label: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [checkingId, setCheckingId] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const sessionsQuery = trpc.fbSession.listFbSessions.useQuery();
  const sessions = sessionsQuery.data ?? [];

  const invalidate = () => {
    utils.fbSession.listFbSessions.invalidate();
    utils.fbScraper.capabilities.invalidate();
  };

  const saveMutation = trpc.fbSession.saveFbSession.useMutation({
    onSuccess: () => {
      toast.success("Facebook session saved");
      setAddOpen(false);
      setAddFields({ ...EMPTY_COOKIES });
      setPasteLabel("");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteMutation = trpc.fbSession.deleteFbSession.useMutation({
    onSuccess: () => {
      toast.success("Session removed");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const checkMutation = trpc.fbSession.checkFbSession.useMutation({
    onSuccess: (d) => {
      d.ok ? toast.success(d.message) : toast.error(d.message);
      setCheckingId(null);
      invalidate();
    },
    onError: (e) => {
      toast.error(e.message);
      setCheckingId(null);
    },
  });

  const refreshMutation = trpc.fbSession.refreshFbSession.useMutation({
    onSuccess: () => {
      toast.success("Cookies replaced — session reactivated");
      setRefreshFor(null);
      setRefreshFields({ ...EMPTY_COOKIES });
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const renameMutation = trpc.fbSession.renameFbSession.useMutation({
    onSuccess: () => {
      toast.success("Session renamed");
      setRenameFor(null);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const pasted = inspectCookieBundle(pasteCookies);
  const pastedRefresh = inspectCookieBundle(refreshCookies);
  const liveCount = sessions.filter((s) => s.status === "active").length;

  return (
    <Card>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-[#1877F2] flex items-center justify-center text-white shrink-0">
              <FacebookGlyph className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold">Facebook Sessions</h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
                Saved cookie bundles that power the Facebook scraper — posts, comments, replies,
                reactors, profiles and groups. Facebook rotates these, so dead ones are flagged
                automatically.
              </p>
            </div>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" /> Add session
            </Button>
          </div>
        </div>

        {sessionsQuery.isLoading ? (
          <div className="h-10 rounded-lg bg-muted/60 animate-pulse" />
        ) : sessions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No sessions yet. Add your Facebook cookie bundle (
            <code className="text-xs">c_user</code> + <code className="text-xs">xs</code>) to enable
            scraping.
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
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
                      : [
                          s.c_user ? `user ${s.c_user}` : null,
                          s.last_checked_at
                            ? `checked ${new Date(s.last_checked_at).toLocaleString()}`
                            : `added ${new Date(s.created_at).toLocaleDateString()}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </p>
                </div>
                <Badge variant={s.status === "active" ? "secondary" : "outline"} className="capitalize">
                  {s.status}
                </Badge>
                <button
                  type="button"
                  onClick={() => {
                    setCheckingId(s.id);
                    checkMutation.mutate({ id: s.id });
                  }}
                  disabled={checkingId === s.id}
                  className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  aria-label="Test session"
                  title="Test if this session is still live"
                >
                  {checkingId === s.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Activity className="h-4 w-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRefreshFor({ id: s.id, label: s.label || "session" });
                    setRefreshFields({ ...EMPTY_COOKIES });
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Replace cookies"
                  title="Paste fresh cookies into this session"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenameFor({ id: s.id, label: s.label || "" });
                    setRenameValue(s.label || "");
                  }}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Rename session"
                  title="Rename"
                >
                  <Pencil className="h-4 w-4" />
                </button>
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
            {liveCount === 0 && (
              <p className="text-xs text-destructive">
                No live sessions — every Facebook scrape will fail until you add or refresh one.
              </p>
            )}
          </div>
        )}

        <div className="flex items-start gap-2 text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded-md p-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Use a <strong>throwaway</strong> account. Scraping violates Facebook&apos;s Terms of
            Service and accounts can be checkpointed or banned. Cookies grant full access to that
            account — treat them like a password.
          </span>
        </div>
      </CardContent>

      {/* Add-session dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" /> Add a Facebook session
            </DialogTitle>
            <DialogDescription>
              In Chrome, log into Facebook → <strong>F12 → Application → Cookies →
              https://www.facebook.com</strong>. Copy each value into the matching box below.
              You can also paste the whole cookie string into any one box — it will split itself
              across the fields.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
            <Input
              placeholder="Label (e.g. the account name)"
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
            />
            <CookieFields values={addFields} onChange={setAddFields} />
            {pasteCookies.trim() && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={pasted.cUser ? "secondary" : "destructive"}>
                  c_user {pasted.cUser ? `✓ ${pasted.cUser}` : "missing"}
                </Badge>
                <Badge variant={pasted.hasXs ? "secondary" : "destructive"}>
                  xs {pasted.hasXs ? "✓" : "missing"}
                </Badge>
                <Badge variant="outline">{pasted.count} cookies</Badge>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                saveMutation.mutate({ cookies: pasteCookies, label: pasteLabel || undefined })
              }
              disabled={saveMutation.isPending || !pasted.cUser || !pasted.hasXs}
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

      {/* Refresh-cookies dialog */}
      <Dialog open={!!refreshFor} onOpenChange={(open) => !open && setRefreshFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5" /> Replace cookies
            </DialogTitle>
            <DialogDescription>
              Fresh cookies for <strong>{refreshFor?.label}</strong>. This updates the session
              in place and reactivates it, keeping its scrape history intact.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 max-h-[55vh] overflow-y-auto pr-1">
            <CookieFields values={refreshFields} onChange={setRefreshFields} />
            {refreshCookies.trim() && (
              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant={pastedRefresh.cUser ? "secondary" : "destructive"}>
                  c_user {pastedRefresh.cUser ? `✓ ${pastedRefresh.cUser}` : "missing"}
                </Badge>
                <Badge variant={pastedRefresh.hasXs ? "secondary" : "destructive"}>
                  xs {pastedRefresh.hasXs ? "✓" : "missing"}
                </Badge>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRefreshFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                refreshFor && refreshMutation.mutate({ id: refreshFor.id, cookies: refreshCookies })
              }
              disabled={refreshMutation.isPending || !pastedRefresh.cUser || !pastedRefresh.hasXs}
            >
              {refreshMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
                </>
              ) : (
                "Replace cookies"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={!!renameFor} onOpenChange={(open) => !open && setRenameFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" /> Rename session
            </DialogTitle>
            <DialogDescription>Give this session a name you&apos;ll recognize.</DialogDescription>
          </DialogHeader>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameFor(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => renameFor && renameMutation.mutate({ id: renameFor.id, label: renameValue })}
              disabled={renameMutation.isPending || !renameValue.trim()}
            >
              {renameMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
