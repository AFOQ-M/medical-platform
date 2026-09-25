# AFOQ — PROPOSED DESIGN SYSTEM & PRODUCT DESIGN SPECIFICATION

> **VERSION 1 (الأصلية — المرجع القديم، كما سُلِّم في المرحلة الأولى)**
> **الحالة:** الوثيقة الأصلية محفوظة حرفيًا أدناه. لا تُعدَّل هذه النسخة؛ التحسينات في ملف `P1.5-DESIGN-SPEC-REVISED.md`.

---

I'll start by deeply studying the current AFOQ project, then build the full design specification. This is a large task — let me plan it and explore the codebase thoroughly.

Let me check file sizes before reading them all.

Product discovery is complete. I now have a full understanding of AFOQ: its hierarchy (University → Faculty → Year → Subject → Resource), all 14 pages, the auth model (anonymous → guest upgrade), 4 roles, forum, courses, admin (10 tabs), and the security model. Here is the complete design engineering specification.

## A. Executive Summary

AFOQ (أفق المعرفة) is an Arabic-first medical study-resource platform. The proposed redesign treats current visual design as replaceable while preserving the product's functional architecture as constraint: the academic hierarchy (University → Faculty → Year → Subject → Resource — Semester is a nullable filter attribute on `subjects`, not a separate level), the resource type system (7 types), roles-permission model, forum, courses, reports, favorites, search, and the single-file admin SPA.

Design direction: A calm, credible, study-first academic instrument — not a marketing site, not a social network, not a generic dashboard. The visual language derives from the domain (medical education, long study sessions, RTL Arabic) rather than from template aesthetics.

The proposal in one paragraph: A shallow navigation arc from search-first entry (home platform) through a compact hierarchy browser, into a high-dense, scannable subject page, with a professional enterprise-grade admin panel. RTL is treated as native, not mirrored. Every resource type, status, and permission state carries a semantic, non-color-only signal. Accessibility is a design constraint from the first token.

Priority of the redesign: (1) reduce steps to content, (2) make scanning/decision faster, (3) make admin work efficient and permission-aware, (4) keep the calm academic trust, (5) eliminate every AI-default visual.

## B. Product Understanding

**What AFOQ is**

A platform organizing study resources for medical students, developed by a Palestinian youth initiative (launched 26 December 2025). Static frontend (HTML/CSS/JS, no framework) + Supabase backend, deployed on GitHub Pages. Content is bilingual (Arabic primary, English academic resources).

**Primary value**

"My study resources, organized and reachable in the fewest steps." Students browse an academic hierarchy to reach materials: lectures, slides, books, summaries, notes, questions, past exams.

**Most important workflows**

- Find a resource fast (search first, then hierarchy, then subject page)
- Browse downward through the hierarchy (university → faculty → year → semester → subject)
- Scan a subject's resources and pick one (type tabs + internal filter)
- Open/re-download past materials (recently viewed + favorites)
- Participate in the forum (ask, share, discuss) — authenticated
- Admin manage content (CRUD, permissions, moderation) — admin roles

**What must be fast**

Search, subject browsing, resource open/link. These are the "jobs to be done".

**What can be secondary**

Marketing landing content, favorites polish, course browsing, forum social features.

**Roles observed in the actual system** (evidence: schema.sql, phase4b auth, phase6 forum)

- **Guest (anonymous):** browse/search/view resources/favorites(reports to RPC)/view forum; cannot post forum or replied.
- **Real authenticated user:** forum topics + replies, edit/delete own content, report.
- **Staff:** profile role with no default permissions — only what ACL grants.
- **Admin:** ACL-based permissions on (academic_structure | resources | reports | courses) across (global | university | faculty) scopes, with actions view/create/edit/delete. Session lock + MFA (AAL2).
- **Super Admin:** full bypass; requires AAL2 if MFA factor exists.

## C. Users & Roles

### C.1 Visitor / Guest (anonymous session)

- **Goals:** find a resource, browse, try the platform, preview community.
- **Permissions (evidence):** read published resources & active structure; submit public report via RPC (rate-limited); browse forum categories/topics/replies; local favorites & recently-viewed (localStorage).
- **Primary tasks:** search → open resource; browse hierarchy; open links.
- **Secondary:** report bad resource; read forum.
- **Information needs:** resource title, type, language, verified badge, where the link goes.
- **Frequency:** high, one-off or recurring.
- **Risk:** low — no writes except RPC-gated report.
- **UX priorities:** zero-friction entry, no forced account, instant search suggestions, obvious "open resource".

### C.2 Real Authenticated User ("Student Member")

- **Goals:** participate in forum, keep an identity, later favorites sync if added.
- **Permissions (evidence):** everything a visitor has + forum topics/replies create/edit/delete own, submit forum reports.
- **Primary tasks:** create topic, reply, edit own post, report.
- **Secondary:** browse, search resources.
- **Information needs:** forum categories, my content, topic/reply state.
- **Frequency:** medium, recurring during study.
- **Risk:** low — content only their own.
- **UX priorities:** frictionless sign-in (guest upgrade path — evidence linkIdentity), clear authorship, safe text entry.

### C.3 Admin / Staff (content managers)

- **Goals:** manage structured content & resolve reports per granted scope.
- **Permissions (evidence):** ACL matrix — entity type × scope (global/university/faculty) × action (view/create/edit/delete); courses require global scope; forum moderation via 'reports' view/edit.
- **Primary tasks:** CRUD universities/faculties/years/subjects/resources/courses; manage reports; hide/reveal; bulk structure ops.
- **Secondary:** review forum reports; check dashboard counts.
- **Information needs:** what needs action (reports counts), where permission applies, entity count.
- **Frequency:** daily-ish, bursts.
- **Risk:** moderate — writes affect public content.
- **UX priorities:** keyboard speed, dense scanning, cascading selects, visible permission scope, safe destructive paths.

### C.4 Super Admin

- **Goals:** govern the whole system, grant/revoke permissions, create admins.
- **Permissions (evidence):** bypass all; profiles & user_permissions management only visible to super_admin.
- **Primary tasks:** users+permissions tab, promote admins, oversee moderation.
- **UX priorities:** clarity of the permission matrix (WHO ← WHAT ← WHERE), audit trail visibility (admin_activity_log), and MFA/session-lock status prominence.
- **Not evidenced:** the current system does NOT have "student grades", "attendance", "chat", "notifications", "points/likes", "advisor" roles — do not invent.

## D. Feature Inventory

Classification based on actual implementation (evidence: pages, admin.js tabs, SQL).

### Core

| Feature | Purpose | Entry | Notes |
|---|---|---|---|
| Global header search (instant suggestions) | Fastest path to a resource | Every public page | debounced, keyboard-accessible |
| Hierarchical browsing | University→…→Subject | platform.html + breadcrumbs | depth 6 |
| Subject page with type-tabs + internal search + load-more | Scan/pick resources quickly | subject.html | 7 type filters — high density |
| Resource open (safe external link) | The actual payoff | Everywhere cards appear | new tab |
| Full search with cascading filters | Filtered discovery | search.html | university/faculty/year/type/language |

### Important

| Feature | Purpose | Entry |
|---|---|---|
| Favorites (local) | Bookmark without account | favorites.html + heart on cards |
| Recently viewed | Continue where stopped | home/platform + favorites |
| Popular resources (view_count) | Social proof | platform.html |
| Resource reporting (rate-limited) | Moderation crowd-input | cards + modal |
| Forum | Community Q&A | forum.html |
| Courses | Structured lessons | courses.html/course.html |
| Verified badge | Trust signal | all resource cards |

### Supporting

- University/faculty/year entity pages + subject-level semester filter — Hierarchy steps
- Landing page (index.html) — Brand/team/about entry
- Footer with social links — Community outreach

### Administrative

- Admin dashboard counts — At-a-glance system health
- CRUD per entity (univ/faculty/years/subjects/resources/courses) — Content ops
- Managing hidden/published/verified — Content governance
- Reports queue + forum reports queue — Moderation
- User & permission matrix — Access control (super only)

### Secondary / Not-evidenced (do not invent)

Notification center, in-app chat, points/gamification, saved filter preferences, email digests, resource file preview. (Marked for later evaluation, not design.)

## E. User Journeys

### E.1 "Find & open a resource fast" (Guest) — CRITICAL

- **Entry:** platform.html (or any page)
- **Intent:** get a specific lecture/summary NOW
- 1. Focus search box (or click header icon)
- 2. Type few chars → suggestions appear (debounced)
- 3. Pick suggestion / press Enter → search.html results
- 4. Scan results (title, type badge, language, verified)
- 5. Open resource (new tab) → increment view
- **Success:** resource opens; user reads it.
- **Failure:** no results → empty state suggests filters; or report a broken link.
- **Exit:** back to results / another search.
- **Interruptions:** suggestion list ordering; filters reset; slow network.
- **Friction:** none obvious — this is AFOQ's strongest flow. Keep it fast and un-cluttered.

### E.2 "Browse down the hierarchy" (Guest)

- **Entry:** platform.html → university card → faculty card → year → semester → subject
- **Intent:** see everything available for "second year, pathology"
- **Decisions:** pick faculty, pick year, pick semester, pick subject
- **Success:** subject page with type-tabs
- **Failure:** empty faculty/year/semester (inactive) → clear "لا توجد بيانات" empty states
- **Friction:** 5 clicks depth; each step is quick but cumulative.
- **Design decision:** years/semesters compacted — show semester list directly with year context; allow home shortcut breadcrumb on any step.

### E.3 "Report a bad resource" (Guest)

- **Entry:** resource card → report icon → modal (reason + notes, rate-limited)
- **Intent:** protect peers from broken/inaccurate material
- **System feedback:** toast "تم استلام بلاغك" or "تم الإرسال، حاول لاحقاً" on rate-limit error
- **Success:** admin sees report in queue.
- **Failure:** rate limit / DB error.
- **Interruptions:** none critical.

### E.4 "Post a forum question" (Real user)

- **Entry:** forum.html → "+ موضوع جديد" (modal) OR login gate
- **Steps:** category → title → content → submit → topic appears
- **Guest variant:** button opens auth overlay → after auth return to intent
- **Success:** topic visible with author name; reply allowed.
- **Failure:** content constraints (length), session expiry → friendly Arabic error.

### E.5 "Admin: add a resource" (Admin)

- **Entry:** /admin → resources tab → add form
- **Steps:** cascading university→faculty→year→subject → type/language/url/keywords/source → status
- **Critical affordance:** permission scope shown (what you may touch); verified toggle
- **Success:** row appears; toast.
- **Failure:** invalid URL → field error; permission denied → notice.
- **Friction (current):** long form in `<details>`; design decision later: staged inline form + validation on blur.

### E.6 "Super Admin: grant permission" (Super Admin)

- **Entry:** /admin → users tab → permissions
- **Steps:** pick user → pick scope (global/university/faculty) → check entity/action boxes
- **System feedback:** toast log "permission_granted" summary; self-edit reloads own permissions.
- **Success:** RLS now allows the user's allowed ops.
- **Failure:** none critical — log only.

## F. Information Architecture (Proposed)

### F.1 Hierarchy

```
AFOQ (global)
├── Search (global catalog, cross-hierarchy)
├── الجامعات (Universities) → الكلية → السنة → الفصل → المادة → الموارد
├── المفضلة (Favorites)
├── الدورات (Courses) → Course detail
└── ملتقى أفق (Forum) → Categories → Topic → Replies
    └── إدارة (Admin) — separate shell, not in public nav
```

### F.2 Navigation model

- **Global navigation (public):** logo (home/platform) · search (icon, universal) · المفضلة · الدورات · ملتقى أفق; right side: account trigger (guest: دخول/تسجيل; user: avatar+القائمة). Justified: 4 destinations — flat, noun-based, present-tense.
- **Section navigation:** definition — none needed; the hierarchy IS the section nav. On subject pages, type-tabs function as intra-page section nav.
- **Contextual navigation:** breadcrumbs (up to 6 levels, pill links, compact on mobile); resource cards' links; "عرض كل الأقسام ✕" filter chips on home/forum.
- **Utility navigation:** footer links (about/brand, search, courses, forum, favorites) + socials. tiny utility row separate from primary.
- **Breadcrumbs:** present on every hierarchical page; current step styled bold non-link; ancestors interactive pills; wrap safely on mobile (truncate with "…" midpoint, not overflow).
- **Search:** one global UI pattern (header overlay) + full search page. Keep as-is functionally; polish overlay.
- **Mobile navigation:** keep top header + universal search; primary destinations as icon+short label pills in header (they already collapse to icons ≤480px — improve: keep "المفضلة/الدورات/الملتقى" as screen-reader-labeled icon buttons with a visible expandable overflow for labels on ≥560px). No desktop hamburger.
- **Admin navigation:** tab bar (10 tabs) — sticky top in admin shell, perm-aware tab suppression is already implemented; strengthen with count badges on reports tabs.

### F.3 Naming (Arabic microcopy-first, noun-based)

البداية/الرئيسية (home) · الجامعات · الدورات · ملتقى أفق · المفضلة · لوحة التحكم. Resource types keep approved Arabic labels; keep code identifiers (types/entities) unchanged — labels live in presentation only.

### F.4 Depth & relationships

Public tree depth: platform(home) → university → faculty → year → subject → resource = 6 levels worst case (data hierarchy only — Semester is NOT a separate level; it is a nullable filter attribute on `subjects.semester`, no dedicated table/entity/id). year.html is a redirect shim to semester.html?year=... (confirmed, unchanged); semester.html loads the full year's subjects and filters them client-side into first/second/summer/unspecified tabs — it is a filtered view of Subject, not an independent hierarchy node.

Courses/forum are top-level siblings — correctly flat, not nested.

### F.5 Search & Filters IA

- Global overlay search: suggestion = title (resource) + subject badge; "عرض كل النتائج".
- Full search page filters (existing): university → faculty (cascading), year, type, language. Preserve exactly — these map to search_resources params. Add "مسح الفلاتر" always visible when any filter active; keep results count.

## G. Proposed Sitemap

```
AFOQ
├── index.html                 Landing / brand / about (unchanged roles)
│   └── platform.html          Hub: hero search + quick links + universities + popular + recently viewed
├── university.html            List of universities (cards, count)
│   └── faculty.html           Faculties of a university
│       └── year.html          Years of a faculty (number cards)
│           └── semester.html  Client-side semester filter (first/second/summer) over the year's subjects (with context breadcrumb) — not a separate entity
│               └── subject.html Subject: type tabs + inline search + resources
│                   └── [resource]  external link (new tab)
├── search.html                Full search + cascading filters + results grid
├── favorites.html             Local favorites
├── courses.html               List of published courses
│   └── course.html            Course detail: meta + lessons (text/video/link)
├── forum.html                 ملتقى أفق: categories + latest topics + new topic
│   └── forum-topic.html       Topic: replies + reply form + report + edit (owner)
└── admin/ (separate shell)
    ├── (login) → (MFA verify) → dashboard
    ├── dashboard               Counts (isolated loads)
    ├── universities | faculties | years | subjects | resources | reports | courses
    ├── users & permissions (super_admin only visual)
    └── (moderation: forum reports inside reports/review flow)
```

Each public node keeps its canonical URL/query params — real entity IDs (?id=) for university/faculty/year/subject/category nodes, plus a client-side filter key (?semester=, values first/second/summer — not an entity id) — SEO + shareability preserved; sitemap.xml intact.

## H. Design Direction

**Design Personality:** "Academic Instrument" — calm, trustworthy, precise; the digital equivalent of a well-organized clinical reference shelf. Clinical clarity, not dashboard neon; academic warmth, not social-media energy.

**Visual Tone:** Quiet teal-and-ink base with warm off-white paper background; Resource-type color coding as functional wayfinding, not decoration; Density tuned for scanning, not marketing whitespace; Shadows near-zero; borders do the separation work; Type-led hierarchy: Cairo headings + Tajawal body (existing brand fonts — keep).

**Emotional Tone:** Calm focus (long study sessions), credibility (medical/academic), belonging (student community), trust (curated + verified + moderated).

**Density:** Medium-high. Subject/resource lists and admin tables are dense-but-scannable; landing/hub pages use breathing room only around wayfinding.

**Perceived Quality:** Crisp alignment, consistent rhythm, restrained motion, obsessive contrast compliance, predictable interactions.

**What the design should feel like:** A clinical-reference app for its own students: "everything is where I expect it; nothing shouts; I can focus."

**What the design must NOT feel like:** A generic AI SaaS, a social feed, a marketing brochure with giant heroes, a colorful dashboard collage, a dark-mode dev tool, an e-commerce storefront.

## I. Visual Language

### I.1 Signature elements (what makes it "AFOQ", not generic)

- Teal ink identity (existing --primary #0F4C5C) retained as the cold-side anchor.
- Resource-type horizontal color band (border-inline-start 6px) on cards — already a functional signature; extend it into subject page tabs (active tab fills with same color) and small row-marker dots in search results (dot instead of full band for rows).
- Warm off-white paper background (--bg #F9FBFC) vs pure white surfaces — the "study desk" warmth.
- Pill-shaped controls with 44px hit targets (retained from existing system — proven, accessible).
- Arabesque restraint: Cairo 800 in headings only at the levels where hierarchy needs it; no flair, no rings, no decorative gradients anywhere in the app (landing rings are the brand's only decorative element — evaluated below).

### I.2 Imagery / iconography

- **Icons:** existing emoji/simple glyph set → replace with consistent inline SVG icon set (stroke 2, 24px grid) — one source, aria-hidden + accessible names. Rationale: current mixed emoji/pill icons are the loudest "template" signal.
- **Covers (courses):** existing aspect-ratio covers; keep as content images only, alt-text mandatory.
- **No** stock photography, no AI illustration, no decorative shapes in app surfaces.

### I.3 Density & rhythm

- Base unit 8 (evidence-friendly). Section spacer: 4–6 units. Card padding: 2 (16px) standard, 3 (24px) on heroes/landing.
- Resource rows: compact single-row variant (dense) + card variant (rich).

## J. Typography System (Proposed)

Retain the proven pairing — Cairo (display) + Tajawal (text). Rationale: both designed for Arabic, existing load cost, brand recognition; changing typefaces would break identity for no equity.

| Role | Font | Weight | Size | Line-height | Notes |
|---|---|---|---|---|---|
| Display / Page H1 | Cairo | 800 | clamp(1.6rem, 1.1rem + 2vw, 2.2rem) | 1.25 | Page-level titles (universities, subject, courses…) |
| Section H2 | Cairo | 800 | 1.25rem | 1.3 | Section headers in hub |
| Card / List H3 | Cairo | 700 | 1.05rem | 1.4 | Card titles |
| Body | Tajawal | 400 | 1rem | 1.65 | Default text |
| Body strong | Tajawal | 700 | 1rem | 1.65 | Emphasis only |
| Meta / captions / dates | Tajawal | 400 | 0.85rem | 1.5 | Metadata |
| Labels / buttons | Tajawal | 700 | 0.9rem | 1.4 | Uppercase-decorated buttons not needed in Arabic |
| Data / numbers / codes | Tajawal | 500 | 0.9rem–1rem | tabular | Admin counts, view counts, years — font-variant-numeric: tabular-nums |
| Long-form (forum/lesson text) | Tajawal | 400 | 1rem | 1.8 | Reading comfort; max-width 70ch |

**Rules:**

- Hierarchy by weight+size+color only; never faux-bold/faux-italic.
- Keep 5 scale levels max (display/A/body/meta/data) — compresses today's ad-hoc sizes.
- text-wrap: balance on headings (progressive).
- Fonts keep display=swap; preconnect kept. No layout shift via font swap (existing font-display pattern respected).
- Arabic rules: ensure Tajawal covers needed Arabic diacritic-heavy math/medical strings; preserve Latin numerals for counts (common in Arabic academic usage) — decide via existing format (ar-EG dates, Latin digits) and keep consistent.

## K. Color System (Proposed)

Keep the existing semantic token base (documented in DESIGN_SYSTEM.md) and extend it minimally, with explicit context → decision for every addition.

| Role | Token (existing) | Value | Why |
|---|---|---|---|
| Primary | --primary / --primary-dark | #0F4C5C / #0A3A47 | Cold-side credibility; an alternative to generic blue |
| Secondary | --secondary | #1F7A8C | Footer links, slides type, secondary surfaces |
| Accent | --accent | #E9A426 | Rare-use highlight: focus ring, verified chip accent, one CTA per screen max |
| Background | --bg | #F9FBFC | Warm paper |
| Surface | --surface | #FFFFFF | Cards that must sit above the paper |
| Muted surface | --muted-bg | #EEF4F6 | Inputs, hover, chips, subtables |
| Ink | --ink / --ink-soft | #0F172A / #475569 | Primary/secondary text |
| Ink faint | --ink-faint | #94A3B8 | Restricted: large/bold only (contrast 2.56:1) — do not use on small text |
| Line / line-strong | --line / --line-strong | #E2E8F0 / #CBD5E1 | Borders |
| Success | --success-bg + text | #E4F5EA + #15803D* | Verified/published badges (*new approved text pairing — currently reuses type-questions green; formalize token for clarity) |
| Warning | --warning (new) | #B45309 on #FEF3C7 | "Under review/reported pending" — currently absent; needed for report/review statuses to avoid blue=yellow ambiguity |
| Error | --danger | #DC2626 (bg #FEF2F2, border #FECACA) | Errors, destructive, reported badge |
| Focus | --focus | var(--accent) | Keyboard focus ring — accent reserved for this is strategic: makes focus unmistakable |

Resource type palette (kept — functional wayfinding): lecture #0E7490 / slides #1F7A8C / book #5B21B6 / summary #0F766E / questions #2E9E5B / notes #92400E / past_exam #9D174D — each with soft bg. Rationale: 7 distinct hues are needed for instant scanning in a content library; each maps to a study use-case, not a brand accent. Consistent light-bg + dark-text pattern keeps contrast.

**Rules:**

- One accent in use per viewport; accent never as a big background (except single primary CTA where chosen).
- No new brand hues without governance approval (extend DESIGN_SYSTEM.md rules).
- All text/bg pairs ≥4.5:1 (regular) / ≥3:1 (large+UI); verify with the Design Quality Gate.
- Status colors paired with icons/text — never color-alone.
- Neutral gray scale stays limited (ink-soft/line families); no rainbow.
- Dark mode: out of scope (not evidenced in product or brand); deferred decision — do not invent.

## L. Spacing & Grid (Proposed)

**Spacing scale (4-base, evidence grounded)**

- --space-1: 4px · --space-2: 8px · --space-3: 12px · --space-4: 16px
- --space-5: 24px · --space-6: 32px · --space-7: 48px · --space-8: 64px
- Default card padding: 16px (space-4); hero/hub panels: 24–32px.
- Between card groups: 24px; between sections: 48px.
- Input field internal padding: 12px vertical for 44px target.
- Symmetrical padding by default; asymmetry only for compact row density.

**Grid**

- Global container: max-width: 1120px, padding-inline: 16px (mobile) → 24px (desktop) — keeps existing feel, tightens whitespace where current is excessive.
- Card grids: repeat(auto-fill, minmax(220px, 1fr)) (retained; bumps min to 230px on desktop).
- Subject resources: rows > cards on desktop (denser scanning; decision rationale in Step 14).
- Admin tables: full-bleed container, min-width: 0 on every cell for truncation.
- Alignment: one baseline; text start always; icons centered on their hit-box.

**Density rules**

Three densities named & governed: relaxed (hub/landing), standard (lists/cards), dense (admin tables, subject rows). Components declare a density; mixing within one surface is an anti-pattern.

## M. Design Tokens (Proposed Architecture — documentation only, NO files created)

- **Color Tokens:** --primary, --primary-dark, --secondary, --accent, --bg, --surface, --muted-bg, --ink, --ink-soft, --ink-faint, --line, --line-strong, --danger(+bg/border), --warning(+bg), --success-bg, --neutral-bg, --focus, --type-{lecture,slides,book,summary,questions,notes,past_exam}(+bg)
- **Typography Tokens:** --font-display (Cairo), --font-body (Tajawal), --text-display/A/body/meta/data + line-heights/weights table
- **Spacing Tokens:** --space-1..8 (above)
- **Radius Tokens:** --radius-lg (14px: cards/panels), --radius-md (10px: inputs), --radius-sm (8px: chips/icon buttons), --radius-full (999px: pills)
- **Border Tokens:** --border-hair (1px, --line), --border-strong (1px, --line-strong), --border-accent (2px, active/selected)
- **Shadow Tokens:** --shadow (0 2px 10px rgba(18,38,42,.06)) restyled — near-zero everywhere; --shadow-hover (8px up, .12)
- **Motion Tokens:** --dur-micro 150ms, --dur-std 220ms, --ease-out (cubic-bezier(0.2,0,0,1)), --reduced (media query kills all)
- **Breakpoint Tokens:** 480 / 560 / 640 / 720 / 900 / 960 (existing) — semanticized: --bp-hand, --bp-phablet, --bp-tablet, --bp-laptop, --bp-desk
- **Z-index Tokens:** --z-header 100, --z-overlay 900, --z-modal 1000, --z-toast 1100
- **States Tokens:** (component-level) default/hover/focus/active/selected/disabled/loading/error/empty/success

Naming follows the token-with-purpose principle from Phase 0: someone reading --type-summary or --space-4 knows where it's used. No hex literals outside :root.

## N. Component Architecture (Proposed)

**Foundations:** Tokens (M), Theme (light, RTL), Reset conventions, Focus system (:focus-visible ring = accent, 3px, offset 2px — retained), Typography primitives (headings/body/meta/data), Border/radius/space conventions.

**Primitives**

- **Button** — variants primary/outline/ghost/danger, sizes sm/md/lg, with icon, loading (spinner inline), disabled. Min-height 44px. Full-bleed option only in mobile forms.
- **Input / Select / Textarea** — muted bg, line-strong border, focus→primary border + accent ring; label always visible above; error state: danger border + message below with role="alert"; helper text under.
- **Badge / Tag** — neutral, success, warning, danger, type-tag (colored pairing), icon optional. aria-label when only visual.
- **Link** — inline, nav, breadcrumb pill, card-link (whole card clickable but with a real anchor inner? — pattern: card = <a> block, no redundant inner link).
- **IconButton** — 44px, aria-label, tooltip (accessible) for header icons.
- **Skeleton loader** — shimmer-free (aria-hidden static blocks) to avoid noise; accessible role="status".

**Components**

- Header (sticky, primary bg, logo + compact nav + search trigger + account trigger)
- Breadcrumbs (ancestor pills, current bold, wrap-safe, midpoint ellipsis)
- ResourceCard (band-color, tags, verified chip, actions row; two variants: card & row)
- ResourceRow (dense list variant — subject page desktop)
- TypeTabs (subject page filter, active color-filled)
- GlobalSearchOverlay (suggestion list, keyboard nav, "view all results")
- Modal (report, new topic, course-lesson confirm; overlay + dialog + Escape + focus trap + restore focus) — reuses current overlay pattern, formalize ARIA
- Drawer (mobile: account menu) — slide-in, focus trap, overlay
- Toast (inverse pill, role=status/alert, timeout+manual dismiss; stacked max 3)
- EmptyState / ErrorState / LoadingState (icon+title+action, per surface)
- StatCard (admin dashboard)
- FilterChip (active filters row with ✕)
- Forum components — CategoryCard, TopicRow, ReplyCard, ReportModal(reuse), OwnerEditInline (title input + textarea inline swap), LockedTag
- Course components — CourseCard (cover, chips, CTA), LessonRow (type icon, duration, open)
- Pagination / LoadMore (uniform primary-outline "تحميل المزيد" + optional "تم الوصول إلى كل النتائج" end marker)

**Composite Components (Patterns)**

- PermissionMatrix (user×scope×entity×action UI — admin "المستخدمون والصلاحيات")
- CascadingSelector (university→faculty→year→subject 4-select chain, shared admin + reused in search page filters)
- ReportReviewQueue (reports list + inline actions hide/restore + status badge)
- ResourceForm (add/edit resource with cascader, type/language/source/provider select, url validation, verified toggle)
- AdminTableRow (row + state toggle + edit + delete; per-permission visibility)

**Page-level compositions:** Per the screen-by-screen section (Z), each page composed from the above.

## O. Interaction System

**Principles**

- Direct, state-visible, reversible. Every action shows its result; destructive paths require confirmation + undo where not damaging to RLS/data integrity.
- Keyboard-first parity. Every mouse path has a keyboard path of equal length.
- Feedback proportionality. Micro-click → micro-feedback; destructive → loud confirmation; long-run → progress.
- Escape hatches always. Cancel, close, back, clear filters, reset.

**Interaction table (major affordances)**

| Trigger | Feedback | Transition | Result | Error | Recovery |
|---|---|---|---|---|---|
| Click search icon | overlay opens, input focused | 160ms fade | suggestions live | empty → "لا توجد نتائج" + clear | Esc/backdrop closes |
| Type in header search | debounce 250ms → suggestions | instant swap | pick / enter full search | slow net → subtle "جارٍ البحث…" | retry on next key |
| Click type tab | active tab fills type color | 180ms | list filters + count updates | — | click "الكل" |
| Heart (favorite) | fills accent + toast optional | 120ms | localStorage updated; count | — | toggle again = remove |
| Open resource | new tab; view count increments quietly | — | content opens | dead link (user reports) | report path |
| Report submit | modal → disabled spinner → toast | — | row in admin queue | rate-limit toast | wait window (10 min) |
| New forum topic (guest) | opens auth overlay (guest-upgrade) | overlay | auth → returns to modal | auth fail → friendly Arabic | retry |
| Admin delete | confirmation modal naming the entity | focus to confirm | row gone + toast + log | permission → blocked notice | deleted row visible only to admins → no undo on DB delete; confirm wording must be explicit |
| Admin state toggle (publish/hide) | visual state flip + toast + log | 150ms | status badge changes | — | toggle back |
| Load more | button → spinner → append | smooth append | more rows | end → "عرض كل النتائج" marker | no-op |

**Focus & selection**

- Tab order = visual order; breadcrumbs before content; skip link first.
- Custom selects: native `<select>` retained (accessibility-first; per Phase 0 rule we prefer native when acceptable — cascading selects are native lists; no custom listbox needed).
- Selected state: border-accent + background tint + check glyph (for filter chips) — never color-only.

## P. Forms (Proposed)

**Global rules**

- Persistent visible labels above fields, always (no placeholder-as-label; placeholder allowed only as example).
- Required marked with visual * + aria-required; groups use heading/whitespace, not boxes.
- Validation: on blur for fields with known rules (URL, format, min lengths); after first error, live re-validate on input (debounced 300ms). Submit reveals any remaining errors inline.
- Errors: field-level, below the input, danger text + icon, role="alert", specific instruction ("أدخل رابطًا صالحًا يبدأ بـ https").
- Preserve input on server failures — never wipe on failed save.
- Autocomplete attributes on login/email fields.
- Buttons: label = action verb, not "Submit"; loading state disables + spinner + text ("جارٍ الحفظ…"); disable only while pending — not pre-emptively.

**Form templates used by screens**

| Form | Structure |
|---|---|
| Login (admin) | email, password; errors top-of-form banner; submit → MFA step if enrolled |
| MFA verify | 6-digit code, numeric, large display, auto-submit on 6, resend/cancel affordance, wrong-code error |
| Report a resource/forum | reason select (existing enum) + optional details (max 1000); hint "استخدام عادل" |
| New forum topic | category select + title (max 200, visible counter) + content (max 10000) |
| Reply | textarea (max 5000) + counter + submit inline |
| Admin entity forms (university/faculty/year/subject/course) | single-column; cascader for leaf entities; details in `<details>` retained but styled as a proper collapsible section; validation on blur |
| Resource form | cascader (4) + type/language/source/provider selects + url (validated, google-drive parse) + keywords + verified toggle + status |
| Permissions form | permission matrix + faculty cascader for scope |

**Destructive confirmation UX:** Delete: confirm modal with entity type + name, primary action danger, cancel default-safe; message states consequence plainly ("ستُحذف السنة وكل موادها المرتبطة نهائيًا").

## Q. Data-heavy Interfaces (Proposed)

**Representation decision rule** (per Phase 0: match representation to task)

| Task | Representation |
|---|---|
| Compare/sort/scan large sets (admin: entities, reports) | Table (dense, sticky header, truncation, right-aligned Arabic text) |
| Set of rich items with metadata (universities/faculties/courses) | Cards (image/logo + short text) |
| Resource library within a subject (many rows, quick scan: type/title/lang/verified) | Dense rows on desktop, cards on mobile long-press-friendly grid |
| Forum topics | Row list (title + meta + reply count) |
| Lessons within a course | Ordered rows with numbered index + type icon + duration |

**Table design (admin):** Dense rows (44px min for touch, 40px keyboard-only), subtle zebra via --muted-bg, hover highlight, border-bottom --line. Numbers/counts right-aligned with tabular-nums. Mobile (≤640px): current flatten-to-block-card pattern (parent data-label headers) is good — keep, standardize. Sorting: on count columns/admin tables where cheap; aria-sort announced.

**Handling scale:** Pagination via existing load-more (consistent). Virtualize nothing yet (<100 typical) — note future threshold (>200 rows → page + virtualize). Filters (admin list tabs): existing local filter inputs — keep, add debounce + "مسح".

**The subject page — the crucial surface**

```
subject.html (desktop)
┌ breadcrumb ──────────────────────────────────────────────┐
│  [Title (Cairo 800)]   [semester chip] [subject code?]    │
│  ─────────────────────────────────────────────────────    │
│  Type tabs: الكل | محاضرة | سلايدات | كتاب | ملخص | ...   │   ← color-filled active
│  [search] [count] ── dense rows ────────────────────      │
│  each row: [type dot] Title + verified chip  · lang ·    │
│            [source icon] [open ↗] [♥] [report]            │
└───────────────────────────────────────────────────────────┘
```

Dense rows beat cards here (observed: 7 types, up to 20/page, two-line title, actions) — scanning speed matters more than visual richness.

## R. Responsive Design (Proposed)

Content-driven breakpoints (existing set retained — 480/560/640/720/900/960 + min targets 320).

| Breakpoint | Change |
|---|---|
| ≥960 (desktop) | Subject = dense rows; admin tables wide; breadcrumb full chain |
| 720–960 | Grid cards 3–4 cols; subject rows keep; hero compacts |
| 640–720 | Cards 2–3 cols; search form stacks; type-tabs wrap |
| 560–640 | Subject rows → card grid (touch); admin tables flatten; toolbar stacks |
| 480–560 | Header: icons only + labels collapse; breadcrumb midpoint-ellipsis; forms full-bleed buttons |
| 320 | Single column; no horizontal overflow; 44px targets intact; sticky bottom action bar on admin resource form |

**Non-negotiables (per Phase 0 gateway):**

- No horizontal page overflow at any listed size.
- min-width: 0 on flexible grid children (truncation safety).
- Tables flatten instead of scroll (admin pattern kept).
- Fonts: no scaling below 16px on inputs (iOS focus zoom avoid).

## S. Mobile Strategy

Mobile is primary for students. Not a shrunk desktop.

- **Navigation:** header (icons), universal search trigger (primary task), account drawer (right, RTL), breadcrumbs collapsed with midpoint ellipsis "…". All 4 destinations reachable ≤2 taps.
- **Subject page:** tabs horizontally scrollable with visible affordance (fade + active fills); rows → full-width cards with larger tap areas; actions (open ♥ report) on the row bottom, 44px.
- **Search:** sticky hero input on search.html; filters as full-width stacked selects + "مسح" chip; results cards.
- **Forms:** single visible column; sticky primary button bar bottom (safe-area inset respected); numeric MFA keyboard; autofocus first error field.
- **Tables:** block-flat cards (already present) — keep with data-label headers.
- **Dense data:** allow horizontal scroll only when content is inherently table-like (lesson matrix) — prefer recomposition.
- **Dialogs:** full-width bottom-sheet style modals ≤560px (keep accessibility focus trap), overlay covers navigation.
- **Touch targets** 44×44 min; sticky actions keep primary CTA reachable without thumb gymnastics; system back gesture supported via history (suggestions: single-page behaviors use popstate as today).

## T. RTL / Arabic UX

RTL is native here — not a transform.

- dir="rtl" language ar on `<html>`; all spacing/positioning via logical properties (inset-inline, border-inline-start, padding-inline…) — already largely in place; governance: new CSS must use logical props, never left/right.
- Icons: directional arrows point toward the reading direction for "forward" (→ in RTL = to the left for forward nav; breadcrumbs separators "‏/‏"; back arrows flipped). Rule from Phase 0: direction = content reading order, not design tool flip.
- Breadcrumbs/prev-next: logical order; separator small "‹/›" oriented by direction via rotate when needed.
- Text alignment: start everywhere; numbers may use dir="ltr" inside RTL text via `<bdi dir="ltr">` for version strings, codes, URLs (safe display).
- Mixed content: URLs/emails/codes/English identifiers displayed LTR with `<bdi>`/uni-bidi: isolate; times/dates formatted with ar-EG locale (existing behavior), Latin digits retained for numbers per current format.
- Tables: headers/rows follow RTL; sorting arrows reflect direction.
- Forms: labels above (direction-independent); icon+text pairs keep logical ordering.
- Punctuation/ellipsis: Arabic curly quotes "…", proper ellipsis …, non-breaking spaces before punctuation § per microcopy rules.
- Numbers: decide numerals policy and centralize (Latin digits currently; keep) — consistent everywhere.
- Scroll/spinner behavior: physical mirroring irrelevant with logical properties; test scrollbars at start edge.

## U. Accessibility (Proposed — system-level)

- **Semantics first:** native `<button>`, `<a>`, `<label>`, `<table>`, landmarks (`<header>`, `<nav>`, `<main>`, `<footer>`) everywhere. No role=substitutes for native elements.
- **Keyboard:** full tab order, skip-link to main, focus never lost into modals/drawers (focus trap), visible order = DOM order.
- **Focus:** single global :focus-visible ring (accent 3px offset 2px). Never outline:none unless a replacement ring in same rule. Keyboard-only focus (the :focus vs :focus-visible distinction) is respected as it is today.
- **Labels:** all inputs labeled; icon buttons aria-label; aria-state (pressed/current/expanded) on toggles, tabs, breadcrumbs current page (aria-current="page").
- **Live regions:** role="status" for toasts (success), role="alert" for errors/rate-limit; aria-live="polite" on count updates; results container polite region.
- **Contrast:** all text/bg pairs pass (≥4.5 regular / ≥3 large). --ink-faint restricted. Verified/test using tokens (not eyeballing).
- **Reduced motion:** global @media (prefers-reduced-motion: reduce) kills all transitions/animations/scroll-behavior (already implemented — governance keeps it).
- **Touch targets:** 44×44 min (kept). Focus order logical RTL.
- **Errors:** inline + announced; not just color.
- **Tables:** captions/summaries where meaningful; data-label mobile pattern announced by td::before (existing) — good, keep.
- **Dialogs:** role="dialog" + aria-modal, labeled, Escape, restore focus, initial focus, scroll lock.
- **Landmarks unique-labeled:** multiple `<nav>` get distinct aria-labels (header nav vs breadcrumb vs footer).
- **SR testing checklist:** each screen passes quality gate item (screen reader pass for header/search/subject/forum/admin flows).

## V. Motion (Proposed)

Philosophy: motion encodes state, not decoration. Restraint is brand.

| Use | Duration | Easing | Example |
|---|---|---|---|
| Micro (hover/press/focus) | 120–150ms | ease-out | button tint, icon swap, heart fill |
| State transitions | 180–220ms | ease-out | tab switch (content fade+8px), overlay open, drawer slide (240ms) |
| Progress/loading | spinner spin 1s linear | linear | inline spinners; skeleton static no animation |
| Reduced motion | all → 0 | — | global media query |

**Rules:**

- Only transform/opacity animated; never transition: all (explicit per property).
- No spring/bounce anywhere in tools; no parallax/scroll-jacking; no autoplay hero.
- Drawer/modal: translate+opacity only; backdrop opacity.
- Table: no row animation on load (avoid shimmer/entrances) — insert is fine.
- Toast: slide+fade in 180ms; auto-dismiss ≥4s (longer for errors) with manual close.
- Skeleton: static neutral blocks; aria-hidden (content arrives with real text).

## W. Content & Microcopy (Proposed)

Voice: clear, warm, brief, human — academic Arabic with plain language.

| Context | Pattern | Examples (Arabic) |
|---|---|---|
| Buttons | verb + short object | "عرض المورد" / "فتح الرابط" / "تحميل المزيد" / "إضافة مادة" / "حفظ التغييرات" |
| Empty states | what's missing + next action | "لا توجد موارد ضمن «الفصل الثاني» بعد. جرّب قسمًا آخر أو أضف موردًا." |
| Error (field) | what + why + fix | "أدخل رابطًا يبدأ بـ https://" |
| Error (system) | what + action | "تعذّر الاتصال. تأكد من الشبكة ثم أعد المحاولة." |
| Rate-limit | wait + window | "لقد تجاوزت حد الإبلاغ. انتظر 10 دقائق ثم حاول مجددًا." |
| Success | done + optional next | "تم إضافة المورد." / "تم إرسال بلاغك." |
| Destructive confirm | object + consequence | "حذف «السنة الثالثة»؟ ستُحذف كل المواد المرتبطة نهائيًا." |
| Locked forum | state + reason | "هذا الموضوع مغلق ولا يمكن الرد عليه." |
| Auth | clear benefit link | "سجّل الدخول للمشاركة في النقاش." |

**Rules:** active voice, second person, specific not "click here"; error messages never raw DB text (existing friendlyAuthErrorMessage); titles describe content; link text = destination; sizing counters on long content; consistent term glossary (مورد/مادة/فصل…).

## X. States & Feedback (Proposed — unified state system)

One state language across screens:

| State | Pattern | Notes |
|---|---|---|
| Initial/loading | skeleton (static) or spinner+text; role=status | skeleton on lazy grids; text during nav |
| Empty | icon + title + explanation + primary action | no "—" as the only answer |
| No results (search) | "لا توجد نتائج لـ «…»" + clear filters + suggestions | differentiate from "no data" |
| Error (fetch) | retry button + friendly message | never raw error text |
| Partial failure | section-scoped message; others remain | used in admin dashboard counts (already isolated) |
| Permission denied | shield icon + "ليس لديك صلاحية" + contact hint | admin scope awareness |
| Success | toast (role=status) + inline confirmation where form | form success → inline + redirect where sensible |
| Destructive success | toast + updated list | content gone from view |
| Offline/network | banner at top "أنت غير متصل — تظهر بيانات محفوظة قد تكون قديمة" | only if app ever caches; otherwise fetch-error on demand |
| Long-running | inline spinner + cancel where applicable | report/moderate |
| Locked/unavailable | banner + disabled controls with reasons | forum locked; resource hidden |

Feedback channels mapped: field errors → inline; operation confirm → toast; destructive → modal; permission → inline panel; location → breadcrumbs/URL.

## Y. Admin / Management UX (Proposed)

Admin is a professional enterprise product, not a marketing page.

- **Shell:** login → MFA → locked single session (existing) → dashboard. Sticky tab bar (10 tabs) with count badges on reports/forum-reports when pending. Header shows principal + logout + MFA badge.
- **Dashboard:** decision-first, not metric collage — order: my pending reports & moderation queue; content health (published vs hidden per entity); counts (existing stat cards, isolated failure → "—"); no charts that explain nothing.
- **Tables:** dense, sticky header, tr/status/actions standardized; each row's actions are permission-aware (hide on deny).
- **Forms:** collapsible add/edit (details) but toolbar-refined; cascader shared; validation on blur; save→toast→row refresh.
- **Reports queue:** two queues in one screen with filters (resource reports / forum reports), action buttons (hide/restore, mark reviewed), status chips pending/reviewed/dismissed; hide→log resource_hidden (existing behavior preserved).
- **Users & permissions (super):** matrix (user→scope→entity→action) with cascader for faculty; log panel (admin_activity_log) viewable; self-edit refreshes current permissions.
- **Efficiency:** keyboard = Tab order optimized, Enter submits forms, Escape closes collapsible; global live filter per tab; predictable selection order.
- **Safety:** destructive confirmations with consequences; row-level data-label mobile pattern; logout returns lock release (existing).

## Z. Screen-by-Screen Design Proposal

18 screens. Each screen: Purpose / Primary User / Intent / Hierarchy / Layout / Primary & Secondary actions / Components / Density / States / Responsive / A11y / Interaction / Mobile / RTL / Why.

### Z.1 Landing (index.html)

- **Purpose:** brand + about + entry to platform. User: new visitor. **Intent:** understand what AFOQ is → get in.
- **Hierarchy:** brand → what it is → offer → CTA. **Layout:** hero (title+lead+2 CTAs) → about rows (initiative) → "من المعرفة إلى الأثر" → 7 resource types legend → quote → pyramid → CTA band → footer.
- **Actions:** primary "ادخل المنصة" (platform), secondary nav, social links.
- **Components:** landing hero, type legend chips, footer. **Density:** relaxed.
- **States:** static; auth-aware hero triggers. **A11y:** existing landmarks; ensure decorative rings aria-hidden.
- **Responsive:** existing ring collapse ≤560px.
- **Why kept/reformed:** current landing works and matches brand; reduce ring decorative complexity and ensure it cannot look template-y; keep content-led clarity. RTL: logical props as now.

### Z.2 Platform Hub (platform.html)

- **Purpose:** the working home — search first, then browse. User: returning visitor (main).
- **Intent:** start a session quickly.
- **Hierarchy:** hero search → quick links → universities → popular → recently viewed. Order = task velocity.
- **Layout:** search-hero card; quick-link cluster (المفضلة/الدورات/الملتقى); university card grid; two resource sections (popular, recent) as dense rows or cards with verified chips.
- **Primary action:** search. **Secondary:** university card, favorites.
- **States:** per-section skeleton/empty/error. **Mobile:** sections stack; hero compacts. RTL: as existing logical.
- **Why:** this screen is the most-traveled; moving it from "brand wall" to "workbench" is the single biggest UX gain.

### Z.3 University list (university.html)

- **Purpose:** top of hierarchy. User: visitor drilling by university.
- **Hierarchy:** breadcrumb → title+count → card grid. **Layout:** 1-col→2-4 col cards (logo, name, short name). Cards = real links with focus-visible; empty/loading state with retry.
- **Actions:** single (go into university).
- **Why:** simple; keep cards; ensure logo fallback alt.

### Z.4 Faculty list (faculty.html)

- **Purpose:** pick specialization. **Layout:** breadcrumb (Platform → University) + card grid (name + description). Same card rules as universities.
- **Why:** consistent ladder; keep.

### Z.5 Year list (year.html)

- **Purpose:** pick year; today a shim that redirects to semester.html?year=... (a client-side filter view of that year's subjects, not a set of separate "semester" records).
- **Proposal:** replace shim-redirect with a direct combined step: from faculty → page auto-loads the year's subjects pre-filtered/tabbed by the `semester` attribute, or keep year page as a simple numbered card grid with a subject-count indicator per semester value (computed client-side, not a stored count). Decision: keep year page (hierarchy intact), cards show "٢ فصول متاحة" (a computed label, not a count of independent semester entities).
- **States:** loading per current behavior; no blank "جارٍ التوجيه…".

### Z.6 Semester filter view (semester.html)

- **Purpose:** filter one year's subjects by semester (first/second/summer/unspecified) — client-side tabs over Subject data, not a separate entity page.
- **Layout:** breadcrumb (up to year) + filter tabs → subject list.
- **Why:** thin but necessary; keep, ensure semester labels with color chips consistent.

### Z.7 Subject + resources (subject.html) — the decision screen

- **Purpose:** scan & pick resources for a subject. User: student (core).
- **Intent:** find THE resource (lecture/summary/past_exam) in seconds.
- **Hierarchy:** breadcrumb → subject title + meta (semester chip, count) → type tabs → toolbar (internal search + count) → resources.
- **Layout (desktop):** dense rows (Q). Mobile: 1-col cards.
- **Actions:** open resource (primary), favorites, report (secondary); "تحميل المزيد" pagination.
- **States:** loading skeleton; empty per-type; no-results-for-search; load-more done.
- **A11y:** tabs as button group with aria-selected; count polite region; rows as links + icon buttons.
- **Why:** the fastest-to-content screen must be the densest in the public app; rows beat cards here.

### Z.8 Search results (search.html)

- **Purpose:** filtered global discovery. User: visitor w/ query.
- **Layout:** sticky search input + active-filter chips + 5 cascading selects (university→faculty→year, type, language) + "مسح الفلاتر" + results grid (dense rows) + load-more.
- **States:** no-query hint; no-results with clear; results count.
- **A11y:** labeled selects; results list semantic; keyboard flow input→filters→results.
- **Mobile:** filters stacked; sticky search; full-width rows.
- **Why:** improve scannability + filter visibility; logic stays with search_resources.

### Z.9 Favorites (favorites.html)

- **Purpose:** local bookmarks. **Layout:** title + browser-only hint + grid of resource rows + empty-state CTA to search.
- **Why:** trivial-ish; keep localStorage semantics; add clear/remove-all with confirm; empty state strengthened.

### Z.10 Courses list (courses.html) & Z.11 Course detail (course.html)

- **Purpose:** structured independent learning units.
- **Courses list:** breadcrumb + title + card grid (cover, title, chips instructor/language, CTA). **Detail:** cover, title/meta, description, lesson rows (number, type icon, duration, open action), lesson text inline on text-type; locked/published gates respected.
- **A11y:** covers alt; external links rel=noopener; lesson rows semantic list.
- **Why:** current cards solid; add duration visibility + status chips.

### Z.12 Forum home (forum.html)

- **Purpose:** community. **Layout:** header + "+ موضوع جديد" (auth-gated) + category chips grid + "أحدث المواضيع" list + filter state ("عرض كل الأقسام ✕") + load-more.
- **Topic rows:** title, category chip, author, date, reply count. Real-user gate clear.
- **A11y:** new-topic modal (dialog semantics); toolbar icons labeled.
- **Why:** keep structure; tighten visual harmony with global system; keep textContent-safe rendering.

### Z.13 Forum topic (forum-topic.html)

- **Purpose:** conversation. **Layout:** breadcrumb → topic detail (title, chips category/locked, author/date, content) → replies list (author, date, content, report, owner edit inline) → reply form (locked→hidden; guest→auth gate CTA).
- **States:** locked banner; hidden replies never fetched (owner/admin view preserved); empty replies.
- **Why:** current flow sound; formalize edit inline + owner identity chips; pre-wrap preserved.

### Z.14 Admin — login/MFA (admin/index.html)

- **Purpose:** secure gate. **Components:** login card → MFA verify card → dashboard. Session-lock is fully blocking: a failed acquire/restore at login triggers immediate signOut() + return to login with "يوجد مسؤول آخر يستخدم لوحة التحكم حاليًا. حاول لاحقًا."; losing the lock mid-session (25s heartbeat) triggers forceLockLogout() with "تم إنهاء جلستك الحالية (جلسة أدمن أخرى بدأت، أو انتهت صلاحية جلستك). سجّل الدخول مجددًا." Enforcement is server-side exclusively via SECURITY DEFINER RPCs (acquire/refresh/release_admin_session_lock) + deny-all RLS (no policy) + 90s TTL — the client code is a mirror, not the guard.
- **A11y:** labeled inputs; MFA code grouped; errors announce.

### Z.15 Admin — dashboard

- **Purpose:** orient + act. Intent: what needs me now?
- **Layout:** greeting + session info + moderation queue counts (reports pending, forum reports pending, hidden resources) → "إجراء عاجل" panel → entity stats row. Permission-aware visibility. Isolated stat failure → "—".
- **Why:** metric collage anti-pattern avoided; the dashboard answers "what needs my action".

### Z.16 Admin — entity tables (universities/faculties/years/subjects/resources/courses)

- **Purpose:** CRUD ops. **Layout:** tab bar; toolbar (add button, live filter); dense table (name, status, counts, updated, actions); excel-grade readability; add/edit form drawer (slide over, focus-trap, sticky actions) replaces tall `<details>` for long resource forms; simple entities keep collapsible.
- **States:** permission-denied empty (shield); loading; filter empty.
- **Why:** professional density + drawers for long forms (better than expanding inside table).

### Z.17 Admin — reports queue

- **Purpose:** moderate resource + forum reports. Smart filter CSV per status; rows: target (80-char truncate), reason chip, reporter, date, actions (hide/restore, mark reviewed, delete report). Status chips pending/reviewed/dismissed.
- **Why:** combines the two existing queues into a moderation workspace; counts surfaced on tab badge.

### Z.18 Admin — users & permissions (super)

- **Purpose:** govern access. **Layout:** user list; per-user permission matrix + faculty scope cascader; log excerpt of recent admin_activity_log.
- **Why:** the WHO←WHAT←WHERE model is the core; keep the matrix UI and improve with scope cards and clearer visual tiers.

## AA. User Flows (textual — critical journeys)

- **AA.1 Find a resource (fast path):** Home → focus search → 2 chars → suggestion → open new tab
- **AA.2 Browse hierarchy (with merged year/semester decision):** Hub → university card → faculty → year (sees "semesters available") → semester → subject → tabs → open
- **AA.3 Guest → participate in forum:** forum → new topic → auth overlay (guest-upgrade) → sign-in → modal resumes → publish
- **AA.4 Report content:** card → report icon → modal → reason+details → submit → toast; rate-limit → guidance
- **AA.5 Admin add resource:** tab(Resources) → add → drawer form → cascader → validate → save → row+toast → (log)
- **AA.6 Super admin grant permission:** tab(Users) → select user → scope(univ→faculty) → check matrix → save → toast + activity log

## AB. Design Decisions & Trade-offs (evidence-style)

| # | Decision | Context/Problem | Constraints | Options | Decision | Why | Trade-off |
|---|---|---|---|---|---|---|---|
| 1 | Search-first hub rework | Home currently a static marketing page; returning users need a workbench | Cannot remove brand entry | brand-wall vs workbench | Workbench (hub) as default entry with brand one link away | Task velocity; students return frequently | Landing loses prominence → keep index.html for brand, link hub |
| 2 | Dense rows on subject page | 7 types × up to 20 items; cards digest poorly at this density | None blocking | cards vs rows | Rows desktop / cards mobile | Scanning speed; type-dot wayfinding | Visual richness lower on desktop |
| 3 | Replace year.html redirect with semester-aware year page | Redirect shim confuses ("جارٍ التوجيه…") | Hierarchy data fixed | redirect vs real page | Real page + semester microcopy | No surprise UX; keeps hierarchy | One more level kept (vs flattening) |
| 4 | Admin long forms = drawers | Tall `<details>` collapsibles hurt context in tables | Single-file admin SPA; script loading fixed | details vs drawer | Drawer for resource/course forms | Contextual + focus-trapped | More complex container; vertical scroll anyway |
| 5 | Toast + modal split | When to confirm vs notify | Existing toast/modal | unify-as-toast vs split | modal for destructive, toast for success | Consequence visibility | Extra click on destructive only |
| 6 | Keep native `<select>` | Custom listboxes risk a11y/consistency | Current code native | native vs custom | Native | Keyboard/a11y parity; ARIA intact | Less branded look — accepted |
| 7 | MFA + session-lock visuals in header | Safety info should be visible but quiet | Not functional change | hide vs badge | Compact MFA badge + lock microcopy | Operator trusts state | Minor header space |
| 8 | RTL-native icons (logical flips) | Arabic-first must not be flipped English | None | flip vs logical | Logical props + direction-aware arrows | Correctness, taste | Requires discipline per icon |
| 9 | Reduced-motion global kill | Study context; WCAG | Existing CSS rule | keep+govern | Global kill (retained) | A11y + calm | No entrance micro-flair |
| 10 | Keep accent = focus ring + rare CTA | Single-accent discipline | DESIGN_SYSTEM.md | multi-accent | One accent, scarce | Memorable + functional | No colorful many-CTA pages |

Trade-off re-statements (explicit): density vs simplicity (2, admin); navigation depth vs discoverability (3); cards vs tables (2, admin); modal vs page (5: report→modal, edit→drawer); desktop efficiency vs mobile simplicity (2; rows vs cards); customization vs consistency (6, native selects); visual richness vs cognitive load (overall restraint).

## AC. What Must Stay (constraints — do not redesign)

**Business logic / data / security:**

- Academic hierarchy & 6-level tree (University→Faculty→Year→Subject→Resource); entity IDs for the 4 real hierarchy tables + a client-side ?semester= filter key (not an entity id) + ?category= URL keys.
- Resource type enum (7), language ar/en, storage/source enums, statuses published/hidden/reported (+draft for courses).
- visibility rule set (published + is_active year/subject; faculty-is-active explicitly out of search filter).
- Permission model: RBAC+ACL (roles super_admin/admin/staff), scopes global/university/faculty, entities + actions, fn_has_permission semantics; admin MFA AAL2 enforcement; single-admin session lock; rate limits (5 reports/10min; 10-min view cooldown).
- RPCs (search_resources, increment_resource_view, submit_public_report, forum RPCs, session RPCs) — unchanged contracts.
- Anonymous-auth guest upgrade flow (linkIdentity), profile row semantics.
- Forum rules: real-user only, content length checks, category seeds (5), locked/hidden flags, report single-target.
- Courses: global-scope course permissions, 3 lesson types, 3-way statuses.
- Favorites/recently-viewed localStorage keys & behavior.
- robots/noindex decisions (subject/course no sitemap — documented product decisions), SEO meta patterns.
- File-url validation constraints (http/https regex, google-drive parse).
- XSS-safe string rendering convention (textContent everywhere).
- Design tokens already consumed by css/style.css (the true source of truth — see DESIGN_SYSTEM.md §14).

## AD. What Can Change

| Area | Can change | Constraint |
|---|---|---|
| Visual language | colors/type scale/shadows/radii within token governance (approve via DESIGN_SYSTEM.md) | token set must stay source-of-truth; no rainbow; accent scarce |
| Layout | page composition, grid, hero treatment, panel order | logical-property RTL discipline |
| Navigation | global nav destinations/labels, breadcrumb compression, drawer vs dropdown | no desktop hamburger; noun labels; ≤4 global destinations |
| Components | build new primitives/components into the architecture (drawer, dense row, skeleton, stat card) | approval gate; reuse > new |
| Typography | sizes/weights/roles table (5-scale) | keep Cairo/Tajawal pairing |
| Spacing/grid | spaces 4-base scale, density tiers | no arbitrary numbers |
| Interactions | drawers, sticky bars, inline edit, progress states | keyboard parity; reduced-motion parity |
| Responsive | breakpoint semantics + reorganizing at sizes | 320 no-horizontal-overflow; content-driven breakpoints |
| Info presentation | rows-vs-cards choice, tab layouts, filter presentation | matches task, not template |
| Admin UX | dashboard purpose, drawers, moderation workspace, action patterns | no metric collage; permission-aware |
| Motion | what moves & when (restraint) | transform/opacity only; no transition: all |
| Microcopy | full tone set | improve clarity/actionability |

**Explicitly NOT changing:** domain enum names, URL shape, RLS/roles, RPC signatures, localStorage keys, forum rules/permissions model, report rate-limits, admin single-session + MFA, file validation rules.

## AE. Anti-AI-Slop Review

Self-audit against the Phase 0 list — each flagged item gets Context → Reason → Evidence.

| Slop pattern | Used? | Context → Reason → Evidence |
|---|---|---|
| Generic purple gradients | No | Deferred; brand = teal/ink; DESIGN_SYSTEM.md §12 rule 4 forbids gradients |
| Excessive glassmorphism | No | Forbidden by brand rule 6; replaced with paper/surface |
| Giant hero in admin | No | Admin dashboard answers "what needs action" (reports), not a hero |
| Excessive rounded cards | No | radius 8/14 systematic; pill only for controls, not every element |
| Random shadows | No | near-zero shadow tokens; borders do separation |
| Rainbow badges | No | success/warning/danger + 7 type hues all with semantic mapping |
| Decorative illustrations | Rejected | Landing rings kept as sole brand accent, aria-hidden, removed in app surfaces |
| Metric-card collage | No | Dashboard = actions + pending queues + isolated counts |
| Excessive animation | No | micro-motion frames only; reduced-motion kill |
| Desktop hamburger | No | 4 flat destinations visible; no hiding |
| Placeholder-as-label | No | persistent labels (Phase 0 rule) |
| Unclear microcopy | No | voice set (W) with examples |
| Arbitrary spacing/breakpoints | No | 4-base scale / semantic breakpoints |
| Generic SaaS/dashboard clone | No | row-density decision, RTL-native, token governance — product-specific |

**Self-critique answers:** (1) not generic SaaS — domain-derived row-density + teal ink + accent-as-focus; (2) belongs to AFOQ — the 7-type color language and paper warmth are product-borne; (3) decorative — only landing rings, marked aria-hidden; (4) nav not complex — 4 global nodes, flat; (5) core info clear — subject page is decisive; (6) admin efficient — tables+drawers+keyboard; (7) mobile real — recomposition + bottom-sheet dialogs not mini-desktop; (8) RTL real — logical props + LTR isolates; (9) a11y integrated — tokens/gates from token zero; (10) cards not overused — rows chosen for the data screens; (11) colors controlled — semantic+tokens; (12) motion minimal; (13) can cut: yes — landing rings, some shadows already cut; (14) components justified per purpose; (15) the design serves user tasks (search→open, scan→pick, admin→act).

## AF. Design Governance

- **Tokens first:** no raw hex outside :root; new token requires this doc approval; never flavor-of-month values.
- **Reuse over new:** new component proposal = pattern request with substitute-check (what existing covers the need).
- **Naming:** Arabic UI terms + English identifiers in code (existing split) preserved; component classes follow existing namespaces (no cross-page bleed).
- **Variants:** variants allowed only via token/type system; no ad-hoc color overrides per screen.
- **Accessibility:** every new component patches the Quality Gate (U + Z); review gate blocks a11y regressions (outline:none, color-only states, reduced-motion break).
- **Responsive:** new patterns tested at 320/375/768/1024/1440; no horizontal overflow.
- **Review gate:** before any visual change lands: (1) proposal doc, (2) quality-gate pass, (3) anti-slop audit, (4) admin+public split check, (5) RTL review, (6) DESIGN_SYSTEM.md source-of-truth updated only after css/style.css is the change (doc follows code).
- **Anti-pattern watchlist:** the table in AE doubles as a standing review checklist.

## AG. Design Quality Gate (per screen, applied before sign-off)

- **Hierarchy** – one focal region; primary > secondary > tertiary; grayscale-passes; within-group space < between-group.
- **Typography** – scale roles used; no faux styles; long-form max-width; numbers tabular.
- **Color** – token-only; pairs ≥4.5/3; no color-only signals; accent scarce.
- **Spacing** – token scale; symmetrical default; density tier declared.
- **Interaction** – all states (default/hover/focus/active/selected/disabled/loading/empty/error); escape hatches; parity keyboard/mouse.
- **Accessibility** – semantics; labels; :focus-visible; trap-free dialogs; landmarks; SR read-through.
- **Responsive** – 320 no overflow; recomposition (not shrink); tables flatten; 44px taps.
- **Forms** – persistent labels; blur+debounce-live validation; inline errors; input preserved on server fail; destructive confirms.
- **Data Density** – right representation (table/rows/cards); monospace/tabular for data; pagination semantics.
- **Motion** – transform/opacity only; no transition: all; reduced-motion kill.
- **Content** – voice; specific errors; statuses stated in text.
- **States** – empty/loading/error/success/permission/offline defined per screen (see X matrix).
- **RTL** – logical props; icons oriented; numbers/URLs isolated (bdi); no left/right leaks.

Every screen in Z has passed or will pass this gate as a checklist.

## AH. Implementation Roadmap — DESIGN ONLY (no execution)

The order of future design/implementation phases only:

- **Phase 1** — Foundations: token audit (M), base primitives, focus/typography/spacing rules, RTL discipline, motion tokens, quality-gate tooling
- **Phase 2** — Navigation: header restructure, breadcrumbs, global search overlay polish, hub (platform) workbench rework
- **Phase 3** — Core public components: button/input/badge/card/row/skeleton/empty/error/modal/drawer/toast
- **Phase 4** — Core public screens: university→faculty→year→semester→subject (dense rows), search results, favorites, courses, landing/hub polish
- **Phase 5** — Forum: component system + auth-gated flows + inline edit + moderation surfaces
- **Phase 6** — Admin: shell, dashboard purpose-led, tables+density, resource form drawer, reports workspace, permission matrix improvements
- **Phase 7** — Responsive & motion audit: all breakpoints, mobile strategy, reduced-motion parity, RTL native
- **Phase 8** — Accessibility validation: SR pass, keyboard pass, contrast verify, focus audit, quality-gate sign-off per screen, DESIGN_SYSTEM.md update to match implementation

Defined for sequencing only — nothing in any phase is executed now.

## SELF-CRITIQUE (final pass)

- **Generic SaaS?** No — hierarchy-driven screens, rows-not-cards on data surfaces, teal/paper identity, Arabic-native.
- **Does it belong to any other site?** No — the 7-resource-type color language and medical-academic calm are product-specific.
- **Decorative elements with no function?** Landing rings only (brand accent, aria-hidden); all else functional.
- **Navigation complex?** No — 4 global nodes, flat; hierarchy num chains though binary choices.
- **Primary info clear?** Subject page decisive via dense rows.
- **Admin effective?** Tables+drawers+keyboard+permission visibility.
- **Mobile real?** Recomposed, not shrunk; bottom-sheets; sticky actions.
- **RTL real?** Logical-prop native + LTR isolation.
- **Accessibility integral?** Token-zero gates; no retrofits.
- **Too many cards?** Cards restricted to identity-bearing surfaces; rows elsewhere.
- **Too many colors?** Semantic orphan-restricted + 7 functional type hues, token-governed.
- **Motion without reason?** Restrained, state-only, reduced-motion honored.
- **Reduction without loss?** Removed marketing whitespace, some shadows, decorative flourishes.
- **Every component justified?** Yes — mapped to a task/evidence above.
- **Serves tasks vs showing off?** Search→open, scan→pick, admin→act; no design theater.

```
DESIGN PROPOSAL COMPLETE
FULL AFOQ DESIGN SPECIFICATION PRODUCED
NO PROJECT CHANGES
NO IMPLEMENTATION
NO DEPLOYMENT
STOP — WAITING FOR DESIGN REVIEW
```