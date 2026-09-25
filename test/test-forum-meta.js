/**
 * test-forum-meta.js
 * ------------------------------------------------------------------
 * اختبارات NEW-07 — وجود كتلة OG/Twitter meta في forum-topic.html
 * مطابقةً للمرجع في forum.html / courses.html (نفس الصورة ونفس الأسلوب).
 * قراءة ملفية فقط (لا محاكاة متصفح) — بلا أي اتصال شبكة أو قاعدة بيانات.
 *
 * التشغيل: node test/test-forum-meta.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const headerOf = (file) => fs.readFileSync(path.join(ROOT, file), "utf-8");

const forumTopic = headerOf("forum-topic.html");
const forum = headerOf("forum.html");
const courses = headerOf("courses.html");

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

console.log("AFOQ NEW-07 — Forum Topic Social Meta Tests\n");

function metaProps(html, prop) {
  const re = new RegExp('<meta[^>]+property="' + prop + '"[^>]*>', "gi");
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

function metaNames(html, name) {
  const re = new RegExp('<meta[^>]+name="' + name + '"[^>]*>', "gi");
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[0]);
  return out;
}

function contentOf(tag) {
  const m = /content="([^"]*)"/.exec(tag);
  return m ? m[1] : "";
}

test("NEW-07 — كل og:/twitter: السبعة موجودة في forum-topic.html (ضمن <head>)", () => {
  const head = /<head>([\s\S]*?)<\/head>/i.exec(forumTopic);
  assert.ok(head, "يوجد وسم <head>");
  const inHead = head[1];
  for (const key of ["og:title", "og:description", "og:type", "og:url", "og:image"]) {
    assert.ok(metaProps(inHead, key).length === 1, key + " موجودة مرة واحدة داخل <head>");
  }
  for (const key of ["twitter:card", "twitter:title", "twitter:description", "twitter:image"]) {
    assert.ok(metaNames(inHead, key).length === 1, key + " موجودة مرة واحدة داخل <head>");
  }
});

test("NEW-07 — og:title/twitter:title = عنوان الصفحة ('موضوع — ملتقى أفق')", () => {
  const t = /<title>([^<]*)<\/title>/.exec(forumTopic);
  assert.ok(t, "يوجد <title>");
  assert.strictEqual(contentOf(metaProps(forumTopic, "og:title")[0]), t[1], "og:title يطابق <title>");
  assert.strictEqual(contentOf(metaNames(forumTopic, "twitter:title")[0]), t[1], "twitter:title يطابق <title>");
});

test("NEW-07 — og:type=website و twitter:card=summary", () => {
  assert.strictEqual(contentOf(metaProps(forumTopic, "og:type")[0]), "website", "og:type = website");
  assert.strictEqual(contentOf(metaNames(forumTopic, "twitter:card")[0]), "summary", "twitter:card = summary");
});

test("NEW-07 — og:image/twitter:image نفس صورة forum.html و courses.html (نفس الملف)", () => {
  const expected = contentOf(metaProps(forum, "og:image")[0]);
  assert.ok(expected, "forum.html يملك og:image");
  assert.strictEqual(contentOf(metaProps(forumTopic, "og:image")[0]), expected, "og:image مطابق لمرجع forum.html");
  assert.strictEqual(contentOf(metaNames(forumTopic, "twitter:image")[0]), expected, "twitter:image مطابق");
  const coursesImg = contentOf(metaProps(courses, "og:image")[0]);
  assert.strictEqual(expected, coursesImg, "الصورتان في المرجعين متطابقتان أيضًا (مرجع مفرد)");
});

test("NEW-07 — og:url يشير إلى forum-topic.html نفسه", () => {
  const url = contentOf(metaProps(forumTopic, "og:url")[0]);
  assert.ok(/forum-topic\.html$/.test(url), "og:url ينتهي بـ forum-topic.html: " + url);
  const canonical = /<link rel="canonical" href="([^"]*)"/.exec(forumTopic);
  assert.ok(canonical, "يوجد canonical");
  assert.strictEqual(url, canonical[1], "og:url = canonical");
});

test("NEW-07 — forum.html و forum-topic.html لم تتضررا (المرجع سليم: og:title واحد لكل منهما)", () => {
  assert.strictEqual(metaProps(forum, "og:title").length, 1, "forum.html og:title واحد فقط");
  assert.strictEqual(metaProps(forumTopic, "og:title").length, 1, "forum-topic.html og:title واحد فقط");
});

test("NEW-07 — لا تكرار: لا og:/twitter في غير <head>", () => {
  const bodyHeadless = forumTopic.replace(/<head>[\s\S]*?<\/head>/i, "");
  assert.ok(!/og:|twitter:/.test(bodyHeadless), "لا كتل OG/Twitter خارج <head>");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;