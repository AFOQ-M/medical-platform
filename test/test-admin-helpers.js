/**
 * test-admin-helpers.js
 * ------------------------------------------------------------------
 * اختبارات Regression للوحة التحكم (admin/admin.js) — الجزء 1:
 * أدوات الإخراج والتحقق من الروابط + سلوك لوحة المعلومات الجديد
 * (F-01: بطاقة "بلاغات المنتدى" + F-06: عزل فشل كل استعلام).
 *
 * تُشغَّل بـNode العادي (لا حاجة لمتصفح حقيقي) — تحمّل admin/admin.js
 * فعليًا كما هو عبر vm.runInNewContext، بمحاكاة الاعتماديات التي يستخدمها
 * من js/app.js وjs/supabase-client.js (supabaseClient, showToast,
 * SUBJECT_SEMESTER_LABELS, LANGUAGE_LABELS) ومحاكاة document/sessionStorage.
 *
 * لا تستخدم أي حساب حقيقي ولا شبكة فعلية ولا اتصال بقاعدة بيانات حقيقية.
 * (التحقق من RLS/SQL الفعلي ليس من اختصاص هذا الملف — هو مراجعة نصّية
 * لملفات SQL في test/test-forum.js وملفات اختبار الأدمن الأخرى.)
 *
 * ملاحظة أمانة (نفس ملاحظة test-forum.js): متغيرات let/const في
 * vm.runInContext لا تُقرأ ولا تُكتب من خارج السياق؛ فقط الدوال
 * المُعرَّفة بـfunction تُتاح كخصائص على sandbox. لذلك نُدخل الحالة
 * (currentProfile/currentPermissions) عبر المسار الحقيقي
 * loadCurrentUserAuthorization() بدل تعيينها يدويًا.
 *
 * التشغيل: node test/test-admin-helpers.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ADMIN_JS_PATH = path.join(__dirname, "..", "admin", "admin.js");
const adminJsSource = fs.readFileSync(ADMIN_JS_PATH, "utf-8");

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

/* عنصر DOM محاكى بسيط — يكفي لتحميل admin.js واختبار سلوكه دون متصفح حقيقي. */
function makeElement(tagName = "DIV") {
  const el = {
    tagName,
    hidden: false,
    disabled: false,
    className: "",
    value: "",
    checked: false,
    open: false,
    selected: false,
    options: [],
    dataset: {},
    style: {},
    _attrs: {},
    _children: [],
    _listeners: {},
    _textContent: "",
    _innerHTML: "",
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
    appendChild(child) { this._children.push(child); return child; },
    insertBefore(child) { this._children.unshift(child); return child; },
    remove() {},
    reset() { this.value = ""; },
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    classList: {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      contains(c) { return this._set.has(c); },
      toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._textContent; },
    set(v) { this._textContent = v; },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML; },
    set(v) { this._innerHTML = v; this._children = []; },
  });
  return el;
}

/* Query builder متسلسل يحاكي supabase-js — كل استدعاء يُسجَّل في calls[]
 * ثم await يُرجع النتيجة المُعطاة (resultsByTable) أو RPC (rpcResults). */
function makeMockSupabase({ resultsByTable = {}, rpcResults = {}, onInsert = null, onUpdate = null, onDelete = null } = {}) {
  const calls = [];

  function builder(table) {
    const state = { table, filters: {}, range: null };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(from, to) { state.range = [from, to]; calls.push({ op: "range", table, from, to }); return chain; },
      limit(n) { calls.push({ op: "limit", table, n }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(payload) {
        calls.push({ op: "insert", table, payload });
        if (onInsert) { const r = onInsert(table, payload, state); if (r !== undefined) return r; }
        return chain;
      },
      update(payload) {
        calls.push({ op: "update", table, payload });
        if (onUpdate) { const r = onUpdate(table, payload, state); if (r !== undefined) return r; }
        return chain;
      },
      delete() {
        calls.push({ op: "delete", table });
        if (onDelete) { const r = onDelete(table, state); if (r !== undefined) return r; }
        return chain;
      },
      then(resolve) {
        const result = resultsByTable[table] || { data: [], error: null };
        resolve(chain._single ? { data: (result.data || [])[0] || null, error: result.error || null } : result);
      },
    };
    return chain;
  }

  const supabase = { from: builder };
  supabase.rpc = async (fn, params) => {
    calls.push({ op: "rpc", fn, params });
    return rpcResults[fn] || { data: null, error: { message: "rpc-unmocked" } };
  };
  supabase.auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({ data: { user: null }, error: { message: "unmocked" } }),
    mfa: {
      listFactors: async () => ({ data: { totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }),
      challenge: async () => ({ data: { id: "challenge-1" }, error: null }),
      verify: async () => ({ data: null, error: null }),
    },
  };
  return { supabase, calls };
}

/* يحمّل admin/admin.js فعليًا في سياق vm مع محاكاة كل الاعتماديات. */
function loadAdminJsSandbox({ resultsByTable = {}, rpcResults = {}, onInsert = null, onUpdate = null, onDelete = null, elementsById = {}, confirm = () => true, ctx = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults, onInsert, onUpdate, onDelete });

  const document = {
    getElementById: (id) => elementsById[id] || registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
  };

  const sessionStorage = {
    getItem: (k) => (k in storageStore ? storageStore[k] : null),
    setItem: (k, v) => { storageStore[k] = String(v); },
    removeItem: (k) => { delete storageStore[k]; },
  };

  const baseCtx = {
    console: { log: () => {}, error: (...a) => consoleErrors.push(a.join(" ")), warn: () => {} },
    document,
    sessionStorage,
    confirm,
    URL,
    URLSearchParams,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    showToast: (msg) => toasts.push(msg),
    SUBJECT_SEMESTER_LABELS: { first: "الفصل الأول", second: "الفصل الثاني", summer: "الفصل الصيفي" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  };

  const sandbox = vm.createContext(Object.assign(baseCtx, ctx));
  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });

  return { sandbox, toasts, consoleErrors, registry, calls };
}

/* يحقن الحساب عبر المسار الحقيقي بحيث يُضبط currentProfile/currentPermissions
 * داخل السياق، والقفل يُكتسب بنجاح (acquired: true) فيدخل الداشبورد. */
async function driveAuthorization(sandbox, profile, perms, { rpcResults = {} } = {}) {
  await sandbox.loadCurrentUserAuthorization({ id: profile.id, email: profile.email });
  // (القفل نجح فعلًا من داخل loadCurrentUserAuthorization عبر rpcResults.)
}

// ============================================================
// أدوات الإخراج / التحقق من الروابط
// ============================================================

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — Helpers & Dashboard Tests\n");

  await testAsync("escHtml — encodes all five HTML metacharacters", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.escHtml(`<script>&"'`), "&lt;script&gt;&amp;&quot;&#39;");
  });

  await testAsync("escHtml — plain text passes through unchanged", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.escHtml("نص عادي 123"), "نص عادي 123");
  });

  await testAsync("escHtml — null/undefined become empty string, 0 stays 0", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.escHtml(undefined), "");
    assert.strictEqual(sandbox.escHtml(null), "");
    assert.strictEqual(sandbox.escHtml(0), "0");
  });

  await testAsync("isValidResourceUrl — accepts http/https absolute URLs", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.isValidResourceUrl("https://drive.google.com/file/d/abc/view"), true);
    assert.strictEqual(sandbox.isValidResourceUrl("http://example.com/file.pdf"), true);
  });

  await testAsync("isValidResourceUrl — rejects non-http schemes and schemeless strings", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.isValidResourceUrl("ftp://example.com/x"), false);
    assert.strictEqual(sandbox.isValidResourceUrl("javascript:alert(1)"), false);
    assert.strictEqual(sandbox.isValidResourceUrl("example.com/file.pdf"), false);
    assert.strictEqual(sandbox.isValidResourceUrl("not a url at all"), false);
  });

  await testAsync("parseGoogleDriveUrl — extracts file id from /file/d/ links", async () => {
    const { sandbox } = loadAdminJsSandbox();
    const r = sandbox.parseGoogleDriveUrl("https://drive.google.com/file/d/aBc123_-/view?usp=sharing");
    assert.strictEqual(r.isFolder, false);
    assert.strictEqual(r.fileId, "aBc123_-");
  });

  await testAsync("parseGoogleDriveUrl — folder links and ?id= links", async () => {
    const { sandbox } = loadAdminJsSandbox();
    const folder = sandbox.parseGoogleDriveUrl("https://drive.google.com/drive/folders/1XYZ");
    assert.strictEqual(folder.isFolder, true);
    assert.strictEqual(folder.fileId, null);
    const idLink = sandbox.parseGoogleDriveUrl("https://drive.google.com/open?id=QwErT");
    assert.strictEqual(idLink.isFolder, false);
    assert.strictEqual(idLink.fileId, "QwErT");
  });

  await testAsync("parseGoogleDriveUrl — non-drive or invalid URLs return empty result", async () => {
    const { sandbox } = loadAdminJsSandbox();
    const a = sandbox.parseGoogleDriveUrl("https://example.com/x");
    assert.strictEqual(a.isFolder, false);
    assert.strictEqual(a.fileId, null);
    const b = sandbox.parseGoogleDriveUrl("garbage");
    assert.strictEqual(b.isFolder, false);
    assert.strictEqual(b.fileId, null);
  });

  // ============================================================
  // F-01 + F-06 — لوحة المعلومات
  // ============================================================

  await testAsync("F-01 — dashboard stats include a 'بلاغات المنتدى' card with the forum_reports count", async () => {
    const grid = makeElement("DIV");
    const recent = makeElement("UL");
    const staff = { id: "u-staff", email: "staff@afoq.test", role: "staff", active: true };
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [], error: null },
        universities: { count: 5, data: [], error: null },
        faculties: { count: 4, data: [], error: null },
        years: { count: 3, data: [], error: null },
        subjects: { count: 2, data: [], error: null },
        resources: { count: 7, data: [], error: null },
        courses: { count: 1, data: [], error: null },
        reports: { count: 2, data: [], error: null },
        forum_reports: { count: 3, data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } },
      elementsById: { "dashboard-stats": grid, "dashboard-recent": recent },
    });

    await sandbox.loadCurrentUserAuthorization({ id: staff.id, email: staff.email });
    await sandbox.loadDashboard();

    const cards = grid._children;
    assert.strictEqual(cards.length, 8, "staff (غير super_admin) يجب أن يرى 8 بطاقات: 7 أساسية + بلاغات المنتدى");
    const forumCard = cards.find((c) => c.innerHTML.includes("بلاغات المنتدى"));
    assert.ok(forumCard, "بطاقة 'بلاغات المنتدى' يجب أن تظهر في لوحة المعلومات");
    assert.ok(forumCard.innerHTML.includes(">3<"), "قيمة بطاقة بلاغات المنتدى يجب أن تكون عدد forum_reports (3)");
  });

  await testAsync("F-06 — a failing query shows '—' for its card only; other cards still render", async () => {
    const grid = makeElement("DIV");
    const recent = makeElement("UL");
    const staff = { id: "u-staff", email: "staff@afoq.test", role: "staff", active: true };
    const { sandbox, consoleErrors } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [], error: null },
        universities: { count: 5, data: [], error: null },
        faculties: { count: 4, data: [], error: null },
        years: { count: 3, data: [], error: null },
        subjects: { count: 2, data: [], error: null },
        resources: { count: 7, data: [], error: null },
        courses: { count: null, data: null, error: { message: "rpc/select failed: courses" } },
        reports: { count: 2, data: [], error: null },
        forum_reports: { count: 3, data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } },
      elementsById: { "dashboard-stats": grid, "dashboard-recent": recent },
    });

    await sandbox.loadCurrentUserAuthorization({ id: staff.id, email: staff.email });
    await sandbox.loadDashboard();

    const cards = grid._children;
    assert.strictEqual(cards.length, 8, "فشل استعلام واحد يجب ألا يُسقط بقية بطاقات لوحة المعلومات");
    const coursesCard = cards.find((c) => c.innerHTML.includes("<div class=\"stat-label\">الدورات"));
    assert.ok(coursesCard, "بطاقة الدورات يجب أن تبقى ظاهرة رغم فشل استعلامها");
    assert.ok(coursesCard.innerHTML.includes("<div class=\"stat-value\">—</div>"), "بطاقة الدورات يجب أن تعرض '—' عند فشل استعلامها");
    const uniCard = cards.find((c) => c.innerHTML.includes("<div class=\"stat-label\">الجامعات"));
    assert.ok(uniCard && uniCard.innerHTML.includes(">5<"), "بطاقة الجامعات يجب أن تعرض 5 حتى عند فشل استعلام آخر");
    assert.ok(consoleErrors.some((m) => m.includes("courses")), "فشل الاستعلام يجب أن يُسجَّل للمطوّر عبر console.error فقط");
  });

  await testAsync("F-06 — a thrown/rejected query is isolated too (never drops the whole Promise.all)", async () => {
    const grid = makeElement("DIV");
    const recent = makeElement("UL");
    const staff = { id: "u-staff", email: "staff@afoq.test", role: "staff", active: true };
    const { sandbox, consoleErrors } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [], error: null },
        universities: { count: 5, data: [], error: null },
        faculties: { count: 4, data: [], error: null },
        years: { count: 3, data: [], error: null },
        subjects: { count: 2, data: [], error: null },
        resources: { count: null, data: null, error: { message: "boom" } },
        courses: { count: 1, data: [], error: null },
        reports: { count: 2, data: [], error: null },
        forum_reports: { count: 3, data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } },
      elementsById: { "dashboard-stats": grid, "dashboard-recent": recent },
    });

    await sandbox.loadCurrentUserAuthorization({ id: staff.id, email: staff.email });
    await sandbox.loadDashboard();

    const cards = grid._children;
    assert.strictEqual(cards.length, 8, "حتى فشل resources، كل البطاقات الأخرى يجب أن تُعرض");
    const resCard = cards.find((c) => c.innerHTML.includes("<div class=\"stat-label\">الموارد"));
    assert.ok(resCard && resCard.innerHTML.includes(">—<"), "بطاقة الموارد يجب أن تعرض '—' عند فشلها");
    assert.ok(consoleErrors.some((m) => m.includes("resources")), "فشل resources يجب أن يظهر في console.error للمطوّر");
  });

  await testAsync("F-01 — as a super_admin, the admin count card is added (9 cards)", async () => {
    const grid = makeElement("DIV");
    const recent = makeElement("UL");
    const superUser = { id: "u-super", email: "super@afoq.test", role: "super_admin", active: true };
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [superUser], error: null },
        user_permissions: { data: [], error: null },
        universities: { count: 5, data: [], error: null },
        faculties: { count: 4, data: [], error: null },
        years: { count: 3, data: [], error: null },
        subjects: { count: 2, data: [], error: null },
        resources: { count: 7, data: [], error: null },
        courses: { count: 1, data: [], error: null },
        reports: { count: 2, data: [], error: null },
        forum_reports: { count: 3, data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } },
      elementsById: { "dashboard-stats": grid, "dashboard-recent": recent },
    });

    await sandbox.loadCurrentUserAuthorization({ id: superUser.id, email: superUser.email });
    await sandbox.loadDashboard();

    const cards = grid._children;
    assert.strictEqual(cards.length, 9, "super_admin يجب أن يرى 8 + بطاقة 'الإداريون' = 9 بطاقات");
    assert.ok(cards.some((c) => c.innerHTML.includes("الإداريون")), "بطاقة 'الإداريون' (count من profiles) يجب أن تظهر لـ super_admin");
    assert.ok(cards.some((c) => c.innerHTML.includes("بلاغات المنتدى")), "بطاقة بلاغات المنتدى تظهر حتى لـ super_admin");
  });

  await testAsync("Dashboard — 'آخر الموارد المضافة' shows the empty-state when there are no resources", async () => {
    const grid = makeElement("DIV");
    const recent = makeElement("UL");
    const staff = { id: "u-staff", email: "staff@afoq.test", role: "staff", active: true };
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [], error: null },
        universities: { count: 5, data: [], error: null },
        faculties: { count: 4, data: [], error: null },
        years: { count: 3, data: [], error: null },
        subjects: { count: 2, data: [], error: null },
        resources: { count: 7, data: [], error: null },
        courses: { count: 1, data: [], error: null },
        reports: { count: 2, data: [], error: null },
        forum_reports: { count: 3, data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } },
      elementsById: { "dashboard-stats": grid, "dashboard-recent": recent },
    });

    await sandbox.loadCurrentUserAuthorization({ id: staff.id, email: staff.email });
    await sandbox.loadDashboard();

    assert.strictEqual(recent.innerHTML, "<li>لا توجد موارد بعد</li>");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();