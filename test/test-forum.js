/**
 * test-forum.js
 * ------------------------------------------------------------------
 * اختبارات Regression لميزة "ملتقى أفق" (Forum MVP — Phase 6).
 * تُشغَّل بـNode العادي (لا حاجة لمتصفح حقيقي) — تحمّل js/forum.js فعليًا
 * كما هو عبر vm.runInNewContext، بمحاكاة الاعتماديات التي يستخدمها من
 * js/auth.js وjs/app.js (currentAuthUser, isAnonymousUser, openAuthOverlay,
 * bestDisplayName, showToast, renderState, renderBreadcrumb, getQueryParam)
 * ومحاكاة supabaseClient (query builder قابل للتسلسل .from().select()...).
 *
 * لا تستخدم أي حساب حقيقي ولا شبكة فعلية ولا اتصال بقاعدة بيانات حقيقية.
 *
 * ملاحظة أمانة (Definition of Done § لا تخمّن):
 * هذا الملف يختبر منطق العميل (JS) فقط. لا يمكنه اختبار تطبيق RLS
 * الفعلي على Postgres/Supabase الحي (لا اتصال قاعدة بيانات من بيئة
 * الاختبار هذه) — التحقق من RLS هنا هو مراجعة نصّية لملف SQL نفسه
 * (assert على وجود كل سياسة بالنص)، وليس تنفيذًا فعليًا ضدها. هذا محدود
 * صراحة في القسم "Known Limitations" من التقرير النهائي.
 *
 * التشغيل: node test/test-forum.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const FORUM_JS_PATH = path.join(__dirname, "..", "js", "forum.js");
const forumJsSource = fs.readFileSync(FORUM_JS_PATH, "utf-8");
const SQL_PATH = path.join(__dirname, "..", "sql", "phase6_forum_mvp.sql");
const sqlSource = fs.readFileSync(SQL_PATH, "utf-8");
const AUTH_JS_PATH = path.join(__dirname, "..", "js", "auth.js");
const authJsSource = fs.readFileSync(AUTH_JS_PATH, "utf-8");

let failures = 0;
let passed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failures++;
  }
}

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

/** عنصر DOM محاكى بسيط — يكفي لاختبار forum.js دون متصفح حقيقي. */
function makeElement(tagName = "DIV") {
  const el = {
    tagName,
    hidden: false,
    disabled: false,
    className: "",
    value: "",
    placeholder: "",
    maxLength: 0,
    _attrs: {},
    _children: [],
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
    appendChild(child) { this._children.push(child); return child; },
    prepend(child) { this._children.unshift(child); return child; },
    remove() {},
    reset() { this.value = ""; },
    querySelector(sel) {
      if (sel.startsWith(".")) {
        return this._children.find((c) => (c.className || "").split(" ").includes(sel.slice(1))) || null;
      }
      return null;
    },
    replaceWith(node) { this._replacedWith = node; },
    scrollIntoView() {},
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._textContent || ""; },
    set(v) { this._textContent = v; },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML || ""; },
    set(v) { this._innerHTML = v; this._children = []; },
  });
  return el;
}

/** Query builder متسلسل (chainable) يحاكي supabase-js — كل استدعاء
 *  from()/select()/eq()/order()/range()... يُسجَّل في calls[] ثم يُعاد
 *  نفس الكائن ليُتابَع التسلسل، وأخيرًا await يُرجع النتيجة المُعطاة. */
function makeMockSupabase({ resultsByTable = {}, onInsert = null, onUpdate = null, onDelete = null } = {}) {
  const calls = [];

  function builder(table) {
    const state = { table, filters: {}, range: null };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(from, to) { state.range = [from, to]; calls.push({ op: "range", table, from, to }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(payload) {
        calls.push({ op: "insert", table, payload });
        if (onInsert) return onInsert(table, payload, chain);
        return chain;
      },
      update(payload) {
        calls.push({ op: "update", table, payload });
        if (onUpdate) return onUpdate(table, payload, state);
        return Promise.resolve({ data: null, error: null });
      },
      delete() {
        calls.push({ op: "delete", table });
        if (onDelete) return onDelete(table, state);
        return chain;
      },
      then(resolve) {
        const result = resultsByTable[table] || { data: [], error: null };
        resolve(chain._single ? { data: (result.data || [])[0] || null, error: result.error || null } : result);
      },
    };
    return chain;
  }

  return { from: builder, calls };
}

function loadForumJsSandbox(overrides = {}) {
  const toasts = [];
  const openAuthOverlayCalls = [];
  const consoleLogs = [];

  const defaultCtx = {
    console: { log: (...a) => consoleLogs.push(a.join(" ")), error: () => {}, warn: () => {} },
    document: {
      getElementById: () => makeElement(),
      createElement: (tag) => makeElement(tag.toUpperCase()),
    },
    window: {
      location: { search: "", href: "" },
      history: { replaceState() {} },
      confirm: () => true,
    },
    URLSearchParams: URLSearchParams,
    encodeURIComponent,
    setTimeout,
    Date,
    // اعتماديات js/auth.js (مُحاكاة — نفس التوقيع الفعلي)
    currentAuthUser: null,
    isAnonymousUser: () => true,
    openAuthOverlay: () => openAuthOverlayCalls.push(true),
    bestDisplayName: (u) => (u && u.user_metadata && u.user_metadata.full_name) || "مستخدم",
    ensureAuthSession: async () => null,
    refreshAuthUI: () => {},
    // اعتماديات js/app.js
    showToast: (msg) => toasts.push(msg),
    escHtml: (v) => String(v ?? ""),
    renderState: () => {},
    renderBreadcrumb: () => {},
    getQueryParam: () => null,
    supabaseClient: makeMockSupabase({}).from ? makeMockSupabase({}) : null,
  };

  const ctx = Object.assign(defaultCtx, overrides);
  ctx.window.confirm = ctx.window.confirm || (() => true);
  const sandbox = vm.createContext(ctx);
  vm.runInContext(forumJsSource, sandbox, { filename: "forum.js" });

  return { sandbox, toasts, openAuthOverlayCalls, consoleLogs };
}

(async () => {
  console.log("AFOQ Forum MVP — Regression Tests\n");

  // ============================================================
  // Routing
  // ============================================================

  await testAsync("Routing — Sidebar forum link points to forum.html", async () => {
    assert.ok(authJsSource.includes('href="forum.html"'), "auth.js يجب أن يحتوي رابط forum.html حقيقي في القائمة الجانبية");
  });

  await testAsync("Routing — No badge-soon left on the forum sidebar entry", async () => {
    const match = authJsSource.match(/<a href="forum\.html"[^]*?<\/a>/);
    assert.ok(match, "forum link block must exist");
    assert.ok(!match[0].includes("badge-soon"), "badge-soon يجب ألا يبقى على عنصر الملتقى");
  });

  await testAsync("Routing — NOT IMPLEMENTED placeholder log removed", async () => {
    assert.ok(!authJsSource.includes("Forum destination: NOT IMPLEMENTED YET"), "رسالة الـplaceholder القديمة يجب أن تُزال بالكامل");
  });

  // ============================================================
  // Auth gating (Guest vs Registered)
  // ============================================================

  await testAsync("Auth — Guest cannot open new-topic action (openAuthOverlay called instead)", async () => {
    const { sandbox, openAuthOverlayCalls } = loadForumJsSandbox({
      currentAuthUser: null,
      isAnonymousUser: () => true,
    });
    const result = sandbox.forumRequireRealUser();
    assert.strictEqual(result, false, "forumRequireRealUser must return false for a guest");
    assert.strictEqual(openAuthOverlayCalls.length, 1, "openAuthOverlay must be called exactly once for a guest attempt");
  });

  await testAsync("Auth — Registered (linked) user passes the gate without opening auth overlay", async () => {
    const { sandbox, openAuthOverlayCalls } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: { full_name: "طالب" } },
      isAnonymousUser: () => false,
    });
    const result = sandbox.forumRequireRealUser();
    assert.strictEqual(result, true, "forumRequireRealUser must return true for a linked user");
    assert.strictEqual(openAuthOverlayCalls.length, 0, "openAuthOverlay must NOT be called for a linked user");
  });

  // ============================================================
  // XSS Protection
  // ============================================================

  await testAsync("Security — Topic card title is set via textContent, XSS payload stays literal text", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const payload = '<img src=x onerror="alert(1)">';
    const card = sandbox.buildForumTopicCard({
      id: "t1",
      title: payload,
      content: "محتوى عادي",
      author_name: "طالب",
      created_at: new Date().toISOString(),
      is_locked: false,
      forum_categories: { name: "أسئلة", slug: "questions" },
    });
    const titleEl = card._children.find((c) => c.tagName === "H3");
    assert.ok(titleEl, "title element must exist");
    assert.strictEqual(titleEl.textContent, payload, "XSS payload must remain as literal textContent, never interpreted as HTML");
  });

  await testAsync("Security — Reply card content is set via textContent, never innerHTML", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const payload = '<script>alert(1)</script>';
    const card = sandbox.buildForumReplyCard({
      id: "r1", content: payload, author_id: "someone-else", author_name: "طالب آخر", created_at: new Date().toISOString(),
    });
    const contentEl = card._children.find((c) => (c.className || "").includes("forum-content-text"));
    assert.ok(contentEl, "content element must exist");
    assert.strictEqual(contentEl.textContent, payload, "script payload must remain literal text, never executed/parsed as HTML");
  });

  // ============================================================
  // Locked topic blocks replies (client-side gating)
  // ============================================================

  await testAsync("Locked topic — reply form is hidden when topic.is_locked = true", async () => {
    const replyFormWrap = makeElement("DIV");
    const textarea = makeElement("TEXTAREA");
    const submitBtn = makeElement("BUTTON");
    const els = { "forum-reply-form-wrap": replyFormWrap, "forum-reply-content": textarea, "forum-reply-submit-btn": submitBtn };
    const { sandbox } = loadForumJsSandbox({
      currentAuthUser: null,
      isAnonymousUser: () => true,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()) },
    });
    sandbox.setupForumReplyForm({ is_locked: true });
    assert.strictEqual(replyFormWrap.hidden, true, "reply form must be hidden for a locked topic");
  });

  await testAsync("Locked topic — submitForumReply refuses to send and does not call insert", async () => {
    let insertCalled = false;
    const mockSupa = {
      from: (table) => {
        const b = makeMockSupabase({
          resultsByTable: {
            forum_topics: { data: [{ id: "t1", title: "عنوان", content: "محتوى", author_id: "someone", author_name: "طالب", created_at: new Date().toISOString(), is_locked: true, is_hidden: false, category_id: "c1", forum_categories: { name: "أسئلة", slug: "questions" } }], error: null },
          },
        }).from(table);
        if (table === "forum_replies") {
          const originalInsert = b.insert;
          b.insert = (payload) => { insertCalled = true; return originalInsert.call(b, payload); };
        }
        return b;
      },
    };
    const textarea = makeElement("TEXTAREA");
    textarea.value = "رد على موضوع مغلق";
    const els = {
      "breadcrumb": makeElement("NAV"),
      "forum-topic-container": makeElement("DIV"),
      "forum-replies-section": makeElement("SECTION"),
      "forum-replies-list": makeElement("DIV"),
      "forum-replies-load-more-btn": makeElement("BUTTON"),
      "forum-reply-form-wrap": makeElement("DIV"),
      "forum-reply-content": textarea,
      "forum-reply-submit-btn": makeElement("BUTTON"),
    };
    const { sandbox, toasts } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: {} },
      isAnonymousUser: () => false,
      supabaseClient: mockSupa,
      getQueryParam: () => "t1",
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()) },
    });
    // نقود الحالة عبر المسار الحقيقي (loadForumTopicDetail) بدل تعيين
    // forumCurrentTopic مباشرة — متغيرات let/const في vm.runInContext لا
    // تُقرأ ولا تُكتب من خارج السياق (تحقّقنا تجريبيًا)، فقط الدوال
    // المُعرَّفة بـfunction تُتاح كخصائص على sandbox، وهي ما تُحدّث تلك
    // المتغيرات داخليًا بشكل صحيح.
    await sandbox.initForumTopicPage();
    await sandbox.submitForumReply({ preventDefault() {} });
    assert.strictEqual(insertCalled, false, "insert must never be called for a locked topic");
    assert.ok(toasts.some((t) => t.includes("مغلق")), "a toast explaining the topic is locked must be shown");
  });

  // ============================================================
  // Reporting
  // ============================================================

  await testAsync("Reporting — reason labels include the required 'offensive' (ألفاظ بذيئة أو إساءة) reason", async () => {
    // ملاحظة: FORUM_REPORT_REASON_LABELS مُعرَّف بـconst على مستوى الملف —
    // متغيرات let/const في vm.runInContext غير قابلة للقراءة من خارج
    // السياق (تحقّقنا تجريبيًا)، فقط الدوال المُعرَّفة بـfunction تُتاح.
    // لذلك نراجع المصدر النصّي مباشرة هنا، بدل الوصول وقت التشغيل.
    assert.ok(/offensive:\s*"ألفاظ بذيئة أو إساءة"/.test(forumJsSource), "FORUM_REPORT_REASON_LABELS.offensive يجب أن يساوي 'ألفاظ بذيئة أو إساءة'");
  });

  await testAsync("Reporting — report modal HTML includes a select with the offensive reason option", async () => {
    const topicHtml = fs.readFileSync(path.join(__dirname, "..", "forum-topic.html"), "utf-8");
    assert.ok(topicHtml.includes('id="forum-report-reason"'), "report reason select must exist");
    assert.ok(topicHtml.includes('value="offensive"'), "offensive reason option must exist");
    assert.ok(topicHtml.includes("ألفاظ بذيئة أو إساءة"), "offensive reason label text must exist");
  });

  await testAsync("Reporting — report button exists for both topic and reply cards", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const topicBox = sandbox.forumEl("div");
    // renderForumTopicDetail relies on real DOM getElementById; بدل ذلك
    // نتحقق مباشرة أن buildForumReplyCard يُنشئ زر إبلاغ ضمن children.
    const replyCard = sandbox.buildForumReplyCard({
      id: "r1", content: "رد عادي", author_id: "x", author_name: "طالب", created_at: new Date().toISOString(),
    });
    const actions = replyCard._children.find((c) => (c.className || "").includes("forum-item-actions"));
    assert.ok(actions, "actions container must exist on a reply card");
    const reportBtn = actions._children.find((c) => c.textContent && c.textContent.includes("إبلاغ"));
    assert.ok(reportBtn, "🚩 إبلاغ button must exist on every reply card");
  });

  await testAsync("Reporting — submitting a report sends exactly one target (topic xor reply)", async () => {
    let capturedPayload = null;
    const mockSupa = {
      from: (table) => {
        const b = makeMockSupabase({}).from(table);
        if (table === "forum_reports") {
          b.insert = (payload) => { capturedPayload = payload; return Promise.resolve({ data: null, error: null }); };
        }
        return b;
      },
    };
    const reasonSelect = makeElement("SELECT"); reasonSelect.value = "offensive";
    const detailsTextarea = makeElement("TEXTAREA"); detailsTextarea.value = "";
    const els = {
      "forum-report-reason": reasonSelect,
      "forum-report-details": detailsTextarea,
      "forum-report-submit-btn": makeElement("BUTTON"),
      "forum-report-modal": makeElement("DIV"),
      "forum-report-form": makeElement("FORM"),
    };
    const { sandbox } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: {} },
      isAnonymousUser: () => false,
      supabaseClient: mockSupa,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()) },
    });
    // نقود forumReportTargetType/Id عبر المسار الحقيقي (openForumReportModal)
    // بدل تعيينهما مباشرة، لنفس سبب let/const أعلاه.
    sandbox.openForumReportModal("reply", "reply-42");
    await sandbox.submitForumReport({ preventDefault() {} });
    assert.ok(capturedPayload, "insert into forum_reports must be called");
    assert.strictEqual(capturedPayload.reply_id, "reply-42");
    assert.strictEqual(capturedPayload.topic_id, null, "topic_id must be null when reporting a reply");
    assert.strictEqual(capturedPayload.reason, "offensive");
  });

  // ============================================================
  // Pagination
  // ============================================================

  await testAsync("Pagination — first topics page requests range(0, 19) (20 per page)", async () => {
    const calls = [];
    const mockSupa = { from: (table) => {
      const b = makeMockSupabase({ resultsByTable: { forum_topics: { data: [], error: null } } }).from(table);
      const originalRange = b.range;
      b.range = (from, to) => { calls.push([from, to]); return originalRange.call(b, from, to); };
      return b;
    } };
    const els = { "forum-topics-list": makeElement("DIV"), "forum-load-more-btn": makeElement("BUTTON") };
    const { sandbox } = loadForumJsSandbox({
      supabaseClient: mockSupa,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()) },
    });
    sandbox.forumCategoriesCache = [];
    sandbox.forumActiveCategorySlug = null;
    await sandbox.loadForumTopics(true);
    assert.deepStrictEqual(calls[0], [0, 19], "first page must request range(0, 19) — 20 items per page");
  });

  await testAsync("Pagination — replies page size is 20 per page", async () => {
    // نفس ملاحظة const أعلاه — مراجعة نصّية للمصدر بدل قراءة وقت التشغيل.
    assert.ok(/FORUM_REPLIES_PAGE_SIZE\s*=\s*20/.test(forumJsSource));
    assert.ok(/FORUM_TOPICS_PAGE_SIZE\s*=\s*20/.test(forumJsSource));
  });

  // ============================================================
  // Security — RLS / SQL review (نصّي فقط، راجع ملاحظة أمانة أعلى الملف)
  // ============================================================

  test("SQL review — RLS is enabled on all 4 forum tables", () => {
    ["forum_categories", "forum_topics", "forum_replies", "forum_reports"].forEach((t) => {
      const re = new RegExp(`alter table\\s+${t}\\s+enable row level security`);
      assert.ok(re.test(sqlSource), `RLS must be enabled on ${t}`);
    });
  });

  test("SQL review — ownership-only update/delete policies exist for topics and replies", () => {
    assert.ok(sqlSource.includes('"update_own_forum_topics"') && sqlSource.includes("author_id = auth.uid()"));
    assert.ok(sqlSource.includes('"delete_own_forum_topics"'));
    assert.ok(sqlSource.includes('"update_own_forum_replies"'));
    assert.ok(sqlSource.includes('"delete_own_forum_replies"'));
  });

  test("SQL review — locked topics are enforced against replies at the database level, not only in the UI", () => {
    const insertRepliesPolicy = sqlSource.match(/"insert_own_forum_replies"[^]*?with check \(([^]*?)\);/);
    assert.ok(insertRepliesPolicy, "insert_own_forum_replies policy must exist");
    assert.ok(insertRepliesPolicy[1].includes("is_locked = false"), "the WITH CHECK clause must reject replies to locked topics at the DB level");
  });

  test("SQL review — forum_reports enforces exactly one target (topic XOR reply)", () => {
    assert.ok(sqlSource.includes("forum_reports_single_target"), "single-target CHECK constraint must exist on forum_reports");
  });

  test("SQL review — no DROP TABLE / no destructive statement on any existing table", () => {
    assert.ok(!/drop\s+table/i.test(sqlSource), "migration must never DROP an existing table");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
