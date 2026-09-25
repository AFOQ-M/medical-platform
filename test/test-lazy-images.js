/**
 * test-lazy-images.js
 * ------------------------------------------------------------------
 * اختبارات NEW-08 — تحميل كسول (lazy/async) لصور البطاقات
 * المنشأة ديناميكيًا عبر JS، مع بقاء شعار الهيدر/الفوتر (المحتوى
 * الأساسي) بلا lazy.
 *
 * حقائق الكود الحالية (يجب أن تبقى ثابتة):
 * 1. بطاقات الموارد (buildResourceCard) تبني أيقونات SVG
 *    (resourceTypeIcon → buildStrokeIcon)، ولا تبني <img> إطلاقًا —
 *    فـ"صورة البطاقة" الوحيدة المنشأة عبر JS هي أغلفة بطاقات
 *    الدورات في courses.html (course-card-cover).
 * 2. كل <img> في الـ HTML الثابت عبر الصفحات العامة هو شعار
 *    (brand-logo) أو شعار الفوتر (footer-logo) — من المدخل (primary
 *    content) ويجب أن يبقى بلا lazy/decoding.
 *
 * التشغيل: node test/test-lazy-images.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const htmlFiles = ["index.html", "platform.html", "search.html", "subject.html", "courses.html", "course.html", "favorites.html", "forum.html", "forum-topic.html", "university.html", "year.html", "faculty.html", "semester.html"];
const coursesHtml = fs.readFileSync(path.join(ROOT, "courses.html"), "utf-8");
const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf-8");

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

console.log("AFOQ NEW-08 — Lazy/Async Images Tests\n");

test("NEW-08 — غلاف بطاقة الدورة في courses.html يحمل loading='lazy' و decoding='async'", () => {
  assert.ok(coursesHtml.includes('img.loading = "lazy"'), "courses.html يضبط img.loading = lazy");
  assert.ok(coursesHtml.includes('img.decoding = "async"'), "courses.html يضبط img.decoding = async (NEW-08)");
});

test("NEW-08 — cards غير course لا تولّد <img> غير كسول (buildResourceCard = أيقونات SVG فقط)", () => {
  const cardSection = appJs.slice(appJs.indexOf("function buildResourceCard"), appJs.indexOf("function escHtml"));
  assert.ok(!cardSection.includes('createElement("img")'), "buildResourceCard لا يبني <img> إطلاقًا — الصور الثابتة للبطاقات غائبة تلقائيًا");
  assert.ok(cardSection.includes("buildStrokeIcon") || cardSection.includes("resourceTypeIcon"), "يستخدم أيقونات SVG عبر buildStrokeIcon/resourceTypeIcon");
});

test("NEW-08 — لا <img> في HTML ثابت يحمل loading/decoding باستثناء أهداف NEW-08 المعلنة", () => {
  const offenders = [];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const imgTags = [...src.matchAll(/<img[^>]*>/gi)].map((m) => m[0]);
    for (const tag of imgTags) {
      if (/loading\s*=|decoding\s*=/.test(tag)) {
        offenders.push(`${f}: ${tag.slice(0, 120)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], "لا يولي أي <img> ثابت lazy/decoding — الشعارات تبقى بحمولة فورية");
});

test("NEW-08 — شعار الهيدر/الفوتر في كل الصفحات العامة بلا lazy (محتوى أساسي)", () => {
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const brand = src.match(/<img[^>]*class="[^"]*brand-logo[^"]*"[^>]*>/i);
    const footer = src.match(/<img[^>]*class="[^"]*footer-logo[^"]*"[^>]*>/i);
    for (const tag of [brand && brand[0], footer && footer[0]]) {
      if (tag) assert.ok(!/loading\s*=|decoding\s*=/.test(tag), `${f}: ${tag.slice(0, 100)} لا يحمل lazy/decoding`);
    }
  }
});

test("NEW-08 — الصور الخارجية (covers) تُعاد عبر safeResourceUrl وتبقى كما هي (لا تغيير سياسة origin)", () => {
  assert.ok(coursesHtml.includes("safeResourceUrl(c.cover_image_url)"), "غلاف الدورة يمر عبر safeResourceUrl قبل src");
  assert.ok(coursesHtml.includes('img.src = safeUrl'), "src = safeUrl (لا إعادة كتابة لسياسة المصدر)");
});

test("NEW-08 — لا IntersectionObserver زائد (الحد الصارم: بساطة السمتين فقط)", () => {
  assert.ok(!appJs.includes("new IntersectionObserver"), "لا watcher جديد في js/app.js");
  assert.ok(!/loading\s*=\s*"eager"/.test(appJs), "لا overwrite ضار لـ eager في app.js");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;