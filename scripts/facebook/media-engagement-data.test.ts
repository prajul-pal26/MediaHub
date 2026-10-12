import assert from "node:assert/strict";
import { test } from "node:test";
import { engagementLabelsFromPayloads } from "../../src/server/services/facebook/media-engagement-data";
import { engagementFromLabels } from "../../src/server/services/facebook/media-engagement";

const photo = { postId: "1516804617131938", contentType: "posts" as const };
const reel = { postId: "2076849902969631", contentType: "reels" as const };
const photoFeedback = "feedback:photo-owner";
const reelFeedback = "feedback:1516438623835204";
const topReactions = (like: number, love: number) => ({ edges: [
  { node: { id: "reaction-like", localized_name: "Like" }, reaction_count: like },
  { node: { id: "reaction-love", localized_name: "Love" }, reaction_count: love },
] });

test("owner Photo feedback fragments provide observed zero shares and localized reaction categories", () => {
  const payloads = [
    { data: { ownerPhoto: { __typename: "Photo", id: photo.postId, feedback: { id: photoFeedback } } } },
    { incremental: [{ data: { id: photoFeedback, reaction_count: { count: 13 }, top_reactions: topReactions(10, 3) } }] },
    { data: { id: photoFeedback, share_count: { count: 0 } } },
  ];
  const parsed = engagementLabelsFromPayloads(payloads, photo);
  assert.deepEqual(parsed.feedbackIds, [photoFeedback]);
  assert.equal(parsed.storyId, undefined);
  const result = engagementFromLabels(parsed.labels);
  assert.equal(result.status, "complete");
  assert.equal(result.totalReactions, 13);
  assert.equal(result.shares, 0);
  assert.deepEqual(result.reactions, { like: 10, love: 3, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 });
});

test("Watch story video identity links exact Like142 Love5 and reshares6 to the requested reel", () => {
  const parsed = engagementLabelsFromPayloads([
    { data: { story: { post_id: "1516438623835204", video: { id: reel.postId }, feedback: { id: reelFeedback } } } },
    { data: { id: reelFeedback, reaction_count: { count: 147, is_empty: false }, i18n_reaction_count: "147", top_reactions: topReactions(142, 5), reshares: { count: 6 }, share_count_reduced: "6" } },
  ], reel);
  assert.equal(parsed.storyId, "1516438623835204");
  assert.deepEqual(parsed.feedbackIds, [reelFeedback]);
  assert.deepEqual(engagementFromLabels(parsed.labels), {
    status: "complete", totalReactions: 147, shares: 6,
    reactions: { like: 142, love: 5, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 },
  });
});

test("story attachment media IDs resolve feedback without relying on a top-level video field", () => {
  const parsed = engagementLabelsFromPayloads([
    { data: { story: { post_id: "1516438623835204", attachments: [{ media: { __typename: "Video", id: reel.postId } }], feedback: { id: reelFeedback } } } },
    { id: reelFeedback, unified_reactors: { count: 147 }, top_reactions: topReactions(142, 5), reshares: { count: 6 } },
  ], reel);
  const result = engagementFromLabels(parsed.labels);
  assert.equal(parsed.storyId, "1516438623835204");
  assert.equal(result.status, "complete");
  assert.equal(result.totalReactions, 147);
});

test("recommended media and nested comment feedback cannot contaminate owner counters", () => {
  const parsed = engagementLabelsFromPayloads([
    { __typename: "Photo", id: photo.postId, feedback: { id: photoFeedback } },
    { id: photoFeedback, reaction_count: { count: 13 }, share_count: { count: 0 }, top_reactions: topReactions(10, 3),
      comments: [{ id: "comment-1", feedback: { id: "feedback:comment", reaction_count: { count: 999 }, top_reactions: topReactions(999, 0) } }] },
    { recommendations: [{ __typename: "Photo", id: "999", feedback: { id: "feedback:recommended", reaction_count: { count: 9999 }, share_count: { count: 123 }, top_reactions: topReactions(9999, 0) } }] },
    { post_id: "1000", video: { id: "other-video" }, feedback: { id: "feedback:other-video", reaction_count: { count: 8888 } } },
  ], photo);
  const result = engagementFromLabels(parsed.labels);
  assert.deepEqual(parsed.feedbackIds, [photoFeedback]);
  assert.equal(result.totalReactions, 13);
  assert.equal(result.reactions.like, 10);
  assert.equal(result.shares, 0);
  assert.equal(result.status, "complete");
});

test("supported reaction infos identify counted edges but never create counters alone", () => {
  const owner = { __typename: "Video", id: reel.postId, feedback: { id: reelFeedback } };
  const info = { id: reelFeedback, supported_reaction_infos: [
    { id: "reaction-like", localized_name: "Like", reaction_count: 777 },
    { id: "reaction-love", localized_name: "Love" },
  ], reaction_count: { count: 147 }, reshares: { count: 6 } };
  const withoutEdges = engagementFromLabels(engagementLabelsFromPayloads([owner, info], reel).labels);
  assert.deepEqual(withoutEdges.reactions, {});
  assert.equal(withoutEdges.status, "partial");
  const withEdges = engagementFromLabels(engagementLabelsFromPayloads([owner, info, {
    id: reelFeedback, top_reactions: { edges: [
      { node: { id: "reaction-like" }, reaction_count: 142 },
      { node: { id: "reaction-love" }, i18n_reaction_count: "5" },
    ] },
  }], reel).labels);
  assert.equal(withEdges.reactions.like, 142);
  assert.equal(withEdges.reactions.love, 5);
  assert.equal(withEdges.status, "complete");
});

test("unlinked feedback and same-number comment IDs do not establish owner identity", () => {
  const parsed = engagementLabelsFromPayloads([
    { __typename: "Comment", id: photo.postId, feedback: { id: photoFeedback } },
    { id: photoFeedback, reaction_count: { count: 13 }, share_count: { count: 0 }, top_reactions: topReactions(10, 3) },
  ], photo);
  assert.deepEqual(parsed.feedbackIds, []);
  assert.deepEqual(parsed.labels, { totals: [], shares: [], reactions: [] });
});

test("a known aggregate zero establishes zero categories while absent shares remain unknown", () => {
  const owner = { __typename: "Photo", id: photo.postId, feedback: { id: photoFeedback } };
  const counts = { id: photoFeedback, reaction_count: { count: 0 } };
  const missing = engagementFromLabels(engagementLabelsFromPayloads([owner, counts], photo).labels);
  assert.equal(missing.totalReactions, 0);
  assert.equal(missing.shares, null);
  assert.equal(missing.status, "partial");
  const zero = engagementFromLabels(engagementLabelsFromPayloads([owner, counts, { id: photoFeedback, share_count: { count: 0 } }], photo).labels);
  assert.equal(zero.status, "complete");
  assert.equal(zero.shares, 0);
  assert.ok(Object.values(zero.reactions).every((count) => count === 0));
});

test("contradictory exact owner-feedback fragments remain unresolved", () => {
  const parsed = engagementLabelsFromPayloads([
    { __typename: "Photo", id: photo.postId, feedback: { id: photoFeedback } },
    { id: photoFeedback, reaction_count: { count: 13 }, share_count: { count: 0 } },
    { id: photoFeedback, reaction_count: { count: 14 } },
  ], photo);
  const result = engagementFromLabels(parsed.labels);
  assert.equal(result.status, "partial");
  assert.equal(result.totalReactions, null);
});

test("associated_video feedback anchors recover exact rounded-display counts without a Video typename", () => {
  const item = { postId: "1700116321059827", contentType: "reels" as const };
  const feedbackId = "feedback:1508404134638653";
  const parsed = engagementLabelsFromPayloads([
    { data: { feedback: { id: feedbackId, associated_video: { id: item.postId } } } },
    { data: { id: feedbackId, reaction_count: { count: 1807 }, i18n_reaction_count: "1.8K", reshares: { count: 60 }, top_reactions: { edges: [
      { node: { id: "1635855486666999", localized_name: "Like" }, reaction_count: 1749, i18n_reaction_count: "1.7K" },
      { node: { id: "1678524932434102", localized_name: "Love" }, reaction_count: 55, i18n_reaction_count: "55" },
      { node: { id: "613557422527858", localized_name: "Care" }, reaction_count: 3, i18n_reaction_count: "3" },
    ] } } },
    { data: { feedback: { id: "wrong-owner", associated_video: { id: "999" }, reaction_count: { count: 999 }, reshares: { count: 999 } } } },
    { __typename: "Comment", id: "comment-feedback", associated_video: { id: item.postId }, reaction_count: { count: 999 } },
  ], item);
  assert.deepEqual(parsed.feedbackIds, [feedbackId]);
  assert.deepEqual(engagementFromLabels(parsed.labels), {
    status: "complete", totalReactions: 1807, shares: 60,
    reactions: { like: 1749, love: 55, care: 3, haha: 0, wow: 0, sad: 0, angry: 0 },
  });
});
