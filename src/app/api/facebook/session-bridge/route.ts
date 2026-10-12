import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/supabase/db";
import { encrypt } from "@/lib/encryption";
import { FB_BRIDGE_EXTENSION_ID } from "@/lib/fb-bridge-config";
import { bridgeCookies, validateBridgeCookies, type BridgeResult } from "@/server/services/facebook/session-bridge-validation";

export const runtime = "nodejs";

const extensionOrigin = `chrome-extension://${FB_BRIDGE_EXTENSION_ID}`;

function isAllowed(request: Request) {
  return request.headers.get("host") === "localhost:3010" && request.headers.get("origin") === extensionOrigin;
}

function response(body: object, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": extensionOrigin,
      Vary: "Origin",
    },
  });
}

export async function OPTIONS(request: Request) {
  if (!isAllowed(request)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": extensionOrigin,
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}

async function readBody(request: Request) {
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 16_000) {
      await reader.cancel();
      throw new Error("Request too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { cookies?: unknown; state?: unknown };
}

/** Extension-only local receiver. A one-time opaque capability authorizes one
 * saved session; raw Facebook cookies never pass through the Settings page. */
export async function POST(request: Request) {
  if (!isAllowed(request)) return response({ status: "forbidden" }, 403);
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return response({ status: "unpaired" }, 401);
  if (request.headers.get("content-type") !== "application/json") return response({ status: "invalid_request" }, 400);

  try {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const db = getDb();
    const { data: bridge, error: bridgeError } = await db
      .from("fb_session_bridges")
      .select("session_id,org_id,enabled,expires_at,last_attempt_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (bridgeError) return response({ status: "error" }, 503);
    if (!bridge?.enabled || Date.parse(bridge.expires_at) <= Date.now()) return response({ status: "unpaired" }, 401);

    let input: { cookies?: unknown; state?: unknown };
    try {
      input = await readBody(request);
    } catch {
      return response({ status: "invalid_request" }, 400);
    }

    if (input.state === "demand") {
      const { data: session, error: sessionError } = await db
        .from("fb_sessions")
        .select("status,last_checked_at")
        .eq("id", bridge.session_id)
        .eq("org_id", bridge.org_id)
        .maybeSingle();
      const { error: heartbeatError } = await db
        .from("fb_session_bridges")
        .update({ last_contact_at: new Date().toISOString() })
        .eq("token_hash", tokenHash)
        .eq("enabled", true);
      if (sessionError || heartbeatError) return response({ status: "error" }, 503);
      const shouldSync = session?.status === "dead" && (!bridge.last_attempt_at ||
        (session.last_checked_at && Date.parse(session.last_checked_at) > Date.parse(bridge.last_attempt_at)));
      return response({ status: "listening", shouldSync: !!shouldSync });
    }

    if (input.state === "stop") {
      const { error } = await db
        .from("fb_session_bridges")
        .update({ enabled: false, status: "stopped", run_id: null, lease_until: null })
        .eq("token_hash", tokenHash);
      return response({ status: error ? "error" : "stopped" }, error ? 503 : 200);
    }

    if (!(typeof input.cookies === "string" || ["login_required", "account_mismatch", "error"].includes(String(input.state)))) {
      return response({ status: "invalid_request" }, 400);
    }

    const runId = randomUUID();
    const { data: claimed, error: claimError } = await db.rpc("fb_bridge_claim", { p_hash: tokenHash, p_run: runId });
    if (claimError) return response({ status: "error" }, 503);
    if (!claimed?.length) return response({ status: "busy" }, 409);

    const expectedUser = claimed[0].expected_user as string;
    const cookies = typeof input.cookies === "string" ? bridgeCookies(input.cookies, expectedUser) : null;
    const status: BridgeResult = typeof input.cookies === "string"
      ? cookies ? await validateBridgeCookies(cookies, expectedUser) : "account_mismatch"
      : input.state as BridgeResult;
    const { data: committed, error: commitError } = await db.rpc("fb_bridge_complete", {
      p_hash: tokenHash,
      p_run: runId,
      p_status: status,
      p_encrypted: status === "fresh" && cookies ? encrypt(cookies) : null,
    });
    if (commitError) return response({ status: "error" }, 503);
    if (!committed) return response({ status: "unpaired" }, 401);
    return response({ status });
  } catch {
    return response({ status: "error" }, 503);
  }
}
