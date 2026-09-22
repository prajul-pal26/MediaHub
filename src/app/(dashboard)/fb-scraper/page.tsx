import { redirect } from "next/navigation";

// The legacy multi-tab Facebook scraper has been replaced by the unified /facebook page
export default function FbScraperRedirect() {
  redirect("/facebook");
}
