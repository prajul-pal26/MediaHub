# Media Publication Platform — Complete Build Specification

> **For Claude Code**: Read this ENTIRE file before writing any code. This is the complete spec for an AI-powered social media management platform. Build exactly what is described — do not deviate from the architecture.

---

## WHAT TO BUILD

A full-stack social media automation platform for agencies with three modes:

1. **Chat Mode** — Users talk to OpenClaw AI agents to create/schedule/analyze content via natural language
2. **Click Mode** — Traditional dashboard UI (media library, upload, publish, calendar, queue, accounts, brands)
3. **Analytics Mode** — Performance dashboards across Instagram, YouTube, and LinkedIn

This is an **agency platform** — one organization has multiple brands (clients), each brand has multiple social accounts. Media is stored in the client's own Google Drive — the platform stores ZERO media files.

---

## TECH STACK (Do not deviate)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | Next.js 14+ (App Router) | TypeScript, server components |
| API | tRPC | Type-safe, co-located with frontend |
| Database | Supabase (PostgreSQL) | Self-hosted via Docker, multi-tenant via RLS |
| Job Queue | BullMQ + Redis | For publishing, analytics fetching, media processing, token refresh |
| File Storage | Google Drive (client's own) | Platform stores zero files — only Drive file IDs in DB |
| Auth | Supabase Auth | JWT with org_id, role, and brand_id claims |
| Styling | Tailwind CSS + shadcn/ui | Consistent design system |
| AI Agents | OpenClaw | External — communicates via same tRPC API |
| Real-time | Supabase Realtime | For live status updates |

**Core Principle: One API, two clients.** Dashboard (Click Mode) and OpenClaw agents (Chat Mode) use the exact same tRPC API. No separate agent API.

---

## ROLE SYSTEM (6 Roles, 2 Levels)

### Agency Level (internal team)
- **super_admin** — Full access to everything. All brands, billing, user management, platform credentials. Only 1-2 per org.
- **agency_admin** — Sees all brands, manages accounts and posts. No billing or platform credentials access.
- **agency_editor** — Assigned to specific brands only. Creates/schedules posts for assigned brands.

### Brand Level (client users who log in)
- **brand_owner** — Sees ONLY their own brand. Views analytics, approves content, invites brand members. Cannot see other brands exist.
- **brand_editor** — Own brand only. Creates/schedules posts, views analytics. No account management.
- **brand_viewer** — Read-only access to own brand. Views analytics, exports reports. Cannot create or modify.

### Key Rules
- Brand users never see the brand switcher — it's hidden from their UI.
- Agency editors see only their assigned_brands list.
- RLS enforces all access at database level — even raw SQL is scoped.
- OpenClaw agents inherit the logged-in user's role — no more, no less.
- Content approval flow: agency creates post → brand_owner approves → post schedules.

### RLS Logic
```
IF role = super_admin or agency_admin → show ALL brands in their org
IF role = agency_editor → show only brands in assigned_brands array
IF role = brand_owner or brand_editor or brand_viewer → show ONLY data where brand_id = user's brand_id
```

### User Invitation Rules

**Two methods:**
- **Direct add** (for internal agency team only) — super_admin/agency_admin creates account directly, person gets welcome email with password setup link
- **Email invite with consent** (for brand/client users) — sends invitation email, invitee must click accept, invite expires in 7 days

**Who can invite whom:**
```
super_admin can invite:
  → agency_admin, agency_editor (direct add)
  → brand_owner, brand_editor, brand_viewer (email invite)

agency_admin can invite:
  → agency_editor (direct add)
  → brand_owner, brand_editor, brand_viewer (email invite)

brand_owner can invite (own brand only):
  → brand_editor, brand_viewer (email invite)

agency_editor, brand_editor, brand_viewer → cannot invite anyone
```

**Who can manage whom:**
```
super_admin → all users in org (except cannot remove themselves)
agency_admin → agency_editors + all brand-level users (cannot manage super_admin or other agency_admins)
brand_owner → brand_editor and brand_viewer in their own brand only
```

---

## PLATFORM CREDENTIALS (Super Admin Only)

The platform needs developer app credentials for each social platform. These are created ONCE by the super_admin and used for ALL users' OAuth flows.

### Super Admin Settings Page — Platform Credentials Section
Only visible to super_admin role. Shows a settings page where admin can enter/update:

**Instagram / Meta:**
- Facebook App ID
- Facebook App Secret
- OAuth Redirect URI (auto-generated: `{APP_URL}/api/callback/instagram`)
- App Review Status indicator (development / in review / approved)

**YouTube / Google:**
- Google Client ID
- Google Client Secret
- OAuth Redirect URI (auto-generated: `{APP_URL}/api/callback/youtube`)

**LinkedIn:**
- LinkedIn Client ID
- LinkedIn Client Secret
- OAuth Redirect URI (auto-generated: `{APP_URL}/api/callback/linkedin`)

**Google Drive:**
- Uses same Google Client ID/Secret as YouTube (same GCP project)

These credentials are stored encrypted in a `platform_credentials` table (org-level, not brand-level). When any user clicks "Connect Instagram" on any brand, the system uses these credentials for the OAuth flow.

### Table: platform_credentials
```sql
CREATE TABLE platform_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  platform TEXT NOT NULL, -- 'instagram', 'youtube', 'linkedin', 'google_drive'
  client_id_encrypted TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  status TEXT DEFAULT 'development', -- 'development', 'in_review', 'approved'
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, platform)
);
```

### Social Account Connection — Two Methods

**Method A: One-click OAuth (primary — for all users)**
User clicks "Connect Instagram" → redirected to Facebook/Google/LinkedIn → authorizes → token stored. Uses platform_credentials from super_admin settings. This is the main flow once apps are approved.

**Method B: Manual token entry (advanced — for developers/testing)**
Expandable "Advanced" section on accounts page. User pastes their own access token + page ID. System validates token with a test API call. For use during development phase or by agencies with their own Meta/Google apps.

---

## BRAND SETUP FLOW (3 Steps)

When a super_admin or agency_admin creates a new brand:

```
Step 1: Brand details
  → Enter brand name, upload logo, set preferences
  → Brand created in database with status "setup_incomplete"

Step 2: Connect Google Drive (one-time, never asked again)
  → System prompts "Connect this brand's Google Drive"
  → Admin clicks Connect → Google OAuth → selects account → grants Drive access
  → System auto-creates MediaHub/Originals/ and MediaHub/Processed/ folders
  → drive_connections row created with tokens + folder IDs
  → Drive shown on Accounts page alongside social accounts

Step 3: Connect social accounts
  → Connect Instagram, YouTube, LinkedIn via OAuth (or manual token)
  → Multiple accounts per platform allowed
```

After setup: Drive always connected. Uploads auto-go to that Drive. Never asked again.
If Drive disconnects: Warning banner on dashboard. Admin or brand_owner reconnects.

Post-setup:
4. Admin invites brand_owner for that brand
5. Brand owner logs in → sees only their brand → invites their team
6. Agency assigns agency_editors to the brand if needed

---

## DATABASE SCHEMA

### organizations
```sql
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### users
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE SET NULL,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT CHECK (role IN ('super_admin', 'agency_admin', 'agency_editor', 'brand_owner', 'brand_editor', 'brand_viewer')) DEFAULT 'brand_viewer',
  assigned_brands UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### brands
```sql
CREATE TABLE brands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  logo_url TEXT,
  settings JSONB DEFAULT '{}',
  setup_status TEXT DEFAULT 'incomplete', -- 'incomplete', 'active'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### social_accounts
```sql
CREATE TABLE social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  platform TEXT CHECK (platform IN ('instagram', 'youtube', 'linkedin')) NOT NULL,
  platform_user_id TEXT NOT NULL,
  platform_username TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  connection_method TEXT DEFAULT 'oauth', -- 'oauth' or 'manual_token'
  platform_metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### drive_connections
```sql
CREATE TABLE drive_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL UNIQUE,
  google_account_email TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  token_expires_at TIMESTAMPTZ,
  root_folder_id TEXT NOT NULL,
  folder_ids JSONB DEFAULT '{}', -- { originals: "id", processed: "id" }
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### media_groups
```sql
CREATE TABLE media_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  uploaded_by UUID REFERENCES users(id),
  title TEXT NOT NULL,
  caption TEXT,
  description TEXT,
  tags TEXT[] DEFAULT '{}',
  notes TEXT,
  variant_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'available', -- 'available', 'archived'
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### media_assets
```sql
CREATE TABLE media_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  drive_file_id TEXT NOT NULL,
  processed_drive_file_id TEXT,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  aspect_ratio TEXT,
  duration_seconds INTEGER,
  tagged_platform TEXT CHECK (tagged_platform IN ('instagram', 'youtube', 'linkedin')),
  tagged_account_id UUID REFERENCES social_accounts(id),
  tagged_action TEXT CHECK (tagged_action IN ('post', 'reel', 'short', 'story', 'video', 'carousel', 'article')),
  metadata JSONB DEFAULT '{}',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### content_posts
```sql
CREATE TABLE content_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES media_groups(id) ON DELETE CASCADE NOT NULL,
  brand_id UUID REFERENCES brands(id) ON DELETE CASCADE NOT NULL,
  scheduled_by UUID REFERENCES users(id),
  status TEXT CHECK (status IN ('draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'failed')) DEFAULT 'draft',
  caption_overrides JSONB DEFAULT '{}', -- { instagram: "...", youtube_title: "...", linkedin: "..." }
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  source TEXT CHECK (source IN ('chat', 'click', 'api')) DEFAULT 'click',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### publish_jobs
```sql
CREATE TABLE publish_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE NOT NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE NOT NULL,
  action TEXT NOT NULL, -- 'ig_post', 'ig_reel', 'ig_story', 'ig_carousel', 'yt_video', 'yt_short', 'li_post', 'li_article'
  resize_option TEXT, -- 'auto_crop', 'blur_bg', 'custom_crop', 'keep_original', null
  status TEXT CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'dead')) DEFAULT 'queued',
  attempt_count INTEGER DEFAULT 0,
  error_message TEXT,
  platform_post_id TEXT,
  completed_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### post_analytics
```sql
CREATE TABLE post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES content_posts(id) ON DELETE CASCADE NOT NULL,
  social_account_id UUID REFERENCES social_accounts(id) ON DELETE CASCADE NOT NULL,
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  engagement_rate FLOAT DEFAULT 0,
  reach INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  platform_specific JSONB DEFAULT '{}',
  fetched_at TIMESTAMPTZ DEFAULT now()
);
```

### api_keys
```sql
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  key_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions JSONB DEFAULT '[]',
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### audit_log
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id UUID,
  source TEXT CHECK (source IN ('chat', 'click', 'api')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### invitations
```sql
CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  brand_id UUID REFERENCES brands(id),
  invited_by UUID REFERENCES users(id) NOT NULL,
  token_hash TEXT NOT NULL,
  method TEXT DEFAULT 'email_invite', -- 'email_invite' or 'direct_add'
  status TEXT DEFAULT 'pending', -- 'pending', 'accepted', 'expired', 'cancelled'
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

### RLS Policy Pattern (apply to ALL tables)
```sql
ALTER TABLE brands ENABLE ROW LEVEL SECURITY;

-- Agency users see all or assigned brands
CREATE POLICY "agency_access" ON brands FOR ALL USING (
  org_id = (SELECT org_id FROM users WHERE id = auth.uid())
  AND (
    (SELECT role FROM users WHERE id = auth.uid()) IN ('super_admin', 'agency_admin')
    OR (
      (SELECT role FROM users WHERE id = auth.uid()) = 'agency_editor'
      AND id = ANY((SELECT assigned_brands FROM users WHERE id = auth.uid()))
    )
  )
);

-- Brand users see only their own brand
CREATE POLICY "brand_access" ON brands FOR SELECT USING (
  id = (SELECT brand_id FROM users WHERE id = auth.uid())
  AND (SELECT role FROM users WHERE id = auth.uid()) IN ('brand_owner', 'brand_editor', 'brand_viewer')
);
```

---

## MEDIA STORAGE — GOOGLE DRIVE (ZERO SERVER STORAGE)

- Each brand connects their own Google Drive (one-time during brand setup)
- System auto-creates `MediaHub/Originals/` and `MediaHub/Processed/` folders
- All uploads go directly to brand's Drive — never touches your server
- Database stores drive_file_id references only
- At publish time: worker downloads from Drive → uploads to social platform API → deletes temp copy

---

## TWO-PHASE CONTENT SYSTEM

### Phase A — Upload (anyone with edit permissions)
- Upload form: drag-and-drop single or multiple files
- Accept ANY file size, ANY ratio — no restrictions, no processing
- Media group concept: single file = group of 1, multiple variants = group of N
- Per-variant optional tagging: platform, account, action
- Shared details per group: title, caption, tags, description, notes
- Files uploaded directly to brand's Google Drive (MediaHub/Originals/)
- Auto-detect file metadata: type, dimensions, ratio, duration
- Content appears in Media Library with status "available"

### Phase B — Publish (anyone with edit permissions, different person can publish)
1. Publisher opens Media Library → selects a media group
2. Single-variant groups: one action panel
3. Multi-variant groups: separate action panel PER variant
4. Each panel shows only VALID actions based on rules engine (see below)
5. Publisher selects actions → only matching accounts appear
6. Accounts auto-suggested based on variant tags, but changeable
7. If file ratio doesn't match platform requirement → resize options appear:
   - Auto center-crop (default)
   - Blur background fill
   - Custom crop (manual framing)
   - Keep original (platform may add black bars)
8. Caption, tags, description auto-filled from upload — editable + per-platform overrides
9. Publisher chooses: **Publish now** or **Schedule for later**
10. Schedule picker: centered popup with dark overlay, calendar for date, 12-hour scrollers (hour + minute in 5-min increments) with AM/PM toggle
11. Publish summary shows all jobs before confirming
12. System creates content_post + publish_jobs

### Platform Rules Engine
```
IMAGE files can be:
  → Instagram Post (1:1, 4:5, 1.91:1), Instagram Story (9:16), Instagram Carousel (1:1, 4:5)
  → LinkedIn Post (1:1, 1.91:1, 4:5), LinkedIn Article cover (1.91:1)
  CANNOT be: Reel, Short, YouTube Video

VIDEO files:
  Under 60s → Reel, Short, Story, Feed Video, Full Video, LinkedIn Video
  60-90s → Reel, Feed Video, Full Video, LinkedIn Video (NOT Story, NOT Short)
  Over 90s → Feed Video, Full YouTube Video, LinkedIn Video only
  CANNOT be: Image Post, Carousel, Article

PLATFORM OUTPUT SPECS:
  IG Post:     1080x1080 or 1080x1350 or 1080x566
  IG Reel:     1080x1920 (9:16), max 90 sec
  IG Story:    1080x1920 (9:16), max 60 sec
  IG Carousel: 1080x1080 or 1080x1350, 2-10 items
  YT Video:    1920x1080 (16:9), up to 4K
  YT Short:    1080x1920 (9:16), max 60 sec
  LI Post:     1200x1200 or 1200x627
  LI Article:  1200x627 cover image
```

### Platform-Aware Metadata
- Instagram Post/Reel → caption + tags as hashtags
- Instagram Story → NO caption, NO tags
- YouTube Video → title + description + tags
- YouTube Short → caption as title + tags
- LinkedIn Post → caption
- LinkedIn Article → title + description

---

## PUBLISHING PIPELINE

1. Publisher clicks "Schedule" or "Publish now"
2. content_post created (status: scheduled or publishing)
3. One publish_job per variant-account pair, each linking to correct asset_id
4. Jobs queued in BullMQ (delayed to scheduled_at, or immediate for publish now)
5. BullMQ uses Redis sorted sets — zero CPU usage until scheduled time arrives
6. At scheduled time, worker:
   a. Checks if resize needed → processes → saves to Drive Processed/
   b. Downloads correct file version from Drive
   c. Uploads to platform API (Instagram/YouTube/LinkedIn)
   d. Deletes temp file from server
7. Success → status: published, platform_post_id saved
8. Failure → retry 3 times (60s, 120s, 240s backoff)
9. After 3 failures → Dead Letter Queue, user notified
10. Per-account rate limiting: IG 2/min, YT 1/5min, LI 3/min

---

## CLICK MODE — UI PAGES

### 1. Media Library (home page of Click Mode)
- Grid view of all media groups with variant badges
- Metric cards: total media, groups, available, published
- Search by title, tags
- Filter: All | Images | Videos | Groups
- Upload button → goes to Upload page
- Select media → goes to Publish page

### 2. Upload Page
- Drag-and-drop zone for single or multiple files
- Each file shown as a variant card with detected metadata (type, dimensions, ratio, duration)
- Per-variant tagging: dropdown for platform, account, action (all optional)
- Shared fields: title, caption, tags, description, notes
- "Upload to library" button — files go to Drive, metadata to DB

### 3. Publish Page
- Shows selected media group with all variants
- Per-variant action panel (valid actions only, based on rules engine)
- Per-variant account selector (only matching accounts)
- Resize options shown when ratio mismatch detected
- Shared caption/tags auto-filled, with per-platform override buttons
- Two buttons: "Publish now" and "Schedule for later"
- Schedule picker popup: dark overlay, centered modal, calendar + 12hr time scrollers + AM/PM
- Publish summary showing all jobs before confirmation

### 4. Calendar Page
- Month / week / day toggle views
- Drag-and-drop rescheduling
- Posts color-coded by platform (IG=pink, YT=red, LI=blue)
- Status indicators: draft, scheduled, published, failed
- Filter by brand, platform, status

### 5. Queue Page
- Metric cards: queued, completed today, failed
- List of all publish jobs with status badges
- Failed jobs have "Retry" button
- Real-time updates via Supabase Realtime

### 6. Accounts Page
- List of all connected social accounts + Google Drive
- Per-account: platform icon, username, token health, expiry date
- "Connect account" button with two methods:
  - Primary: One-click OAuth (uses platform credentials from admin settings)
  - Advanced (expandable): Manual token entry with validation
- "Disconnect" per account

### 7. Brands Page
- List of all brands with account count and media count
- "Add brand" button → 3-step setup flow (details → Drive → social accounts)

### 8. Settings Page (super_admin only sections)
- **Platform Credentials** section (super_admin only):
  - Instagram/Meta: App ID, App Secret, redirect URI (auto-generated), review status badge
  - YouTube/Google: Client ID, Client Secret, redirect URI
  - LinkedIn: Client ID, Client Secret, redirect URI
  - Save button with validation (test API call to verify credentials)
- User management: list members, invite, change roles, remove
- Organization settings: name, plan, preferences

---

## OPENCLAW INTEGRATION

Agents authenticate via JWT/API key mapped to a user. Agent inherits user's role — RLS enforces at DB level. Agent actions logged with source: "chat".

Tools map 1:1 to tRPC endpoints:
- create_media_group, upload_media, list_media
- publish_content, schedule_content
- get_analytics, list_accounts, list_brands
- cancel_post, retry_failed, get_queue_status

---

## FILE STRUCTURE

```
media-publication/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/page.tsx
│   │   │   ├── signup/page.tsx
│   │   │   └── callback/[platform]/route.ts
│   │   ├── (dashboard)/
│   │   │   ├── layout.tsx                     # Shell: sidebar + header + mode switcher
│   │   │   ├── chat/page.tsx                  # Chat Mode
│   │   │   ├── library/page.tsx               # Media Library
│   │   │   ├── upload/page.tsx                # Upload form
│   │   │   ├── publish/[groupId]/page.tsx     # Publish page for selected media
│   │   │   ├── calendar/page.tsx              # Content calendar
│   │   │   ├── queue/page.tsx                 # Publishing queue
│   │   │   ├── accounts/page.tsx              # Social accounts + Drive
│   │   │   ├── brands/page.tsx                # Brand management
│   │   │   ├── brands/new/page.tsx            # 3-step brand setup
│   │   │   ├── analytics/page.tsx             # Analytics overview
│   │   │   ├── analytics/posts/page.tsx       # Per-post analytics
│   │   │   ├── analytics/export/page.tsx      # Export reports
│   │   │   └── settings/page.tsx              # Org settings + platform credentials
│   │   ├── api/
│   │   │   ├── trpc/[trpc]/route.ts
│   │   │   └── webhooks/[platform]/route.ts
│   │   └── layout.tsx
│   │
│   ├── server/
│   │   ├── trpc/
│   │   │   ├── index.ts
│   │   │   ├── router.ts
│   │   │   ├── routers/
│   │   │   │   ├── media.ts              # Upload, list, search media groups
│   │   │   │   ├── publish.ts            # Publish, schedule, cancel
│   │   │   │   ├── social-accounts.ts    # Connect, disconnect, list
│   │   │   │   ├── analytics.ts          # Query analytics
│   │   │   │   ├── brands.ts             # CRUD brands + setup flow
│   │   │   │   ├── jobs.ts               # Queue status, retry
│   │   │   │   ├── users.ts              # User management, invitations
│   │   │   │   ├── credentials.ts        # Platform credentials (super_admin)
│   │   │   │   └── drive.ts              # Drive connection, folder management
│   │   │   └── middleware.ts
│   │   │
│   │   ├── services/
│   │   │   ├── publishing/
│   │   │   │   ├── instagram.ts
│   │   │   │   ├── youtube.ts
│   │   │   │   ├── linkedin.ts
│   │   │   │   └── publisher.ts
│   │   │   ├── analytics/
│   │   │   │   ├── fetcher.ts
│   │   │   │   └── aggregator.ts
│   │   │   ├── media/
│   │   │   │   ├── processor.ts          # Resize, crop, blur-bg
│   │   │   │   └── rules-engine.ts       # Valid actions per file type
│   │   │   ├── drive/
│   │   │   │   ├── client.ts             # Google Drive API wrapper
│   │   │   │   └── folder-manager.ts     # Auto-create MediaHub folders
│   │   │   └── auth/
│   │   │       └── oauth.ts
│   │   │
│   │   ├── queue/
│   │   │   ├── connection.ts
│   │   │   ├── queues.ts
│   │   │   ├── workers/
│   │   │   │   ├── publish.worker.ts
│   │   │   │   ├── analytics.worker.ts
│   │   │   │   └── media.worker.ts
│   │   │   └── cron/
│   │   │       ├── analytics-fetch.ts
│   │   │       └── token-refresh.ts
│   │   │
│   │   └── db/
│   │       ├── schema.sql
│   │       └── migrations/
│   │
│   ├── components/
│   │   ├── chat/
│   │   │   ├── ChatInterface.tsx
│   │   │   ├── MessageBubble.tsx
│   │   │   └── ChatInput.tsx
│   │   ├── media/
│   │   │   ├── MediaLibrary.tsx
│   │   │   ├── MediaGroupCard.tsx
│   │   │   ├── UploadForm.tsx
│   │   │   ├── VariantCard.tsx
│   │   │   └── VariantTagger.tsx
│   │   ├── publish/
│   │   │   ├── PublishPanel.tsx
│   │   │   ├── ActionSelector.tsx
│   │   │   ├── AccountSelector.tsx
│   │   │   ├── ResizeOptions.tsx
│   │   │   ├── CaptionEditor.tsx
│   │   │   ├── PublishSummary.tsx
│   │   │   └── SchedulePicker.tsx        # Calendar + 12hr time + AM/PM popup
│   │   ├── calendar/
│   │   │   ├── CalendarView.tsx
│   │   │   └── PostCard.tsx
│   │   ├── analytics/
│   │   │   ├── OverviewDashboard.tsx
│   │   │   ├── PostMetrics.tsx
│   │   │   └── GrowthChart.tsx
│   │   ├── accounts/
│   │   │   ├── AccountList.tsx
│   │   │   ├── ConnectOAuth.tsx
│   │   │   └── ManualTokenEntry.tsx
│   │   ├── brands/
│   │   │   ├── BrandList.tsx
│   │   │   └── BrandSetupWizard.tsx      # 3-step: details → drive → accounts
│   │   ├── settings/
│   │   │   └── PlatformCredentials.tsx   # Super admin only
│   │   ├── common/
│   │   │   ├── ModeSwitcher.tsx
│   │   │   ├── BrandSwitcher.tsx
│   │   │   └── StatusBadge.tsx
│   │   └── layout/
│   │       ├── Sidebar.tsx
│   │       ├── Header.tsx
│   │       └── DashboardShell.tsx
│   │
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts
│   │   │   └── server.ts
│   │   ├── redis.ts
│   │   ├── encryption.ts
│   │   ├── rate-limiter.ts
│   │   └── utils.ts
│   │
│   └── openclaw/
│       ├── tools/
│       │   ├── create-media.ts
│       │   ├── publish-content.ts
│       │   ├── get-analytics.ts
│       │   └── ...
│       └── agent-config.ts
│
├── supabase/
│   ├── config.toml
│   └── migrations/
│
├── worker.ts
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── tailwind.config.ts
├── .env.example
└── README.md
```

---

## SCHEDULE PICKER UI SPEC

When user clicks "Schedule for later":
- Dark overlay (rgba(0,0,0,0.55)) covers the entire screen
- Centered modal with white/primary background, rounded corners (16px)
- **Calendar section**: month navigation arrows, day name headers (Mo-Su), clickable day grid, today highlighted, past dates greyed/disabled, selected date gets accent color fill
- **Time section**: two scrollers side by side (hour: 01-12, minute: 00-55 in 5-min steps), up/down arrows to scroll, large display numbers
- **AM/PM toggle**: two stacked buttons, active one gets accent fill
- **Summary row**: shows "Saturday, March 29, 2026 at 6:00 PM" — updates live
- **Buttons**: Cancel (ghost) + Schedule (accent fill)
- **"or publish now"** link below buttons

---

## ENVIRONMENT VARIABLES (.env.example)

```env
# Supabase (self-hosted)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis
REDIS_URL=redis://localhost:6379

# Encryption key for tokens (AES-256)
TOKEN_ENCRYPTION_KEY=

# App
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Note: Platform credentials (Instagram, YouTube, LinkedIn, Google Drive)
# are NOT in .env — they are stored encrypted in platform_credentials table
# and managed by super_admin via Settings page.
```

---

## BUILD ORDER

### Phase 1: Foundation
1. Initialize Next.js project with TypeScript, Tailwind, shadcn/ui
2. Set up Supabase (self-hosted Docker), create all tables with RLS
3. Implement auth (signup, login, org creation, role system)
4. Build dashboard shell: sidebar, header, 3-mode switcher (Chat | Click | Analytics)
5. Build Settings page with Platform Credentials section (super_admin only)
6. Build brand management + 3-step setup wizard

### Phase 2: Click Mode
7. Build Media Library page (grid, search, filter, metrics)
8. Build Upload page (drag-drop, variant tagging, shared details)
9. Build Google Drive integration (OAuth, folder creation, file upload)
10. Build Publish page (action panels, rules engine, account selector, resize options)
11. Build Schedule Picker popup (calendar + 12hr time + AM/PM)
12. Build Accounts page (OAuth connect + manual token + Drive status)
13. Set up BullMQ + Redis, create publish queue
14. Build publish workers for each platform (Instagram, YouTube, LinkedIn)
15. Build Queue page (live status, retry, dead letter)
16. Build Calendar page (month/week/day views, drag-drop reschedule)

### Phase 3: Analytics Mode
17. Build analytics fetcher workers (cron every 6 hours)
18. Build analytics dashboard (overview, per-post, trends)
19. Build export (CSV, PDF reports)

### Phase 4: Chat Mode
20. Define OpenClaw tools matching tRPC endpoints
21. Build chat UI
22. Connect OpenClaw gateway to platform API
23. Test agent workflows

### Phase 5: Polish
24. Content approval workflow (pending_approval status)
25. Invitation system (email invite + direct add)
26. Error handling, loading states, empty states
27. Audit logging
28. Multi-tenant isolation testing
29. Rate limit testing with real platform APIs

---

## COMPLETE FEATURE CHECKLIST (80 Features)

### 1. Authentication & Roles (10) — Phase 1
- [ ] Email + password signup/login
- [ ] Google SSO login
- [ ] Magic link login (passwordless)
- [ ] 6 role types with permission enforcement
- [ ] Agency-level vs brand-level user separation
- [ ] Row-Level Security (RLS) on every table
- [ ] JWT tokens with role + org_id + brand_id
- [ ] Invite users (email invite for clients, direct add for team)
- [ ] Role-based UI rendering (brand users see simplified UI)
- [ ] Brand assignment for agency editors

### 2. Multi-Tenant Model (5) — Phase 1
- [ ] Organization (agency) creation
- [ ] Brand management with 3-step setup wizard
- [ ] Brand switcher (hidden for brand users)
- [ ] Per-brand social account + Drive grouping
- [ ] Cross-brand overview for agency admins

### 3. Platform Credentials (4) — Phase 1
- [ ] Super admin settings page with credential entry for IG/YT/LI
- [ ] Encrypted storage of platform app IDs and secrets
- [ ] Auto-generated redirect URIs
- [ ] App review status indicators

### 4. Social Accounts + Drive (9) — Phase 2
- [ ] Connect Instagram via OAuth (one-click)
- [ ] Connect YouTube via OAuth (one-click)
- [ ] Connect LinkedIn via OAuth (one-click)
- [ ] Connect Google Drive via OAuth (per brand, one-time)
- [ ] Manual token entry (advanced, expandable section)
- [ ] Multiple accounts per platform per brand
- [ ] Token health monitoring dashboard
- [ ] Automatic token refresh (daily cron)
- [ ] AES-256 encrypted token storage

### 5. Media Upload — Phase A (10) — Phase 2
- [ ] Upload form: drag-and-drop single or multiple files
- [ ] Accept any file size, any ratio — no restrictions
- [ ] Media group concept (1 variant or N variants)
- [ ] Per-variant tagging: platform, account, action (optional)
- [ ] Shared details: title, caption, tags, description, notes
- [ ] Files uploaded directly to brand's Google Drive
- [ ] Auto-detect metadata: type, dimensions, ratio, duration
- [ ] Media library with grid view, groups, variant badges
- [ ] Search/filter by type, tags, date, status
- [ ] Upload via Chat Mode (same library)

### 6. Content Publishing — Phase B (14) — Phase 2
- [ ] Select content from media library
- [ ] Single-variant: one action panel
- [ ] Multi-variant: separate panel per variant
- [ ] Rules engine: valid actions only (file type + duration)
- [ ] Account selector: matching accounts only
- [ ] Auto-suggest accounts from variant tags
- [ ] Ratio adjustment at publish time (4 options)
- [ ] Processed versions saved to Drive
- [ ] Platform-aware metadata auto-fill
- [ ] Per-platform caption/title override
- [ ] Publish now button
- [ ] Schedule for later with date/time picker popup
- [ ] Content approval workflow
- [ ] Publish summary before confirmation

### 7. Schedule Picker (1) — Phase 2
- [ ] Dark overlay popup with calendar + 12hr time scrollers + AM/PM toggle

### 8. Calendar (5) — Phase 2
- [ ] Month / week / day views
- [ ] Drag-and-drop rescheduling
- [ ] Color-coded by platform
- [ ] Status indicators
- [ ] Filter by brand / platform / status

### 9. Publishing Engine (8) — Phase 2
- [ ] BullMQ job queue
- [ ] Per-account publish jobs
- [ ] 3 retries with exponential backoff
- [ ] Dead letter queue
- [ ] Per-account rate limiting
- [ ] Queue dashboard (live status)
- [ ] Cancel scheduled posts
- [ ] Publish now (immediate)

### 10. Analytics (8) — Phase 3
- [ ] Auto-fetch every 6 hours
- [ ] Overview dashboard with metrics
- [ ] Per-post breakdown
- [ ] Platform comparison
- [ ] Growth trends (7/30/90 days)
- [ ] Best performing content
- [ ] CSV export
- [ ] PDF reports

### 11. Chat Mode (7) — Phase 4
- [ ] Chat UI with message history
- [ ] Agent uses same API
- [ ] Agent inherits role permissions
- [ ] OpenClaw tools mapped to tRPC
- [ ] Rich response cards
- [ ] File upload in chat
- [ ] Conversation history

### 12. Security & Audit (5) — Phase 5
- [ ] Full audit log
- [ ] API key management
- [ ] Encrypted token storage
- [ ] API rate limiting
- [ ] Multi-tenant isolation testing

### 13. Infrastructure (4) — Phase 1
- [ ] Self-hosted Supabase via Docker
- [ ] Redis in Docker
- [ ] Three-mode layout shell
- [ ] Dashboard with sidebar + header + mode switcher
