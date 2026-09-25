/**
 * test-footer-svg-focus.js
 * ------------------------------------------------------------------
 * اختبارات Group E — `focusable="false"` لأيقونات SVG في فوتر
 * المواقع الاجتماعية (footer-social) عبر كل الصفحات العامة، لكي
 * لا يصبح أي SVG زخرفي هدفًا للتبويب بلوحة المفاتيح (قارئ شاشة
 * يتنقل Tab) دون فائدة، وهو نفس معيار aria-hidden="true" لمحتوى
 * زخرفي.
 *
 * الحقائق الحالية (يجب أن تبقى ثابتة):
 * 1. كل صفحة عامة من الصفحات الـ13 تحتوي divisionً واحدًا
 *    بعنصر class="footer-social" فيه 5 أيقونات SVGs للتواصل
 *    فيسبوك/واتساب/تليغرام/إنستغرام/تيك توك (4 بنمط fill=currentColor
 *    + 1 بنمط fill=none & stroke=currentColor).
 * 2. كل SVG في هذا الفوتر يحمل aria-hidden="true".
 * 3. (NEW في هذه الجلسة) كل SVG فيه يحمل أيضًا focusable="false".
 * 4. لا يوجد أي `<svg` في أي صفحة عامة يفتقر إلى focusable="false"
 *    (الشعارات الجوّالة، أيقونات الروابط، أيقونة العودة للأعلى... كلها
 *    زخرفية ومرّت بنفس المعالجة).
 *
 * بند "اختبار مخفي لعنوان التبويب المستخدم في مسار 422" — مُسقَط
 * بلا إجراء: لا يوجد أي عنصر عنوان/عنوان مخفي مرتبط بمسار ردّ
 * 422 لجلسة الضيف في الكود، والمسار نفسه مغطّى أصلًا في اختبارات
 * Test G/H في test-google-auth-state.js (10/10). مسجَّل في
 * CURRENT-STATUS.md كبند غير قابل للتطبيق بدل اختراع اختبار بلا معنى.
 *
 * التشغيل: node test/test-footer-svg-focus.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const htmlFiles = ["index.html", "platform.html", "search.html", "subject.html", "courses.html", "course.html", "favorites.html", "forum.html", "forum-topic.html", "university.html", "year.html", "faculty.html", "semester.html"];

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

function footerSocialDiv(src) {
  const start = src.indexOf('class="footer-social"');
  if (start === -1) return "";
  const divStart = src.lastIndexOf("<div", start);
  const end = src.indexOf("</div>", start);
  if (divStart === -1 || end === -1) return "";
  return src.slice(divStart, end);
}

console.log("AFOQ Group E — Footer Social SVG Focus Tests\n");

test("Group E — كل صفحة عامة فيها division footer-social واحد بالضبط", () => {
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const count = (src.match(/class="footer-social"/g) || []).length;
    assert.strictEqual(count, 1, `${f}: يتوقع division footer-social واحدًا، وجد ${count}`);
  }
});

test("Group E — كل footer-social فيه 5 أيقونات SVG (4 fill + 1 stroke) كل واحدة بحمل focusable='false'", () => {
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const div = footerSocialDiv(src);
    assert.ok(div, `${f}: لم يُستخرج footer-social div`);
    const svgs = [...div.matchAll(/<svg\b/g)];
    assert.strictEqual(svgs.length, 5, `${f}: يتوقع 5 SVGs في footer-social، وجد ${svgs.length}`);
    const fillOnly = (div.match(/<svg[^>]*fill="currentColor"(?![^>]*fill="none")[^>]*>/g) || []).length;
    const stroke = (div.match(/<svg[^>]*fill="none"[^>]*stroke="currentColor"[^>]*>/g) || []).length;
    assert.strictEqual(fillOnly, 4, `${f}: يتوقع 4 أيقونات fill=currentColor، وجد ${fillOnly}`);
    assert.strictEqual(stroke, 1, `${f}: يتوقع أيقونة stroke=currentColor واحدة، وجد ${stroke}`);
    for (const m of div.matchAll(/<svg[^>]*>/g)) {
      const tag = m[0];
      assert.ok(/aria-hidden="true"/.test(tag), `${f}: ${tag.slice(0, 80)} يفتقر إلى aria-hidden="true"`);
      assert.ok(/focusable="false"/.test(tag), `${f}: ${tag.slice(0, 80)} يفتقر إلى focusable="false" (Group E)`);
    }
  }
});

test("Group E — لا يوجد أي <svg> في أي صفحة عامة بلا focusable='false'", () => {
  const offenders = [];
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    for (const m of src.matchAll(/<svg\b[^>]*>/g)) {
      const tag = m[0];
      if (!/focusable="false"/.test(tag)) {
        offenders.push(`${f}: ${tag.slice(0, 90)}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], "كل SVGs الصفحات العامة (شعارات/أيقونات/فوتر) تحمل focusable='false'");
});

test("Group E — كل أيقونة social محاطة برابط social-link (عنصر تفاعلي يرث focus إليها لا إليها مباشرة)", () => {
  for (const f of htmlFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf-8");
    const div = footerSocialDiv(src);
    const links = (div.match(/class="social-link"/g) || []).length;
    assert.strictEqual(links, 5, `${f}: يتوقع 5 روابط social-link، وجد ${links}`);
    assert.ok(/rel="noopener noreferrer"/.test(div), `${f}: روابط social تحمل rel=noopener noreferrer`);
    assert.ok(/target="_blank"/.test(div), `${f}: روابط social تفتح في تبويب جديد`);
  }
});

test("Group E — لا focusable مطلوبة لأي SVG زخرفي في صناديق modals/overlays المنشأة JS (لا ينطبق — كلها تولد عبر authSvgIcon بمعاملات آمنة)", () => {
  const authJs = fs.readFileSync(path.join(ROOT, "js", "auth.js"), "utf-8");
  const iconBuild = authJs.slice(authJs.indexOf("function authSvgIcon"), authJs.indexOf("function authSvgMarkup"));
  assert.ok(iconBuild.includes('setAttribute("aria-hidden", "true")'), "authSvgIcon يضبط aria-hidden");
  assert.ok(iconBuild.includes('setAttribute("focusable", "false")'), "authSvgIcon يضبط focusable=false (افتراضي SVG في IE/قديم)");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;