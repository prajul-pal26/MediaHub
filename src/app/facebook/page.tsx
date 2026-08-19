"use client";

import { useState } from "react";
import Link from "next/link";
import { trpc } from "@/lib/trpc/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/landing/lib/motion";
import { SURFACE } from "@/components/landing/lib/constants";
import { BrandLogo } from "@/components/common/BrandLogo";
import {
  Search,
  Loader2,
  CheckCircle2,
  MessageSquare,
  Link2,
  AlertTriangle,
  Users,
  ChevronRight,
} from "lucide-react";

const MAX_PAGES = 3;

function fmt(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

/** Route CDN media (fbcdn included) through our proxy so it isn't hotlink-blocked. */
const mediaProxy = (url: string | null | undefined) =>
  url ? `/api/insta-media?url=${encodeURIComponent(url)}` : "";

const PRIMARY_BTN =
  "inline-flex items-center justify-center gap-2 rounded-full bg-indigo-600 text-white font-medium hover:bg-indigo-500 transition-colors disabled:opacity-60 disabled:pointer-events-none";

/** Result type derived from the mutation's inferred data — no server type import. */
type FbResult = NonNullable<
  ReturnType<typeof trpc.fbSession.fbDemoFetch.useMutation>["data"]
>["results"][number];

/** Strip @, whitespace and any facebook.com URL prefix, leaving a bare handle. */
function normalizeHandle(raw: string): string {
  let s = raw.trim().replace(/^@/, "");
  s = s.replace(/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i, "");
  s = s.replace(/[?#].*$/, ""); // drop query/hash
  s = s.replace(/\/+$/, ""); // drop trailing slashes
  return s.trim();
}

export default function FacebookDemoPage() {
  const [pagesText, setPagesText] = useState("");

  const fbDemoFetch = trpc.fbSession.fbDemoFetch.useMutation({
    onError: (e) => toast.error(e.message),
  });

  const parsed = pagesText
    .split(/[\s,\n]+/)
    .map(normalizeHandle)
    .filter(Boolean);

  const unique = Array.from(new Set(parsed.map((p) => p.toLowerCase())));
  const capped = unique.slice(0, MAX_PAGES);
  const overCap = unique.length > MAX_PAGES;

  const handleFetch = () => {
    if (capped.length === 0) {
      toast.error("Enter at least one Facebook Page");
      return;
    }
    fbDemoFetch.mutate({ pages: capped });
  };

  const results = fbDemoFetch.data?.results ?? [];

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
            Facebook
            <br />
            <span className="text-indigo-600">Intelligence</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-zinc-600">
            Point us at any public Facebook Page. We render it live and pull the whole
            picture — profile, following, engagement and recent posts.
          </p>
        </Reveal>

        {/* ── Search panel ── */}
        <Reveal delay={0.08}>
          <div className={cn(SURFACE.card, "mt-10 p-5 sm:p-7")}>
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="pages"
                className="font-mono text-[11px] uppercase tracking-[0.2em] text-zinc-500"
              >
                Pages to decode
              </label>
              <span
                className={cn(
                  "font-mono text-xs",
                  overCap ? "text-amber-600" : "text-zinc-500",
                )}
              >
                {capped.length}/{MAX_PAGES}
              </span>
            </div>

            <textarea
              id="pages"
              value={pagesText}
              onChange={(e) => setPagesText(e.target.value)}
              rows={2}
              placeholder="nasa, facebook.com/natgeo, @vogue"
              className="mt-2.5 w-full resize-none rounded-xl border border-zinc-300 bg-white px-4 py-3 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 outline-none transition-colors focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            />
            <p className="mt-2 text-xs text-zinc-500">
              Page handles or URLs — comma, space or newline separated, up to {MAX_PAGES} public
              Pages per run.
              {overCap && (
                <span className="text-amber-600">
                  {" "}
                  Only the first {MAX_PAGES} will be analysed.
                </span>
              )}
            </p>

            <button
              type="button"
              onClick={handleFetch}
              disabled={fbDemoFetch.isPending}
              className={cn(PRIMARY_BTN, "mt-6 w-full px-6 py-3.5 text-base sm:w-auto")}
            >
              {fbDemoFetch.isPending ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" /> Rendering…
                </>
              ) : (
                <>
                  <Search className="h-5 w-5" /> Analyse
                </>
              )}
            </button>

            <p className="mt-3 text-xs text-zinc-500">
              Renders live via a real browser session — allow a few seconds per Page.
            </p>
          </div>
        </Reveal>

        {/* ── Loading skeletons ── */}
        {fbDemoFetch.isPending && (
          <div className="mt-8 space-y-4">
            <div className="flex items-center gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Rendering pages… this takes a few seconds each.
            </div>
            {capped.map((p, i) => (
              <PageSkeleton key={p + i} />
            ))}
          </div>
        )}

        {/* ── Empty state ── */}
        {!fbDemoFetch.isPending && results.length === 0 && (
          <div className="mt-10 flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-200 bg-zinc-50">
              <Search className="h-6 w-6 text-indigo-600" />
            </div>
            <p className="mt-5 font-display text-xl uppercase tracking-tight text-zinc-900">
              Nothing decoded yet
            </p>
            <p className="mt-2 max-w-sm text-sm text-zinc-600">
              Drop a public Facebook Page above and hit Analyse to see the intelligence layer
              in action.
            </p>
          </div>
        )}

        {/* ── Results ── */}
        {!fbDemoFetch.isPending && results.length > 0 && (
          <div className="mt-8 space-y-6">
            {results.map((r) =>
              r.ok && r.page ? (
                <PageCard key={r.query} r={r} />
              ) : (
                <div
                  key={r.query}
                  className="flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-5 py-4"
                >
                  <AlertTriangle className="h-5 w-5 shrink-0 text-red-600" />
                  <span className="text-sm text-zinc-700">
                    <strong className="text-zinc-900">{r.query}</strong> — {r.error}
                  </span>
                </div>
              ),
            )}
          </div>
        )}

        {/* ── Footer CTA strip ── */}
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
      </main>
    </div>
  );
}

/* ────────────────────── Page card ────────────────────── */

function PageCard({ r }: { r: FbResult }) {
  const p = r.page!;
  return (
    <Reveal className={cn(SURFACE.card, "overflow-hidden p-5 sm:p-7")}>
      <div className="flex gap-4 sm:gap-5">
        {p.profilePic ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaProxy(p.profilePic)}
            alt={p.name}
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
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="font-display text-xl uppercase tracking-tight text-zinc-900 hover:text-indigo-600"
            >
              {p.name}
            </a>
            {p.verified && <CheckCircle2 className="h-4 w-4 text-sky-500" />}
            {p.category && (
              <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[11px] text-zinc-600">
                {p.category}
              </span>
            )}
          </div>

          {p.handle && <p className="mt-1 text-sm font-medium text-zinc-800">@{p.handle}</p>}
          {p.about && (
            <p className="mt-1 whitespace-pre-line text-sm text-zinc-600">{p.about}</p>
          )}
          <a
            href={p.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
          >
            <Link2 className="h-3 w-3" /> View Page
          </a>

          <div className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Stat label="Followers" value={p.followers !== null ? fmt(p.followers) : "—"} />
            <Stat label="Likes" value={p.likes !== null ? fmt(p.likes) : "—"} />
          </div>

          {/* Contact info / socials — Facebook shows the Instagram row as a bare
              handle with only an icon, so these come from the unwrapped hrefs. */}
          {(p.instagram || p.twitter || p.email || p.phone || p.website) && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {p.instagram && (
                <ContactChip
                  href={p.instagram}
                  label={`@${p.instagram.replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")}`}
                  title="Instagram"
                />
              )}
              {p.twitter && (
                <ContactChip
                  href={p.twitter}
                  label={`@${p.twitter.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "")}`}
                  title="X / Twitter"
                />
              )}
              {p.email && <ContactChip href={`mailto:${p.email}`} label={p.email} title="Email" />}
              {p.phone && <ContactChip label={p.phone} title="Phone" />}
              {p.website && (
                <ContactChip
                  href={p.website}
                  label={p.website.replace(/^https?:\/\/(www\.)?/i, "")}
                  title="Website"
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Recent posts */}
      {p.posts.length > 0 && (
        <div className="mt-6">
          <SectionLabel>Recent posts ({p.posts.length})</SectionLabel>
          <div className="space-y-2.5">
            {p.posts.map((post, i) => (
              <div
                key={i}
                className="rounded-xl border border-zinc-200 bg-white p-3.5"
              >
                {post.text ? (
                  <p className="line-clamp-3 text-sm text-zinc-700">{post.text}</p>
                ) : (
                  <p className="text-sm italic text-zinc-400">No caption</p>
                )}
                <div className="mt-2.5 flex items-center gap-4 text-xs text-zinc-500">
                  <span>❤ {fmt(post.likes)}</span>
                  <span className="inline-flex items-center gap-1">
                    <MessageSquare className="h-3 w-3" /> {fmt(post.comments)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Reveal>
  );
}

/* ────────────────────── Small pieces ────────────────────── */

/** One contact/social pill. Renders as a link when there's somewhere to go. */
function ContactChip({ href, label, title }: { href?: string; label: string; title: string }) {
  const cls =
    "inline-flex max-w-full items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1 text-xs text-zinc-700";
  const inner = (
    <>
      <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-zinc-400">{title}</span>
      <span className="truncate">{label}</span>
    </>
  );
  if (!href) return <span className={cls} title={title}>{inner}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={title}
      className={cn(cls, "transition-colors hover:border-indigo-300 hover:text-indigo-700")}
    >
      {inner}
    </a>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="font-display text-2xl uppercase leading-none tracking-tight text-zinc-900">
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

function PageSkeleton() {
  return (
    <div className={cn(SURFACE.card, "p-5 sm:p-7")}>
      <div className="flex gap-5">
        <div className="h-16 w-16 shrink-0 animate-pulse rounded-full bg-zinc-100 sm:h-20 sm:w-20" />
        <div className="flex-1 space-y-3">
          <div className="h-5 w-40 animate-pulse rounded bg-zinc-100" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-zinc-100" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100" />
          <div className="flex gap-6 pt-1">
            {[0, 1].map((i) => (
              <div key={i} className="h-8 w-14 animate-pulse rounded bg-zinc-100" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
