# MediaHub — Working Pipeline

> Single source of truth for the MediaHub social media management platform.
> Last updated: 2026-03-30

---

## 1. Platform Overview

MediaHub is a full-stack agency social media management platform with three operating modes:

- **Chat Mode** — AI-powered natural language interface (browse media, schedule posts, check analytics via conversation)
- **Click Mode** — Traditional dashboard UI (media library, upload, publish, calendar, queue, accounts, brands, settings)
- **Analytics Mode** — Performance dashboards for published content

### Core Principles

- **One API, Two Clients:** Dashboard (Click) and AI Agent (Chat) share the same tRPC API
- **Multi-Tenant with RLS:** Organizations → Brands → Users, enforced at database level
- **Zero Server Storage:** All media stored in brand's own Google Drive; platform stores only drive_file_id references
- **Agency Model:** Super admin manages organization, creates brands, assigns users

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| API | tRPC v11 with Zod validation |
| Database | Supabase PostgreSQL (self-hosted Docker) with Row-Level Security |
| Queue | BullMQ + Redis (publish scheduling, token refresh, analytics) |
| Storage | Google Drive API v3 (brand's own account) |
| Auth | Supabase Auth (email/password, magic link, Google SSO) |
| AI | Multi-provider LLM (OpenRouter, Anthropic, OpenAI, Google Gemini) |
| Media Processing | sharp (images), fluent-ffmpeg (video metadata) |
| UI | shadcn/ui + Tailwind CSS + lucide-react icons |

---

## 2. Role-Based Access Control (RBAC)

6 roles with hierarchical permissions:

| Role | Scope | Capabilities |
|------|-------|-------------|
| `super_admin` | Org-wide | Everything: platform credentials, LLM config, all brands, all users, all settings |
| `agency_admin` | Org-wide | Manage all brands, users (except super_admin), social accounts, media, publish |
| `agency_editor` | Assigned brands | Manage only assigned brands: media, publish, queue, analytics |
| `brand_owner` | Own brand | Full brand control: social accounts, Drive, users (invite editors/viewers), media, publish |
| `brand_editor` | Own brand | Upload media, publish, manage queue, view analytics |
| `brand_viewer` | Own brand | Read-only: browse media, view analytics, view queue |

### Permission Matrix

| Permission | super_admin | agency_admin | agency_editor | brand_owner | brand_editor | brand_viewer |
|-----------|:-----------:|:------------:|:-------------:|:-----------:|:------------:|:------------:|
| Platform Credentials | Yes | — | — | — | — | — |
| LLM Config (org) | Yes | — | — | — | — | — |
| Brand Access (LLM) | Yes | — | — | — | — | — |
| Personal LLM Key | Yes | Yes | Yes | Yes | Yes | Yes |
| Social Account OAuth | — | — | — | Yes | — | — |
| Google Drive | Yes | Yes | — | Yes | — | — |
| Upload Media | Yes | Yes | Yes | Yes | Yes | — |
| Publish/Schedule | Yes | Yes | Yes | Yes | Yes | — |
| Manage Users | Yes | Yes | — | Yes (invite only) | — | — |
| View Analytics | Yes | Yes | Yes | Yes | Yes | Yes |

### Enforcement Layers

1. **Database:** RLS policies per table
2. **tRPC:** `protectedProcedure`, `adminProcedure`, `superAdminProcedure` middleware
3. **Application:** `assertBrandAccess()` helper validates brand ownership

---

## 3. Database Schema

### Core Tables

#### organizations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| name | text | |
| plan | text | |
| settings | jsonb | |

#### users
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK, FK → auth.users |
| org_id | uuid | FK → organizations |
| brand_id | uuid | FK → brands (nullable) |
| email | text | |
| name | text | |
| role | text | One of: super_admin, agency_admin, agency_editor, brand_owner, brand_editor, brand_viewer |
| assigned_brands | uuid[] | For agency_editor role |

#### brands
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | FK → organizations |
| name | text | |
| logo_url | text | |
| settings | jsonb | |
| setup_status | text | |

### Credentials & Connections

#### platform_credentials
| Column | Type | Notes |
|--------|------|-------|
| org_id | uuid | FK → organizations |
| platform | text | See platform list below |
| client_id_encrypted | text | AES-256-GCM encrypted |
| client_secret_encrypted | text | AES-256-GCM encrypted |
| redirect_uri | text | |
| status | text | |
| metadata | jsonb | |

**Platform values:** `instagram`, `youtube`, `linkedin`, `google_drive`, `email_smtp`, `llm_provider`, `llm_openrouter`, `llm_anthropic`, `llm_openai`, `llm_google`

#### social_accounts
| Column | Type | Notes |
|--------|------|-------|
| brand_id | uuid | FK → brands |
| platform | text | instagram, youtube, linkedin |
| platform_user_id | text | |
| platform_username | text | |
| access_token_encrypted | text | AES-256-GCM encrypted |
| refresh_token_encrypted | text | AES-256-GCM encrypted |
| token_expires_at | timestamptz | |
| connection_method | text | |
| platform_metadata | jsonb | |
| is_active | boolean | |

#### drive_connections
| Column | Type | Notes |
|--------|------|-------|
| brand_id | uuid | FK → brands, UNIQUE |
| google_account_email | text | |
| access_token_encrypted | text | AES-256-GCM encrypted |
| refresh_token_encrypted | text | AES-256-GCM encrypted |
| token_expires_at | timestamptz | |
| root_folder_id | text | |
| folder_ids | jsonb | |
| is_active | boolean | |

### Media & Publishing

#### media_groups
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| brand_id | uuid | FK → brands |
| uploaded_by | uuid | FK → users |
| title | text | |
| caption | text | |
| description | text | |
| tags | text[] | |
| notes | text | |
| variant_count | integer | |
| status | text | available, scheduled, published, archived |

#### media_assets
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| group_id | uuid | FK → media_groups |
| drive_file_id | text | Google Drive file ID |
| processed_drive_file_id | text | Processed version (if any) |
| file_name | text | |
| file_type | text | MIME type |
| file_size | bigint | Bytes |
| width | integer | |
| height | integer | |
| aspect_ratio | text | e.g., "16:9" |
| duration_seconds | float | Video only |
| sort_order | integer | |
| tagged_platform | text | |
| tagged_account_id | uuid | |
| tagged_action | text | |
| metadata | jsonb | |

#### content_posts
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| group_id | uuid | FK → media_groups |
| brand_id | uuid | FK → brands |
| scheduled_by | uuid | FK → users |
| status | text | draft, pending_approval, scheduled, publishing, published, partial_published, failed |
| caption_overrides | jsonb | |
| scheduled_at | timestamptz | |
| published_at | timestamptz | |
| source | text | chat, click, api |

#### publish_jobs
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| post_id | uuid | FK → content_posts |
| asset_id | uuid | FK → media_assets |
| social_account_id | uuid | FK → social_accounts |
| action | text | See platform rules engine |
| resize_option | text | |
| status | text | queued, processing, completed, failed, dead, cancelled |
| attempt_count | integer | |
| error_message | text | |
| platform_post_id | text | ID returned by platform |
| next_retry_at | timestamptz | |

#### post_analytics
| Column | Type | Notes |
|--------|------|-------|
| post_id | uuid | FK → content_posts |
| social_account_id | uuid | FK → social_accounts |
| views | integer | |
| likes | integer | |
| comments | integer | |
| shares | integer | |
| saves | integer | |
| clicks | integer | |
| reach | integer | |
| impressions | integer | |
| engagement_rate | float | |

### LLM System

#### llm_configurations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| scope | text | org, brand, user |
| org_id | uuid | FK → organizations |
| brand_id | uuid | Nullable |
| user_id | uuid | Nullable |
| provider | text | |
| label | text | |
| api_key_encrypted | text | AES-256-GCM encrypted |
| base_url | text | |
| default_model | text | |
| is_active | boolean | |

UNIQUE constraint: `(org_id, scope, brand_id, user_id, provider)`

#### llm_brand_access
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | FK → organizations |
| brand_id | uuid | FK → brands |
| provider | text | Maps to platform_credentials LLM provider |
| granted_by | uuid | FK → users |
| is_active | boolean | |

UNIQUE constraint: `(org_id, brand_id)`

#### llm_limits
| Column | Type | Notes |
|--------|------|-------|
| org_id | uuid | |
| brand_id | uuid | |
| user_id | uuid | |
| daily_requests | integer | |
| monthly_requests | integer | |
| max_tokens_per_request | integer | |

#### llm_usage_logs
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | |
| brand_id | uuid | |
| user_id | uuid | |
| config_id | uuid | FK → llm_configurations |
| scope_used | text | org, brand, user |
| provider | text | |
| model | text | |
| input_tokens | integer | |
| output_tokens | integer | |
| total_tokens | integer | |
| cost_estimate | numeric | |

### Administration

#### invitations
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | FK → organizations |
| email | text | |
| role | text | |
| brand_id | uuid | Nullable |
| invited_by | uuid | FK → users |
| token_hash | text | SHA-256 hash of invite token |
| method | text | |
| status | text | pending, accepted, expired, cancelled |
| expires_at | timestamptz | |

#### audit_log
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | |
| user_id | uuid | |
| action | text | |
| resource_type | text | |
| resource_id | uuid | |
| source | text | |
| metadata | jsonb | |

#### api_keys
| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| org_id | uuid | |
| key_hash | text | |
| name | text | |
| permissions | text[] | |
| expires_at | timestamptz | |
| last_used_at | timestamptz | |

---

## 4. Authentication & Signup Flow

### First-Time Setup
1. Super admin creates org on first signup (auto via `handle_new_user` trigger)
2. Super admin invites users via email → invitation record created with `token_hash`

### Invite-Based Signup
1. Invited user clicks link → `/signup?invite={token}`
2. Signup page validates invite token via `/api/invite-check`
3. User creates account → `handle_new_user` trigger checks invitations table by email
4. If invitation found: assigns `org_id`, `role`, `brand_id` from invitation
5. If no invitation: creates new organization, sets role to `super_admin`

### OAuth Callback Routes

| Route | Purpose |
|-------|---------|
| `/api/callback/instagram` | Facebook Graph API token exchange |
| `/api/callback/youtube` | Google OAuth2 token exchange |
| `/api/callback/linkedin` | LinkedIn OAuth2 token exchange |
| `/api/callback/google-drive` | Google Drive OAuth2 + folder creation |
| `/callback/auth` | Supabase auth (magic link, password reset) |

### OAuth State Security
- State parameter is HMAC-SHA256 signed using `TOKEN_ENCRYPTION_KEY`
- `signState()` creates signed base64 payload
- `verifyState()` validates signature on callback

---

## 5. Media Upload Flow

### Step-by-Step

1. User opens Upload page → checks Drive connection status
2. User drops files (images/videos) into UploadForm
3. Client extracts metadata: dimensions, duration, thumbnail (canvas for video, base64 for image)
4. `POST /api/upload` with FormData (file + metadata)
5. Server validates: MIME whitelist + 500MB limit
6. Server extracts metadata via `sharp` (images) or `ffprobe` (videos)
7. Server uploads to Google Drive → `MediaHub/Originals` folder
8. Creates `media_groups` + `media_assets` records in DB
9. Returns success → redirects to library

### File Type Whitelist

| Category | MIME Types |
|----------|-----------|
| Images | image/jpeg, image/png, image/gif, image/webp, image/heic, image/heif |
| Videos | video/mp4, video/quicktime, video/webm, video/x-msvideo |

**Max file size:** 500MB per file

---

## 6. Publishing Flow

### Platform Rules Engine

8 publish actions with constraints:

| Action | Platform | Image | Video | Max Duration | Aspect Ratios | Notes |
|--------|----------|:-----:|:-----:|:------------:|---------------|-------|
| `ig_post` | Instagram | Yes | Yes | 3600s | 1:1, 4:5, 1.91:1 | |
| `ig_reel` | Instagram | — | Yes | 90s | 9:16 | Video only |
| `ig_story` | Instagram | Yes | Yes | 60s | 9:16 | No captions |
| `ig_carousel` | Instagram | Yes | Yes | 60s | 1:1, 4:5 | Requires 2+ files |
| `yt_video` | YouTube | — | Yes | 43200s | 16:9 | |
| `yt_short` | YouTube | — | Yes | 60s | 9:16 | |
| `li_post` | LinkedIn | Yes | Yes | 600s | 1:1, 1.91:1, 4:5 | |
| `li_article` | LinkedIn | Yes | — | N/A | 1.91:1 | Images only |

### Publish Workflow (Click Mode)

1. User selects media group → navigates to `/publish/[groupId]`
2. **Step 1:** Select actions (filtered by rules engine based on asset type/dimensions)
3. **Step 2:** Select accounts per action (from `social_accounts`)
4. **Step 3:** Customize content per job (title, caption, description, tags)
5. **Step 4:** Review → Publish Now or Schedule

### Publish Execution

1. `content_post` created (status: `publishing` or `scheduled`)
2. `publish_jobs` created (one per asset x account x action combination)
3. Jobs queued to BullMQ with delay if scheduled
4. Worker processes each job (see platform-specific details below)
5. Job status updated: `queued` → `processing` → `completed` / `failed` / `dead`
6. Post status: `publishing` → `published` (all done) / `partial_published` (some failed) / `failed` (all failed)
7. Retry: 3 attempts with exponential backoff (1s → 2s → 4s, max 30s)

### Instagram Publishing Detail

| Action | Flow |
|--------|------|
| `ig_post` | `POST /v19.0/{ig_user_id}/media` (image_url or video_url + caption) → `POST /media_publish` |
| `ig_reel` | Same as ig_post but `media_type=REELS` |
| `ig_story` | Same but `media_type=STORIES`, no caption |
| `ig_carousel` | Create child containers for each asset → create parent carousel container → publish |

- Video containers are polled every 3s until `FINISHED` (max 120s timeout)
- Files made temporarily public on Drive; access revoked in `finally` block

### YouTube Publishing Detail

1. Downloads file from Google Drive
2. Uploads via `google.youtube.videos.insert` with resumable upload
3. Sets title, description, tags, categoryId, privacyStatus
4. Auto-refreshes OAuth tokens

### LinkedIn Publishing Detail

- Supports `li_post` (image/video) and `li_article` (image only)
- For video: `initializeUpload` → upload binary → create post with person URN
- For image: same flow with image-specific endpoints
- Uses `LinkedIn-Version: 202401`

---

## 7. Worker System (worker.ts)

### Publish Worker

| Setting | Value |
|---------|-------|
| Concurrency | 3 |
| Backoff | Exponential: 1s, 2s, 4s... max 30s |
| Max retries | 3 attempts, then marked `dead` |
| Request timeout | 60s on all external API calls (AbortController) |
| Post status | After job completion, checks all sibling jobs to determine post status |

### Token Refresh Worker (scheduled daily)

| Platform | Method |
|----------|--------|
| Google Drive | Google OAuth2 `refreshAccessToken()` |
| YouTube | Same Google OAuth2 refresh |
| Instagram | Long-lived token refresh via `ig_refresh_token` endpoint |
| LinkedIn | Cannot refresh (logs warning, user must re-auth) |

### Zombie Job Detection

- Checks every run for jobs stuck in `processing` for 10+ minutes
- Marks them as `failed` with timeout message
- Updates parent post status accordingly

### Startup Verification

1. Redis connection check
2. Supabase connection check
3. `TOKEN_ENCRYPTION_KEY` existence check
4. FFmpeg availability check
5. Schedules cron jobs: analytics (6h), token refresh (24h)

---

## 8. LLM System (Multi-Level Access)

### Resolution Chain (highest to lowest priority)

1. **User Personal Key** — user adds their own API key in Settings → Personal LLM Key
2. **Brand Assigned Provider** — super admin assigns a specific provider to the brand in LLM Access → Brand Access
3. **Org Default** — admin-only fallback via `llm_configurations` (scope=org)
4. **No LLM** — chat shows "No LLM" badge, sends error on message

### Platform Credentials LLM Cards

4 separate cards in Platform Credentials (same UI pattern as Instagram/YouTube):

| Card | Platform Key | API Key Prefix | Models |
|------|-------------|----------------|--------|
| OpenRouter | `llm_openrouter` | `sk-or-...` | 300+ models |
| Anthropic Claude | `llm_anthropic` | `sk-ant-...` | Claude family |
| OpenAI GPT | `llm_openai` | `sk-...` | GPT-4o, GPT-4o-mini |
| Google Gemini | `llm_google` | Google API key | Gemini Pro, Gemini Flash |

### Brand Access

- Super admin goes to LLM Access → Brand Access
- Dropdown per brand shows only configured providers
- Different brands can get different providers (e.g., cheap OpenRouter for basic brands, Anthropic for premium)

### Usage & Limits

- Super admin sets per-brand limits: daily requests, monthly requests, max tokens per request
- Quota checked before every LLM call
- All usage logged to `llm_usage_logs` (provider, model, tokens, cost estimate)

### Chat Mode Tools

The AI agent has 6 tools available during chat:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_media` | search, type, status | Browse media library |
| `get_media_details` | groupId | Full group info + publish history |
| `schedule_content` | groupId, actions[], scheduledAt, caption | Publish or schedule content |
| `get_analytics` | period | Job stats + post metrics |
| `list_accounts` | — | Social accounts for brand |
| `get_queue_status` | status | Publish job queue status |

---

## 9. Frontend Architecture

### Pages

| Route | Purpose |
|-------|---------|
| `/login` | Login (email/password, magic link, Google SSO) |
| `/signup` | Signup (direct or invite-based) |
| `/reset-password` | Password reset |
| `/library` | Media library with search, filter, pagination |
| `/upload` | File upload with drag-drop, metadata extraction |
| `/publish/[groupId]` | 4-step publish wizard |
| `/calendar` | Calendar view of scheduled posts |
| `/queue` | Publish job queue with retry/cancel |
| `/chat` | AI chat interface with tool execution |
| `/accounts` | Social account + Drive connection management |
| `/brands` | Brand list |
| `/brands/new` | Brand creation + setup wizard |
| `/settings` | Platform credentials, users, organization, LLM access, personal LLM key |
| `/analytics` | Analytics dashboard |
| `/analytics/posts` | Per-post analytics |
| `/analytics/export` | Analytics export |

### Key Components

| Component | Description |
|-----------|-------------|
| `ErrorBoundary` | Wraps dashboard layout |
| `LlmStatusBadge` | Shows current LLM source in chat header |
| `BrandSwitcher` | Header dropdown to switch active brand |
| `ModeSwitcher` | Chat/Click/Analytics mode tabs |
| `PublishPanel` | 4-step publish wizard with action validation |
| `SchedulePicker` | Datetime picker for scheduling |
| `MediaLibrary` | Paginated grid with search/filter |
| `ChatInterface` | Message list + tool execution + LLM status |

---

## 10. Security

### Encryption

- **Algorithm:** AES-256-GCM
- **Key:** `TOKEN_ENCRYPTION_KEY` environment variable (hex-encoded)
- **Format:** IV + auth tag included in encrypted value
- **Scope:** All social account tokens, Drive tokens, platform credentials, LLM API keys encrypted before DB storage

### Authorization

| Check | Where |
|-------|-------|
| `assertBrandAccess()` | All data mutation endpoints |
| MIME type whitelist + 500MB limit | File upload endpoint |
| HMAC-SHA256 signed state | OAuth callbacks |
| SHA-256 hashed invite tokens | Invitation validation on signup |
| `CRON_SECRET` header | Cron endpoint (mandatory) |

### Row-Level Security

- All tables have RLS enabled
- Policies enforce org isolation + role-based access
- Service role client bypasses RLS for server-side operations

---

## 11. Infrastructure

### Docker Services (docker-compose.yml)

| Service | Port | Purpose |
|---------|------|---------|
| db | 54322 | PostgreSQL |
| kong | 54321 | API gateway |
| auth | — | GoTrue (Supabase Auth) |
| rest | — | PostgREST |
| realtime | — | Supabase Realtime |
| studio | 54323 | Supabase Studio |
| meta | — | Supabase Meta |
| redis | 6379 | BullMQ queue backend |
| inbucket | 54324 | Email testing |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-side only) |
| `REDIS_URL` | Redis connection string |
| `TOKEN_ENCRYPTION_KEY` | AES-256 hex key for encryption |
| `NEXT_PUBLIC_APP_URL` | App URL (https://localhost:3443 for dev) |
| `CRON_SECRET` | Secret for cron endpoint auth |

### HTTPS Setup (Development)

- `mkcert` generates localhost SSL certificates
- `local-ssl-proxy` proxies `https://localhost:3443` → `http://localhost:3000`
- Required for Meta/Instagram OAuth (HTTPS mandatory for Business apps)
- `npm run dev:https` starts both dev server + SSL proxy

---

## 12. API Reference (tRPC Routers)

### brands

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | List all brands for org |
| `getById` | query | Get single brand by ID |
| `create` | mutation | Create new brand |
| `update` | mutation | Update brand settings |

### media

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | Paginated media list with filters |
| `get` | query | Get single media group |
| `getStats` | query | Media library statistics |
| `search` | query | Full-text search across media |
| `createGroup` | mutation | Create new media group |
| `addVariant` | mutation | Add variant to existing group |
| `updateGroup` | mutation | Update group metadata |
| `deleteGroup` | mutation | Delete media group |
| `removeVariant` | mutation | Remove single variant from group |

### publish

| Procedure | Type | Description |
|-----------|------|-------------|
| `getPublishData` | query | Get publish context for a media group |
| `schedule` | mutation | Create post + publish jobs |
| `saveDraft` | mutation | Save post as draft |
| `listScheduled` | query | List scheduled posts |
| `reschedule` | mutation | Change scheduled time |

### jobs

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | List publish jobs with filters |
| `getStats` | query | Job statistics (counts by status) |
| `retry` | mutation | Retry a failed job |
| `cancel` | mutation | Cancel a queued/scheduled job |

### socialAccounts

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | List social accounts for brand |
| `initiateOAuth` | mutation | Start OAuth flow for platform |
| `connectManual` | mutation | Manual token connection |
| `disconnect` | mutation | Disconnect social account |
| `checkHealth` | query | Check account token health |
| `refreshToken` | mutation | Force token refresh |

### drive

| Procedure | Type | Description |
|-----------|------|-------------|
| `connect` | mutation | Initiate Drive OAuth |
| `verify` | query | Verify Drive connection |
| `disconnect` | mutation | Disconnect Drive |
| `status` | query | Get Drive connection status |

### credentials

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | List all platform credentials |
| `upsert` | mutation | Create or update credential |
| `test` | mutation | Test credential validity |
| `updateStatus` | mutation | Enable/disable credential |
| `getRedirectUri` | query | Get OAuth redirect URI |

### chat

| Procedure | Type | Description |
|-----------|------|-------------|
| `getConfig` | query | Get chat/LLM configuration |
| `getConversations` | query | List conversations |
| `getMessages` | query | Get messages for conversation |
| `sendMessage` | mutation | Send message + get AI response |
| `deleteConversation` | mutation | Delete conversation |

### llm

| Procedure | Type | Description |
|-----------|------|-------------|
| `listConfigs` | query | List LLM configurations |
| `upsertConfig` | mutation | Create or update LLM config |
| `deleteConfig` | mutation | Delete LLM config |
| `getActiveConfig` | query | Get resolved active config for context |
| `listBrandAccess` | query | List brand → provider mappings |
| `grantBrandAccess` | mutation | Assign LLM provider to brand |
| `revokeBrandAccess` | mutation | Remove brand LLM access |
| `getLimits` | query | Get usage limits |
| `setLimits` | mutation | Set usage limits |
| `getUsageSummary` | query | Get usage statistics |

### users

| Procedure | Type | Description |
|-----------|------|-------------|
| `me` | query | Get current user profile |
| `list` | query | List org users |
| `updateRole` | mutation | Change user role |

### invitations

| Procedure | Type | Description |
|-----------|------|-------------|
| `list` | query | List invitations |
| `emailStatus` | query | Check email service status |
| `send` | mutation | Send invitation email |
| `checkToken` | query | Validate invite token |
| `resend` | mutation | Resend invitation email |

---

## 13. File Structure Overview

```
src/
├── app/
│   ├── (auth)/              # Login, signup, reset-password
│   ├── (dashboard)/         # All authenticated pages
│   │   ├── library/
│   │   ├── upload/
│   │   ├── publish/[groupId]/
│   │   ├── calendar/
│   │   ├── queue/
│   │   ├── chat/
│   │   ├── accounts/
│   │   ├── brands/
│   │   ├── settings/
│   │   └── analytics/
│   ├── api/
│   │   ├── trpc/            # tRPC handler
│   │   ├── upload/          # File upload endpoint
│   │   ├── callback/        # OAuth callbacks (instagram, youtube, linkedin, google-drive)
│   │   ├── invite-check/    # Invite token validation
│   │   └── cron/            # Cron endpoint
│   └── layout.tsx
├── components/
│   ├── brands/              # Brand management UI
│   ├── calendar/            # Calendar views
│   ├── chat/                # Chat interface
│   ├── common/              # Shared components
│   ├── layout/              # Dashboard layout, sidebar, header
│   ├── media/               # Media library, upload form
│   ├── publish/             # Publish wizard
│   ├── settings/            # Settings panels
│   └── ui/                  # shadcn/ui primitives
├── lib/
│   ├── supabase/            # Supabase client (browser + server)
│   ├── trpc/                # tRPC client + React hooks
│   ├── hooks/               # Custom React hooks
│   ├── email.ts             # Email sending (invitations)
│   ├── encryption.ts        # AES-256-GCM encrypt/decrypt
│   ├── llm.ts               # Multi-provider LLM client
│   ├── redis.ts             # Redis/BullMQ connection
│   └── types.ts             # Shared TypeScript types
├── server/
│   ├── routers/             # tRPC routers (brands, media, publish, etc.)
│   ├── context.ts           # tRPC context (auth, db)
│   └── trpc.ts              # tRPC init + middleware
├── proxy.ts                 # SSL proxy for dev HTTPS
└── worker.ts                # BullMQ worker (publish, token refresh, analytics)
supabase/
├── migrations/              # Database migrations
└── config.toml              # Supabase local config
scripts/                     # Utility scripts
docker-compose.yml           # Supabase + Redis services
```

---

## 14. Deployment

### Local Development

Docker runs Supabase + Redis. Next.js and Worker run on your machine.

```
docker compose up -d          # Start Supabase + Redis
bash scripts/setup-db.sh      # Create tables (first time only)
npm run dev:https              # Terminal 1 — App (https://localhost:3443)
npm run worker:dev             # Terminal 2 — Worker (auto-reloads on changes)
```

### Production (Vercel + Supabase.com + Redis Cloud)

No Docker needed. Two services to deploy from the same repo:

| Service | Where | Start command |
|---------|-------|--------------|
| Next.js (frontend + API) | Vercel | Auto — connects to GitHub, deploys on push |
| Worker (background jobs) | Railway / Fly.io / any VPS | `npm run worker` |
| Database | Supabase.com | Managed — no deployment needed |
| Redis | Upstash / Redis Cloud | Managed — just a connection string |

### How updates work

| Update type | What to do |
|-------------|-----------|
| Code change | `git push` → Vercel + Railway auto-deploy from GitHub |
| Database change | Write a migration file, run it in Supabase SQL Editor |
| Env var change | Update in Vercel dashboard + Railway dashboard |

### Database migration rules

| File | When to use |
|------|------------|
| `src/server/db/schema.sql` | Fresh setup only (no existing data) |
| `supabase/migrations/0000X_*.sql` | Existing database (has data) |

**NEVER run schema.sql on production with data.** Always use migration files.

To make a database change:
1. Create `supabase/migrations/0000X_your_change.sql` with safe ALTER statements
2. Test locally: run against Docker DB
3. Update `schema.sql` to match (for fresh setups)
4. Push to GitHub
5. Run the migration file in Supabase SQL Editor (production)

### Worker: dev vs production

| Command | Use when |
|---------|---------|
| `npm run worker:dev` | Local only — auto-reloads on file changes |
| `npm run worker` | Production — runs once, no file watching |

Never use `worker:dev` in production.

## 15. Commands Reference

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start Next.js dev server (HTTP only) |
| `npm run dev:https` | Start Next.js + SSL proxy (https://localhost:3443) |
| `npm run ssl-proxy` | Start only the HTTPS proxy |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run worker:dev` | Start worker with auto-reload (local only) |
| `npm run worker` | Start worker (production) |
| `npm run lint` | Run ESLint |
| `docker compose up -d` | Start Supabase + Redis (local only) |
| `docker compose down` | Stop Supabase + Redis |
| `bash scripts/setup-db.sh` | Create all database tables (first time only) |
