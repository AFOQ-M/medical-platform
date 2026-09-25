/**
 * run-tests.js — المركّب الرسمي لمجموعة اختبارات أفق المعرفة.
 * ------------------------------------------------------------------
 * السبب (CI hygiene):
 *   - لم يكن هناك أمر `npm test` موحّد؛ كل ملف يُشغَّل يدويًا.
 *   - test-full.js / test-runtime-deferred.js هما تدقيقا Playwright
 *     ضد هدف حي (non-deterministic، exit 0 دائمًا) — لا يدخلان هنا.
 *
 * هذا السكربت:
 *   - يكتشف تلقائيًا كل ملفات test/test-*.js الوحدوية (بلا Playwright،
 *     بلا شبكة، بلا خادم) ويشغّلها عبر child_process على نحو متسلسل.
 *   - يمرّر أي فشل على كود الخروج: exit 1 إن فشل أي ملف.
 *   - يطبع خلاصة (passed/failed/exit) ولا يخفي الفقدان.
 *   - يمكن استثناء/إضافة ملفات عبر المَتغيّرات أدناه.
 *
 * التشغيل: npm test        (أو: node scripts/run-tests.js)
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TEST_DIR = path.join(ROOT, "test");

// تدقيقا Playwright اللذان يتطلبان خادمًا/هدفًا حيًّا ويخرجان 0 دائمًا
// (تصميم متعمّد: يكتبان حالتيهما VERIFIED/NOT-VERIFIED في تقارير خاصة)
const EXCLUDED = new Set(["test-full.js", "test-runtime-deferred.js"]);

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.startsWith("test-") && f.endsWith(".js") && !EXCLUDED.has(f))
  .sort();

const results = [];
let totalPassed = 0;
let totalFailed = 0;

console.log("AFOQ — canonical test runner (run-tests.js)");
console.log(`sharding: ${files.length} unit test files selected`);

for (const file of files) {
  const filePath = path.join(TEST_DIR, file);
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [filePath], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
  const ms = Date.now() - t0;
  const exitOk = res.status === 0;
  const summarize = String(res.stdout || "").split("\n").filter((l) => /^\s*\d+ passed, \d+ failed/.test(l)).join(" | ");
  const failLine = String(res.stdout || "").split("\n").filter((l) => /FAIL/.test(l)).slice(0, 3).join(" ; ");
  results.push({ file, exitOk, ms, summarize, failLine });
  totalPassed += exitOk ? 1 : 0;
  totalFailed += exitOk ? 0 : 1;
  console.log((exitOk ? "PASS" : "FAIL").padEnd(5) + " " + file.padEnd(36) + (summarize ? " — " + summarize : "") + ` (${ms}ms)`);
  if (!exitOk) {
    if (res.stderr) console.log("        stderr: " + String(res.stderr).split("\n").slice(0, 4).join(" ; "));
    if (failLine) console.log("        first FAILs: " + failLine.slice(0, 200));
  }
  // 300s المهلة = إخفاق قسري؛ نُنهي الطباعة كفشل صريح بدل أمل غير متحقق
  if (res.error) {
    console.log("        spawn error: " + res.error.message);
  }
}

console.log("\n" + "=".repeat(70));
console.log(`TOTAL: ${files.length} files — PASS ${totalPassed} / FAIL ${totalFailed}`);
for (const r of results) {
  if (!r.exitOk) console.log(`  FAILED: ${r.file} (exit=${r.exitOk ? 0 : "nonzero"})`);
}
console.log("=".repeat(70));
process.exitCode = totalFailed > 0 ? 1 : 0;