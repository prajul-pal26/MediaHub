/**
 * Page size is fixed at 15/request, so the only remaining levers are pacing and
 * concurrency. Measure both, and watch for throttling rather than assuming.
 *
 * Test A — how low can sequential pacing go before Instagram pushes back?
 * Test B — does hitting DIFFERENT posts concurrently raise total throughput, or
 *          is the rate limit global per account (in which case it cannot)?
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
if (process.env.KEY_OVERRIDE) process.env.TOKEN_ENCRYPTION_KEY = process.env.KEY_OVERRIDE;

import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../../src/lib/encryption";
import { normalizeSession } from "../../src/server/services/instagram/fetcher";

const APP_UA =
  "Instagram 269.0.0.18.75 Android (26/8.0.0; 480dpi; 1080x1920; Xiaomi; MI 5s; capricorn; qcom; en_US)";

const POSTS = [
  "3964313285523919107",
  "3964137067496392667",
  "3963510110499812330",
  "3963452901268152213",
  "3962130802514507532",
];

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

let headers: Record<string, string>;

interface PageResult {
  ok: boolean;
  count: number;
  ms: number;
  status: number;
  throttled: boolean;
  cursor: string | null;
}

async function getPage(mediaId: string, cursor: string | null): Promise<PageResult> {
  const url = new URL(`https://www.instagram.com/api/v1/media/${mediaId}/comments/`);
  url.searchParams.set("can_support_threading", "true");
  url.searchParams.set("permalink_enabled", "false");
  if (cursor) url.searchParams.set("min_id", cursor);

  const t0 = Date.now();
  try {
    const res = await fetch(url.toString(), { headers, cache: "no-store" });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (text.trimStart().startsWith("<")) {
      return { ok: false, count: 0, ms, status: res.status, throttled: true, cursor: null };
    }
    const j: any = JSON.parse(text);
    const throttled =
      res.status === 429 || (typeof j?.message === "string" && /wait|try again|spam/i.test(j.message));
    const raw = j?.next_min_id ?? null;
    return {
      ok: !throttled,
      count: Array.isArray(j?.comments) ? j.comments.length : 0,
      ms,
      status: res.status,
      throttled,
      cursor: raw == null ? null : typeof raw === "string" ? raw : JSON.stringify(raw),
    };
  } catch (e: any) {
    return { ok: false, count: 0, ms: Date.now() - t0, status: 0, throttled: false, cursor: null };
  }
}

async function testPacing(mediaId: string, pacing: number, pages: number) {
  let cursor: string | null = null;
  let total = 0;
  let throttles = 0;
  const t0 = Date.now();
  for (let i = 0; i < pages; i++) {
    const r = await getPage(mediaId, cursor);
    if (r.throttled) {
      throttles++;
      console.log(`      ! throttled at page ${i + 1} (HTTP ${r.status})`);
      break;
    }
    total += r.count;
    if (!r.cursor) break;
    cursor = r.cursor;
    await new Promise((res) => setTimeout(res, pacing));
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `    ${String(pacing).padStart(4)}ms pacing: ${total} comments in ${secs.toFixed(1)}s = ${(total / secs).toFixed(1)}/sec, throttles=${throttles}`,
  );
  return { rate: total / secs, throttles };
}

async function testConcurrent(concurrency: number, pagesEach: number) {
  const targets = POSTS.slice(0, concurrency);
  const t0 = Date.now();
  const results = await Promise.all(
    targets.map(async (mediaId) => {
      let cursor: string | null = null;
      let total = 0;
      let throttles = 0;
      for (let i = 0; i < pagesEach; i++) {
        const r = await getPage(mediaId, cursor);
        if (r.throttled) {
          throttles++;
          break;
        }
        total += r.count;
        if (!r.cursor) break;
        cursor = r.cursor;
        await new Promise((res) => setTimeout(res, 1400));
      }
      return { total, throttles };
    }),
  );
  const secs = (Date.now() - t0) / 1000;
  const total = results.reduce((a, r) => a + r.total, 0);
  const throttles = results.reduce((a, r) => a + r.throttles, 0);
  console.log(
    `    concurrency ${concurrency}: ${total} comments in ${secs.toFixed(1)}s = ${(total / secs).toFixed(1)}/sec, throttles=${throttles}`,
  );
  return { rate: total / secs, throttles };
}

async function main() {
  const { data } = await db
    .from("insta_sessions")
    .select("session_id_encrypted")
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  const s = normalizeSession(decrypt(data!.session_id_encrypted));
  headers = {
    "User-Agent": APP_UA,
    "X-IG-App-ID": "936619743392459",
    Referer: "https://www.instagram.com/",
    Accept: "*/*",
    Cookie: s.cookie,
  };
  if (s.csrftoken) headers["x-csrftoken"] = s.csrftoken;

  console.log("TEST A — sequential pacing (12 pages each)\n");
  for (const pacing of [1400, 700, 350, 150, 0]) {
    await testPacing(POSTS[2], pacing, 12);
    await new Promise((r) => setTimeout(r, 6000)); // cool off between trials
  }

  console.log("\nTEST B — concurrency across different posts (8 pages each, 1400ms within each)\n");
  for (const c of [1, 3, 5]) {
    await testConcurrent(c, 8);
    await new Promise((r) => setTimeout(r, 8000));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
