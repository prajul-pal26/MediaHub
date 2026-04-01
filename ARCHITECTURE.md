# MediaHub — System Architecture

```
                                    MEDIAHUB ARCHITECTURE
 ___________________________________________________________________________________________________
|                                                                                                   |
|   CLIENTS (Browser)                                                                               |
|   ┌─────────────────────────────────────────────────────────────────────┐                         |
|   │  Next.js 16 App (React + Tailwind + shadcn/ui + Recharts)          │                         |
|   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │                         |
|   │  │ Chat     │ │ Library  │ │ Publish  │ │Analytics │ │ Threads  │ │                         |
|   │  │ (AI)     │ │ Upload   │ │ Schedule │ │ Charts   │ │ Comments │ │                         |
|   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │                         |
|   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │                         |
|   │  │ Calendar │ │ Queue    │ │ Brands   │ │ Settings │ │ Export   │ │                         |
|   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │                         |
|   └─────────────────────────────┬───────────────────────────────────────┘                         |
|                                 │ tRPC (Type-safe API)                                            |
|                                 ▼                                                                 |
|   ┌─────────────────────────────────────────────────────────────────────┐                         |
|   │  NEXT.JS SERVER (Vercel)                                           │                         |
|   │                                                                     │                         |
|   │  tRPC Routers:                                                      │                         |
|   │  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────┐          │                         |
|   │  │brands  │ │media   │ │publish │ │chat    │ │analytics│          │                         |
|   │  │users   │ │jobs    │ │drive   │ │llm     │ │threads  │          │                         |
|   │  │creds   │ │social  │ │invites │ │        │ │         │          │                         |
|   │  └────────┘ └────────┘ └────────┘ └────────┘ └─────────┘          │                         |
|   │                                                                     │                         |
|   │  API Routes:                                                        │                         |
|   │  ┌───────────────┐ ┌───────────────┐ ┌──────────────┐              │                         |
|   │  │/api/upload     │ │/api/callback/* │ │/api/invite   │              │                         |
|   │  │(Google Drive)  │ │(OAuth returns) │ │(Token check) │              │                         |
|   │  └───────────────┘ └───────────────┘ └──────────────┘              │                         |
|   │                                                                     │                         |
|   │  Services:                                                          │                         |
|   │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌──────────┐           │                         |
|   │  │LLM Client │ │Encryption │ │Drive API  │ │Audit Log │           │                         |
|   │  │(Multi-    │ │(AES-256-  │ │(Google    │ │          │           │                         |
|   │  │ provider) │ │ GCM)      │ │ Drive v3) │ │          │           │                         |
|   │  └─────┬─────┘ └───────────┘ └───────────┘ └──────────┘           │                         |
|   └─────────┼───────────────────────────┬───────────────────────────────┘                         |
|             │                           │                                                         |
|             │ LLM API Calls             │ Queue Jobs                                              |
|             │ (Key Rotation)            │ (BullMQ)                                                |
|             ▼                           ▼                                                         |
|   ┌───────────────────┐   ┌─────────────────────────────────────────────┐                         |
|   │  LLM PROVIDERS    │   │  REDIS (Upstash / Redis Cloud)             │                         |
|   │                   │   │                                             │                         |
|   │  ┌─────────────┐  │   │  Queues:                                    │                         |
|   │  │ OpenRouter   │  │   │  ┌──────────┐ ┌────────────┐ ┌──────────┐ │                         |
|   │  │ (Key Pool    │  │   │  │ publish  │ │ analytics  │ │ comment  │ │                         |
|   │  │  Rotation)   │  │   │  │          │ │ -fetch     │ │ -sync    │ │                         |
|   │  ├─────────────┤  │   │  ├──────────┤ ├────────────┤ ├──────────┤ │                         |
|   │  │ Anthropic   │  │   │  │ comment  │ │ comment    │ │ trend    │ │                         |
|   │  │ OpenAI      │  │   │  │ -reply   │ │ -sentiment │ │-forecast │ │                         |
|   │  │ Google      │  │   │  ├──────────┤ ├────────────┤ ├──────────┤ │                         |
|   │  │ DeepSeek    │  │   │  │competitor│ │ token      │ │historical│ │                         |
|   │  └─────────────┘  │   │  │ -fetch   │ │ -refresh   │ │ -import  │ │                         |
|   └───────────────────┘   │  └──────────┘ └────────────┘ └──────────┘ │                         |
|                           └──────────────────────┬──────────────────────┘                         |
|                                                  │                                                |
|                                                  │ Jobs                                           |
|                                                  ▼                                                |
|   ┌──────────────────────────────────────────────────────────────────────┐                        |
|   │  WORKER (Railway — Node.js)                                         │                        |
|   │                                                                      │                        |
|   │  ┌─────────────────────────────────────────────────────────────────┐ │                        |
|   │  │  Publish Worker (concurrency: 3)                                │ │                        |
|   │  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐      │ │                        |
|   │  │  │ Instagram │ │ YouTube   │ │ LinkedIn  │ │ Facebook  │      │ │                        |
|   │  │  │ ig_post   │ │ yt_video  │ │ li_post   │ │ fb_post   │      │ │                        |
|   │  │  │ ig_reel   │ │ yt_short  │ │ li_article│ │ fb_reel   │      │ │                        |
|   │  │  │ ig_story  │ │           │ │           │ │ fb_story  │      │ │                        |
|   │  │  │ ig_carousel│ │          │ │           │ │           │      │ │                        |
|   │  │  ├───────────┤ ├───────────┤ ├───────────┤ ├───────────┤      │ │                        |
|   │  │  │ TikTok    │ │ Twitter/X │ │ Snapchat  │ │           │      │ │                        |
|   │  │  │ tt_post   │ │ tw_tweet  │ │ sc_story  │ │           │      │ │                        |
|   │  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘      │ │                        |
|   │  └─────────────────────────────────────────────────────────────────┘ │                        |
|   │                                                                      │                        |
|   │  ┌───────────────────┐ ┌───────────────────┐ ┌──────────────────┐   │                        |
|   │  │ Analytics Fetch   │ │ Comment Sync      │ │ Comment Reply    │   │                        |
|   │  │ (every 6h)        │ │ (every 2h)        │ │ (every 30s)      │   │                        |
|   │  │ → post_analytics  │ │ → platform_       │ │ → platform APIs  │   │                        |
|   │  │ → post_analytics_ │ │    comments       │ │                  │   │                        |
|   │  │    history        │ │                   │ │                  │   │                        |
|   │  └───────────────────┘ └───────────────────┘ └──────────────────┘   │                        |
|   │                                                                      │                        |
|   │  ┌───────────────────┐ ┌───────────────────┐ ┌──────────────────┐   │                        |
|   │  │ Sentiment Worker  │ │ Trend Forecast    │ │ Competitor Fetch │   │                        |
|   │  │ (daily, LLM)      │ │ (weekly, LLM)     │ │ (daily, APIs)    │   │                        |
|   │  │ → comment_        │ │ → trend_snapshots │ │ → competitor_    │   │                        |
|   │  │   sentiments      │ │ + best_posting_   │ │    metrics       │   │                        |
|   │  │                   │ │   times           │ │                  │   │                        |
|   │  └───────────────────┘ └───────────────────┘ └──────────────────┘   │                        |
|   │                                                                      │                        |
|   │  ┌───────────────────┐ ┌───────────────────┐                        │                        |
|   │  │ Token Refresh     │ │ Historical Import │                        │                        |
|   │  │ (daily)           │ │ (on account       │                        │                        |
|   │  │ → social_accounts │ │  connect)         │                        │                        |
|   │  │ → drive_          │ │ → content_posts   │                        │                        |
|   │  │   connections     │ │ → post_analytics  │                        │                        |
|   │  └───────────────────┘ └───────────────────┘                        │                        |
|   └──────────────────────────────────┬───────────────────────────────────┘                        |
|                                      │                                                            |
|                                      │ Reads/Writes                                               |
|                                      ▼                                                            |
|   ┌──────────────────────────────────────────────────────────────────────┐                        |
|   │  SUPABASE (PostgreSQL + Auth + Realtime)                            │                        |
|   │                                                                      │                        |
|   │  Core Tables:              Analytics:            AI & Comments:       │                        |
|   │  ┌──────────────┐         ┌──────────────┐     ┌──────────────┐     │                        |
|   │  │organizations │         │post_analytics│     │platform_     │     │                        |
|   │  │brands        │         │post_analytics│     │ comments     │     │                        |
|   │  │users         │         │ _history     │     │comment_      │     │                        |
|   │  │social_       │         │content_      │     │ sentiments   │     │                        |
|   │  │ accounts     │         │ categories   │     │comment_      │     │                        |
|   │  │drive_        │         │trend_        │     │ replies      │     │                        |
|   │  │ connections  │         │ snapshots    │     │reply_        │     │                        |
|   │  │platform_     │         │performance_  │     │ templates    │     │                        |
|   │  │ credentials  │         │ predictions  │     │llm_          │     │                        |
|   │  │media_groups  │         │competitor_   │     │ configurations│     │                        |
|   │  │media_assets  │         │ metrics      │     │llm_brand_    │     │                        |
|   │  │content_posts │         │              │     │ access       │     │                        |
|   │  │publish_jobs  │         │              │     │llm_usage_logs│     │                        |
|   │  │invitations   │         │              │     │chat_         │     │                        |
|   │  │audit_log     │         │              │     │ conversations│     │                        |
|   │  │api_keys      │         │              │     │chat_messages │     │                        |
|   │  └──────────────┘         └──────────────┘     └──────────────┘     │                        |
|   │                                                                      │                        |
|   │  Security: RLS on all tables │ Auth: Supabase Auth (email, SSO)     │                        |
|   │  Encryption: AES-256-GCM    │ All tokens encrypted at rest          │                        |
|   └──────────────────────────────────────────────────────────────────────┘                        |
|                                                                                                   |
|   EXTERNAL PLATFORM APIs:                                                                         |
|   ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   |
|   │Instagram │ │YouTube   │ │LinkedIn  │ │Facebook  │ │TikTok    │ │Twitter/X │ │Snapchat  │   |
|   │Graph API │ │Data v3   │ │v2 API    │ │Graph API │ │Open API  │ │v2 API    │ │Ads API   │   |
|   └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘   |
|                                                                                                   |
|   MEDIA STORAGE:                                                                                  |
|   ┌─────────────────────────────────────────────┐                                                 |
|   │  Google Drive (brand's own account)          │                                                 |
|   │  MediaHub/ → Originals/ + Processed/         │                                                 |
|   │  Zero server storage — only drive_file_id    │                                                 |
|   └─────────────────────────────────────────────┘                                                 |
|___________________________________________________________________________________________________|


CRON SCHEDULE:
┌────────────────────────┬───────────────────────────────┐
│ Every 30 seconds       │ Comment reply processing      │
│ Every 2 hours          │ Comment sync (all platforms)  │
│ Every 6 hours          │ Analytics fetch + history     │
│ Every 24 hours         │ Token refresh                 │
│ Every 24 hours         │ Sentiment analysis (LLM)      │
│ Every 24 hours         │ Competitor data fetch         │
│ Every 7 days           │ Trend forecast + best times   │
└────────────────────────┴───────────────────────────────┘

DATA FLOW:
User Action → tRPC → Redis Queue → Worker → Platform API → Supabase → UI
                                     ↓
                                  LLM API (OpenRouter with key pool rotation)
```

## Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | Next.js 16 + React + TypeScript | App Router, SSR/CSR |
| UI | shadcn/ui + Tailwind CSS + Recharts | Components, styling, charts |
| API | tRPC v11 + Zod | Type-safe API with validation |
| Database | Supabase PostgreSQL | RLS, Auth, Realtime |
| Queue | BullMQ + Redis | Job scheduling, background tasks |
| Worker | Node.js (Railway) | Publishing, analytics, AI tasks |
| AI | OpenRouter (multi-model, key rotation) | Chat, sentiment, forecasting |
| Storage | Google Drive API v3 | Media files (zero server storage) |
| Auth | Supabase Auth | Email/password, magic link, Google SSO |
| Encryption | AES-256-GCM | All tokens and API keys at rest |
| Hosting | Vercel (frontend) + Railway (worker) | Auto-deploy from GitHub |
