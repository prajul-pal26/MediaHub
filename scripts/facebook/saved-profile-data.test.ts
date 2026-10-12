import assert from "node:assert/strict";
import { test } from "node:test";
import type { FbBrowserPage } from "../../src/server/services/facebook/browser-fetcher";
import { buildFbMediaRows } from "../../src/lib/fb-export";
import { savedRowsToPage } from "../../src/server/services/facebook/saved-profile-data";

function sourcePage(): FbBrowserPage {
  return {
    handle: "owner", name: "Owner", url: "https://www.facebook.com/owner/", contentType: "posts",
    profilePic: null, followers: null, likes: null, category: null, about: null, verified: false,
    instagram: null, twitter: null, email: null, phone: null, website: null,
    posts: [{
      postId: "123", url: "https://www.facebook.com/photo.php?fbid=123", mediaType: "photo", text: "", likes: 0, comments: 5, shares: 0,
      metricsAvailable: false, commentsReportedCount: 5, commentsStatus: "partial",
      commentsData: [
        { id: "c1", authorName: "Reader", text: "One", likeCount: 0, replyCount: 0, depth: 0 },
        { id: "c2", authorName: "Reader", text: "Two", likeCount: 0, replyCount: 0, depth: 0 },
      ],
      commentsVerifiedAccessibleCount: 2,
      commentsAccessibility: { sourceView: "newest", stablePasses: 2, reportedCount: 5, lastScanFingerprint: "b".repeat(64) },
    }],
  };
}

const strings = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value)]));

test("saved rows retain a verified accessible target only with intact matching evidence", () => {
  const row = strings(buildFbMediaRows(sourcePage())[0]);
  const saved = savedRowsToPage([row], "posts", "https://www.facebook.com/owner/")!;
  assert.equal(saved.posts[0].commentsReportedCount, 5);
  assert.equal(saved.posts[0].commentsVerifiedAccessibleCount, 2);
  assert.equal(saved.posts[0].commentsAccessibility?.sourceView, "newest");
  assert.equal(saved.posts[0].commentsAccessibility?.stablePasses, 2);

  delete row["Comments Accessibility Evidence"];
  const legacy = savedRowsToPage([row], "posts", "https://www.facebook.com/owner/")!;
  assert.equal(legacy.posts[0].commentsReportedCount, 5);
  assert.equal(legacy.posts[0].commentsVerifiedAccessibleCount, undefined);
  assert.equal(legacy.posts[0].commentsAccessibility, undefined);
});

test("saved rows retain a clean Newest-panel total before it has verification evidence", () => {
  const row = strings(buildFbMediaRows(sourcePage())[0]);
  row["Reported Delta Count"] = "3";
  row["Comments Accessible Count (Verified)"] = "";
  row["Comments Accessibility Status"] = "";
  row["Comments Accessibility Evidence"] = "";
  const saved = savedRowsToPage([row], "posts", "https://www.facebook.com/owner/")!;
  assert.equal(saved.posts[0].commentsReportedCount, 5);
  assert.equal(saved.posts[0].commentsReportedDeltaCount, 3);
  assert.equal(saved.posts[0].commentsVerifiedAccessibleCount, undefined);
});
