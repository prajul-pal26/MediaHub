import { summarizeFbComments, type FbBrowserComment, type FbBrowserPage, type FbBrowserPost, type FbCommentsAccessibility } from './browser-fetcher';
import { fbExportPageSchema, mergeSavedComments } from './media-drive-export';

export function canonicalSavedProfile(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || !/^(www\.|m\.|web\.)?facebook\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const handle = parts[0] === 'profile.php' ? u.searchParams.get('id') : parts[0] === 'people' ? parts[2]
      : parts[0] === 'p' ? /-(\d+)$/.exec(parts[1] ?? '')?.[1] : parts[0];
    if (!handle || !/^[a-z0-9._-]+$/i.test(handle) || /^(groups|reel|watch|photo|photo.php|videos|posts|login|share)$/i.test(handle)) return null;
    if (parts.length > 1 && !['people','p'].includes(parts[0]) && !(parts.length===2 && parts[1]==='about')) return null;
    return `https://www.facebook.com/${handle.toLowerCase()}/`;
  } catch { return null; }
}
const text = (row: Record<string,string>, key: string) => row[key] || '';
const number = (row: Record<string,string>, key: string) => {
  const value = text(row,key).trim();
  return value && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
};
const textCommentCount = (comments: NonNullable<FbBrowserPost['commentsData']> = []) => {
  let count = 0;
  const pending = [...comments];
  while (pending.length) {
    const comment = pending.pop()!;
    if (comment.text.trim()) count++;
    pending.push(...(comment.replies ?? []));
  }
  return count;
};
function link(value: string) {
  try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}

/** A Sheet is an export record, not the source of the raw Facebook badge.
 * A Newest-panel total is a separately stored operational basis; it can be
 * restored after a manual workspace reload even before a second scan upgrades
 * it to the stronger verified-accessible classification. */
function savedCommentsAccessibility(row: Record<string, string>, reportedCount: number | null): Pick<FbBrowserPost, 'commentsVerifiedAccessibleCount' | 'commentsReportedDeltaCount' | 'commentsAccessibility'> {
  const panelCount = number(row, 'Reported Delta Count');
  const validPanelCount = panelCount != null && (reportedCount == null || panelCount <= reportedCount)
    ? panelCount
    : undefined;
  const verified = number(row, 'Comments Accessible Count (Verified)');
  const status = text(row, 'Comments Accessibility Status');
  let rawEvidence: unknown;
  try { rawEvidence = JSON.parse(text(row, 'Comments Accessibility Evidence')); } catch { rawEvidence = null; }
  if (!rawEvidence || typeof rawEvidence !== 'object') {
    return validPanelCount == null ? {} : { commentsReportedDeltaCount: validPanelCount };
  }
  const evidence = rawEvidence as Record<string, unknown>;
  const sourceView = evidence.sourceView === 'all' || evidence.sourceView === 'newest' ? evidence.sourceView : null;
  const stablePasses = typeof evidence.stablePasses === 'number' ? evidence.stablePasses : NaN;
  const evidenceReported = typeof evidence.reportedCount === 'number' ? evidence.reportedCount : NaN;
  const fingerprint = typeof evidence.lastScanFingerprint === 'string' ? evidence.lastScanFingerprint : '';
  if (!sourceView || !Number.isInteger(stablePasses) || stablePasses < 1 || !Number.isFinite(evidenceReported) || evidenceReported < 0 || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
    return validPanelCount == null ? {} : { commentsReportedDeltaCount: validPanelCount };
  }
  const accessibility: FbCommentsAccessibility = {
    sourceView,
    stablePasses,
    reportedCount: evidenceReported,
    lastScanFingerprint: fingerprint,
    ...(typeof evidence.verifiedAt === 'string' ? { verifiedAt: evidence.verifiedAt } : {}),
  };
  const verifiedStatus = /^Verified after (\d+) matching (All comments|Newest) scans$/.exec(status);
  const hasMatchingVerifiedStatus = verifiedStatus
    && Number(verifiedStatus[1]) === stablePasses
    && (verifiedStatus[2] === 'All comments' ? 'all' : 'newest') === sourceView;
  if (verified == null || !hasMatchingVerifiedStatus || stablePasses < 2 || (reportedCount != null && verified > reportedCount)) {
    return { ...(validPanelCount != null ? { commentsReportedDeltaCount: validPanelCount } : {}), commentsAccessibility: accessibility };
  }
  // This count is derived from the same independently verified evidence as
  // the accessible target. Ignore any hand-edited Sheet value rather than
  // letting it mask a raw Facebook gap after reload.
  return { commentsVerifiedAccessibleCount: verified, commentsReportedDeltaCount: validPanelCount ?? verified, commentsAccessibility: accessibility };
}

const SAVED_COMMENT_TYPES = new Set(["text", "gif", "image", "video", "attachment", "unavailable"]);

/** Older saved runs labelled emoji-only comments as `emoji`.  The current
 * detail schema represents those as text, so normalize that legacy label on
 * read instead of rejecting the whole profile Sheet. Unknown future labels
 * are omitted: the comment itself and all of its replies remain intact. */
function normalizeSavedCommentTypes(comments: FbBrowserPost["commentsData"] = []): NonNullable<FbBrowserPost["commentsData"]> {
  return comments.map((comment) => {
    const rawContentType = (comment as { contentType?: string }).contentType;
    const contentType = rawContentType === "emoji"
      ? "text"
      : SAVED_COMMENT_TYPES.has(rawContentType ?? "") ? rawContentType : undefined;
    return {
      ...comment,
      ...(contentType ? { contentType } : { contentType: undefined }),
      replies: normalizeSavedCommentTypes(comment.replies ?? []),
    } as FbBrowserComment;
  });
}

/** Saved exports reconstruct the same result type. Absent values stay unknown. */
export function savedRowsToPage(rows: Record<string,string>[], type: 'posts'|'reels', expectedUrl: string): FbBrowserPage | null {
  if (!rows.length) return null;
  const canonical = canonicalSavedProfile(expectedUrl);
  if (!canonical || rows.some(r => canonicalSavedProfile(r['Profile URL']) !== canonical)) throw new Error('Saved rows belong to a different Facebook profile.');
  const first = rows[0];
  const posts: FbBrowserPost[] = rows.map(row => {
    const id = row['Post ID'];
    if (!/^\d{1,40}$/.test(id)) throw new Error('Saved media has an invalid ID.');
    const postUrl = type === 'posts' ? `https://www.facebook.com/photo.php?fbid=${id}` : `https://www.facebook.com/reel/${id}/`;
    const rawComments = row['Comments JSON'] ? JSON.parse(row['Comments JSON']) : [];
    if (!Array.isArray(rawComments)) throw new Error('Saved comments are not an array.');
    const comments = normalizeSavedCommentTypes(mergeSavedComments([],rawComments).comments);
    const reactions: NonNullable<FbBrowserPost['engagement']>['reactions'] = {};
    for (const kind of ['like','love','care','haha','wow','sad','angry'] as const) {
      const count = number(row,`${kind[0].toUpperCase()}${kind.slice(1)} Count`);
      if (count !== null) reactions[kind] = count;
    }
    const total = number(row,'Reactions Count'), shares = number(row,'Shares Count');
    const hasEngagement = !!row['Reactions Status'] || total !== null || shares !== null || Object.keys(reactions).length > 0;
    const reported = number(row,'Comments Count (Reported)');
    const status = row['Comments Status'];
    const storedTextCount = number(row,'Comments Text Count');
    // A failed pre-scope retry used to replace this derived cell with zero
    // while preserving the JSON tree. Recover that precise legacy failure on
    // read so the next normal managed save repairs the displayed count.
    const recoveredTextCount = status === 'failed'
      && row['Comments Error'] === 'Facebook comments could not be retrieved for this item. Retry it in a new run.'
      && storedTextCount === 0
      ? textCommentCount(comments)
      : storedTextCount;
    return {
      postId: id, url: postUrl, mediaType: type === 'posts' ? 'photo' : 'reel', isVideo: type === 'reels',
      text: text(row,'Message / Caption'), publishedTime: text(row,'Published Time') || null,
      video: link(text(row,'Video URL')), views: number(row,'Views Count'), images: [],
      metricsAvailable: false, likes: total ?? 0, shares: shares ?? 0, comments: reported ?? 0,
      commentsReportedCount: reported, commentsData: comments, commentsBreakdown: summarizeFbComments(comments),
      commentsObservedCount: number(row,'Comments Retrieved Count') ?? undefined,
      ...savedCommentsAccessibility(row, reported),
      commentsTextCount: recoveredTextCount ?? undefined,
      commentsExcludedNonTextCount: number(row,'Comments Excluded Non-text Count') ?? undefined,
      commentsExcludedAttachmentCount: number(row,'Comments Excluded Attachment Count') ?? undefined,
      commentsContentScope: row['Comments Content Scope'] === 'text_only' || row['Comments Content Scope'] === 'observed_nodes'
        ? row['Comments Content Scope'] : undefined,
      commentsSourceView: ['all','newest','most_relevant','unknown'].includes(row['Comments Source View'])
        ? row['Comments Source View'] as FbBrowserPost['commentsSourceView'] : undefined,
      commentsStatus: ['pending','running','complete','partial','failed','cancelled'].includes(status) ? status as FbBrowserPost['commentsStatus'] : comments.length ? 'partial' : undefined,
      commentsStopReason: text(row,'Comments Stop Reason') || undefined, commentsError: text(row,'Comments Error') || undefined,
      engagement: hasEngagement ? { totalReactions: total, shares, reactions,
        status: row['Reactions Status'] === 'complete' ? 'complete' : 'partial',
        approximate: row['Reaction Counts Approximate']?.toLowerCase() === 'true',
        error: row['Reactions Error'] || undefined,
      } : undefined,
    };
  });
  if (new Set(posts.map(p=>p.postId)).size !== posts.length) throw new Error('Saved media contains duplicate IDs.');
  const page: FbBrowserPage = {
    contentType: type, url: canonical, handle: text(first,'Handle / ID') || new URL(canonical).pathname.split('/')[1],
    name: text(first,'Page / Profile Name'), profilePic: null, followers: number(first,'Total Followers'), likes: null,
    category: text(first,'Category') || null, about: text(first,'About / Intro') || null, verified: false,
    email: text(first,'Email') || null, phone: text(first,'Phone') || null,
    instagram: link(text(first,'Instagram')), twitter: link(text(first,'Twitter / X')), website: null, posts,
  };
  // Validate the reconstructed tree against the same bounds as live exports.
  fbExportPageSchema.parse(page);
  return page;
}
