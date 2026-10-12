/**
 * Deployment mode — what this installation is allowed to do.
 *
 * MediaHub runs in two places with genuinely different capabilities:
 *
 *  - **local**  — the full Docker stack. A long-running BullMQ worker, ffmpeg,
 *                 Chromium, a writable disk cache, and no request-body limit.
 *                 Everything works.
 *  - **live**   — the Vercel deployment. Serverless: no persistent worker, no
 *                 ffmpeg, no Chromium, an ephemeral filesystem, and a hard
 *                 ~4.5MB request-body cap. Anything that depends on those is
 *                 not merely slow there, it cannot run at all.
 *
 * The mode is fixed per deployment by `NEXT_PUBLIC_DEPLOYMENT_MODE`. It is a
 * NEXT_PUBLIC_ var on purpose: the sidebar and page guards are client-side, so
 * the browser has to know which build it is talking to.
 *
 * Locally the header also offers a preview toggle, so you can see exactly what
 * a Vercel user sees without deploying. That toggle is deliberately absent when
 * the build itself is `live` — a Vercel visitor must not be able to switch into
 * local mode and be shown features whose backends do not exist there.
 */

export type DeploymentMode = "local" | "live";

/** What this build is, from the environment. Never user-changeable. */
export const BUILD_MODE: DeploymentMode =
  process.env.NEXT_PUBLIC_DEPLOYMENT_MODE === "live" ? "live" : "local";

/** Only a local build may preview "live"; a live build is locked to live. */
export const CAN_PREVIEW_MODES = BUILD_MODE === "local";

/**
 * Capabilities, and the honest reason each one is local-only.
 *
 * `true` = available in live (Vercel) too.
 */
export const LIVE_CAPABILITIES = {
  /** Browse the media library, open groups, read captions. Pure DB reads. */
  browseMedia: true,
  /** Create and edit an Edit Document. The doc is JSON in Postgres. */
  editDrafts: true,
  /** View analytics that the worker already collected. DB reads. */
  viewAnalytics: true,
  /** Connect/disconnect social accounts. Plain OAuth redirects. */
  manageAccounts: true,
  /** Settings, brands, users. */
  manageSettings: true,

  // ── Local only ────────────────────────────────────────────────────────────
  /** Needs the BullMQ worker; serverless functions cannot hold a job. */
  publish: false,
  /** Needs ffmpeg + sharp + the /tmp/render volume in the worker. */
  renderEdits: false,
  /** Vercel caps a serverless request body at ~4.5MB; our limit is 500MB. */
  uploadMedia: false,
  /** Needs Chromium (Playwright) — not available on Vercel. */
  scrapers: false,
  /** Queues an analytics-fetch job, which only the worker can run. */
  refreshAnalytics: false,
} as const;

export type Capability = keyof typeof LIVE_CAPABILITIES;

/** Is `capability` available in `mode`? Local has everything. */
export function can(capability: Capability, mode: DeploymentMode): boolean {
  return mode === "local" ? true : LIVE_CAPABILITIES[capability];
}

/** Shown in the UI when something is unavailable, so it is never a dead click. */
export const LOCAL_ONLY_REASON: Record<Capability, string> = {
  browseMedia: "",
  editDrafts: "",
  viewAnalytics: "",
  manageAccounts: "",
  manageSettings: "",
  publish: "Publishing runs on the local background worker.",
  renderEdits: "Rendering needs ffmpeg on the local worker.",
  uploadMedia: "Uploads above 4.5MB need the local server.",
  scrapers: "Scraping needs a local browser runtime.",
  refreshAnalytics: "Refreshing analytics needs the local worker.",
};
