type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;

function unixPublishedTime(value: unknown): string | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" && /^\d{10}$/.test(value) ? Number(value) : NaN;
  // These fields are Unix seconds, never milliseconds or relative time labels.
  return Number.isSafeInteger(seconds) && seconds >= 1_075_766_400 && seconds < 4_102_444_800
    ? new Date(seconds * 1000).toISOString() : null;
}

/** Join only this media's creation story; recommended videos, comments and
 * request timestamps in the same page payload do not establish publication. */
export function publishedTimeFromPayloads(payloads: unknown[], item: { postId: string; contentType: "posts" | "reels" }): string | null {
  const nodes: JsonRecord[] = [], pending = [...payloads];
  const visited = new Set<object>();
  while (pending.length && nodes.length < 150_000) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) { pending.push(...value.slice(0, 10_000)); continue; }
    const node = value as JsonRecord;
    nodes.push(node);
    pending.push(...Object.values(node).filter((child) => child && typeof child === "object"));
  }
  const type = item.contentType === "posts" ? "Photo" : "Video";
  const typedMedia = nodes.some((node) => String(node.id) === item.postId && (node.__typename === type || node.__isMedia === type));
  const media = nodes.filter((node) => String(node.id) === item.postId &&
    (node.__typename === type || node.__typename == null && (node.__isMedia === type || typedMedia)));
  const storyIds = new Set<string>();
  for (const node of media) {
    const storyId = record(node.creation_story)?.id;
    if (typeof storyId === "string") storyIds.add(storyId);
  }
  // Native Reel/Watch fragments sometimes expose a story without a typed Video.
  for (const node of nodes) {
    if (item.contentType === "reels" && String(record(node.video)?.id) === item.postId &&
      (node.__typename === "Story" || node.__typename == null && typeof node.post_id === "string") && typeof node.id === "string") storyIds.add(node.id);
  }
  const storyTimes = new Set<string>(), mediaTimes = new Set<string>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || !storyIds.has(node.id) || node.__typename != null && node.__typename !== "Story") continue;
    const date = unixPublishedTime(node.creation_time);
    if (date) storyTimes.add(date);
  }
  for (const node of media) {
    const date = unixPublishedTime(node.publish_time) ?? unixPublishedTime(node.created_time);
    if (date) mediaTimes.add(date);
  }
  // Conflicting fragments must not turn into an arbitrary date.
  if (storyTimes.size) return storyTimes.size === 1 ? [...storyTimes][0] : null;
  return mediaTimes.size === 1 ? [...mediaTimes][0] : null;
}
