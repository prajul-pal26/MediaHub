import assert from "node:assert/strict";
import { test } from "node:test";
import { engagementFromLabels, isReactionInspector, mergeEngagementViews, parseEngagementCount } from "../../src/server/services/facebook/media-engagement";

test("counts distinguish exact integers from abbreviated displays", () => {
  assert.deepEqual(parseEngagementCount("1,234"), { count: 1234, approximate: false });
  assert.deepEqual(parseEngagementCount("1,23,456"), { count: 123456, approximate: false });
  assert.deepEqual(parseEngagementCount("1.2K"), { count: 1200, approximate: true });
  assert.deepEqual(parseEngagementCount("2M"), { count: 2000000, approximate: true });
  for (const value of ["", "123 people", "1.2", "12,34", "-1", "2026-09-06", "Name 123", "1.5K comments"]) assert.equal(parseEngagementCount(value), null);
});

test("missing engagement counts remain unknown", () => {
  const result = engagementFromLabels({ totals: [], reactions: [], shares: [] });
  assert.equal(result.status, "partial");
  assert.equal(result.totalReactions, null);
  assert.equal(result.shares, null);
  assert.deepEqual(result.reactions, {});
});

test("only an exact accounting total establishes missing reaction types as zero", () => {
  const result = engagementFromLabels({ totals: ["All reactions: 12"], reactions: [{ label: "Like 10" }, { label: "2", icons: ["Love"] }], shares: ["3 shares"] });
  assert.equal(result.status, "complete");
  assert.equal(result.shares, 3);
  assert.deepEqual(result.reactions, { like: 10, love: 2, care: 0, haha: 0, wow: 0, sad: 0, angry: 0 });
  const partial = engagementFromLabels({ totals: ["1.2K reactions"], reactions: [{ label: "Like 1.2K" }], shares: ["3 shares"] });
  assert.equal(partial.status, "partial");
  assert.equal(partial.approximate, true);
  assert.deepEqual(partial.reactions, { like: 1200 });
});

test("conflicting totals and category sums never fabricate a complete result", () => {
  const conflict = engagementFromLabels({ totals: ["10 reactions", "11 reactions"], reactions: [{ label: "Like 10" }], shares: ["1 share"] });
  assert.equal(conflict.totalReactions, null);
  assert.equal(conflict.status, "partial");
  const excess = engagementFromLabels({ totals: ["10 reactions"], reactions: [{ label: "Like 10" }, { label: "Love 1" }], shares: ["0 shares"] });
  assert.equal(excess.status, "partial");
  assert.equal(excess.reactions.care, undefined);
});

test("a precise total takes precedence over its rounded label", () => {
  const result = engagementFromLabels({ totals: ["1.2K reactions", "All 1,234"], reactions: [{ label: "Like 1,234" }], shares: ["0 shares"] });
  assert.equal(result.totalReactions, 1234);
  assert.equal(result.approximate, undefined);
  assert.equal(result.status, "complete");
});

test("native photo reaction tabs expose the count and type in their accessible label", () => {
  const result = engagementFromLabels({ totals: ["All reactions: 13"], reactions: [{ label: "Show 13 people who reacted with Like" }], shares: ["3 shares"] });
  assert.equal(result.status, "complete");
  assert.equal(result.reactions.like, 13);
  assert.equal(result.reactions.love, 0);
});

test("a counter already scoped to the All tab can be raw numeric text", () => {
  const result = engagementFromLabels({ totals: ["All", "13"], reactions: [{ label: "13", icons: ["Like"] }], shares: ["3 shares"] });
  assert.equal(result.totalReactions, 13);
  assert.equal(result.reactions.love, 0);
  assert.equal(result.status, "complete");
  // A raw counter in an unclassified reaction row cannot identify its type.
  const untyped = engagementFromLabels({ totals: ["13"], reactions: [{ label: "13" }], shares: ["3 shares"] });
  assert.deepEqual(untyped.reactions, {});
  assert.equal(untyped.status, "partial");
});

test("plural category labels and icon labels identify a single reaction type", () => {
  const result = engagementFromLabels({ totals: ["All 15"], reactions: [{ label: "13 likes" }, { label: "2", icons: ["Loves"] }], shares: ["1 share"] });
  assert.equal(result.reactions.like, 13);
  assert.equal(result.reactions.love, 2);
  assert.equal(result.reactions.care, 0);
  assert.equal(result.status, "complete");
});

test("all exact category counters must account for the exact aggregate", () => {
  const reactions = ["Like 10", "Love 0", "Care 0", "Haha 0", "Wow 0", "Sad 0", "Angry 0"].map((label) => ({ label }));
  const missing = engagementFromLabels({ totals: ["All 12"], reactions, shares: ["0 shares"] });
  assert.equal(missing.totalReactions, 12);
  assert.equal(missing.status, "partial");
  assert.match(missing.error ?? "", /disagree/i);
  // Without a separate aggregate, seven known exact categories establish it.
  const derived = engagementFromLabels({ totals: [], reactions, shares: ["0 shares"] });
  assert.equal(derived.totalReactions, 10);
  assert.equal(derived.status, "complete");
});

test("share labels accept singular, prefixes, grouped counts, and spaced abbreviations", () => {
  for (const [label, count, approximate] of [
    ["1 share", 1, false], ["Shares: 1,234", 1234, false], ["Share: 0", 0, false],
    ["1.2\u00a0K shares", 1200, true], ["2 lakh shares", 200000, true],
  ] as const) {
    const result = engagementFromLabels({ totals: ["All 0"], reactions: [], shares: [label] });
    assert.equal(result.shares, count, label);
    assert.equal(Boolean(result.approximate), approximate, label);
    assert.equal(result.status, "complete", label);
  }
});

test("a refreshed snapshot can replace counts without treating a genuine conflict as a maximum", () => {
  const before = engagementFromLabels({ totals: ["All 12"], reactions: [{ label: "Like 12" }], shares: ["1 share"] });
  const after = engagementFromLabels({ totals: ["All 13"], reactions: [{ label: "Like 13" }], shares: ["2 shares"] });
  assert.equal(before.status, "complete");
  assert.equal(after.status, "complete");
  assert.equal(after.totalReactions, 13);
  const mixed = engagementFromLabels({ totals: ["All 12", "All 13"], reactions: [{ label: "Like 13" }], shares: ["2 shares"] });
  assert.equal(mixed.totalReactions, null);
  assert.equal(mixed.status, "partial");
});

test("inspection allowlist rejects every reaction and sharing action", () => {
  for (const label of ["Like", "Love", "Share", "React", "Change Like reaction", "Remove reaction", "Like 123", "Your reactions", "Choose reaction", "Add reaction", "Send reaction", "You and 100 others", "13", "1.2K"]) assert.equal(isReactionInspector(label), false, label);
  for (const label of ["All reactions", "1.2K reactions", "100 people reacted", "See who reacted", "Show reactions", "View who reacted to this photo", "Like: 13 people"]) assert.equal(isReactionInspector(label), true, label);
});

test("view fallback never turns abbreviated totals into exact accounting zeroes", () => {
  const rounded = engagementFromLabels({ totals: ["1.2K reactions"], shares: ["2 shares"], reactions: [{ label: "Like 1.2K" }] });
  const empty = engagementFromLabels({ totals: [], shares: [], reactions: [] });
  const merged = mergeEngagementViews(rounded, empty);
  assert.equal(merged.approximate, true);
  assert.equal(merged.status, "partial");
  assert.deepEqual(merged.reactions, { like: 1200 });
});

test("new category snapshot replaces older categories instead of adding stale counts", () => {
  const before = engagementFromLabels({ totals: ["3 reactions"], shares: ["0 shares"], reactions: [{ label: "Like 2" }, { label: "Love 1" }] });
  const after = engagementFromLabels({ totals: ["2 reactions"], shares: [], reactions: [{ label: "Like 2" }] });
  const merged = mergeEngagementViews(before, after);
  assert.equal(merged.status, "complete");
  assert.equal(merged.reactions.love, 0);
  assert.equal(merged.totalReactions, 2);
});
