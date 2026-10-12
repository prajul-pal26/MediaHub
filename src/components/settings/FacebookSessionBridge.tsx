"use client";

import { useState } from "react";
import { Link2, Loader2, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc/client";
import { FB_BRIDGE_EXTENSION_ID } from "@/lib/fb-bridge-config";

type Session = { id: string; label: string | null; c_user: string | null };
type BridgeReply = { state?: string };
type Runtime = {
  sendMessage(id: string, message: unknown, callback: (reply?: BridgeReply) => void): void;
  lastError?: { message?: string };
};

const localOrigins = new Set(["http://localhost:3010", "https://localhost:3443"]);
const messages: Record<string, string> = {
  available: "Chrome bridge is ready.",
  fresh: "Chrome session validated and synced.",
  waiting: "Waiting for Chrome to complete the sync.",
  running: "Chrome is validating the Facebook session.",
  login_required: "Facebook needs a login or verification in Chrome.",
  account_mismatch: "The logged-in Chrome account does not match this saved session.",
  app_unreachable: "Chrome cannot reach local MediaHub.",
  unpaired: "Pair this saved session with Chrome first.",
  busy: "A sync is already in progress. Please wait a moment.",
  stopped: "Chrome session syncing is stopped.",
  error: "Facebook did not validate the Chrome session. The previous saved session was kept.",
};

function sendToBridge(message: unknown): Promise<BridgeReply> {
  const runtime = (window as Window & { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  if (!runtime || !localOrigins.has(window.location.origin)) {
    return Promise.reject(new Error("Open local MediaHub Settings in the Chrome profile with the MediaHub Facebook bridge installed."));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Chrome did not respond. Check that the MediaHub Facebook bridge is enabled.")),
      35_000,
    );
    runtime.sendMessage(FB_BRIDGE_EXTENSION_ID, message, (reply) => {
      window.clearTimeout(timer);
      if (runtime.lastError || !reply) reject(new Error("The MediaHub Facebook bridge is not available in this Chrome profile."));
      else resolve(reply);
    });
  });
}

/**
 * Lets a local Chrome extension refresh an existing saved session. The page
 * never sees Facebook cookies: the extension sends its cookie bundle directly
 * to the protected localhost receiver after an account-bound pairing.
 */
export function FacebookSessionBridge({ sessions }: { sessions: Session[] }) {
  const utils = trpc.useUtils();
  const statusQuery = trpc.fbSessionBridge.status.useQuery(undefined, { refetchInterval: 5_000 });
  const [busySession, setBusySession] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const refresh = async () => {
    await Promise.all([
      utils.fbSessionBridge.status.invalidate(),
      utils.fbSession.listFbSessions.invalidate(),
    ]);
  };

  const sync = async (session: Session) => {
    if (!session.c_user) {
      setNotice("This saved session has no Facebook account ID. Add a fresh session once before enabling Chrome sync.");
      return;
    }
    setBusySession(session.id);
    setNotice("");
    try {
      const available = await sendToBridge({ action: "ping" });
      if (available.state !== "available") throw new Error(messages[available.state ?? ""] ?? "Chrome bridge is unavailable.");
      const paired = (statusQuery.data ?? []).find((bridge) =>
        bridge.session_id === session.id && bridge.enabled && Date.parse(bridge.expires_at) > Date.now(),
      );
      if (paired) {
        const result = await sendToBridge({ action: "sync", sessionId: session.id });
        setNotice(messages[result.state ?? ""] ?? "Chrome session sync requested.");
      } else {
        const pairing = await utils.client.fbSessionBridge.pair.mutate({
          sessionId: session.id,
          expectedUser: session.c_user,
        });
        try {
          const result = await sendToBridge({ action: "pair", pairing });
          setNotice(messages[result.state ?? ""] ?? "Chrome session pairing started.");
        } catch (error) {
          await utils.client.fbSessionBridge.stop.mutate({ sessionId: session.id });
          throw error;
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not start Chrome session sync.");
    } finally {
      await refresh();
      setBusySession(null);
    }
  };

  const stop = async (sessionId: string) => {
    setBusySession(sessionId);
    setNotice("");
    try {
      await utils.client.fbSessionBridge.stop.mutate({ sessionId });
      await sendToBridge({ action: "stop", sessionId }).catch(() => undefined);
      setNotice(messages.stopped);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not stop Chrome session sync.");
    } finally {
      await refresh();
      setBusySession(null);
    }
  };

  const pairedBySession = new Map((statusQuery.data ?? []).map((bridge) => [bridge.session_id, bridge]));

  return (
    <section className="rounded-lg border bg-muted/20 p-3 space-y-2" aria-label="Automatic Facebook session sync">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Refresh from Chrome</h3>
          <p className="text-xs text-muted-foreground">One click refreshes the matching saved session from the Facebook login already open in this Chrome profile. Cookies are never shown or pasted into MediaHub.</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {sessions.filter((session) => session.c_user).map((session) => {
          const bridge = pairedBySession.get(session.id);
          const syncing = busySession === session.id;
          return (
            <div key={session.id} className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
              <span className="max-w-44 truncate text-xs">{session.label || `Facebook ${session.c_user}`}</span>
              <Button size="sm" variant="outline" onClick={() => sync(session)} disabled={!!busySession}>
                {syncing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Link2 className="mr-1.5 h-3.5 w-3.5" />}
                {bridge?.enabled ? "Sync from Chrome" : "Connect Chrome"}
              </Button>
              {bridge?.enabled && (
                <Button size="sm" variant="ghost" onClick={() => stop(session.id)} disabled={!!busySession} aria-label={`Stop Chrome sync for ${session.label || "Facebook session"}`}>
                  <Unplug className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {statusQuery.error ? <p className="text-xs text-destructive">Chrome sync status is unavailable: {statusQuery.error.message}</p> : null}
      {notice ? <p className="text-xs" role="status">{notice}</p> : null}
    </section>
  );
}
