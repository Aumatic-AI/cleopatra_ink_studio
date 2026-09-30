# Cleopatra Ink Studio — Agent Reference

Technical reference for coding agents working in this repo. For a plain-language
description of what the product does, see `docs/PROJECT_SCOPE.md` instead —
that one has no code in it and is safe to hand to a non-technical reader.

## Project Overview

AI-powered tattoo design platform for **in-shop use by staff (designers +
admin)**. A designer looks up or creates a customer by phone, runs a design
session (style → generate → refine in chat → placement → finalize), and can
print a stencil at the end. The admin does all of that plus manages staff,
customers, and studio-wide reporting. Customers never log in or touch the
app — staff acts on their behalf.

## Stack

- **Framework:** Next.js 16 (App Router) + React 19 + TypeScript strict mode
- **Auth:** Supabase Auth (email + password) via `@supabase/ssr` cookie-based sessions
- **State:** Zustand with throttled localStorage persistence + Supabase hydration (`src/store/app-store.ts`)
- **Database & Storage:** Supabase PostgreSQL + Storage bucket `session-assets`
- **Image generation:** KEI API (`api.kie.ai`) — NOT Claude or DALL·E.
  - AI Design, Rework, and Flash/sticker isolate: `nano-banana-pro` (Gemini 3 Pro Image).
  - Placement: currently `gpt-image-2-image-to-image`, deliberately — see `src/app/api/placement/route.ts`'s `PLACEMENT_MODEL` comment. `nano-banana-pro` was tried here and rejected: it let the tattoo's position/pose drift instead of strictly preserving the composite, which `gpt-image`'s edit mode handles correctly. Don't switch this one without re-testing that regression first.
- **Prompt enhancer:** OpenAI GPT-4o-mini (`/api/enhance-prompt`) — kept on GPT deliberately; only image generation moved to Gemini/nano-banana-pro.
- **Styling:** Tailwind CSS v4. Dark luxury theme: bg `#0D0D0D`, gold `#C9A84C`, font Cinzel.

---

## Dev Environment

```bash
npm install
npm run dev      # next dev — http://localhost:3000
npm run build    # next build (also the pre-deploy sanity check)
npm run start    # next start — serve a production build
npm run lint     # eslint
```

There is **no automated test suite** in this repo. Verify changes with:
```bash
npx tsc --noEmit -p .      # type-check the whole project
npx eslint <changed files> # lint just what you touched
```
...and then actually exercise the feature in a browser — most of this app's
bugs are runtime/UX issues (timezone math, RLS denials, race conditions)
that a clean type-check won't catch.

### Known machine-specific issue

On at least one dev machine, **Node-side `fetch` calls from this app's own
server to Supabase are unreliable** (uploads *and* plain `SELECT`s can hang
or fail), while the exact same calls succeed from the browser, and Node's
`fetch` to third-party hosts (KEI, Pinterest) is fine. If you hit a
mysterious server-side Supabase failure, this is the first thing to
suspect. The established fix, followed throughout this codebase: **do
Supabase reads/writes from the browser** (`src/lib/supabase-client.ts`)
wherever RLS allows it; only fall back to a server route when the
operation genuinely requires the service role (bypassing RLS, admin auth
APIs, Storage deletes) or a third-party secret. See `src/lib/browser-upload.ts`
for the client-side upload helper (with retry-with-backoff for the
occasional genuine transient failure, distinct from the systemic issue
above — retries never help with the systemic one).

---

## Architecture Notes

**Long-running generation = start-job + poll, never one held-open request.**
`src/lib/generation-jobs.ts` tracks jobs in two Supabase tables,
`generation_jobs` (one row per job key) and `generation_job_slots` (one row
per parallel generation task — a separate table, not a JSON array column, so
concurrent slot completions never race on a read-modify-write). This used to
be an in-memory `Map` pinned to `globalThis`, which only works on a single
persistent process — it broke silently on a serverless deploy (e.g. Vercel),
where the POST that starts a job and the later GET polls aren't guaranteed
to land on the same instance. A `POST` to `/api/generate`,
`/api/generate-rework`, `/api/generate-flash`, or `/api/placement` starts
the job row, then does the actual KEI work inside Next.js's `after()` (not a
bare un-awaited promise — a serverless platform can freeze the invocation
the moment the response goes out, `after()` is what keeps it alive until the
background work actually finishes) and returns immediately. The client polls
`GET /api/generation-status?sessionId=<key>` instead of holding a connection
open for the 1–3 minutes generation can take. `getJob()` also treats a job
still "pending" past 6 minutes as the server having died mid-run and flips
its remaining slots to a clear `"Generation timed out"` error, so a killed
invocation surfaces as a visible failure instead of an endless spinner. This
also makes a page reload (or reopening the tab later) resume watching an
in-progress batch instead of losing it. Follow this pattern for any new
long-running generation endpoint — do not reintroduce a synchronous
streaming/NDJSON response, and do not go back to in-memory job state.

**Soft-delete only, with a real retention policy.** `sessions.deleted_at`
(and `staff.deleted_at`) is the only way anything gets removed from staff
lists — every query that lists sessions must include
`.is("deleted_at", null)`. A soft-deleted session is recoverable from the
admin's Recently Deleted tab (`/studio/admin/trash`) for 30 days, after
which a scheduled job hard-deletes it (see **Retention / Cron Setup**
below). **Never add a mechanism that hard-deletes sessions outside of
that documented job** — an earlier, undocumented `pg_cron` job did exactly
that silently for months; it's why this section exists.

**`flow_type` has three values, not two — `'direct'` is Upload Existing.**
Every reader of `flow_type` used to assume a binary `ai_design`/`rework`, so
the Upload Existing path (no AI generation, straight to Placement) silently
defaulted to `ai_design` — which meant any place that treats "ai_design
session with a persisted design" as "resume it in Chat" would redirect an
Upload Existing session there too, landing on an empty, unusable Chat
screen. `handleProceedDirect` in `design/page.tsx` now writes
`flow_type: 'direct'` to the session row the moment a design is uploaded.
Chat's own load effect additionally hard-guards on `flow_type === 'direct'`
and redirects to Placement — never rely on every other flow_type check
being correct instead; keep that guard. If you add a fourth flow type,
audit every `flow_type`/`flowType` reader in the codebase (`grep -rn
"flow_type\|flowType"`) before assuming a binary check still holds.

**Resuming a session must check what actually happened, not guess from one field.** Two places compute "which screen does Continue/Edit open" —
`SessionOverview.tsx`'s `continueUrl` and `customer/[userId]/page.tsx`'s
`resumeUrl()` — and both used to guess from `tattoo_designs.length` alone,
which is flow-type-blind: it sent every Upload Existing session (which
always has a design) to Chat, and any AI Design session that had already
reached Placement back to Chat instead of Placement. The correct rule,
checked in this order:
1. `flow_type === 'direct'` → a design exists means Placement, otherwise Design (never Chat — Upload Existing never has one).
2. No `chat_messages` rows yet → Design/Rework (generation never started).
3. `flow_type === 'ai_design'` and a `placements` row already exists (finalized or not — existing at all is "furthest point reached") → Placement.
4. Otherwise → Chat (this is Rework's permanent answer once chat exists, since Rework has no Placement step).
This only decides the initial landing screen — free navigation between
Design/Chat/Placement via the app's own back buttons is unrestricted and
unaffected, for every flow type.

**`designer_id` means "handled by," not "designer-exclusive."** An admin
who runs a session themself is still recorded as `designer_id`. Don't
assume `designer_id IS NULL` means "no designer type" — it means
unassigned, which is what the dashboard's "Needs Attention" list surfaces.

**Prompt-minimalism.** Short, direct prompt instructions produce
measurably better image-edit fidelity than long ALL-CAPS constraint
lists — this was learned the hard way and is why `prompts-rework.ts` and
`prompts-test.ts` are deliberately terse compared to the original,
verbose `prompts.ts`. If a generation result looks over-constrained or
ignores the reference image, try shortening the prompt before adding more
rules to it.

**Reference-image batches should reflect *every* reference, not just the
first.** `/api/generate`'s `rotateReferences()` cycles which reference
image leads across the 5 parallel generation slots — the underlying model
otherwise anchors on whichever image is listed first, every time. If you
touch this route, keep that rotation; removing it silently reintroduces
"5 versions of reference #1."

**Role-check staleness.** `AdminSidebarShell` (root layout) determines
whether to show the admin sidebar via a client-side Supabase role check.
It subscribes to `supabase.auth.onAuthStateChange` specifically so a
sign-out/sign-in *in the same tab* re-validates — a one-time mount check
alone will keep showing the previous session's sidebar to whoever signs
in next.

---

## Route Map

### Public
| Route | Purpose |
|-------|---------|
| `/studio/login` | Staff login — first page shown to everyone |

### Staff — shared (admin or designer, gated by ownership/role inside the page)
| Route | Purpose |
|-------|---------|
| `/` | Logo splash → auto-redirects by role |
| `/customer/[userId]` | Customer tattoo history + start new session |
| `/studio/sessions/[id]` | Session overview, designer-facing (read-only once finalized/deleted) |
| `/[sessionId]/design` | Design entry: AI Design, Upload Existing, or Rework mode |
| `/[sessionId]/chat` | Chat-style generation + refinement thread |
| `/[sessionId]/placement` | Body placement editor + composite generation |

### Designer only
| Route | Purpose |
|-------|---------|
| `/studio/designer` | Dashboard: phone lookup, new customer, recent sessions |
| `/studio/designer/settings` | Change own password/profile |

### Admin only
| Route | Purpose |
|-------|---------|
| `/studio/admin` | Dashboard: KPIs, 14-day session trend, designer leaderboard, recent work grid, needs-attention list |
| `/studio/admin/customers` | All customers with live search |
| `/studio/admin/sessions/[id]` | Admin session view (shares `SessionOverview` with the designer route) |
| `/studio/admin/designers` | Designer list — search, active/inactive filter, edit modal |
| `/studio/admin/designers/[id]` | Designer profile, session history, password reset |
| `/studio/admin/designers/new` | Create designer account |
| `/studio/admin/trash` | Recently Deleted — restore or permanently delete soft-deleted sessions |
| `/studio/admin/settings` | Change admin password |

`AdminSidebarShell` (`src/components/layout/AdminSidebarShell.tsx`) wraps
the whole app from the root layout and renders the sidebar/nav only when
the signed-in user resolves to an active admin — every other case (login
page, designer, no session) renders `children` directly. It's
role-driven rather than route-driven because pages like `/customer/[userId]`
and the session-flow pages are reached by both roles.

---

## API Routes

| Route | Purpose |
|-------|---------|
| `POST /api/generate` | Starts an AI Design generation/refinement job (5 parallel KEI tasks); returns immediately, client polls `/api/generation-status`. Rotates which reference image leads per slot (see Architecture Notes). Accepts `isTextTattoo` to switch model + prompt; `faithfulMode` for minor-changes-only refinement. At least one reference image is required for a non-refinement generation. |
| `POST /api/generate-rework` | Same job/poll pattern, for the Rework (cover-up/extend) flow. Prompts in `src/lib/prompts-rework.ts`. |
| `POST /api/generate-flash` | Isolates the finalized design onto a plain white background (the "sticker" version used for Rework stencils). Same job/poll pattern. |
| `GET /api/generation-status` | Generic poll endpoint for any of the three generate routes and `/api/placement` — takes `sessionId` (an arbitrary job key), returns job/slot state. |
| `POST /api/placement` | Starts body-placement composite generation. Job/poll pattern. Prompts currently from `src/lib/prompts-test.ts` (minimal-prompt experiment). |
| `POST /api/upload-ref` | Uploads base64 to Supabase Storage server-side. `prefix`: `"refs"` or `"designs"`. Prefer the browser-side `src/lib/browser-upload.ts` for new code — see the Node/Supabase note above. |
| `POST /api/enhance-prompt` | Calls OpenAI GPT-4o-mini to generate 3 enhanced tattoo description variations from raw staff input. Requires `OPENAI_API_KEY`. |
| `GET /api/pinterest/search` | Pinterest reference-image search |
| `GET /api/pinterest/image` | Pinterest image proxy (CORS bypass) |
| `GET /api/proxy-image` | General image proxy (`src/lib/image-src.ts` decides when a proxy is needed vs. a direct Supabase Storage URL) |
| `GET /api/studio/designers` | List all staff, excluding soft-deleted (admin only) |
| `POST /api/studio/designers` | Create designer (admin only) |
| `PATCH /api/studio/designers` | Edit name/email/photo/`is_active` (admin only) |
| `PUT /api/studio/designers` | Reset password — Supabase Auth only, never stored (admin only) |
| `DELETE /api/studio/designers` | Soft-delete designer (admin only) |
| `PATCH /api/studio/profile` | Update a staff member's own name/avatar, or (admin) another staff member's |
| `POST /api/studio/logout` | Sign out |
| `DELETE /api/studio/trash/[id]` | Permanently hard-delete one soft-deleted session — files from `session-assets`, then the row (cascades). Admin only, verified server-side. |
| `GET /api/cron/purge-trash` | Scheduled retention purge — hard-deletes every session soft-deleted more than 30 days ago. `CRON_SECRET`-gated. See **Retention / Cron Setup**. |

---

## Database Tables

| Table | Key columns |
|-------|-------------|
| `auth.users` | Supabase Auth — staff accounts |
| `staff` | `id`, `email`, `name`, `role` (admin\|designer), `is_active`, `last_login`, `deleted_at`, `trash_last_viewed_at` |
| `users` | `id`, `first_name`, `phone` — customers (no auth) |
| `sessions` | `id`, `user_id`, `designer_id` ("handled by," see Architecture Notes), `tattoo_style`, `tattoo_description`, `target_body_area`, `flow_type` (ai_design\|rework\|direct, see Architecture Notes), `status` (active\|completed\|abandoned), `deleted_at` |
| `tattoo_designs` | `id`, `session_id`, `image_url`, `style_name`, `pattern_type`, `iteration`, `is_finalized`, `parent_design_ids[]`, `flash_image_url` |
| `chat_messages` | `id`, `session_id`, `role` (user\|assistant), `content`, `image_urls[]`, `design_ids[]` — the chat screen's source of truth |
| `placements` | `id`, `session_id`, `placement_text`, `body_photo_url`, `final_composite_url`, `is_finalized` |
| `user_preferences` | `user_id`, `preferred_styles[]`, `preferred_placements[]` |
| `generation_jobs` | `job_key`, `iteration`, `parent_design_ids[]`, `user_instruction`, `created_at` — start-job/poll tracker, service-role only |
| `generation_job_slots` | `job_key`, `slot_index`, `status`, `image_base64`, `reason`, `code` — one row per parallel generation task |

**RPC:** `finalize_session(p_session_id, p_design_id, p_placement_id)` —
marks finalized rows, prunes siblings, completes session, updates
preferences.

**RLS:** Admin sees/edits everything (`is_admin()`). Designer sees only
sessions/designs/placements/chat where `designer_id = auth.uid()`. Service
role (used in API routes for privileged operations) bypasses RLS entirely.

---

## Key Files

### Auth & Security
- `middleware.ts` — route protection, 24hr session timeout, soft-delete check. Reads the cookie-local session first, then runs `getUser()` and the staff-row query in parallel (not sequentially).
- `src/lib/supabase-server.ts` — `createSupabaseServerClient` (cookie-based, server components/routes), `createServiceClient` (service role, bypasses RLS — API routes only), `getStaffSession`
- `src/lib/supabase-client.ts` — `createSupabaseBrowserClient`, safe in `"use client"` components; the default for reads/writes per the Node/Supabase note above
- `src/lib/auth-utils.ts` — `getClientRole()`, `resolveBackUrl()` — role-validated back navigation for pages reached from multiple entry points

### Core Logic
- `src/lib/prompts.ts` — AI Design + Rework's original prompt builders. `STYLE_PROMPT_DESCRIPTORS` maps 70+ styles to visual language. Unified entry: `buildTattooPrompt(desc, style, hasRefs, refinement?, colors?, bodyArea?, isTextTattoo?, textTattooDetails?, referenceCount?)`.
- `src/lib/prompts-rework.ts` — deliberately minimal Rework prompts (see Architecture Notes)
- `src/lib/prompts-test.ts` — deliberately minimal Placement prompts, currently in use by `/api/placement` as an experiment against the composite-mode prompts in `prompts.ts`
- `src/lib/kei-api.ts` — KEI HTTP client: `createKeiTask`, `waitForKeiTask`, `KeiTaskFailedError`, `KeiCreditsError`; also re-exports `buildTattooPrompt` from `prompts.ts`
- `src/lib/generation-jobs.ts` — the start-job/poll job tracker, backed by `generation_jobs`/`generation_job_slots` (see Architecture Notes)
- `src/lib/session-storage-cleanup.ts` — deletes every file under `{sessionId}/` in `session-assets`; shared by the one-off hard-delete route and the scheduled purge
- `src/lib/storage.ts` — server-side `uploadBase64`, `uploadFromUrl` to `session-assets`
- `src/lib/browser-upload.ts` — client-side upload helpers with retry-with-backoff for genuine transient failures
- `src/lib/tattoo-colors.ts` — ink palette (`TATTOO_COLORS`), `getColorsByHex`
- `src/lib/tattoo-pdf.ts` — stencil engine: `computeStencilLayout`, `loadTrimmedStencilImage`, `downloadTattooStencilPdf` (multi-page A4, mirror + rotation, 2mm safe-area guide)
- `src/lib/image-src.ts` — decides whether an image URL can load directly (own Supabase Storage, CORS-permissive) or needs `/api/proxy-image`
- `src/store/app-store.ts` — Zustand store. `makeThrottledStorage(400ms)` batches localStorage writes. Pages render from the store immediately; `hydrateFromSession()` syncs from Supabase in the background.

### Components
- `src/components/layout/AdminSidebarShell.tsx` — admin sidebar/nav shell (see Route Map)
- `src/components/session/SessionOverview.tsx` — shared read-only session view (admin + designer routes)
- `src/components/dashboard/ActiveSessionsModal.tsx` — paginated active-sessions list, launched from the admin dashboard KPI tile
- `src/components/design/PreviousDesignsModal.tsx` — role-scoped "browse previous designs" picker (paginated, customer/designer filters)
- `src/components/design/ColorPickerModal.tsx` — ink color selection
- `src/components/placement/TattooPlacementEditor.tsx` — drag/scale/rotate canvas overlay for interactive placement
- `src/components/print/TattooPrintStudio.tsx` — A4 print modal
- `src/components/typography/TypographyGenerator.tsx` — text-tattoo font picker + canvas renderer
- `src/components/pinterest/PinterestSearch.tsx` — Pinterest reference search UI
- `src/components/camera/CameraCapture.tsx` — in-browser camera capture for reference/body photos
- `src/components/ui/StyleSelect.tsx` — searchable style dropdown (70+ styles by category)
- `src/components/ui/FilterChips.tsx` — small pill-style filter control used across admin list pages

**Custom dropdowns only** — this app never uses a native `<select>`; every
dropdown is a hand-built button + chevron + absolute panel matching the
app's visual language (see `StyleSelect`, `FilterChips`, or any
`FilterDropdown` in a list page for the pattern to copy).

---

## Staff Flow

1. Any URL → middleware checks auth + 24hr timeout → `/studio/login` if needed
2. Login → `last_login` stamped → redirect to `/studio/designer` or `/studio/admin`
3. Designer: phone lookup → new or existing customer → `/[sessionId]/design`
4. Design: AI Design (chat-based generate/refine), Upload Existing, Browse Previous Designs, or Rework
5. Placement: describe or photograph the body location → interactive editor → generate composite
6. Finalize (with confirmation) → optionally print a stencil
7. Admin: dashboard, manage designers/customers, review Recently Deleted

---

## Retention / Cron Setup

Two schedules matter, both documented at the point they're declared —
**never add an undocumented one; see Architecture Notes for why.**

- **30-day trash purge** — a `pg_cron` job (`purge-expired-trash`) declared
  in `supabase-schema.sql` near the bottom, under "PURGE JOB". It only
  triggers an HTTP call (via `pg_net`) to `GET /api/cron/purge-trash`,
  which does the actual storage + row deletion. The SQL block has a
  placeholder domain and secret that must be filled in and re-run in the
  Supabase SQL editor before it does anything — check it's live with
  `select * from cron.job where jobname = 'purge-expired-trash';`.
- Run `supabase-schema.sql` for a fresh install. For an already-running
  database, apply new columns/indexes/policies as targeted `ALTER`/`CREATE`
  statements instead of re-running the whole file.

---

## Environment Variables

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
KEI_API_KEY
OPENAI_API_KEY                  # /api/enhance-prompt (GPT-4o-mini description enhancer)
CRON_SECRET                    # shared secret for the purge-trash cron endpoint
PINTEREST_APP_ID               # currently unused at runtime — see supabase-schema.sql comment
PINTEREST_APP_SECRET           # currently unused at runtime — see supabase-schema.sql comment
```

---

## Security Considerations

- Never log or expose `SUPABASE_SERVICE_ROLE_KEY` — it bypasses RLS
  entirely. It belongs only in server-only files (`src/lib/supabase-server.ts`
  and API routes that import from it), never in a `"use client"` file.
- Every admin-only API route must independently verify the caller's role
  server-side (`getStaffSession()` or the `getUser()` + service-role staff
  lookup pattern used in `src/app/api/studio/designers/route.ts`) — never
  trust a client-supplied role/flag for a privileged or destructive action.
- Storage deletes have no client-facing RLS policy on purpose — hard
  deletion of a session's files only ever happens through
  `src/lib/session-storage-cleanup.ts`, called from a service-role API
  route, never directly from the browser.
