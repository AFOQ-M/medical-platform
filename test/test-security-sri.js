/**
 * test-security-sri.js
 * ------------------------------------------------------------------
 * SRI (Subresource Integrity) regression for the pinned supabase-js
 * CDN script across all HTML pages.
 *
 * 1) كل صفحة تحمّل script واحد بالضبط من jsdelivr لـ supabase-js.
 * 2) المسار is the pinned UMD file (لا convenience URL — لا يتغير
 *    بحسب resolution ديناميكي).
 * 3) integrity مطابق للأشعة sha384 المحسوبة من الملف الفعلي المقدَّم
 *    (نفس البايتات المُخدَّمة للمتصفح — تحققنا حيًا بالـ Chromium).
 * 4) crossorigin="anonymous" إلزامي مع SRI.
 * 5) لا صفحات بصياغة قديمة (بدون integrity) والعدد 14 صفحة كامل.
 * ------------------------------------------------------------------
 * ملاحظة إصلاح (TST-005): SCRIPT_RE يحمل علم /g؛ استخدامه المباشر مع
 * exec/test يترك lastIndex مشتركًا فيفشل الفحص بالتناوب. لذلك كل
 * exec/test تستخدم SCRIPT_SINGLE_RE (بلا /g)، والعدّ يتم عبر match
 * (بلا حالة lastIndex).
 * ------------------------------------------------------------------
 * التشغيل: node test/test-security-sri.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const EXPECTED_HASH = "sha384-yiVMs0R/Jyz7OhoXa/DsEMUSBLjEhr/QJta2ONO+zB6I8/GmNg/7AUFrZmAJV7KV";
const EXPECTED_SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.112.4/dist/umd/supabase.min.js";

const pages = [
  "course.html", "courses.html", "faculty.html", "favorites.html",
  "forum.html", "forum-topic.html", "index.html", "platform.html",
  "search.html", "semester.html", "subject.html", "university.html",
  "year.html", "admin/index.html",
];

let failures = 0;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures++;
  }
}

// /g فقط للعدّ عبر match (بلا lastIndex). كل exec/test تستخدم النسخة بلا /g.
const SCRIPT_RE = /<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^>]*><\/script>/g;
const SCRIPT_SINGLE_RE = /<script[^>]*src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^>]*><\/script>/;

function countScripts(html) {
  const m = html.match(SCRIPT_RE);
  return m ? m.length : 0;
}

console.log("AFOQ Security — SRI (Subresource Integrity) Tests\n");

test(`عدد الصفحات = ${pages.length} (كل صفحة HTML فيها سكربت supabase-js)`, () => {
  for (const p of pages) {
    const html = fs.readFileSync(path.join(ROOT, p), "utf-8");
    assert.ok(html, p + " readable");
  }
  const also = fs.readdirSync(ROOT).filter((f) => f.endsWith(".html"));
  for (const f of also) {
    const html = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const m = SCRIPT_SINGLE_RE.exec(html);
    if (m) {
      assert.ok(pages.includes(f), f + " موجود في قائمة الفحص (2)");
    }
  }
});

for (const p of pages) {
  const moduleName = "SRI — " + p;
  if (p === "admin/index.html") {
    test(moduleName + " : integrity + crossorigin + pinned UMD (تحت admin/)", () => {
      const html = fs.readFileSync(path.join(ROOT, p), "utf-8");
      const m = SCRIPT_SINGLE_RE.exec(html);
      assert.ok(m && m[0], "سكربت supabase-js موجود");
      assertOkSri(m[0], p);
      assert.strictEqual(countScripts(html), 1, "لا نسخة ثانية من سكربت supabase-js");
    });
  } else {
    test(moduleName + " : integrity + crossorigin + pinned UMD", () => {
      const html = fs.readFileSync(path.join(ROOT, p), "utf-8");
      const m = SCRIPT_SINGLE_RE.exec(html);
      assert.ok(m && m[0], "سكربت supabase-js موجود");
      assertOkSri(m[0], p);
      assert.strictEqual(countScripts(html), 1, "لا نسخة ثانية من سكربت supabase-js");
    });
  }
}

function assertOkSri(tag, page) {
  assert.ok(tag.includes('src="' + EXPECTED_SRC + '"'), page + ": src هو الملف UMD المثبَّت");
  assert.ok(tag.includes('integrity="' + EXPECTED_HASH + '"'), page + ": integrity مطابق للأشعة المتوقعة");
  assert.ok(tag.includes('crossorigin="anonymous"'), page + ": crossorigin=anonymous مطلوب مع SRI");
}

test("لا بقايا من الصياغة بدون integrity في أي صفحة", () => {
  for (const p of pages) {
    const html = fs.readFileSync(path.join(ROOT, p), "utf-8");
    const m = SCRIPT_SINGLE_RE.exec(html);
    if (m) {
      assert.ok(m[0].includes("integrity="), p + " يملك integrity (لا نسخة قديمة)");
    }
  }
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;