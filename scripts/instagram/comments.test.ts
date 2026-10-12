import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchMediaComments, harvestManyPosts } from "../../src/server/services/instagram/comments";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("Instagram cursor paging preserves replies and the reported total", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    if (url.pathname.endsWith("/child_comments/")) {
      return json({ child_comments: [{ pk: "reply-1", text: "Reply", user: { username: "reply" } }], has_more_head_child_comments: false });
    }
    if (url.searchParams.has("min_id")) {
      return json({ comments: [{ pk: "comment-2", text: "Second", user: { username: "second" } }], comment_count: 3, has_more_comments: false });
    }
    return json({
      comments: [{ pk: "comment-1", text: "First", child_comment_count: 1, user: { username: "first" } }],
      comment_count: 3,
      has_more_comments: true,
      next_min_id: { cached_comments_cursor: "cursor-2" },
    });
  };
  try {
    const result = await fetchMediaComments("media-1", "1:session", { delayMs: 0, includeReplies: true });
    assert.equal(result.reportedTotal, 3);
    assert.equal(result.comments.length, 3);
    assert.equal(result.comments.filter((comment) => comment.depth === 0).length, 2);
    assert.equal(result.comments.filter((comment) => comment.depth === 1).length, 1);
    assert.equal(result.pagesFetched, 2);
    assert.ok(requests.some((url) => new URL(url).searchParams.get("min_id")?.includes("cursor-2")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bulk harvesting publishes every settled post for durable checkpointing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const mediaId = url.pathname.split("/")[4] ?? "unknown";
    return json({ comments: [{ pk: `${mediaId}-comment`, text: mediaId, user: { username: mediaId } }], comment_count: 1, has_more_comments: false });
  };
  const settled: string[] = [];
  try {
    const result = await harvestManyPosts(["media-a", "media-b"], "1:session", {
      concurrency: 1,
      onResult: async (post) => { settled.push(post.mediaId); },
    });
    assert.equal(result.totalComments, 2);
    assert.deepEqual(settled.sort(), ["media-a", "media-b"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
