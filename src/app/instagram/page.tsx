"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { useUser } from "@/lib/hooks/use-user";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/landing/lib/motion";
import { SURFACE } from "@/components/landing/lib/constants";
import { BrandLogo } from "@/components/common/BrandLogo";
import {
  Search,
  Loader2,
  CheckCircle2,
  Lock,
  MessageSquare,
  Link2,
  Download,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Users,
  Play,
} from "lucide-react";
import type { InstaMediaItem } from "@/server/services/instagram/fetcher";

const MAX_HANDLES = 3;
const MAX_TAGS = 5;

/** Item shape inferred from the hashtagFetch mutation result (no server import). */
type HashResults = NonNullable<
  ReturnType<typeof trpc.instaFetcher.hashtagFetch.useMutation>["data"]
>;
type HashItem = NonNullable<HashResults["results"][number]["items"]>[number];

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Rough fetch-time estimate: GraphQL serves ~50 followers/page with light
 *  anti-ban pacing → ~3.5s/page on average (request + gentle delay). */
function estFetchTime(limit: number): string {
  const secs = Math.round(Math.ceil(limit / 50) * 3.5);
  return secs < 90 ? `~${secs}s per account` : `~${Math.round(secs / 60)} min per account`;
}

/** Route Instagram CDN media through our proxy so it isn't hotlink-blocked. */
const mediaProxy = (url: string | null | undefined) =>
  url ? `/api/insta-media?url=${encodeURIComponent(url)}` : "";

const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors disabled:opacity-60 disabled:pointer-events-none";
const GHOST_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full border border-zinc-300 text-zinc-800 font-medium hover:bg-zinc-50 transition-colors";

type Mode = "profiles" | "trending";
type SortKey = "views" | "likes" | "comments" | "recent";
type TypeFilter = "all" | "reels" | "posts";

const SORT_LABEL: Record<SortKey, string> = {
  views: "Top views",
  likes: "Top likes",
  comments: "Top comments",
  recent: "Most recent",
};

export default function InstagramDemoPage() {
  const [mode, setMode] = useState<Mode>("profiles");

  // Logged-in studio users get the full fetcher (more handles, deeper limits,
  // auto-using their saved Instagram session). Anonymous visitors get the
  // rate-limited public demo. Either way there is NO session UI on this page —
  // sessions are managed in Settings → Instagram.
  const { profile } = useUser();
  const authed = !!profile;
  const maxHandles = authed ? 20 : MAX_HANDLES;

  // ── Profiles flow ──
  const [usernamesText, setUsernamesText] = useState("");
  const [includeFriends, setIncludeFriends] = useState(false);
  const [includeContent, setIncludeContent] = useState(false);
  const [friendsLimit, setFriendsLimit] = useState(1000);

  const demoFetch = trpc.instaFetcher.demoFetch.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const fullFetch = trpc.instaFetcher.fetchProfiles.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const parsed = usernamesText
    .split(/[\s,\n]+/)
    .map((u) => u.trim().replace(/^@/, ""))
    .filter(Boolean);

  const unique = Array.from(new Set(parsed.map((u) => u.toLowerCase())));
  const capped = unique.slice(0, maxHandles);
  const overCap = unique.length > maxHandles;

  const handleFetch = () => {
    if (capped.length === 0) {
      toast.error("Enter at least one Instagram username");
      return;
    }
    if (authed) {
      // No sessionDbId → server auto-resolves the org's active session.
      fullFetch.mutate({
        usernames: capped,
        includeFriends,
        includeContent,
        friendsLimit,
        contentLimit: 200,
      });
    } else {
      demoFetch.mutate({
        usernames: capped,
        includeFriends,
        includeContent,
      });
    }
  };

  const profilesPending = authed ? fullFetch.isPending : demoFetch.isPending;
  const results = (authed ? fullFetch.data?.results : demoFetch.data?.results) ?? [];

  // ── Trending flow ──
  const [tagsText, setTagsText] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");

  const hashtagFetch = trpc.instaFetcher.hashtagFetch.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const parsedTags = tagsText
    .split(/[\s,\n]+/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
  const uniqueTags = Array.from(new Set(parsedTags.map((t) => t.toLowerCase())));
  const cappedTags = uniqueTags.slice(0, MAX_TAGS);
  const overTagCap = uniqueTags.length > MAX_TAGS;

  const handleTrending = () => {
    if (cappedTags.length === 0) {
      toast.error("Enter at least one hashtag");
      return;
    }
    hashtagFetch.mutate({ tags: cappedTags });
  };

  const hashResults = hashtagFetch.data?.results ?? [];
  const hasSession = hashtagFetch.data?.hasSession ?? true;

  // Merge all items across tags, de-dupe by id, filter by type, sort desc.
  const trendingItems = (() => {
    const seen = new Set<string>();
    const merged: (HashItem & { sourceTag: string })[] = [];
    for (const r of hashResults) {
      if (!r.ok || !r.items) continue;
      for (const it of r.items) {
        const key = it.id || it.shortcode;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ ...it, sourceTag: r.tag });
      }
    }
    const filtered = merged.filter((it) => {
      if (typeFilter === "reels") return it.kind === "reel";
      if (typeFilter === "posts") return it.kind !== "reel";
      return true;
    });
    filtered.sort((a, b) => {
      if (sortKey === "recent") return (b.takenAt ?? 0) - (a.takenAt ?? 0);
      if (sortKey === "likes") return b.likes - a.likes;
      if (sortKey === "comments") return b.comments - a.comments;
      return (b.views ?? 0) - (a.views ?? 0); // views
    });
    return filtered;
  })();

  const tagErrors = hashResults.filter((r) => !r.ok);
  const usedTags = hashResults.filter((r) => r.ok).map((r) => r.tag);

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[#f7f8fc] text-zinc-700">
      {/* Studio-light background — white with a soft indigo tint at the top */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 15% -10%, rgba(99,102,241,0.10), transparent 55%)," +
            "radial-gradient(110% 70% at 90% -5%, rgba(129,140,248,0.08), transparent 55%)," +
            "linear-gradient(180deg, #eef1fb 0%, #f7f8fc 45%, #ffffff 100%)",
        }}
      />

      {/* ── Top bar ── */}
      <header className="sticky top-0 z-30 border-b border-zinc-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <BrandLogo hideWordmarkOnMobile />
          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/"
              className="hidden rounded-full px-3 py-2 text-sm text-zinc-600 transition-colors hover:text-zinc-900 sm:inline-flex"
            >
              ← Back
            </Link>
            <Link href="/api/studio-enter" className={cn(PRIMARY_BTN, "px-4 py-2 text-sm")}>
              Enter the studio
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-24 pt-14 sm:px-6 sm:pt-20">
        {/* ── Hero-lite header ── */}
        <Reveal>
          <p className={cn(SURFACE.kicker, "mb-4")}>Live Demo</p>
          <h1 className="font-display text-5xl uppercase leading-[0.92] tracking-tight text-zinc-900 sm:text-7xl">
            Instagram
            <br />
            <span className="text-indigo-600">Intelligence</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-zinc-600">
            Point us at any public handle, or chase a hashtag to see what&rsquo;s going viral —
            profile, engagement, followers and the full content library, instantly.
          </p>
        </Reveal>

        {/* ── Tool selector — two clean, prominent options ── */}
        <Reveal delay={0.05}>
          <div
            role="tablist"
            aria-label="Choose a tool"
            className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <ToolOption
              active={mode === "profiles"}
              onSelect={() => setMode("profiles")}
              icon={<Users className="h-5 w-5" />}
              title="Profile View"
              subtitle="Analyse any account — followers, following, content & downloads."
            />
            <ToolOption
              active={mode === "trending"}
              onSelect={() => setMode("trending")}
              icon={<span aria-hidden className="text-xl leading-none">🔥</span>}
              title="Trending Search"
              subtitle="Discover viral reels & posts by hashtag, ranked by views."
            />
          </div>
        </Reveal>

        {/* ══════════ PROFILES MODE ══════════ */}
        {mode === "profiles" && (
          <>
        {/* ── Search panel ── */}
        <Reveal delay={0.08}>
          <div className={cn(SURFACE.card, "mt-10 p-5 sm:p-7")}>
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="handles"
                className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500"
              >
                Handles to decode
              </label>
              <span
                className={cn(
                  "font-mono text-xs",
                  overCap ? "text-amber-600" : "text-zinc-500",
                )}
              >
                {capped.length}/{maxHandles}
              </span>
            </div>

            <textarea
              id="handles"
              value={usernamesText}
              onChange={(e) => setUsernamesText(e.target.value)}
              rows={2}
              placeholder="instagram, natgeo, nasa"
              className="mt-2.5 w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <p className="mt-2 text-xs text-zinc-500">
              Comma, space or newline separated — up to {maxHandles} accounts per run.
              {overCap && (
                <span className="text-amber-600">
                  {" "}
                  Only the first {maxHandles} will be analysed.
                </span>
              )}
            </p>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
              <Toggle
                checked={includeFriends}
                onChange={setIncludeFriends}
                label="Include followers & following"
              />
              <Toggle
                checked={includeContent}
                onChange={setIncludeContent}
                label="Include posts & reels"
              />
            </div>

            {authed && includeFriends && (
              <div className="mt-3 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
                <label
                  htmlFor="friendsLimit"
                  className="text-xs font-medium uppercase tracking-wide text-zinc-500"
                >
                  Followers to fetch
                </label>
                <select
                  id="friendsLimit"
                  value={friendsLimit}
                  onChange={(e) => setFriendsLimit(Number(e.target.value))}
                  className="h-9 w-fit rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                >
                  {[200, 500, 1000, 2000, 5000].map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString()} each
                    </option>
                  ))}
                </select>
                <span className="text-xs text-zinc-500">
                  ≈ {estFetchTime(friendsLimit)} · higher counts risk Instagram throttling
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={handleFetch}
              disabled={profilesPending}
              className={cn(PRIMARY_BTN, "mt-6 w-full px-6 py-3.5 text-base sm:w-auto")}
            >
              {profilesPending ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> Analysing…
                </>
              ) : (
                <>
                  <Search className="h-5 w-5" /> Analyse
                </>
              )}
            </button>
          </div>
        </Reveal>

        {/* ── Loading skeletons ── */}
        {profilesPending && (
          <div className="mt-8 space-y-4">
            {capped.map((u, i) => (
              <ProfileSkeleton key={u + i} />
            ))}
          </div>
        )}

        {/* ── Empty state ── */}
        {/* ── Results ── */}
        {!profilesPending && results.length > 0 && (
          <div className="mt-8 space-y-6">
            {results.map((r) =>
              r.ok && r.profile ? (
                <ProfileCard key={r.username} r={r} />
              ) : (
                <div
                  key={r.username}
                  className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4"
                >
                  <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                  <span className="text-sm text-zinc-700">
                    <strong className="text-zinc-900">@{r.username}</strong> — {r.error}
                  </span>
                </div>
              ),
            )}
          </div>
        )}
          </>
        )}

        {/* ══════════ TRENDING MODE ══════════ */}
        {mode === "trending" && (
          <>
            {/* ── Trending search panel ── */}
            <Reveal delay={0.08}>
              <div className={cn(SURFACE.card, "mt-10 p-5 sm:p-7")}>
                <div className="flex items-center justify-between gap-3">
                  <label
                    htmlFor="tags"
                    className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500"
                  >
                    Hashtags to chase
                  </label>
                  <span
                    className={cn(
                      "font-mono text-xs",
                      overTagCap ? "text-amber-600" : "text-zinc-500",
                    )}
                  >
                    {cappedTags.length}/{MAX_TAGS}
                  </span>
                </div>

                <textarea
                  id="tags"
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  rows={2}
                  placeholder="cmyogi, fitness, foodie"
                  className="mt-2.5 w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-2 text-xs text-zinc-500">
                  Comma, space or newline separated — the leading # is optional, up to {MAX_TAGS}{" "}
                  tags per run.
                  {overTagCap && (
                    <span className="text-amber-600">
                      {" "}
                      Only the first {MAX_TAGS} will be searched.
                    </span>
                  )}
                </p>

                <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end">
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="sort"
                      className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500"
                    >
                      Sort
                    </label>
                    <select
                      id="sort"
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    >
                      {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                        <option key={k} value={k}>
                          {SORT_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="type"
                      className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500"
                    >
                      Type
                    </label>
                    <select
                      id="type"
                      value={typeFilter}
                      onChange={(e) => setTypeFilter(e.target.value as TypeFilter)}
                      className="rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-900 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="all">All</option>
                      <option value="reels">Reels only</option>
                      <option value="posts">Posts only</option>
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleTrending}
                  disabled={hashtagFetch.isPending}
                  className={cn(PRIMARY_BTN, "mt-6 w-full px-6 py-3.5 text-base sm:w-auto")}
                >
                  {hashtagFetch.isPending ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin" /> Finding…
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5" /> Find trending
                    </>
                  )}
                </button>
              </div>
            </Reveal>

            {/* Session note */}
            {!hashtagFetch.isPending && hashtagFetch.data && !hasSession && (
              <div className="mt-6">
                <AmberNote>
                  A logged-in Instagram session is needed to search hashtags. Add one in the studio
                  to unlock trending discovery.
                </AmberNote>
              </div>
            )}

            {/* Loading skeletons */}
            {hashtagFetch.isPending && (
              <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <TrendingSkeleton key={i} />
                ))}
              </div>
            )}


            {/* Results */}
            {!hashtagFetch.isPending && hashtagFetch.data && (
              <div className="mt-8">
                {tagErrors.length > 0 && (
                  <div className="mb-4 space-y-2">
                    {tagErrors.map((r) => (
                      <AmberNote key={r.tag}>
                        <strong>#{r.tag}</strong> — {r.error}
                      </AmberNote>
                    ))}
                  </div>
                )}

                {trendingItems.length > 0 ? (
                  <>
                    <p className="mb-4 text-sm text-zinc-600">
                      Showing{" "}
                      <strong className="text-zinc-900">{trendingItems.length}</strong> trending
                      {typeFilter === "reels"
                        ? " reels"
                        : typeFilter === "posts"
                          ? " posts"
                          : " items"}
                      {usedTags.length > 0 && (
                        <> across {usedTags.map((t) => `#${t}`).join(" ")}</>
                      )}{" "}
                      — sorted by{" "}
                      <span className="font-medium text-indigo-600">{SORT_LABEL[sortKey]}</span>.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                      {trendingItems.map((it, i) => (
                        <TrendingCard
                          key={it.id || it.shortcode || i}
                          it={it}
                          tag={it.sourceTag}
                          sortKey={sortKey}
                        />
                      ))}
                    </div>
                  </>
                ) : (
                  tagErrors.length === 0 && (
                    <div className="flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 px-6 py-14 text-center">
                      <p className="font-display text-lg uppercase tracking-tight text-zinc-900">
                        No matching content
                      </p>
                      <p className="mt-2 max-w-sm text-sm text-zinc-600">
                        Nothing came back for this filter. Try another hashtag or switch the Type
                        filter to All.
                      </p>
                    </div>
                  )
                )}
              </div>
            )}
          </>
        )}

        {/* ── Footer CTA strip — only for anonymous visitors (studio upsell).
             Hidden for logged-in (god) users who are already in the studio. ── */}
        {!authed && (
          <Reveal>
            <div
              className={cn(
                SURFACE.card,
                "mt-16 flex flex-col items-start gap-5 p-7 sm:flex-row sm:items-center sm:justify-between sm:p-9",
              )}
            >
              <div>
                <p className="font-display text-2xl uppercase leading-tight tracking-tight text-zinc-900 sm:text-3xl">
                  Want the full studio?
                </p>
                <p className="mt-2 max-w-md text-sm text-zinc-600">
                  Scheduling, automation and cross-platform analytics — all in one control room.
                </p>
              </div>
              <Link href="/api/studio-enter" className={cn(PRIMARY_BTN, "shrink-0 px-6 py-3 text-base")}>
                Enter the studio <ChevronRight className="h-4 w-4" />
              </Link>
            </div>
          </Reveal>
        )}
      </main>
    </div>
  );
}

/* ─────────────────────── Tool option card ─────────────────────── */

function ToolOption({
  active,
  onSelect,
  icon,
  title,
  subtitle,
}: {
  active: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition-all sm:p-6",
        active
          ? "border-indigo-500 bg-indigo-50 shadow-[0_12px_32px_-16px_rgba(79,70,229,0.35)]"
          : "border-zinc-200 bg-white hover:border-indigo-300 hover:shadow-sm",
      )}
    >
      {/* Icon tile */}
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors",
          active
            ? "bg-indigo-600 text-white"
            : "bg-zinc-100 text-zinc-600 group-hover:bg-indigo-100 group-hover:text-indigo-600",
        )}
      >
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "font-display text-lg uppercase tracking-tight transition-colors",
            active ? "text-indigo-700" : "text-zinc-900",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "mt-1 block text-sm leading-snug",
            active ? "text-indigo-700/80" : "text-zinc-600",
          )}
        >
          {subtitle}
        </span>
      </span>

      {/* Selected indicator */}
      <span className="shrink-0 pt-0.5">
        {active ? (
          <CheckCircle2 className="h-5 w-5 text-indigo-600" />
        ) : (
          <span className="block h-5 w-5 rounded-full border-2 border-zinc-300 transition-colors group-hover:border-indigo-300" />
        )}
      </span>
    </button>
  );
}

/* ────────────────────────── Toggle ────────────────────────── */

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-full border px-4 py-2 text-sm transition-colors",
        checked
          ? "border-indigo-300 bg-indigo-50 text-indigo-700"
          : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-zinc-300 accent-indigo-600"
      />
      {label}
    </label>
  );
}

/* ────────────────────── Profile card ────────────────────── */

type FetchResult = NonNullable<
  ReturnType<typeof trpc.instaFetcher.demoFetch.useMutation>["data"]
>["results"][number];

function ProfileCard({ r }: { r: FetchResult }) {
  const p = r.profile!;
  return (
    <Reveal className={cn(SURFACE.card, "overflow-hidden p-5 sm:p-7")}>
      <div className="flex gap-4 sm:gap-5">
        {p.profilePic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaProxy(p.profilePic)}
            alt={p.username}
            className="h-16 w-16 shrink-0 rounded-full border border-zinc-200 object-cover sm:h-20 sm:w-20"
          />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border border-zinc-200 bg-zinc-50 sm:h-20 sm:w-20">
            <Users className="h-6 w-6 text-zinc-400" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`https://instagram.com/${p.username}`}
              target="_blank"
              rel="noreferrer"
              className="font-display text-xl uppercase tracking-tight text-zinc-900 hover:text-indigo-600"
            >
              @{p.username}
            </a>
            {p.isVerified && <CheckCircle2 className="h-4 w-4 text-sky-500" />}
            {p.isPrivate && (
              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600">
                <Lock className="h-3 w-3" /> Private
              </span>
            )}
            {p.isBusiness && (
              <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600">
                Business
              </span>
            )}
            {p.category && (
              <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600">
                {p.category}
              </span>
            )}
          </div>

          {p.fullName && <p className="mt-1 text-sm font-medium text-zinc-800">{p.fullName}</p>}
          {p.bio && (
            <p className="mt-1 whitespace-pre-line text-sm text-zinc-600">{p.bio}</p>
          )}
          {p.externalUrl && (
            <a
              href={p.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              <Link2 className="h-3 w-3" /> {p.externalUrl}
            </a>
          )}

          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Posts" value={fmt(p.postsCount)} />
            <Stat label="Followers" value={fmt(p.followers)} />
            <Stat label="Following" value={fmt(p.following)} />
            {p.engagementRate !== null && (
              <Stat label="Engagement" value={`${p.engagementRate}%`} highlight />
            )}
          </div>
        </div>
      </div>

      {/* Recent posts strip */}
      {p.recentPosts.length > 0 && (
        <div className="mt-6">
          <SectionLabel>Recent posts ({p.recentPosts.length})</SectionLabel>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {p.recentPosts.slice(0, 6).map((post) => (
              <div
                key={post.shortcode}
                className="group relative aspect-square overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50"
              >
                {post.isVideo && post.videoUrl ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    src={mediaProxy(post.videoUrl)}
                    poster={mediaProxy(post.thumbnail)}
                    controls
                    preload="none"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    className="block h-full w-full"
                  >
                    {post.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={mediaProxy(post.thumbnail)}
                        alt=""
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                      />
                    )}
                    {post.isVideo && (
                      <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] text-white">
                        <Play className="h-2.5 w-2.5" /> video
                      </span>
                    )}
                  </a>
                )}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <span>❤ {fmt(post.likes)}</span>
                  <span className="inline-flex items-center gap-0.5">
                    <MessageSquare className="h-3 w-3" /> {fmt(post.comments)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Full content library */}
      {(r.content || r.contentError) && (
        <div className="mt-6">
          <SectionLabel>
            Content
            {r.content ? ` (${r.content.length}${r.contentTruncated ? "+" : ""})` : ""}
          </SectionLabel>
          {r.contentError && <AmberNote>{r.contentError}</AmberNote>}
          {r.content && r.content.length > 0 && (
            <ContentGrid items={r.content} username={p.username} />
          )}
        </div>
      )}

      {/* Followers / following */}
      {(r.followers || r.following || r.friendsError) && (
        <div className="mt-6 space-y-2.5">
          {r.friendsError && <AmberNote>{r.friendsError}</AmberNote>}
          {r.followersQuality && r.followersQuality.sampled > 0 && (
            <AudienceQualityBar q={r.followersQuality} />
          )}
          {r.followers && (
            <FriendList title="Followers" users={r.followers} truncated={r.friendsTruncated} />
          )}
          {r.following && (
            <FriendList title="Following" users={r.following} truncated={r.friendsTruncated} />
          )}
        </div>
      )}

      {p.isPrivate && p.recentPosts.length === 0 && !r.friendsError && (
        <p className="mt-4 text-sm text-zinc-600">
          🔒 This account is private — posts and followers are not accessible.
        </p>
      )}
    </Reveal>
  );
}

/* ────────────────────── Small pieces ────────────────────── */

function AudienceQualityBar({
  q,
}: {
  q: {
    sampled: number;
    verifiedPct: number;
    privatePct: number;
    noPhotoPct: number;
    qualityScore: number;
    flags: string[];
  };
}) {
  const score = q.qualityScore;
  const tone = score >= 70 ? "text-emerald-600" : score >= 45 ? "text-amber-600" : "text-red-600";
  const bar = score >= 70 ? "bg-emerald-500" : score >= 45 ? "bg-amber-500" : "bg-red-500";
  const label = score >= 70 ? "Healthy" : score >= 45 ? "Mixed" : "Low-quality";
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Audience quality
        </span>
        <span className={cn("text-sm font-bold", tone)}>
          {score}/100 · {label}
        </span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
        <div className={cn("h-full rounded-full", bar)} style={{ width: `${score}%` }} />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
        <span>
          Sampled <strong className="text-zinc-900">{q.sampled}</strong>
        </span>
        <span>
          Verified <strong className="text-zinc-900">{q.verifiedPct}%</strong>
        </span>
        <span>
          Private <strong className="text-zinc-900">{q.privatePct}%</strong>
        </span>
        <span>
          No photo <strong className="text-zinc-900">{q.noPhotoPct}%</strong>
        </span>
      </div>
      <p className="mt-2 text-[11px] text-zinc-400">
        Estimated from a follower sample — a high “no photo / no name” share signals bot or
        throwaway accounts.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p
        className={cn(
          "font-display text-2xl uppercase leading-none tracking-tight",
          highlight ? "text-amber-600" : "text-zinc-900",
        )}
      >
        {value}
      </p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
        {label}
      </p>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2.5 font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500">
      {children}
    </p>
  );
}

function AmberNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-700">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {children}
    </p>
  );
}

function ProfileSkeleton() {
  return (
    <div className={cn(SURFACE.card, "p-5 sm:p-7")}>
      <div className="flex gap-5">
        <div className="h-16 w-16 shrink-0 animate-pulse rounded-full bg-zinc-100 sm:h-20 sm:w-20" />
        <div className="flex-1 space-y-3">
          <div className="h-5 w-40 animate-pulse rounded bg-zinc-100" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-100" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100" />
          <div className="flex gap-6 pt-1">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-8 w-14 animate-pulse rounded bg-zinc-100" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Content grid ────────────────────── */

const KIND_LABEL: Record<InstaMediaItem["kind"], string> = {
  post: "Post",
  video: "Video",
  reel: "Reel",
  carousel: "Carousel",
};

function ContentGrid({ items, username }: { items: InstaMediaItem[]; username: string }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
      {items.map((it, i) => {
        const downloadUrl = it.videoUrl ?? it.displayUrl;
        const downloadHref = downloadUrl
          ? `${mediaProxy(downloadUrl)}&dl=${encodeURIComponent(`${username}_${it.shortcode || i}`)}`
          : null;
        return (
          <div
            key={it.id || i}
            className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white"
          >
            <div className="relative aspect-square bg-zinc-100">
              {it.videoUrl ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={mediaProxy(it.videoUrl)}
                  poster={mediaProxy(it.displayUrl)}
                  controls
                  preload="none"
                  className="h-full w-full object-cover"
                />
              ) : it.displayUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaProxy(it.displayUrl)} alt="" className="h-full w-full object-cover" />
              ) : null}
              <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] text-white">
                {KIND_LABEL[it.kind]}
                {it.kind === "carousel" && it.carousel.length ? ` ·${it.carousel.length}` : ""}
              </span>
            </div>

            <div className="flex flex-1 flex-col gap-2 p-3">
              {it.caption && (
                <p className="line-clamp-2 text-xs text-zinc-600">{it.caption}</p>
              )}
              <div className="mt-auto flex items-center gap-3 text-xs text-zinc-500">
                <span>❤ {fmt(it.likes)}</span>
                <span className="inline-flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" /> {fmt(it.comments)}
                </span>
                {it.views !== null && (
                  <span className="inline-flex items-center gap-1">
                    <Play className="h-3 w-3" /> {fmt(it.views)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {downloadHref && (
                  <a
                    href={downloadHref}
                    className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 transition-colors hover:bg-zinc-50"
                  >
                    <Download className="h-3 w-3" /> Download
                  </a>
                )}
                {it.url && (
                  <a
                    href={it.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
                  >
                    <Link2 className="h-3 w-3" /> Open
                  </a>
                )}
              </div>
              {it.carousel.length > 1 && (
                <div className="flex flex-wrap gap-1.5 border-t border-zinc-200 pt-2">
                  {it.carousel.map((c, ci) => {
                    const cu = c.videoUrl ?? c.displayUrl;
                    return cu ? (
                      <a
                        key={ci}
                        href={`${mediaProxy(cu)}&dl=${encodeURIComponent(`${username}_${it.shortcode}_${ci + 1}`)}`}
                        className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-50"
                      >
                        {c.isVideo ? "▶" : "🖼"} {ci + 1}
                      </a>
                    ) : null;
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ────────────────────── Trending card ────────────────────── */

function TrendingSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="aspect-square animate-pulse bg-zinc-100" />
      <div className="space-y-2 p-3">
        <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-100" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-zinc-100" />
      </div>
    </div>
  );
}

function TrendingCard({
  it,
  tag,
  sortKey,
}: {
  it: HashItem;
  tag: string;
  sortKey: SortKey;
}) {
  const isVideo = (it.kind === "reel" || it.kind === "video") && !!it.videoUrl;
  const downloadUrl = it.videoUrl ?? it.displayUrl;
  const downloadHref = downloadUrl
    ? `${mediaProxy(downloadUrl)}&dl=${encodeURIComponent(`${tag}_${it.shortcode}`)}`
    : null;

  const stat = (active: boolean, base = "text-zinc-500") =>
    active ? "font-bold text-indigo-600" : base;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
      <div className="relative aspect-square bg-zinc-100">
        {isVideo ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={mediaProxy(it.videoUrl)}
            poster={mediaProxy(it.displayUrl)}
            controls
            muted
            preload="none"
            onMouseEnter={(e) => {
              const v = e.currentTarget;
              v.play().catch(() => {});
            }}
            onMouseLeave={(e) => {
              const v = e.currentTarget;
              v.pause();
            }}
            className="h-full w-full object-cover"
          />
        ) : it.displayUrl ? (
          <a href={it.url} target="_blank" rel="noreferrer" className="block h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaProxy(it.displayUrl)} alt="" className="h-full w-full object-cover" />
          </a>
        ) : null}

        <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">
          {KIND_LABEL[it.kind]}
          {it.kind === "carousel" && it.carousel.length ? ` ·${it.carousel.length}` : ""}
        </span>
        <span className="absolute right-1.5 top-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-indigo-700 shadow-sm">
          #{tag}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-center gap-3 text-xs">
          {it.views !== null && (
            <span className={cn("inline-flex items-center gap-1", stat(sortKey === "views"))}>
              ▶ {fmt(it.views)}
            </span>
          )}
          <span className={cn("inline-flex items-center gap-1", stat(sortKey === "likes"))}>
            ❤ {fmt(it.likes)}
          </span>
          <span className={cn("inline-flex items-center gap-1", stat(sortKey === "comments"))}>
            💬 {fmt(it.comments)}
          </span>
        </div>

        {it.caption && <p className="line-clamp-2 text-xs text-zinc-600">{it.caption}</p>}

        <div className="mt-auto flex items-center gap-2 pt-1">
          {downloadHref && (
            <a
              href={downloadHref}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-300 px-2 py-1 text-xs text-zinc-800 transition-colors hover:bg-zinc-50"
            >
              <Download className="h-3 w-3" /> Download
            </a>
          )}
          {it.url && (
            <a
              href={it.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              <Link2 className="h-3 w-3" /> Open
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

/* ────────────────────── Friend list ────────────────────── */

function FriendList({
  title,
  users,
  truncated,
}: {
  title: string;
  users: {
    id: string;
    username: string;
    fullName: string;
    isPrivate: boolean;
    isVerified: boolean;
    profilePic?: string | null;
  }[];
  truncated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${what}`),
      () => toast.error("Copy failed"),
    );
  };
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-zinc-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-400" />
        )}
        {title}
        <span className="ml-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
          {users.length}
          {truncated ? "+" : ""}
        </span>
        <span className="ml-auto flex gap-3" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => copy(users.map((u) => u.id).join("\n"), `${users.length} IDs`)}
            className="text-xs text-indigo-600 hover:underline"
          >
            Copy IDs
          </button>
          <button
            type="button"
            onClick={() =>
              copy(users.map((u) => u.username).join("\n"), `${users.length} usernames`)
            }
            className="text-xs text-indigo-600 hover:underline"
          >
            Copy usernames
          </button>
        </span>
      </div>
      {open && (
        <div className="max-h-64 divide-y divide-zinc-100 overflow-y-auto border-t border-zinc-200">
          {users.map((u) => (
            <div key={u.id} className="flex items-center gap-2 px-3.5 py-2 text-sm">
              {u.profilePic ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mediaProxy(u.profilePic)}
                  alt=""
                  className="h-6 w-6 shrink-0 rounded-full border border-zinc-200 object-cover"
                />
              ) : (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[10px] font-semibold text-zinc-400">
                  {u.username?.[0]?.toUpperCase() || "?"}
                </span>
              )}
              <a
                href={`https://instagram.com/${u.username}`}
                target="_blank"
                rel="noreferrer"
                className="truncate font-medium text-zinc-900 hover:text-indigo-600"
              >
                @{u.username}
              </a>
              {u.isVerified && <CheckCircle2 className="h-3 w-3 shrink-0 text-sky-500" />}
              {u.isPrivate && <Lock className="h-3 w-3 shrink-0 text-zinc-400" />}
              {u.fullName && (
                <span className="hidden truncate text-zinc-500 sm:inline">{u.fullName}</span>
              )}
              <span className="ml-auto shrink-0 font-mono text-xs text-zinc-400">{u.id}</span>
            </div>
          ))}
          {truncated && (
            <p className="px-3.5 py-2 text-xs text-zinc-600">
              List truncated at the demo limit — the full studio paginates the complete list.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
