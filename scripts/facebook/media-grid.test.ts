import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaCacheKey, mediaCollection, mediaOwnerName, mediaTile } from "../../src/server/services/facebook/media-grid";

test("owner routes normalize tab URLs, handles and numeric profiles", () => {
  for (const input of ["@example", "https://www.facebook.com/example/photos/", "m.facebook.com/example/reels"]) {
    assert.equal(mediaCollection(input, "posts").collectionUrl, "https://www.facebook.com/example/photos/");
    assert.equal(mediaCollection(input, "reels").collectionUrl, "https://www.facebook.com/example/reels/");
  }
  assert.equal(mediaCollection("https://www.facebook.com/profile.php?id=123", "reels").handle, "123");
  assert.equal(mediaCollection("https://www.facebook.com/people/Name/123/", "posts").handle, "123");
});

test("media fetch cannot navigate foreign hosts or interpret post/group IDs as owners", () => {
  for (const input of ["https://facebook.com.evil.test/x", "https://example.com/", "https://facebook.com/groups/123", "https://facebook.com/reel/123", "https://facebook.com/example/posts/123"]) {
    assert.throws(() => mediaCollection(input, "posts"));
  }
});

const tile = { url: "https://www.facebook.com/photo.php?fbid=123&set=456", image: "https://scontent.fbcdn.net/image.jpg", label: "", text: "" };
test("owner names come from the collection title, excluding notification counts", () => {
  assert.equal(mediaOwnerName("(7) Example Person Reels | Facebook", "example"), "Example Person");
  assert.equal(mediaOwnerName("(7) Example Person | Facebook", "example"), "Example Person");
  assert.equal(mediaOwnerName("Notifications", "example"), "example");
});
test("photo IDs survive query cleanup, and header/activity links are rejected", () => {
  for (const path of ["photo.php", "photo/", "photo"]) {
    const item = mediaTile({ ...tile, url: `https://www.facebook.com/${path}?fbid=123&set=456` }, "posts");
    assert.equal(item?.postId, "123");
    assert.equal(item?.url, "https://www.facebook.com/photo.php?fbid=123");
    assert.equal(item?.metricsAvailable, false);
    assert.equal(item?.text, "");
  }
  assert.equal(mediaTile({ ...tile, label: "View profile cover photo" }, "posts"), null);
  assert.equal(mediaTile({ ...tile, url: "https://www.facebook.com/login_alerts/start/?fbid=123" }, "posts"), null);
  assert.equal(mediaTile({ ...tile, image: "" }, "posts"), null);
});

test("reels and photos remain separate; tile views never become likes or captions", () => {
  const reel = { ...tile, url: "https://www.facebook.com/reel/123/?ref=grid", text: "1.2K" };
  assert.equal(mediaTile(reel, "posts"), null);
  assert.equal(mediaTile(tile, "reels"), null);
  const item = mediaTile(reel, "reels")!;
  assert.equal(item.views, 1200);
  assert.equal(item.metricsAvailable, false);
  assert.equal(item.isVideo, true);
  assert.equal(item.text, "");
  assert.equal(mediaTile({ ...reel, text: "some caption" }, "reels")?.views, null);
});

test("snapshots are isolated by session, media type, requested count and target", () => {
  const base = mediaCacheKey("owner", "posts", 12, "test-session-a");
  assert.equal(base, mediaCacheKey("owner", "posts", 12, "test-session-a"));
  assert.notEqual(base, mediaCacheKey("owner", "posts", 12, "test-session-b"));
  assert.notEqual(base, mediaCacheKey("owner", "reels", 12, "test-session-a"));
  assert.notEqual(base, mediaCacheKey("owner", "posts", 60, "test-session-a"));
  assert.notEqual(base, mediaCacheKey("another-owner", "posts", 12, "test-session-a"));
});
