import type { EngagementLabels } from "./media-engagement";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const reactionName = (value: unknown): string | null => typeof value === "string" && /^(like|love|care|haha|wow|sad|angry)$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
const countText = (value: unknown): string | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === "string" && /^[\d,.\s]+(?:K|M|B|L|thousand|million|billion|lakh|crore)?$/i.test(value.trim()) ? value.trim() : null;

/** Read only counters on feedback proven to belong to the requested media.
 * Facebook's rendered JSON includes zero shares even when its button omits 0.
 * Recommended reels, comment likes and supported-reaction lists are not counts.
 */
export function engagementLabelsFromPayloads(payloads: unknown[], item: { postId: string; contentType: "posts" | "reels" }): {
  labels: EngagementLabels; feedbackIds: string[]; storyId?: string;
} {
  const objects: RecordValue[] = [];
  const pending = [...payloads];
  while (pending.length && objects.length < 150_000) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value.slice(0, 10_000)); continue; }
    const node = value as RecordValue;
    objects.push(node);
    pending.push(...Object.values(node).filter((child) => child && typeof child === "object"));
  }
  const feedbackIds = new Set<string>();
  let storyId: string | undefined;
  for (const node of objects) {
    // Watch's data.feedback fragments can omit the outer Video typename. The
    // feedback's explicit associated_video relationship still proves ownership.
    if (item.contentType === "reels" && String(record(node.associated_video)?.id) === item.postId
      && typeof node.id === "string" && (node.__typename == null || node.__typename === "Feedback")) {
      feedbackIds.add(node.id);
    }
    const isMedia = String(node.id) === item.postId && (node.__typename === "Photo" || node.__typename === "Video" || node.__isMedia != null);
    const matchesVideo = item.contentType === "reels" && (String(record(node.video)?.id) === item.postId ||
      (Array.isArray(node.attachments) && node.attachments.some((attachment) => String(record(record(attachment)?.media)?.id) === item.postId)));
    if (!isMedia && !matchesVideo) continue;
    const feedbackId = record(node.feedback)?.id;
    if (typeof feedbackId === "string" && feedbackId) feedbackIds.add(feedbackId);
    if (matchesVideo && typeof node.post_id === "string" && /^\d+$/.test(node.post_id)) storyId = node.post_id;
  }
  const feedback = objects.filter((node) => typeof node.id === "string" && feedbackIds.has(node.id));
  const names = new Map<string, string>();
  for (const node of feedback) {
    const edges = record(node.top_reactions)?.edges;
    const infos = [...(Array.isArray(node.supported_reaction_infos) ? node.supported_reaction_infos : []),
      ...(Array.isArray(edges) ? edges.map((edge) => record(edge)?.node) : [])];
    for (const info of infos) {
      const value = record(info);
      const name = reactionName(value?.localized_name) ?? reactionName(value?.name);
      if (typeof value?.id === "string" && name) names.set(value.id, name);
    }
  }
  const totals = new Set<string>(), shares = new Set<string>();
  const reactions = new Map<string, { label: string }>();
  for (const node of feedback) {
    // likers is deliberately excluded: its meaning differs between FB surfaces.
    for (const value of [record(node.reaction_count)?.count, record(node.unified_reactors)?.count, record(node.reactors)?.count, node.i18n_reaction_count, node.reaction_count_reduced]) {
      const count = countText(value); if (count !== null) totals.add(`${count} reactions`);
    }
    for (const value of [record(node.share_count)?.count, record(node.reshares)?.count, node.i18n_share_count, node.share_count_reduced]) {
      const count = countText(value); if (count !== null) shares.add(`${count} shares`);
    }
    const edges = record(node.top_reactions)?.edges;
    if (!Array.isArray(edges)) continue;
    for (const edge of edges) {
      const value = record(edge), type = record(value?.node);
      const kind = reactionName(type?.localized_name) ?? reactionName(type?.name) ?? (typeof type?.id === "string" ? names.get(type.id) : undefined);
      const count = countText(value?.reaction_count) ?? countText(value?.i18n_reaction_count);
      if (kind && count !== null) reactions.set(`${kind}:${count}`, { label: `${kind} ${count}` });
    }
  }
  return { labels: { totals: [...totals], shares: [...shares], reactions: [...reactions.values()] }, feedbackIds: [...feedbackIds], storyId };
}
