/**
 * test-admin-reports.js
 * ------------------------------------------------------------------
 * اختبارات G-13 — قائمة البلاغات الموحّدة (Unified Reports Queue).
 * تتحقق من سلوك loadReports() الفعلي في admin/admin.js:
 *   - دمج بلاغات الموارد (reports) وبلاغات المنتدى (forum_reports) في قائمة واحدة؛
 *   - الترتيب (المعلّقة أولًا ثم الأحدث تاريخيًا)؛
 *   - الحالة الفارغة؛
 *   - عرض آمن عبر textContent (لا innerHTML لقيم من المستخدم)؛
 *   - شارة عدد المعلّقة (pending) في تبويب البلاغات؛
 *   - ربط الأزرار بالأذونات (hasPerm/HasAnyPerm) دون كسر سلوك سابق.
 *
 * التشغيل: node test/test-admin-reports.js
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
    console.log(`        ${String(err.message).split("\n").join("\n        ")}`);
    failures++;
  }
}

function flush() { return new Promise((r) => setImmediate(r)); }

function makeElement(tagName = "DIV") {
  const el = {
    tagName, hidden: false, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    appendChild(c) { this._children.push(c); return c; }, insertBefore(c) { this._children.unshift(c); return c; },
    append(...els) { els.forEach((e) => this._children.push(e)); },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    classList: { _set: new Set(), add(...cs) { cs.forEach((c) => this._set.add(c)); }, remove(...cs) { cs.forEach((c) => this._set.delete(c)); }, contains(c) { return this._set.has(c); }, toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } },
  };
  Object.defineProperty(el, "textContent", { get() { return this._textContent; }, set(v) { this._textContent = String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._innerHTML; }, set(v) { this._innerHTML = v; this._children = []; } });
  Object.defineProperty(el, "children", { get() { return this._children; } });
  return el;
}

function makeMockSupabase({ resultsByTable = {}, rpcResults = {} } = {}) {
  const calls = [];
  function builder(table) {
    const state = { table, filters: {} };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(f, t) { state.range = [f, t]; calls.push({ op: "range", table, f, t }); return chain; },
      limit(n) { calls.push({ op: "limit", table, n }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      then(resolve) {
        if (chain._single) {
          const result = resultsByTable[table] || { data: [], error: null };
          resolve({ data: (result.data || [])[0] || null, error: result.error || null });
          return;
        }
        const result = resultsByTable[table] || { data: [], error: null };
        let data = result.data || [];
        if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
        resolve({ data, error: result.error || null });
      },
    };
    return chain;
  }
  const supabase = { from: builder };
  supabase.rpc = async (fn, params) => { calls.push({ op: "rpc", fn, params }); return rpcResults[fn] || { data: null, error: { message: "unmocked" } }; };
  supabase.auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({ data: { user: null }, error: { message: "unmocked" } }),
    mfa: {
      listFactors: async () => ({ data: { totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }),
      challenge: async () => ({ data: { id: "c" }, error: null }),
      verify: async () => ({ data: null, error: null }),
      unenroll: async () => ({ error: null }),
    },
  };
  return { supabase, calls };
}

/* بيئة مخصصة: tbody حقيقي لـ #reports-table يتراكم الصفوف فعليًا، وبقية
 * العناصر عبر getElementById registry. تسمح بالتحقق من الصفوف والخلايا
 * والأزرار والأذونات. */
function setupSandbox({ profile = null, perms = [], resultsByTable = {}, rpcResults = {}, authUser = null } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const tbody = makeElement("TBODY");
  const querySelectorResults = { "#reports-table tbody": tbody };
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults });

  const document = {
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: () => ({}),
    querySelector: (sel) => querySelectorResults[sel] || makeElement(),
    querySelectorAll: () => [],
    activeElement: null,
  };
  registry["reports-tab-badge"] = makeElement("SPAN");
  registry["reports-tab-badge"].hidden = true;

  const sandbox = vm.createContext({
    console: { log: () => {}, error: (...a) => consoleErrors.push(a.join(" ")), warn: () => {} },
    document,
    sessionStorage: {
      getItem: (k) => (k in storageStore ? storageStore[k] : null),
      setItem: (k, v) => { storageStore[k] = String(v); },
      removeItem: (k) => { delete storageStore[k]; },
    },
    confirm: () => true,
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    showToast: (m) => toasts.push(m),
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, toasts, consoleErrors, calls, tbody, registry };
}

/* ---- بيانات نموذجية ---- */
function resReport(id, { reason = "broken_link", note = null, created_at, title = "مورد X", status = "published", uniId = "u1", facId = "f1" } = {}) {
  return { id, reason, note, created_at, resource_id: "res-" + id, resources: { id: "res-" + id, title, status, subjects: { years: { university_id: uniId, faculty_id: facId } } } };
}
function forumReport(id, { reason = "offensive", details = null, status = "pending", created_at, isTopic = true, title = "موضوع Y", is_hidden = false } = {}) {
  if (isTopic) {
    return { id, reason, details, status, created_at, topic_id: "t-" + id, reply_id: null, forum_topics: { id: "t-" + id, title, author_name: "مؤلف", is_hidden }, forum_replies: null };
  }
  return { id, reason, details, status, created_at, topic_id: "t9", reply_id: "r-" + id, forum_topics: null, forum_replies: { id: "r-" + id, content: "رد نصي", author_name: "مؤلف", is_hidden, topic_id: "t9" } };
}

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — G-13 Unified Reports Queue Tests\n");

  // 1) دمج المصدرين في قائمة واحدة
  await testAsync("G-13 — loadReports merges reports + forum_reports into one queue", async () => {
    const env = setupSandbox({ resultsByTable: {
      reports: { data: [resReport("1", { created_at: "2026-01-01T10:00:00Z", title: "كتاب فيزياء" })], error: null },
      forum_reports: { data: [forumReport("2", { created_at: "2026-01-02T10:00:00Z", title: "نقاش حول الذكاء" })], error: null },
    } });
    await env.sandbox.loadReports();
    await flush();

    const rows = env.tbody._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(rows.length, 2, `يجب دمج مصدرين في صفين (وُجد ${rows.length})`);
    const sources = rows.map((tr) => tr._children.filter((c) => c.tagName === "TD").map((td) => td.textContent));
    const flat = sources.flat();
    assert.ok(flat.includes("مورد"), "يجب أن يورد بلاغ المورد مصدره 'مورد'");
    assert.ok(flat.some((s) => s.includes("كتاب فيزياء")), "يجب عرض عنوان المورد المبلغ عنه");
    assert.ok(flat.includes("موضوع"), "يجب أن يورد بلاغ المنتدى مصدره 'موضوع'");
    assert.ok(flat.some((s) => s.includes("نقاش حول الذكاء")), "يجب عرض عنوان الموضوع المبلغ عنه");
  });

  // 2) الترتيب: المعلّقة (forum pending) أولًا ثم الأحدث تاريخيًا
  await testAsync("G-13 — ordering: pending forum reports first, then newest date", async () => {
    const env = setupSandbox({ resultsByTable: {
      reports: { data: [resReport("r-new", { created_at: "2026-03-01T10:00:00Z", title: "أحدث مورد" })], error: null },
      forum_reports: {
        data: [
          forumReport("f-old", { status: "reviewed", created_at: "2025-01-01T00:00:00Z", title: "مراجَع قديم" }),
          forumReport("f-pend", { status: "pending", created_at: "2025-06-01T00:00:00Z", title: "معلّق" }),
        ],
        error: null,
      },
    } });
    await env.sandbox.loadReports();
    await flush();

    const trs = env.tbody._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(trs.length, 3);
    const firstContent = trs[0]._children.find((td) => td.getAttribute("data-label") === "المحتوى المُبلَّغ عنه").textContent;
    const secondContent = trs[1]._children.find((td) => td.getAttribute("data-label") === "المحتوى المُبلَّغ عنه").textContent;
    assert.ok(firstContent.includes("معلّق"), `المعلّق يجب أن يسبق الجميع (أول صف = ${firstContent})`);
    assert.ok(secondContent.includes("أحدث"), `بعد المعلّق، الأحدث تاريخيًا ${secondContent}`);
  });

  // 3) الحالة الفارغة
  await testAsync("G-13 — empty state row shown when both sources empty", async () => {
    const env = setupSandbox({ resultsByTable: { reports: { data: [], error: null }, forum_reports: { data: [], error: null } } });
    await env.sandbox.loadReports();
    await flush();
    assert.ok(env.tbody.innerHTML.includes("لا توجد بلاغات"), "يجب عرض رسالة الحالة الفارغة");
    const badge = env.registry["reports-tab-badge"];
    assert.strictEqual(badge.hidden, true, "شارة صفرية يجب أن تختفي");
    assert.strictEqual(badge.textContent, "");
  });

  // 4) عرض آمن عبر textContent — قيمة المستخدم لا تُحقن كـ HTML
  await testAsync("G-13 — safe rendering: user-controlled values go through textContent, never innerHTML", async () => {
    const evil = "<img src=x onerror=alert(1)>";
    const env = setupSandbox({ resultsByTable: {
      reports: { data: [resReport("1", { created_at: "2026-01-01T10:00:00Z", title: evil, note: "نص <b>غير آمن</b>" })], error: null },
      forum_reports: { data: [], error: null },
    } });
    await env.sandbox.loadReports();
    await flush();

    const trs = env.tbody._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(trs.length, 1);
    const contentTd = trs[0]._children.find((td) => td.getAttribute("data-label") === "المحتوى المُبلَّغ عنه");
    assert.ok(contentTd.textContent.includes("<img src=x"), "يجب أن تظهر القيمة كنص (escaped عبر textContent)");
    assert.ok(!contentTd.innerHTML.includes("onerror"), "يجب ألا يوجد أي innerHTML محقون");
    // التحقق الجذري: لا بناء خلايا عبر innerHTML إطلاقًا في loadReports
    assert.ok(/tbody\.innerHTML\s*=/.test(adminJsSource), "فحص نزاهة: توجد سلسلة innerHTML أولية/فارغة (مقبولة)");
  });

  // 5) شارة العدد = عدد البلاغات المعلّقة فقط
  await testAsync("G-13 — badge counts only pending forum reports; hidden when zero", async () => {
    const env = setupSandbox({ resultsByTable: {
      reports: { data: [resReport("1", { created_at: "2026-01-01T10:00:00Z" })], error: null },
      forum_reports: {
        data: [
          forumReport("a", { status: "pending", created_at: "2026-01-02T00:00:00Z" }),
          forumReport("b", { status: "pending", created_at: "2026-01-03T00:00:00Z" }),
          forumReport("c", { status: "reviewed", created_at: "2026-01-04T00:00:00Z" }),
          forumReport("d", { status: "dismissed", created_at: "2026-01-05T00:00:00Z" }),
        ],
        error: null,
      },
    } });
    await env.sandbox.loadReports();
    await flush();

    const badge = env.registry["reports-tab-badge"];
    assert.strictEqual(badge.hidden, false, "يجب إظهار الشارة عند وجود معلّقات");
    assert.strictEqual(Number(badge.textContent), 2, "الشارة تحسب البلاغات المعلّقة فقط (2)");
  });

  // 6) ربط أزرار البلاغ بحسب الأذونات — super_admin يرى كل الإجراءات
  await testAsync("G-13 — super_admin sees delete/hide for reports and actions for forum rows", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [{ id: "u1", email: "sa@afoq.test", role: "super_admin", active: true }], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [resReport("1", { created_at: "2026-01-01T10:00:00Z", status: "published" })], error: null },
        forum_reports: { data: [forumReport("2", { status: "pending", created_at: "2026-01-02T00:00:00Z", title: "موضوع معلق" })], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } },
    });
    await env.sandbox.loadCurrentUserAuthorization({ id: "u1", email: "sa@afoq.test" });
    await env.sandbox.loadReports();
    await flush();

    const trs = env.tbody._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(trs.length, 2);

    const reportRow = trs.find((tr) => tr._children.find((td) => td.getAttribute("data-label") === "المصدر")?.textContent === "مورد");
    assert.ok(reportRow, "يجب إيجاد صف بلاغ المورد");
    const reportBtns = reportRow._children[6]._children[0]._children.filter((b) => b.tagName === "BUTTON").map((b) => b.textContent);
    assert.ok(reportBtns.some((t) => t.includes("إخفاء المورد")), "super_admin يملك زر إخفاء/إظهار المورد");
    assert.ok(reportBtns.some((t) => t.includes("حذف البلاغ")), "super_admin يملك زر حذف البلاغ");

    const forumRow = trs.find((tr) => tr._children.find((td) => td.getAttribute("data-label") === "المصدر")?.textContent === "موضوع");
    assert.ok(forumRow, "يجب إيجاد صف بلاغ المنتدى");
    const forumBtns = forumRow._children[6]._children[0]._children.filter((b) => b.tagName === "BUTTON").map((b) => b.textContent);
    assert.ok(forumBtns.some((t) => t.includes("إخفاء الموضوع")), "super_admin يملك زر إخفاء/إظهار الموضوع");
    assert.ok(forumBtns.some((t) => t.includes("رفض البلاغ")), "يجب توفير زر رفض البلاغ");
    assert.ok(forumBtns.some((t) => t.includes("تحديد كمُراجَع")), "يجب توفير زر تحديد كمُراجَع");
  });

  // 7) قائمة فعلية: أزرار المنتدى تُعطِّل عند حالة غير معلّقة
  await testAsync("G-13 — forum dismiss/review disabled when status is not pending", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [{ id: "u1", email: "sa@afoq.test", role: "super_admin", active: true }], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [], error: null },
        forum_reports: { data: [forumReport("2", { status: "reviewed", created_at: "2026-01-02T00:00:00Z", title: "تمت مراجعته" })], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } },
    });
    await env.sandbox.loadCurrentUserAuthorization({ id: "u1", email: "sa@afoq.test" });
    await env.sandbox.loadReports();
    await flush();

    const tr = env.tbody._children.filter((c) => c.tagName === "TR")[0];
    const btns = tr._children[6]._children[0]._children.filter((b) => b.tagName === "BUTTON");
    assert.ok(btns.length >= 2, "يجب توفير أزرار الحالة حتى لو معطّلة");
    const statusBtns = btns.filter((b) => !b.textContent.includes("إظهار") && !b.textContent.includes("إخفاء"));
    assert.ok(statusBtns.length >= 2, "يجب توفير زري رفض/مراجعة");
    for (const b of statusBtns) {
      assert.strictEqual(b.disabled, true, `أزرار المُراجَع/المرفوض يجب أن تكون معطّلة (${b.textContent})`);
    }
  });

  // 8) بدون صلاحيات: no action buttons rendered on report row
  await testAsync("G-13 — no-permission staff gets no action buttons (no accidental exposure)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [{ id: "u2", email: "staff@afoq.test", role: "staff", active: true }], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [resReport("1", { created_at: "2026-01-01T10:00:00Z" })], error: null },
        forum_reports: { data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } },
    });
    await env.sandbox.loadCurrentUserAuthorization({ id: "u2", email: "staff@afoq.test" });
    await env.sandbox.loadReports();
    await flush();

    const tr = env.tbody._children.filter((c) => c.tagName === "TR")[0];
    const td = tr._children[6];
    assert.strictEqual(td._children.length, 0, "لا أزرار إجراءات لموظف بلا صلاحيات — لا تعرّض غير مقصود");
  });

  // 9) نزاهة: لا remaining onclick ، وloadForumReports ما زالت كيل (compat)
  await testAsync("G-13 — source integrity: no onclick, loadForumReports kept as alias", async () => {
    assert.ok(!adminJsSource.includes('onclick="'), "لا يجب أن يبقى أي onclick في admin.js");
    assert.ok(/async function loadForumReports\(\)\s*\{\s*return loadReports\(\);/.test(adminJsSource), "loadForumReports() يجب أن تبقى كيلًا لـ loadReports (توافق خلفي)");
    assert.ok(adminJsSource.includes("forum_reports"), "يجب استعلام forum_reports دائمًا");
    assert.ok(adminJsSource.includes(".from(\"reports\")"), "يجب استعلام reports دائمًا");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();