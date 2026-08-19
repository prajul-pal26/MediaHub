import { redirect } from "next/navigation";

// The FB Page Fetcher has been consolidated into the single /fb-scraper page —
// its Graph API lookup now lives there as the "Graph API" tab, alongside the
// cookie-based scraping methods. Session management lives in Settings → Facebook.
export default function FbFetcherRedirect() {
  redirect("/fb-scraper");
}
