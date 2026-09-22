import assert from "node:assert/strict";
import { test } from "node:test";
import { publishedTimeFromPayloads } from "../../src/server/services/facebook/media-metadata-data";

const photo = { postId: "123", contentType: "posts" as const };
const reel = { postId: "456", contentType: "reels" as const };
const unix = 1788695600;
const iso = new Date(unix * 1000).toISOString();

test("exact photo created_time works without a caption, excluding nearby photos and comment timestamps", () => {
  assert.equal(publishedTimeFromPayloads([{ __typename: "Photo", id: "123", created_time: unix },
    { __typename: "Photo", id: "999", created_time: unix + 2 }, { __typename: "Comment", id: "123", created_time: unix + 4 }], photo), iso);
});

test("fragmented photo creation stories join by ID and prefer publication over upload time", () => {
  assert.equal(publishedTimeFromPayloads([{ __typename: "Photo", id: "123" },
    { id: "123", created_time: unix - 120, creation_story: { id: "story-123" } },
    { id: "story-123", comet_sections: { metadata: [{ story: { id: "story-123", creation_time: unix } }] } },
    { id: "unrelated-story", creation_time: unix + 30 }], photo), iso);
});

test("reel story dates join through the requested video; recommended reels are excluded", () => {
  assert.equal(publishedTimeFromPayloads([{ id: "story-456", post_id: "789", video: { id: "456" }, creation_time: unix },
    { __typename: "Story", id: "other", video: { id: "000" }, creation_time: unix + 90 }], reel), iso);
});

test("Video creation_story fragments and native publish_time support Watch and Live details", () => {
  assert.equal(publishedTimeFromPayloads([{ __typename: "Video", id: "456", creation_story: { id: "story" } },
    { id: "story", creation_time: unix }], reel), iso);
  assert.equal(publishedTimeFromPayloads([{ __typename: "Video", id: "456", publish_time: unix }], reel), iso);
});

test("missing, invalid, scheduled, request and conflicting times remain unavailable", () => {
  for (const created_time of [0, -1, unix * 1000, "Yesterday", null, Number.NaN]) {
    assert.equal(publishedTimeFromPayloads([{ __typename: "Photo", id: "123", created_time }], photo), null);
  }
  assert.equal(publishedTimeFromPayloads([{ __typename: "Photo", id: "123", timestamp: unix, scheduled_publish_time: unix }], photo), null);
  assert.equal(publishedTimeFromPayloads([{ id: "123", created_time: unix }], photo), null);
  assert.equal(publishedTimeFromPayloads([{ __typename: "Photo", id: "123", created_time: unix },
    { __typename: "Photo", id: "123", created_time: unix + 10 }], photo), null);
});
