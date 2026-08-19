import { redirect } from "next/navigation";

// The Insta Page Fetcher has been consolidated into the single /instagram page.
// Session management now lives in Settings → Instagram.
export default function InstaFetcherRedirect() {
  redirect("/instagram");
}
