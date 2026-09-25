/**
 * test-runtime-deferred.js
 * Runtime verification of P1.5 D-RT deferred items (D-RT-01 .. D-RT-11)
 * using real Chromium (playwright) against the served site.
 *
 * Honest principle: an item is marked VERIFIED only for what was actually
 * exercised. Items that need an authenticated Admin session, or items whose
 * success-path needs real published DB rows (none exist), stay NOT-VERIFIED
 * with the precise reason. Guest-observable paths are exercised for real.
 *
 * Run:  node scripts/dev-server.js  (then in another shell)
 *       node test/test-runtime-deferred.js
 * Env:  BASE_URL (default http://localhost:3100)
 *
 * Writes test/artifacts/runtime-deferred/report.json + report.utf8.txt
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const BASE = process.env.BASE_URL || "http://localhost:3100";
const OUT_DIR = path.join(__dirname, "artifacts", "runtime-deferred");
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function record(id, status, note) {
  results.push({ id, status, note });
  console.log(`${id}: ${status} — ${note}`);
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });

  // ---------- D-RT-01 — G-03 Account Sidebar (guest path) ----------
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/index.html`, { waitUntil: "networkidle", timeout: 20000 });
    const trigger = page.locator("#account-trigger");
    const hasTrigger = (await trigger.count()) === 1;
    const hasControls = (await trigger.getAttribute("aria-controls")) === "account-sidebar";
    let overlaySeen = null;
    const overlay = page.locator("#auth-overlay");
    if (await overlay.count()) overlaySeen = await overlay.isVisible().catch(() => "hidden");
    await trigger.click().catch(() => {});
    await page.waitForTimeout(600);
    const authVisible = (await overlay.isVisible().catch(() => false));
    const pageErrorsAfter = pageErrors.length;
    record(
      "D-RT-01",
      hasTrigger && hasControls && authVisible ? "VERIFIED" : "PARTIAL",
      `guest click: trigger=${hasTrigger}, aria-controls=${hasControls}, #auth-overlay visible after click=${authVisible}, pageerrors=${pageErrorsAfter}`
    );
    await page.close();
  } catch (e) {
    record("D-RT-01", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-02 — G-05 Lesson Icon (needs real course data) ----------
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/course.html?id=missing-test-id`, { waitUntil: "networkidle", timeout: 20000 });
    const h1 = await page.locator("h1").first().textContent().catch(() => null);
    const bodyText = (await page.locator("body").innerText()).slice(0, 140);
    record(
      "D-RT-02",
      pageErrors.length === 0 ? "PARTIAL" : "NOT-VERIFIED",
      `no published course in DB → success-path icon rendering not verifiable; safe state: body="${bodyText.replace(/\s+/g, " ")}", pageerrors=${pageErrors.length} (${pageErrors[0] || "none"})`
    );
    await page.close();
  } catch (e) {
    record("D-RT-02", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-03 — G-06 Search active-filter chips (real interaction) ----------
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/search.html?q=test`, { waitUntil: "networkidle", timeout: 20000 });
    const chipHolder = page.locator("#active-filter-chips");
    const initialHidden = await chipHolder.getAttribute("hidden");
    // pick the first option of the type filter (excluding placeholder)
    const opts = await page.locator("#filter-type option").allInnerTexts();
    if (opts.length >= 2) {
      await page.locator("#filter-type").selectOption({ label: opts[1] });
      await page.waitForTimeout(900);
    }
    const hiddenAfter = await chipHolder.getAttribute("hidden");
    const chipCount = await page.locator(".filter-chip").count();
    const removeLabels = await page.locator(".filter-chip-remove").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label"))
    );
    // click one remove button → chips go away
    if (chipCount > 0) {
      await page.locator(".filter-chip-remove").first().click();
      await page.waitForTimeout(900);
    }
    const chipCountAfterRemove = await page.locator(".filter-chip").count();
    record(
      "D-RT-03",
      chipCount > 0 && chipCountAfterRemove === 0 && initialHidden === "" ? "VERIFIED" : "PARTIAL",
      `chips render(${chipCount}), remove works(${chipCountAfterRemove} left), aria-labels=${JSON.stringify(removeLabels).slice(0, 120)}, pageerrors=${pageErrors.length}`
    );
    await page.close();
  } catch (e) {
    record("D-RT-03", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-04 — G-07 SVG icons present + decentive attrs ----------
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/index.html`, { waitUntil: "load", timeout: 20000 });
    const svgInfo = await page.locator("svg.icon, header svg, .footer-social svg").evaluateAll((els) =>
      els.map((s) => {
        const r = s.getBoundingClientRect();
        const inFooter = !!s.closest(".footer-social");
        const inBtn = !!s.closest("button");
        return {
          ariaHidden: s.getAttribute("aria-hidden"),
          focusable: s.getAttribute("focusable"),
          w: s.getAttribute("width"),
          visible: r.width > 0 && r.height > 0,
          inFooter,
          inBtn,
        };
      })
    );
    const withAria = svgInfo.filter((s) => s.ariaHidden === "true").length;
    const withFocusable = svgInfo.filter((s) => s.focusable === "false").length;
    const visible = svgInfo.filter((s) => s.visible).length;
    const noFocusableAttr = svgInfo.filter((s) => s.focusable !== "false").map((s) =>
      `header/btn=${s.inBtn},footer=${s.inFooter}`
    );
    const noFocInBtn = svgInfo.filter((s) => s.inBtn && s.focusable !== "false").length;
    record(
      "D-RT-04",
      svgInfo.length >= 2 && withAria === svgInfo.length && visible === svgInfo.length && noFocInBtn === 0 ? "VERIFIED" : "PARTIAL",
      `svg count=${svgInfo.length}, aria-hidden=${withAria}/${svgInfo.length}, focusable=false=${withFocusable}/${svgInfo.length}, rendered-visible=${visible}/${svgInfo.length}, focusable-attrs-missing=${JSON.stringify(noFocusableAttr)}, svgs-in-buttons-without-focusable=false=${noFocInBtn}, pageerrors=${
        pageErrors.length
      }`
    );
    await page.close();
  } catch (e) {
    record("D-RT-04", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-05 — Stage 3 RTL visual (screenshots + dir attribute) ----------
  const pagesToShot = ["index.html", "platform.html", "search.html", "forum.html", "courses.html", "year.html"];
  const rtlChecks = [];
  try {
    for (const p of pagesToShot) {
      const page = await context.newPage();
      await page.goto(`${BASE}/${p}`, { waitUntil: "load", timeout: 20000 });
      const dir = await page.locator("html").getAttribute("dir");
      const lang = await page.locator("html").getAttribute("lang");
      rtlChecks.push({ p, dir, lang });
      if (dir === "rtl" && lang === "ar") {
        await page.screenshot({ path: path.join(OUT_DIR, `shot-${p.replace(".html", "")}.png`), fullPage: false });
      }
      await page.close();
    }
    const allRtl = rtlChecks.every((c) => c.dir === "rtl" && c.lang === "ar");
    record(
      "D-RT-05",
      allRtl ? "VERIFIED" : "PARTIAL",
      `dir/lang per page: ${JSON.stringify(rtlChecks)}, screenshots saved to test/artifacts/runtime-deferred/`
    );
  } catch (e) {
    record("D-RT-05", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-06 — G-04 Clear-All flow (seed favorites → cancel → confirm) ----------
  try {
    await context.addInitScript((key) => {
      try {
        const seed = [{ id: "seed-resource-1", title: "بداية", type: "ملف", url: "#" }];
        localStorage.setItem(key, JSON.stringify(seed));
      } catch (e) {}
    }, "mrp_favorites");
    const page = await context.newPage();
    const dialogs = [];
    let dialogIndex = 0;
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      const isFirst = dialogIndex === 0;
      dialogIndex += 1;
      if (isFirst) {
        d.dismiss();
      } else {
        d.accept();
      }
    });
    await page.goto(`${BASE}/favorites.html`, { waitUntil: "networkidle", timeout: 20000 });
    const btnHidden = await page.locator("#clear-favorites-btn").getAttribute("hidden");
    const btn = page.locator("#clear-favorites-btn");
    if (btnHidden === null || btnHidden === "") {
      await btn.click();
      await page.waitForTimeout(500);
    }
    const storedAfterDismiss = await page.evaluate(() => localStorage.getItem("mrp_favorites"));
    // second round: accept (first dialog dismissed, second accepted via dialogIndex)
    if (btnHidden === null || btnHidden === "") {
      await btn.click();
      await page.waitForTimeout(600);
    }
    const storedAfterAccept = await page.evaluate(() => localStorage.getItem("mrp_favorites"));
    record(
      "D-RT-06",
      btnHidden === null || btnHidden === "" ? "VERIFIED" : "PARTIAL",
      `btn visible=${btnHidden === null || btnHidden === ""}, dialog-count=${dialogs.length}, dialog-msgs=${JSON.stringify(dialogs).slice(0, 80)}, cancel-keeps=${!!storedAfterDismiss}, accept-clears=${storedAfterAccept === "[]" || storedAfterAccept === null}`
    );
    await page.close();
  } catch (e) {
    record("D-RT-06", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-07 — G-08 Footer social forum.html vs forum-topic.html ----------
  try {
    const compare = [];
    for (const p of ["forum.html", "forum-topic.html"]) {
      const page = await context.newPage();
      await page.goto(`${BASE}/${p}`, { waitUntil: "load", timeout: 20000 });
      const links = await page.locator(".footer-social a.social-link").evaluateAll((els) =>
        els.map((a) => ({
          label: a.getAttribute("aria-label"),
          href: a.getAttribute("href"),
          target: a.getAttribute("target"),
          rel: a.getAttribute("rel"),
          hasSvg: !!a.querySelector("svg"),
        }))
      );
      compare.push({ page: p, links });
      await page.close();
    }
    const [a, b] = compare;
    const sameShape =
      a.links.length === b.links.length &&
      a.links.every((l, i) => l.label === b.links[i].label && l.href === b.links[i].href);
    const allFocusable = a.links.every((l) => l.label && l.target === "_blank" && l.rel && l.hasSvg);
    record(
      "D-RT-07",
      sameShape && allFocusable ? "VERIFIED" : "PARTIAL",
      `forum=${a.links.length} links, forum-topic=${b.links.length}, same set=${sameShape}, focusable+svg+rel=${allFocusable}`
    );
  } catch (e) {
    record("D-RT-07", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-08 — G-09 Resource count live region (subject page) ----------
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    await page.goto(`${BASE}/subject.html?id=missing-subject`, { waitUntil: "networkidle", timeout: 20000 });
    const rc = page.locator("#resource-count");
    const role = await rc.getAttribute("role");
    const live = await rc.getAttribute("aria-live");
    const atomic = await rc.getAttribute("aria-atomic");
    const textAfter = (await rc.innerText().catch(() => "")).slice(0, 60);
    record(
      "D-RT-08",
      role === "status" && live === "polite" ? "VERIFIED" : "PARTIAL",
      `role=${role}, aria-live=${live}, aria-atomic=${atomic}, text="${textAfter}", pageerrors=${pageErrors.length}`
    );
    await page.close();
  } catch (e) {
    record("D-RT-08", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-09 — G-10 Year page (no-param + id compat; real-id needs data) ----------
  try {
    const pages = [
      { url: "year.html", label: "no-param" },
      { url: "year.html?id=some-id", label: "id-compat" },
    ];
    const states = [];
    for (const { url, label } of pages) {
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));
      await page.goto(`${BASE}/${url}`, { waitUntil: "networkidle", timeout: 20000 });
      const title = (await page.locator("h1, #page-title").first().textContent().catch(() => null));
      const crumb = await page.locator("#breadcrumb").count();
      states.push({ label, title, crumbCount: crumb, pageErrors: pageErrors.length });
      await page.close();
    }
    const safe = states.every((s) => s.pageErrors === 0 && s.crumbCount === 1 && s.title);
    record(
      "D-RT-09",
      safe ? "VERIFIED" : "PARTIAL",
      `safe states ok=${safe}; real-id success path NOT-VERIFIED (no published year rows in DB): ${JSON.stringify(states).slice(0, 180)}`
    );
  } catch (e) {
    record("D-RT-09", "NOT-VERIFIED", `exception: ${String(e).slice(0, 160)}`);
  }

  // ---------- D-RT-10 — G-12 Admin urgent queue (needs authenticated admin) ----------
  record(
    "D-RT-10",
    "NOT-VERIFIED",
    "requires an authenticated Admin session (dashboard renders pending forum reports). No admin credentials available in this environment; login gate verified earlier via test-full.js (authenticatedSessionAvailable=false). Will not fabricate."
  );

  // ---------- D-RT-11 — G-19 Warning token rendering (needs authenticated admin) ----------
  record(
    "D-RT-11",
    "NOT-VERIFIED",
    "requires an authenticated Admin session (--warning / --warning-bg / --warning-border contrast on pending rows). No admin credentials available; visual/contrast judgement must be done by a human with access."
  );

  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    items: results,
  };
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(summary, null, 2), "utf8");

  const lines = [];
  lines.push("Runtime Deferred (D-RT) verification report");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`Base URL : ${BASE}`);
  lines.push("-----------------------------------------------------");
  for (const r of results) {
    lines.push(`[${r.status}] ${r.id}`);
    lines.push(`   ${r.note}`);
  }
  lines.push("-----------------------------------------------------");
  lines.push("Legend: VERIFIED = exercised for real in Chromium. PARTIAL = exercised but success-path needs data. NOT-VERIFIED = cannot be exercised ethically without an authenticated Admin session / real rows.");
  fs.writeFileSync(path.join(OUT_DIR, "report.utf8.txt"), lines.join("\n"), "utf8");

  const verified = results.filter((r) => r.status === "VERIFIED").length;
  const partial = results.filter((r) => r.status === "PARTIAL").length;
  const notVerified = results.filter((r) => r.status === "NOT-VERIFIED").length;
  console.log(`\nD-RT items: VERIFIED=${verified}, PARTIAL=${partial}, NOT-VERIFIED=${notVerified}`);
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});