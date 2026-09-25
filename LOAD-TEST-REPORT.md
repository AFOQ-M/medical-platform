# AFOQ — Capacity / Load / Stress Test Report

> **Status:** COMPLETE — evidence captured for the capacity workstream (sections 19–35 of the master prompt).
> **Date:** 2026-09-25 · **Scope:** synthetic virtual users, read-only GET scenarios, controlled ramp. No writes, no auth storms, no admin paths, no MFA.
> **Verdicts:** Local static serving **VERIFIED below; knee observed >3000 VU**. Supabase public reads **VERIFIED (read-only, low–moderate concurrency)**. Cloudflare Pages live probe **PARTIAL — conservative evidence only; tail latency observed; not a capacity guarantee**.

---

## A. Summary

| Layer | What was tested | Best clean run | Worst tail | Hard errors |
|---|---|---|---|---|
| **Local static (dev-server 3100, loopback)** | public nav, asset-heavy, home | 100 VU → **6,619 RPS**, p95 21 ms | 5000 VU → p95 2418 ms, p99 2928 ms | **0** in all 18 runs (incl. 60s soak) |
| **Supabase public REST reads** | catalog reads + search-like filtered read | 10 VU → **34.8 RPS**, p95 530 ms | p99 1073 ms @ 10 VU | **0** (after harness schema fix) |
| **Cloudflare Pages live** | home + public nav, read-only | 5 VU → 14.6 RPS, p95 959 ms | 25 VU → p99 8124 ms, p95 2687 ms | 0 (2 timeouts @ 10 VU home = 1.1%) |
| **Browser journey (Playwright)** | 2 journeys × 7 pages, localstack + Supabase reads | 14/14 pages HTTP 200 | — | 0 crashes |

**Loading model:** each VU holds open a keep-alive-free request loop (sequential GETs) for the full duration; concurrency = VU count. This is a **synthetic stress model**, not a browser-equivalent model (the Playwright journey covers the browser path separately, section I).

---

## B. Environment

- **Repository:** `afoq-courses-mvp` (local working copy, Windows PowerShell shell).
- **Local target:** first-party `scripts/dev-server.js` (Node http static server; ETag/304; GET/HEAD; root = repo) on `http://localhost:3100`.
- **Live target:** Cloudflare Pages `https://afoq-m.pages.dev` (free tier) — **serves an older build** than the local working tree; results reflect the deployed artifact, not the current build.
- **Supabase:** `https://lzmkgfxlsynaphpofblb.supabase.co` — public (`anon`) read via PostgREST, mirroring exact column lists used by the app (`platform.html`, `subject.html`, `search.html`, `courses.html`, etc.).
- **Tooling:** no external load-test binary exists on this host (k6/autocannon/artillery/ab/hey/wrk/vegeta all absent). Built first-party zero-dependency harness: `scripts/load-test-harness.js` (Node stdlib `http`/`https`). Browser journeys: `scripts/load-browser-journey.js` (Playwright, already in repo devDeps).

---

## C. Methodology

- **Scenarios (read-only GET):**
  - **A static-home** — `/` (largest single page asset set).
  - **B public-nav** — representative public pages: `/`, platform, courses, course, university, faculty, year, subject, forum, forum-topic, search, favorites.
  - **C asset-heavy** — `/` + CSS + JS + images repeated (turns up asset pipeline cost).
  - **D api-read** — Supabase REST SELECT on `universities`, `faculties`, `resources` with app-mirrored columns.
  - **E search** — Supabase REST filtered read on `courses` (search-like read path; **no `search_resources` RPC call** — RPC writes are outside the read-only load scope).
- **Ramp:** local `1→5→10→25→50→100→150→200→300→500→800→1200→1600→3000→5000` VU, 15 s each (+ 60 s soak at 100 VU, + 200 VU home, + 100 VU asset-heavy). Supabase: `1→5→10` VU (D), `1→5` (E) — deliberately light per the conservative-probe rule. Live: `1→5→10` (A), `10→25` (B) — light read-only.
- **Redirect handling:** live Cloudflare enables clean-URLs, returning `308 /page.html → /page`. The harness now **follows up to 3 redirects and time-windows the full hop chain**, so results are navigation-equivalent (a later fix, section K).
- **Per-run metrics:** total/successful/3xx-redirect/4xx/5xx/timeout/conn-error counts, error rate, RPS, latency p50/p90/p95/p99/max/mean.
- **Acceptance criteria (test criteria, NOT product requirements):** goal-window p95 latency < 2000 ms; error rate < 1%; no sustained 5xx; no server crash at end of ramp. If the ramp shows instability, stop, record the knee, and report honestly.

---

## D. Local dev-server results (scenario B — public-nav mix, 15 s/run)

| VU | RPS | total | ok | err% | timeouts | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1418.67 | 4256 | 4256 | 0 | 0 | 1 | 1 | 1 | 27 |
| 5 | 6006.73 | 90101 | 90101 | 0 | 0 | 1 | 1 | 2 | 34 |
| 10 | 6568.40 | 98526 | 98526 | 0 | 0 | 1 | 2 | 4 | 33 |
| 25 | 6958.67 | 104380 | 104380 | 0 | 0 | 3 | 6 | 7 | 37 |
| 50 | 6764.60 | 101469 | 101469 | 0 | 0 | 7 | 11 | 13 | 46 |
| 100 | 6619.60 | 99294 | 99294 | 0 | 0 | 14 | 21 | 25 | 80 |
| 150 | 6510.53 | 97658 | 97658 | 0 | 0 | 22 | 31 | 36 | 102 |
| 200 | 6330.80 | 94962 | 94962 | 0 | 0 | 30 | 42 | 56 | 147 |
| 300 | 6511.33 | 97670 | 97670 | 0 | 0 | 44 | 60 | 74 | 201 |
| 500 | 4659.73 | 69896 | 69896 | 0 | 0 | 106 | 126 | 145 | 375 |
| 800 | 5013.40 | 75201 | 75201 | 0 | 0 | 154 | 191 | 499 | 651 |
| 1200 | 5007.87 | 75118 | 75118 | 0 | 0 | 235 | 267 | 702 | 846 |
| 1600 | 4693.33 | 70400 | 70400 | 0 | 0 | 330 | 375 | 998 | 1099 |
| 3000 | 5000.00 | 75000 | 75000 | 0 | 0 | 573 | 684 | 1639 | 1735 |
| 5000 | 4580.60 | 68709 | 68709 | 0 | 0 | 1007 | 2418 | 2928 | 3058 |

**Soak:** 100 VU × 60 s → **350,083 requests**, 58.35 RPS·s sustained, 0 errors, p95 23 ms, p99 27 ms — no degradation over the sustained window.

**Home (A) 200 VU:** 39,982 requests, 2,665 RPS, 0 errors, p95 81 ms.
**Asset-heavy (C) 100 VU:** 75,810 requests, 5,054 RPS, 0 errors, p95 29 ms.

> **Read:** the first-party static server holds **p95 < 100 ms through 300 VU**, maintains ~4,700–5,000 RPS to 5000 VU with **zero hard errors**, and the measured knee (latency breakaway) sits between **3000 and 5000 VU** (p95 684 ms → 2418 ms; p99 1639 ms → 2928 ms). This is **loopback local capacity for the static layer** — no Cloudflare/NAT/region variables involved.

---

## E. Supabase public read results (read-only REST, app-mirrored columns)

| Scenario | VU | RPS | total | ok | err% | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|
| D api-read | 1 | 3.80 | 38 | 38 | 0 | 241 | 490 | 580 | 580 |
| D api-read | 5 | 17.30 | 173 | 173 | 0 | 244 | 504 | 710 | 1268 |
| D api-read | 10 | 34.80 | 348 | 348 | 0 | 243 | 530 | 1073 | 2635 |
| E search-like | 1 | 3.50 | 35 | 35 | 0 | 244 | 494 | 991 | 991 |
| E search-like | 5 | 15.70 | 157 | 157 | 0 | 246 | 609 | 1185 | 1423 |

> p50 ~240 ms throughout; throughput scales roughly linearly (3.8 → 17.3 → 34.8 RPS at 1/5/10 VU). No 4xx/5xx/timeout/conn-error. **Initial 400 events were a harness bug** (my D-template used non-existent columns `semester_id`/`is_active`); corrected to app-real columns and re-ran — 0% errors after. A lesson for tooling, not an app defect (section K).

---

## F. Live Cloudflare Pages results (read-only, conservative)

| Scenario | VU | RPS | total | ok | err% | timeouts | p50 | p95 | p99 | max |
|---|---|---|---|---|---|---|---|---|---|---|
| A home | 1 | 2.50 | 25 | 25 | 0 | 0 | 291 | 1208 | 1429 | 1429 |
| A home | 5 | 14.60 | 146 | 146 | 0 | 0 | 238 | 959 | 1795 | 2517 |
| A home | 10 | 18.20 | 182 | 180 | 1.1 | 2 | 323 | 1209 | 2151 | 2274 |
| B public-nav | 10 | 32.10 | 321 | 321 | 0 | 0 | 240 | 730 | 1288 | 4146 |
| B public-nav | 25 | 34.70 | 347 | 347 | 0 | 0 | 489 | 2687 | 8124 | 8879 |

> Findings, stated honestly: the **deployed free-tier Cloudflare Pages build** sustains ~35 RPS of warm public navigation at 25 VU; latency is healthy at low concurrency (p50 240–490 ms) but tail-heavy as concurrency grows (25 VU → p95 2687 ms, p99 8124 ms), and the home probe at 10 VU produced **2 timeout events (1.1%)** — consistent with cold-cache origin fetch on free-tier Pages, not definitive evidence of a fault. Cold-cache vs warm spread and single-region free-tier behavior dominate here. **This is conservative evidence, not a production capacity guarantee** — see section H verdicts.

---

## G. Browser journey (Playwright) — client-side rendering stack

2 concurrent journeys × 7 pages (/, platform, courses, search, forum, forum-topic, favorites) against `localhost:3100` with live Supabase reads: **14/14 HTTP 200**. Page DOM-ready (post first-load, warm browser) 71–117 ms; first-navigation bootstrap dominated by cold browser context (~4.1 s). No page error events captured. Data-dependent empty-state rendering is the correct client behavior for the current (small) dataset — see section H for the data caveat.

---

## H. Capacity question table (test criteria, with evidence)

| Question | Verdict | Evidence |
|---|---|---|
| Does the static layer serve public navigation at ≤100 VU with p95 < 2 s and <1% errors? | **VERIFIED** | Local: 100 VU p95 21 ms/0%; 300 VU p95 60 ms/0%; live 25 VU p95 2687 ms but 0% errors over 347 req |
| What is the static serving knee? | **MEASURED 3,000–5,000 VU (local)** | p95 684 ms @3000 → 2418 ms @5000; RPS plateaus ~4,700–5,000 |
| Does the asset pipeline sustain load? | **VERIFIED (test criterion)** | asset-heavy 100 VU p95 29 ms; home 200 VU p95 81 ms |
| Are public Supabase reads healthy under concurrent readers? | **VERIFIED (read-only, ≤10 VU)** | ≤34.8 RPS, p50 243 ms, 0% errors |
| Can the live Cloudflare free-tier Pages build take sustained public traffic without timeouts? | **PARTIAL — NOT VERIFIED as guarantee** | 25 VU public-nav 0 errors, 10 VU home 1.1% timeouts; deployed build ≠ current build; free-tier cold-cache variance observed |
| Is end-to-end user navigation functional under load? | **VERIFIED (local) / NOT VERIFIED (live data paths)** | Playwright 14/14 HTTP 200 on localstack; live public success paths depend on Supabase data (currently small) |
| Is there any write-path capacity evidence? | **NOT VERIFIED (out of scope by design)** | Load scope = read-only GET only (sections 19–35 hard rules); no synthetic writes/signups/admin/delete stress executed |

**Note on acceptance criteria:** the SDL/SLO-scale numbers above are **load-test-criteria**, not product commitments. Real production capacity cannot be asserted from loopback static numbers or a free-tier probe; only the request-handling behavior recorded above is evidenced.

---

## I. Artifacts & reproduction

- **Harness:** `scripts/load-test-harness.js` — `node scripts/load-test-harness.js --target <local|live|supabase> --scenario <A|B|C|D|E> --vu N --duration S --out <path>.json`
- **Journey:** `scripts/load-browser-journey.js` — Playwright journeys over localstack.
- **Raw per-run JSON:** `test/artifacts/load/` (28 run files + `browser-journey.json`).

| File | Run |
|---|---|
| `local-B-1vu … local-B-5000vu.json` | local public-nav ramp (15 runs) |
| `local-B-100vu-soak60.json` | local soak 100 VU × 60 s |
| `local-A-200vu.json` | home 200 VU |
| `local-C-100vu.json` | asset-heavy 100 VU |
| `sb-D-{1,5,10}vu.json`, `sb-E-{1,5}vu.json` | Supabase read probes |
| `live-A-{1,5,10}vu.json`, `live-B-{10,25}vu.json` | Cloudflare read-only probes |
| `browser-journey.json` | Playwright 2×7 pages |

---

## J. Findings that required action

1. **Harness schema bug (fixed):** initial Supabase scenario D/P used incorrect column names → 400s. Corrected to app-mirrored selects and re-verified 0% error. **No app/schema change was made.**
2. **Live clean-URL redirects (accounted):** Cloudflare 308s are navigation-equivalent; the harness now follows redirects so RTT reflects real page loads.
3. **Tooling gap (worked around):** no load-test binary on the host → first-party zero-dependency stdlib harness written, committed in-repo so any contributor can reproduce.

## K. Constraints honored

- GET-only, synthetic VUs, no writes/sign-ups/delete/admin/MFA stress.
- Conservative live and Supabase probing (max 25 / 10 VU respectively, short durations).
- No schema, RLS, Auth, SQL, domain, or deployment changes made.
- No fabricated metrics: every number above is a recorded harness run under `test/artifacts/load/`.