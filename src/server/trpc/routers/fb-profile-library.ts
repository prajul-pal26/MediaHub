import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../index';
import { mediaExportDestinations, readExistingMediaRows, saveMediaSheet } from '@/server/services/facebook/media-drive-export';
import { getAuthenticatedDrive } from '@/server/services/drive/client';
import { canonicalSavedProfile, savedRowsToPage } from '@/server/services/facebook/saved-profile-data';
import type { FbBrowserPage } from '@/server/services/facebook/browser-fetcher';
import type { UserProfile } from '@/lib/types';
import { getDb } from '@/lib/supabase/db';
import { decrypt } from '@/lib/encryption';
import { fetchSelectedMedia, resolveActiveFbCookies } from './fb-session';
import { randomUUID } from 'node:crypto';
import { facebookCommentJobs } from '@/server/services/facebook/comment-jobs';
import { enrichMediaSheetPages, validateSheetJobItems } from '@/server/services/facebook/media-sheet-job';
import { commentRetryDisposition } from '@/lib/fb-detail-retry';
import { flattenFbComments } from '@/lib/fb-export';

const scope = z.object({ brandId: z.string().uuid() });
const rowSchema = z.object({ name: z.string(), facebookProfile: z.string(), row: z.number() });
const profileKey = (url: string) => {
  const parsed = new URL(url);
  const handle = parsed.pathname.split('/')[1];
  // This must be byte-for-byte identical to media-drive-export's managed
  // profile identity. A trailing slash here previously made the library miss
  // its own app-managed Sheet and left partial rows unreachable for retry.
  return createHash('sha256').update(`${handle.toLowerCase()}|${parsed.pathname.replace(/\/+$/, '').toLowerCase()}|${parsed.searchParams.get('id') ?? ''}`).digest('hex');
};
async function list(profile: UserProfile, brandId: string) {
  const allowed = await mediaExportDestinations(profile);
  const destination = allowed.find(d=>d.brandId===brandId);
  if (!destination) throw new TRPCError({ code: 'FORBIDDEN', message: 'Choose a connected Drive brand you can access.' });
  const { data, error } = await getDb().from('fb_profile_lists').select('source_file_id,source_name,imported_at,profiles').eq('org_id',profile.org_id).eq('brand_id',brandId).maybeSingle();
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The profile list could not be loaded.' });
  const profiles = data ? z.array(rowSchema).max(10000).parse(data.profiles).map(p=>({...p,url:canonicalSavedProfile(p.facebookProfile)})) : [];
  const { data: stats } = await getDb().from('fb_profile_stats').select('profile_key,photos_count,reels_count').eq('org_id', profile.org_id).eq('brand_id', brandId);
  const typedStats = (stats ?? []) as unknown as { profile_key: string; photos_count: number; reels_count: number }[];
  const byKey = new Map<string, { photos_count: number; reels_count: number }>(typedStats.map((stat) => [stat.profile_key, stat]));
  // The Sheet is the source of truth for these counts. A deleted/moved Sheet
  // must immediately disappear from the summary rather than leaving a stale
  // database count beside an MLA.
  const drive = await getAuthenticatedDrive(brandId, profile.org_id);
  const root = destination.rootFolderUrl.split('/').pop()!;
  const folders = await drive.files.list({ q: `'${escaped(root)}' in parents and name='Facebook scraper' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id)', pageSize: 100 });
  const storedKeys = new Set<string>();
  for (const folder of folders.data.files ?? []) {
    const files = await drive.files.list({ q: `'${escaped(folder.id!)}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet' and appProperties has { key='mh_org' and value='${escaped(profile.org_id)}' } and appProperties has { key='mh_brand' and value='${escaped(brandId)}' }`, fields: 'files(appProperties)', pageSize: 1000 });
    for (const file of files.data.files ?? []) {
      const key = file.appProperties?.mh_fb_profile;
      if (key) storedKeys.add(key);
    }
  }
  return { destination, source: data ? { fileId: data.source_file_id as string, name: data.source_name as string, importedAt: data.imported_at as string } : null,
    profiles: profiles.map(p => {
      const key = p.url ? profileKey(p.url) : undefined;
      const stat = key && storedKeys.has(key) ? byKey.get(key) : undefined;
      return { ...p, photosCount: stat?.photos_count ?? 0, reelsCount: stat?.reels_count ?? 0 };
    }) };
}
const escaped = (s: string) => s.replace(/\\/g,'\\\\').replace(/'/g,"\\'");

/** Fast candidate authorization for an already-loaded local workspace. This
 * deliberately avoids Drive and Sheets reads on every retry. */
async function selectedProfileDestination(profile: UserProfile, brandId: string, url: string) {
  const allowed = await mediaExportDestinations(profile);
  const destination = allowed.find((entry) => entry.brandId === brandId);
  if (!destination) throw new TRPCError({ code: 'FORBIDDEN', message: 'Choose a connected Drive brand you can access.' });
  const [{ data: listRow, error }, custom] = await Promise.all([
    getDb().from('fb_profile_lists').select('profiles').eq('org_id', profile.org_id).eq('brand_id', brandId).maybeSingle(),
    getDb().from('fb_custom_profiles').select('url').eq('org_id', profile.org_id).eq('brand_id', brandId).eq('url', url).maybeSingle(),
  ]);
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The profile list could not be loaded.' });
  const parsedProfiles = z.array(rowSchema).max(10_000).safeParse(listRow?.profiles ?? []);
  const inImportedList = parsedProfiles.success && parsedProfiles.data.some((entry) => canonicalSavedProfile(entry.facebookProfile) === url);
  if (!inImportedList && !custom.data) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Select a Facebook profile from the imported list.' });
  return destination;
}

type SavedProfileData = {
  pages: FbBrowserPage[];
  source: { name: string; url: string | null; modifiedAt: string | null } | null;
};

type WorkspaceSource = (NonNullable<SavedProfileData['source']> & {
  /** Counts captured from the managed Sheet when this local copy was loaded. */
  snapshotCounts?: { photos: number; reels: number };
}) | null;

function collectionCounts(pages: FbBrowserPage[]) {
  return {
    photos: pages.find((page) => page.contentType === 'posts')?.posts.length ?? 0,
    reels: pages.find((page) => page.contentType === 'reels')?.posts.length ?? 0,
  };
}

/** Keep the complete local candidate snapshot, adding only newly fetched media. */
function mergeWorkspacePages(existing: FbBrowserPage[], additions: FbBrowserPage[]): FbBrowserPage[] {
  const byType = new Map(existing.map((page) => [page.contentType, { ...page, posts: [...page.posts] }]));
  for (const page of additions) {
    const current = byType.get(page.contentType);
    if (!current) {
      byType.set(page.contentType, { ...page, posts: [...page.posts] });
      continue;
    }
    const known = new Set(current.posts.map((post) => post.postId));
    current.posts.push(...page.posts.filter((post) => !known.has(post.postId)));
  }
  return ['posts', 'reels'].flatMap((type) => {
    const page = byType.get(type as FbBrowserPage['contentType']);
    return page ? [page] : [];
  });
}

/** Candidate-scoped local working copy. It is intentionally separate from the
 * Google Sheet report: repeated retries merge here without Drive round trips. */
async function readWorkspace(profile: UserProfile, brandId: string, key: string): Promise<SavedProfileData | null> {
  const { data, error } = await getDb().from('fb_profile_workspaces').select('pages,source').eq('org_id', profile.org_id).eq('brand_id', brandId).eq('profile_key', key).maybeSingle();
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The candidate workspace could not be loaded.' });
  if (!data?.pages || !Array.isArray(data.pages)) return null;
  return { pages: data.pages as unknown as FbBrowserPage[], source: (data.source ?? null) as WorkspaceSource };
}

async function saveWorkspace(profile: UserProfile, brandId: string, url: string, pages: FbBrowserPage[], source: WorkspaceSource, loadedFromSheet = false) {
  const { error } = await getDb().from('fb_profile_workspaces').upsert({
    org_id: profile.org_id, brand_id: brandId, profile_key: profileKey(url), profile_url: url,
    pages, source, ...(loadedFromSheet ? { loaded_from_sheet_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString(),
  }, { onConflict: 'org_id,brand_id,profile_key' });
  if (error) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'The candidate workspace could not be saved.' });
}

function workspaceCompletion(
  profile: UserProfile,
  brandId: string,
  url: string,
  pages: FbBrowserPage[],
  source: WorkspaceSource,
  options: { requireExisting?: boolean } = {},
) {
  return async (progress: Parameters<typeof enrichMediaSheetPages>[1]) => {
    // A retry contains only a subset of this candidate's media. Always enrich
    // the full workspace and add only genuinely new media from an update. A
    // late completion must never turn a 400-item candidate into its small
    // retry subset.
    const current = await readWorkspace(profile, brandId, profileKey(url));
    if (!current && options.requireExisting) {
      throw new TRPCError({ code: 'CONFLICT', message: 'The local candidate workspace was reloaded while this retry ran. Reload the candidate before retrying again; its Sheet data is unchanged.' });
    }
    const merged = mergeWorkspacePages(current?.pages ?? [], pages);
    await saveWorkspace(profile, brandId, url, enrichMediaSheetPages(merged, progress), current?.source ?? source);
    // The details-job transport currently calls this a sheet save; retain its
    // stable shape while the UI reloads the local workspace after completion.
    return { url: 'workspace://facebook-candidate', folderUrl: 'workspace://facebook-candidate', fileId: profileKey(url), updatedAt: new Date().toISOString() };
  };
}

/** Read only the app-managed Sheet for one allowed profile. Both the view and
 * the retry path use this so a retry can never target a guessed media URL. */
async function readSavedProfile(profile: UserProfile, brandId: string, profileUrl: string): Promise<SavedProfileData> {
  const url = canonicalSavedProfile(profileUrl);
  if (!url) throw new TRPCError({code:'BAD_REQUEST',message:'Select a Facebook profile from the imported list.'});
  const destination = await selectedProfileDestination(profile, brandId, url);
  const key = profileKey(url);
  const workspace = await readWorkspace(profile, brandId, key);
  // `fb_profile_stats` is calculated from the validated managed Sheet. It is
  // a cheap guard against an old/cancelled subset completion replacing a full
  // local snapshot. A mismatch repairs only this candidate by reading its
  // Sheet again; ordinary retries never make Drive round trips.
  const { data: expected } = await getDb().from('fb_profile_stats').select('photos_count,reels_count').eq('org_id', profile.org_id).eq('brand_id', brandId).eq('profile_key', key).maybeSingle();
  const expectedCounts = expected ? { photos: Number(expected.photos_count) || 0, reels: Number(expected.reels_count) || 0 } : null;
  if (workspace) {
    const actual = collectionCounts(workspace.pages);
    const matchesExpected = !expectedCounts || (actual.photos >= expectedCounts.photos && actual.reels >= expectedCounts.reels);
    if (matchesExpected) return workspace;
  }
  const drive = await getAuthenticatedDrive(brandId,profile.org_id);
  const root = destination.rootFolderUrl.split('/').pop()!;
  const folders = await drive.files.list({q:`'${escaped(root)}' in parents and name='Facebook scraper' and mimeType='application/vnd.google-apps.folder' and trashed=false`,fields:'files(id)',pageSize:100});
  if (!folders.data.files?.length) return { pages: [], source: null };
  const matches = [];
  for(const folder of folders.data.files) {
    const found = await drive.files.list({q:`'${escaped(folder.id!)}' in parents and trashed=false and mimeType='application/vnd.google-apps.spreadsheet' and appProperties has { key='mh_org' and value='${escaped(profile.org_id)}' } and appProperties has { key='mh_brand' and value='${escaped(brandId)}' } and appProperties has { key='mh_fb_profile' and value='${key}' }`,fields:'files(id,name,webViewLink,modifiedTime,parents,appProperties)',pageSize:100});
    matches.push(...(found.data.files??[]));
  }
  if (!matches.length) return { pages: [], source: null };
  if(matches.length!==1) throw new TRPCError({code:'CONFLICT',message:'Multiple saved Sheets match this profile. Choose which to keep in Drive before loading.'});
  const file = (await drive.files.get({fileId:matches[0].id!,fields:'id,name,mimeType,trashed,parents,appProperties,webViewLink,modifiedTime'})).data;
  if(file.trashed || file.mimeType!=='application/vnd.google-apps.spreadsheet' || !folders.data.files.some(f=>file.parents?.includes(f.id!)) || file.appProperties?.mh_org!==profile.org_id || file.appProperties?.mh_brand!==brandId || file.appProperties?.mh_fb_profile!==key) return {pages:[],source:null};
  const {google}=await import('googleapis');
  const sheets=google.sheets({version:'v4',auth:drive.context._options.auth});
  const metadata=await sheets.spreadsheets.get({spreadsheetId:file.id!,fields:'sheets(properties)'});
  try {
    const rows=await readExistingMediaRows(sheets,file.id!,metadata.data.sheets?.flatMap(s=>s.properties?[s.properties]:[])??[]);
    const pages=[savedRowsToPage(rows.photos,'posts',url),savedRowsToPage(rows.reels,'reels',url)].filter((p):p is NonNullable<typeof p>=>!!p);
    const source: WorkspaceSource = {
      name:file.name??'Facebook export', url:file.webViewLink??null, modifiedAt:file.modifiedTime??null,
      snapshotCounts: { photos: rows.photos.length, reels: rows.reels.length },
    };
    await saveWorkspace(profile, brandId, url, pages, source, true);
    return {pages,source};
  } catch { throw new TRPCError({code:'PRECONDITION_FAILED',message:'Saved data could not be read completely. The Sheet is unchanged; use a fresh fetch or repair its managed headers/JSON.'}); }
}

function retryNeeds(post: FbBrowserPage['posts'][number]): { includeComments: boolean; includeReactions: boolean } {
  // This action resumes only concrete comment-stage failures. User-cancelled
  // work, Facebook-filtered views, raw-count-only differences and generic
  // legacy errors remain visible for review but are never replayed implicitly.
  return { includeComments: commentRetryDisposition(post) === 'retry', includeReactions: false };
}

function retryableMedia(post: FbBrowserPage['posts'][number]): boolean {
  return retryNeeds(post).includeComments;
}

export const fbProfileLibraryRouter = router({
  list: protectedProcedure.input(scope).query(({ctx,input})=>list(ctx.profile,input.brandId)),
  custom: protectedProcedure.input(scope).query(async ({ctx,input})=>{
    const catalog=await list(ctx.profile,input.brandId);
    const {data,error}=await getDb().from('fb_custom_profiles').select('name,url').eq('org_id',ctx.profile.org_id).eq('brand_id',input.brandId).order('created_at');
    if(error) throw new TRPCError({code:'INTERNAL_SERVER_ERROR',message:'Profiles could not be loaded.'});
    return ((data ?? []) as unknown as { name: string; url: string }[]).filter((p) => !catalog.profiles.some(mla=>mla.url===p.url));
  }),
  add: protectedProcedure.input(scope.extend({name:z.string().trim().min(1).max(200),profileUrl:z.string().max(2048)})).mutation(async ({ctx,input})=>{
    const catalog=await list(ctx.profile,input.brandId);
    const url=canonicalSavedProfile(input.profileUrl);
    if(!url) throw new TRPCError({code:'BAD_REQUEST',message:'Enter a valid Facebook profile URL.'});
    if(catalog.profiles.some(p=>p.url===url)) return {url};
    const {error}=await getDb().from('fb_custom_profiles').upsert({org_id:ctx.profile.org_id,brand_id:input.brandId,url,name:input.name},{onConflict:'org_id,brand_id,url'});
    if(error) throw new TRPCError({code:'INTERNAL_SERVER_ERROR',message:'Profile could not be saved.'});
    return {url};
  }),
  update: protectedProcedure.input(scope.extend({profileUrl:z.string().max(2048), contentTypes:z.array(z.enum(['posts','reels'])).min(1).max(2), ownerLeaseId:z.string().uuid().optional()})).mutation(async ({ctx,input})=>{
    const url=canonicalSavedProfile(input.profileUrl);
    if(!url) throw new TRPCError({code:'BAD_REQUEST',message:'Choose an MLA profile from the list.'});
    // Candidate work stays local after its initial Sheet load. Reading and
    // reordering Sheets here added latency and could write during a retry.
    const saved = await readSavedProfile(ctx.profile, input.brandId, url);
    const session=await resolveActiveFbCookies(getDb(),ctx.profile.org_id);
    if(!session) throw new TRPCError({code:'PRECONDITION_FAILED',message:'No active Facebook session is configured.'});
    const knownIds={
      posts:saved.pages.find((page)=>page.contentType==='posts')?.posts.map((post)=>post.postId!).filter((id)=>/^\d+$/.test(id)) ?? [],
      reels:saved.pages.find((page)=>page.contentType==='reels')?.posts.map((post)=>post.postId!).filter((id)=>/^\d+$/.test(id)) ?? [],
    };
    const fetched=await fetchSelectedMedia(url,session.cookies,{contentTypes:input.contentTypes,postLimit:1000,photoLimit:1000,reelLimit:1000,bypassCache:true,knownIds});
    const pages=fetched.results.flatMap(result=>result.ok&&result.page&&result.page.posts.length?[result.page]:[]);
    const added={posts:pages.find(p=>p.contentType==='posts')?.posts.length??0,reels:pages.find(p=>p.contentType==='reels')?.posts.length??0};
    if (!pages.length) return { jobId: null, added };
    const items=pages.flatMap(page=>page.posts.map(post=>({postId:post.postId!,url:post.url!,contentType:page.contentType!})));
    validateSheetJobItems(pages,items);
    const job=facebookCommentJobs.start({orgId:ctx.profile.org_id,userId:ctx.profile.id},session.cookies,{items,limit:0,withReplies:true,includeComments:true,includeReactions:true,includeMetadata:true,ownerLeaseId:input.ownerLeaseId},{
      onProgress: workspaceCompletion(ctx.profile, input.brandId, url, pages, saved.source, { requireExisting: true }),
      onComplete:workspaceCompletion(ctx.profile, input.brandId, url, pages, saved.source, { requireExisting: true }),
      onAuthenticationFailure: async () => {
        const { data }=await getDb().from('fb_sessions').select('cookie_encrypted').eq('id',session.id).eq('org_id',ctx.profile.org_id).maybeSingle();
        if (!data?.cookie_encrypted || decrypt(data.cookie_encrypted) !== session.cookies) return;
        await getDb().from('fb_sessions').update({status:'dead',last_error:'Facebook requires a session refresh.',last_checked_at:new Date().toISOString()}).eq('id',session.id).eq('org_id',ctx.profile.org_id).eq('cookie_encrypted',data.cookie_encrypted);
      },
    });
    return { jobId: job.jobId, added };
  }),
  /** Retry only concrete, stage-classified comment failures. The completion
   * handler merges those IDs with the existing Sheet, retaining complete rows
   * and earlier comments when Facebook exposes fewer on retry. */
  retryPartial: protectedProcedure.input(scope.extend({ profileUrl: z.string().max(2048), ownerLeaseId:z.string().uuid().optional() })).mutation(async ({ctx,input})=>{
    const saved = await readSavedProfile(ctx.profile, input.brandId, input.profileUrl);
    const pages = saved.pages.flatMap((page) => {
      const posts = page.posts.filter(retryableMedia);
      return posts.length ? [{ ...page, posts }] : [];
    });
    const items = pages.flatMap((page) => page.posts.map((post) => ({
      postId: post.postId!,
      url: post.url!,
      contentType: page.contentType!,
      ...retryNeeds(post),
      // Existing caption/date fields are already persisted. Partial retries
      // should not reload an otherwise complete media page just to read them.
      includeMetadata: false,
    })));
    if (!items.length) return { jobId: null, total: 0 };
    validateSheetJobItems(pages, items);
    const session = await resolveActiveFbCookies(getDb(),ctx.profile.org_id);
    if (!session) throw new TRPCError({code:'PRECONDITION_FAILED',message:'No active Facebook session is configured. Refresh it in Settings before retrying details.'});
    const job = facebookCommentJobs.start({orgId:ctx.profile.org_id,userId:ctx.profile.id},session.cookies,{
      items,
      limit:0,
      withReplies:true,
      includeComments:items.some((item) => item.includeComments),
      includeReactions:items.some((item) => item.includeReactions),
      includeMetadata:false,
      ownerLeaseId:input.ownerLeaseId,
    },{
      onProgress: workspaceCompletion(ctx.profile, input.brandId, canonicalSavedProfile(input.profileUrl)!, pages, saved.source, { requireExisting: true }),
      onComplete:workspaceCompletion(ctx.profile, input.brandId, canonicalSavedProfile(input.profileUrl)!, pages, saved.source, { requireExisting: true }),
      onAuthenticationFailure: async () => {
        const { data }=await getDb().from('fb_sessions').select('cookie_encrypted').eq('id',session.id).eq('org_id',ctx.profile.org_id).maybeSingle();
        if (!data?.cookie_encrypted || decrypt(data.cookie_encrypted) !== session.cookies) return;
        await getDb().from('fb_sessions').update({status:'dead',last_error:'Facebook requires a session refresh.',last_checked_at:new Date().toISOString()}).eq('id',session.id).eq('org_id',ctx.profile.org_id).eq('cookie_encrypted',data.cookie_encrypted);
      },
    });
    return { jobId: job.jobId, total: items.length };
  }),
  /** Retry a displayed comment-gap range against the local candidate workspace. */
  retryDelta: protectedProcedure.input(scope.extend({ profileUrl:z.string().max(2048), min:z.number().int().min(0), max:z.number().int().min(0), includeMissingPanelCounts:z.boolean().optional().default(false), postIds:z.array(z.string().min(1).max(256)).min(1).max(25).optional(), contentType:z.enum(['posts','reels']).optional(), maxItems:z.number().int().min(1).max(400).optional(), ownerLeaseId:z.string().uuid().optional() })).mutation(async ({ctx,input})=>{
    const saved=await readSavedProfile(ctx.profile,input.brandId,input.profileUrl);
    const url=canonicalSavedProfile(input.profileUrl)!;
    const requestedPostIds = input.postIds ? new Set(input.postIds) : undefined;
    let remaining = input.maxItems ?? Number.POSITIVE_INFINITY;
    const pages=saved.pages.flatMap(page=>{
      if (input.contentType && page.contentType !== input.contentType) return [];
      const posts=page.posts.filter(post=>{
        // A legacy Sheet row without a canonical media ID cannot be retried.
        // Skip it instead of rejecting the entire selected delta range.
        if (!post.postId || !post.url) return false;
        // A card-level retry is explicit. It runs even if the current delta is
        // zero, so a user can refresh a single Reel or Photo on demand.
        if (requestedPostIds) return requestedPostIds.has(post.postId);
        // A separate all-profile pass can fill a missing Newest-panel count
        // without pretending a missing grid badge is zero. It is deliberately
        // opt-in so the ordinary visible delta buckets keep their exact range.
        if (input.includeMissingPanelCounts) return post.commentsReportedDeltaCount == null;
        // Prefer the count Facebook shows inside the selected Newest tray.
        // Older or currently unscanned rows fall back to the raw badge so
        // their retry ranges remain actionable until a panel count is saved.
        const deltaBasis=post.commentsReportedDeltaCount ?? post.commentsReportedCount;
        if (deltaBasis==null) return false;
        const delta=Math.max(0,deltaBasis-flattenFbComments(post.commentsData??[]).length);
        return delta>=input.min && delta<=input.max;
      }).slice(0, remaining);
      remaining -= posts.length;
      return posts.length?[{...page,posts}]:[];
    });
    const items=pages.flatMap(page=>page.posts.map(post=>({
      postId:post.postId!, url:post.url!, contentType:page.contentType! as 'posts'|'reels',
      includeComments:true, includeReactions:false, includeMetadata:false,
      panelCountOnly: input.includeMissingPanelCounts,
    })));
    if(!items.length) return {jobId:null,total:0};
    validateSheetJobItems(pages,items);
    const session=await resolveActiveFbCookies(getDb(),ctx.profile.org_id);
    if(!session) throw new TRPCError({code:'PRECONDITION_FAILED',message:'No active Facebook session is configured.'});
    const completion = workspaceCompletion(ctx.profile,input.brandId,url,pages,saved.source,{ requireExisting: true });
    const job=facebookCommentJobs.start({orgId:ctx.profile.org_id,userId:ctx.profile.id},session.cookies,{items,limit:0,withReplies:true,includeComments:true,includeReactions:false,includeMetadata:false,ownerLeaseId:input.ownerLeaseId,appendToActive:true},{
      onProgress:completion,
      onComplete:completion,
      // Keep this retry path consistent with fresh fetches and partial-detail
      // retries. Otherwise an expired session stays marked active and every
      // subsequent delta retry repeats the same authentication failure.
      onAuthenticationFailure: async () => {
        const { data }=await getDb().from('fb_sessions').select('cookie_encrypted').eq('id',session.id).eq('org_id',ctx.profile.org_id).maybeSingle();
        if (!data?.cookie_encrypted || decrypt(data.cookie_encrypted) !== session.cookies) return;
        await getDb().from('fb_sessions').update({status:'dead',last_error:'Facebook requires a session refresh.',last_checked_at:new Date().toISOString()}).eq('id',session.id).eq('org_id',ctx.profile.org_id).eq('cookie_encrypted',data.cookie_encrypted);
      },
    });
    return {jobId:job.jobId,total:items.length,appendedItems:job.appendedItems,ownerLeaseId:job.ownerLeaseId};
  }),
  /** Explicit final export: the only route that writes a candidate workspace back to Sheets. */
  syncToSheet: protectedProcedure.input(scope.extend({profileUrl:z.string().max(2048)})).mutation(async ({ctx,input})=>{
    const saved=await readSavedProfile(ctx.profile,input.brandId,input.profileUrl);
    return saveMediaSheet(ctx.profile,{brandId:input.brandId,runId:randomUUID(),pages:saved.pages});
  }),
  saved: protectedProcedure.input(scope.extend({ profileUrl: z.string().max(2048) })).query(async ({ctx,input})=>{
    return readSavedProfile(ctx.profile, input.brandId, input.profileUrl);
  }),
});
