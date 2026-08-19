# CJP "School Thik Karo" — Uttar Pradesh harvest

Scrapes YouTube, Instagram and Facebook for content about CJP's **School Thik
Karo** campaign, filtered to Uttar Pradesh and the current campaign window.

## Run

```bash
KEY_OVERRIDE="$(docker exec mediahub-app printenv TOKEN_ENCRYPTION_KEY)" \
  npx tsx scripts/cjp/harvest.ts
```

`KEY_OVERRIDE` is needed because the running container's `TOKEN_ENCRYPTION_KEY`
differs from `.env.local`, so a local process cannot otherwise decrypt sessions
that were saved through the app. Fixing that drift would remove the need for it.

Output lands in `cjp_output/`:

| File | Contents |
|---|---|
| `cjp_school_youtube.csv` | Strict: campaign + UP + recent |
| `cjp_school_insta.csv` | Strict: campaign + UP + recent |
| `cjp_school_facebook.csv` | Verified post links + page targets |
| `*_all.csv` | Unfiltered companions, so the filter is auditable |

## What the campaign actually is

Established by research, and it differs from the brief in ways that change the
scrape:

- **CJP = Cockroach Janta Party** — a satirical political movement founded
  16 May 2026 by **Abhijeet Dipke**, after the CJI compared unemployed youth to
  "cockroaches". It is **not** Citizens for Justice and Peace (the Teesta
  Setalvad organisation); conflating them produces badly wrong output, so
  `cjp.org.in` / "Citizens for Justice and Peace" are in `EXCLUDE_TERMS`.
- **Canonical campaign name is "School Thik Karo"**, hashtag `#SchoolThikKaro`.
  "School Theek Karo Abhiyan" is a headline spelling variant, not its branding.
- **Launched 15 August 2026 from Hingoli district, Maharashtra** — Dipke's
  native village. It is a **national** campaign whose main theatres are
  Maharashtra and Rajasthan. There is **no CJP UP unit or UP launch event**.
- **The UP link is amplification, not organisation.** The genuinely viral UP
  story is the "Gen Alpha" student protest wave:
  - **Hamirpur**, 11–12 Aug 2026 — children from Gangwa Ka Dera, Bachichi ka
    Dera and Chandupur marched ~5 km ("Tiranga Yatra") to the DM's office for a
    paved road to school. Dipke amplified it; Allahabad HC took suo motu
    cognisance.
  - **Fatehpur**, 28–29 Jul 2026 — ~1,500 students of Sarvodaya Inter College,
    Kishanpur held a ~6-hour sit-in; 7 of 8 demands conceded in writing.
- **A separate 2025 UP campaign exists** against the school merger/"pairing"
  policy, branded **स्कूल बचाओ अभियान / School Bachao Andolan** (AAP, Congress,
  teacher unions). Different campaign, different hashtags
  (`#SaveVillageSchool`, `#JusticeForSchoolChildren`).

### The name-collision trap

**स्कूल चलो अभियान (School Chalo Abhiyan)** is the UP government's own
pro-government school *enrolment* drive. It dominates Hindi results for anything
shaped like "स्कूल … अभियान" and is unrelated. It is actively excluded — not
merely unmatched — in `EXCLUDE_TERMS`.

## How filtering works

Three independent axes (`classify.ts`), kept separate on purpose:

**1. Campaign tier**
| Tier | Rule |
|---|---|
| `core` | Matches a campaign phrase (`school thik/theek karo`, `स्कूल ठीक करो`) — sufficient alone |
| `org_school` | CJP/Dipke **and** genuine school context **and** no entertainment markers |
| `up_protest` | A UP Gen Alpha event (Hamirpur/Fatehpur/Tiranga Yatra) **and** school context |
| `org_only` | Bare CJP mention — **rejected** |
| `none` | No match, or hit an exclusion term |

Org mention alone is insufficient by measurement, not caution: it pulled in
CJP's earlier July Jantar Mantar exam-leak protest and a viral *"teacher dances"*
clip carrying a stray `#cjp` tag.

**2. Geography** — `strong` (Uttar Pradesh / यूपी / CM Yogi / Basic Shiksha
Parishad) or `district` (75 UP districts, Hamirpur first). A district-only hit
alongside another state's name is treated as contested and dropped, since the
campaign is national and most content is Maharashtra or Bihar.

**3. Recency** — within `RECENCY_DAYS` (45).

Strict output requires all three. Every row carries its evidence columns
(`campaign_evidence`, `school_evidence`, `noise_evidence`, `up_evidence`,
`other_state_evidence`) so the filter can be audited rather than trusted.

## Per-platform reality

| Platform | Method | Status |
|---|---|---|
| YouTube | Own scraper (`services/youtube/search.ts`) + Data API enrichment via the stored OAuth token | Works. No API key needed for discovery; the API supplies exact `publishedAt`, likes and comments |
| Instagram | `fetchHashtagMedia` with the stored session | Works |
| Facebook | Named page scraping only | **Blocked** — session dead, and Meta removed public hashtag/keyword search. Google does not index post content usefully either |

Facebook cannot be keyword-searched at all. Even with fresh cookies the scraper
harvests **pages you name**, then filters. Add fresh `c_user` + `xs` cookies in
**Settings → Facebook** and re-run to populate it.

## Tuning

Everything lives in `config.ts`: `YT_QUERIES`, `IG_TAGS`, `FB_TARGETS`,
`UP_STRONG`, `UP_DISTRICTS`, `UP_PROTEST_EVENTS`, `EXCLUDE_TERMS`,
`ENTERTAINMENT_NOISE`, `RECENCY_DAYS`.

## Caveat

Scraping Instagram and Facebook violates their Terms of Service and can get an
account checkpointed or banned — use throwaway accounts. YouTube discovery here
reads only public, unauthenticated data.
