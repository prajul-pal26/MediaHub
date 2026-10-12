import Papa from "papaparse";
import type { InstaMediaItem } from "@/server/services/instagram/fetcher";
import type { InstaFetchResult } from "@/server/trpc/routers/insta-fetcher";

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

export function downloadCsv(rows: Record<string, unknown>[], basename: string): void {
  if (!rows.length) return;
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = Papa.unparse({
    fields: columns,
    data: rows.map((row) => columns.map((c) => row[c] ?? "")),
  });
  download(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }), `${basename}-${stamp()}.csv`);
}

export function exportProfileSummaryCsv(result: InstaFetchResult): void {
  const p = result.profile;
  const s = result.stats;
  if (!p) return;

  const row = {
    Username: p.username,
    "Full Name": p.fullName,
    Biography: p.bio,
    "Profile URL": `https://www.instagram.com/${p.username}/`,
    "Profile Picture": p.profilePic ?? "",
    "External URL": p.externalUrl ?? "",
    Category: p.category ?? "",
    "Is Verified": p.isVerified ? "Yes" : "No",
    "Is Business": p.isBusiness ? "Yes" : "No",
    "Is Private": p.isPrivate ? "Yes" : "No",
    "Total Posts (Profile)": p.postsCount,
    "Scraped Posts": s?.scrapedPosts ?? (result.content?.length || p.recentPosts.length),
    "Total Followers (Profile)": p.followers,
    "Scraped Followers": s?.scrapedFollowers ?? (result.followers?.length || 0),
    "Total Following (Profile)": p.following,
    "Scraped Following": s?.scrapedFollowing ?? (result.following?.length || 0),
    "Scraped Comments Count": s?.totalCommentsScraped ?? 0,
    "Total Likes Across Scraped Posts": s?.totalLikesScraped ?? 0,
    "Total Views Across Scraped Posts": s?.totalViewsScraped ?? 0,
    "Engagement Rate (%)": s?.calculatedEngagementRate ?? p.engagementRate ?? "",
    "Audience Quality Score": result.followersQuality ? `${result.followersQuality.qualityScore}/100` : "",
  };

  downloadCsv([row], `instagram_${p.username}_summary`);
}

export function exportPostsCsv(result: InstaFetchResult): void {
  const username = result.profile?.username || result.username;
  const posts = result.content?.length
    ? result.content
    : ((result.profile?.recentPosts as any[]) || []);
  if (!posts.length) return;

  const rows = posts.map((post: InstaMediaItem, idx: number) => ({
    Index: idx + 1,
    Shortcode: post.shortcode,
    "Post URL": post.url || `https://www.instagram.com/p/${post.shortcode}/`,
    "Content Type": post.kind || "post",
    "Likes Count": post.likes,
    "Comments Count (Reported)": post.comments,
    "Comments Scraped Count": post.commentsData?.length ?? 0,
    "Views / Play Count": post.views ?? "",
    "Published Date": post.takenAt ? new Date(post.takenAt * 1000).toISOString() : "",
    Caption: post.caption ?? "",
    "Location Name": post.location?.name ?? "",
    "Location ID": post.location?.id ?? "",
    "Media URL": post.videoUrl || post.displayUrl || (post as any).thumbnail || "",
    "Thumbnail URL": post.displayUrl || (post as any).thumbnail || "",
    "Is Carousel": post.kind === "carousel" ? "Yes" : "No",
    "Carousel Slides Count": post.carousel?.length ?? 0,
  }));

  downloadCsv(rows, `instagram_${username}_posts`);
}

export function exportCommentsCsv(result: InstaFetchResult): void {
  const username = result.profile?.username || result.username;
  const posts = result.content?.length
    ? result.content
    : ((result.profile?.recentPosts as any[]) || []);

  const rows: Record<string, unknown>[] = [];
  for (const post of posts) {
    const comments = post.commentsData || [];
    for (const c of comments) {
      rows.push({
        "Post Shortcode": post.shortcode,
        "Post URL": post.url || `https://www.instagram.com/p/${post.shortcode}/`,
        "Comment ID": c.id,
        "Comment Depth": c.depth === 0 ? "Top-level" : "Reply",
        "Parent Comment ID": c.parentId ?? "",
        "Commenter Username": c.username,
        "Commenter Full Name": c.fullName,
        "Commenter Profile URL": `https://www.instagram.com/${c.username}/`,
        "Commenter Verified": c.isVerified ? "Yes" : "No",
        "Comment Text": c.text,
        "Likes Count": c.likeCount,
        "Replies Count": c.replyCount,
        "Created At": c.createdAt ?? "",
      });
    }
  }

  if (!rows.length) return;
  downloadCsv(rows, `instagram_${username}_comments`);
}

export function exportFollowersCsv(
  result: InstaFetchResult,
  type: "followers" | "following" = "followers",
): void {
  const username = result.profile?.username || result.username;
  const list = type === "followers" ? result.followers : result.following;
  if (!list || !list.length) return;

  const rows = list.map((u, i) => ({
    Index: i + 1,
    "User ID": u.id,
    Username: u.username,
    "Full Name": u.fullName,
    "Profile URL": `https://www.instagram.com/${u.username}/`,
    "Is Verified": u.isVerified ? "Yes" : "No",
    "Is Private": u.isPrivate ? "Yes" : "No",
    "Profile Picture URL": u.profilePic ?? "",
  }));

  downloadCsv(rows, `instagram_${username}_${type}`);
}
