const { chromium } = require("playwright");

(async () => {
  const base = process.env.BASE_URL || "http://localhost:3100";
  const outFile = require("path").join(__dirname, "..", "test", "artifacts", "load", "browser-journey.json");
  const browsers = await Promise.all([chromium.launch(), chromium.launch()]);
  const results = [];

  const pages = [
    "/",
    "/platform.html",
    "/courses.html",
    "/search.html",
    "/forum.html",
    "/forum-topic.html",
    "/favorites.html",
  ];

  const journeys = browsers.map((b, bi) => (async () => {
    const context = await b.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));
    for (const p of pages) {
      const t0 = Date.now();
      try {
        await page.goto(base + p, { waitUntil: "domcontentloaded", timeout: 15000 });
        const title = (await page.title()).slice(0, 60);
        const resp = await page.goto(base + p);
        const r = resp.status();
        results.push({ journey: bi, path: p, status: r, domMs: Date.now() - t0, title, pageErrors: pageErrors.length });
      } catch (e) {
        results.push({ journey: bi, path: p, status: "ERROR", domMs: Date.now() - t0, err: String(e).slice(0, 120), pageErrors: pageErrors.length });
      }
    }
    await context.close();
  })());

  await Promise.all(journeys);

  const fs = require("fs");
  fs.mkdirSync(require("path").dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
  console.log(JSON.stringify({ journeys: 2, pages: pages.length, checks: results.length }, null, 2));
  for (const r of results) console.log(`J${r.journey} ${r.status} ${r.domMs}ms ${r.title}`);
  await Promise.all(browsers.map((b) => b.close()));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });