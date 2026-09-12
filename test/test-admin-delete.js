/**
 * test-admin-delete.js
 * ------------------------------------------------------------------
 * اختبارات Regression للوحة التحكم (admin/admin.js) — الجزء 3:
 * حذف الصفوف عبر deleteRow()، وتفويض الأحداث (event delegation) الجديد
 * handleAdminRowAction()/ADMIN_ROW_REFRESHERS (F-11): نفس النتائج ونفس
 * المعطيات التي كانت تُمرَّر بها أزرار onclick السابقة، مع التأكيد الفعلي
 * على عدم بقاء أي onclick في المصدر.
 *
 * التشغيل: node test/test-admin-delete.js
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

function flush() { return new Promise((r) => setImmediate(r)); }

function makeElement(tagName = "DIV") {
  const el = {
    tagName, hidden: false, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    appendChild(c) { this._children.push(c); return c; }, insertBefore(c) { this._children.unshift(c); return c; },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    classList: { _set: new Set(), add(...cs) { cs.forEach((c) => this._set.add(c)); }, remove(...cs) { cs.forEach((c) => this._set.delete(c)); }, contains(c) { return this._set.has(c); }, toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } },
  };
  Object.defineProperty(el, "textContent", { get() { return this._textContent; }, set(v) { this._textContent = v; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._innerHTML; }, set(v) { this._innerHTML = v; this._children = []; } });
  return el;
}

function makeMockSupabase({ resultsByTable = {}, rpcResults = {}, onUpdate = null, onDelete = null } = {}) {
  const calls = [];
  function builder(table) {
    const state = { table, filters: {}, op: null, payload: null };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(f, t) { calls.push({ op: "range", table, f, t }); return chain; },
      limit(n) { calls.push({ op: "limit", table, n }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(p) { calls.push({ op: "insert", table, p }); return chain; },
      update(p) { calls.push({ op: "update", table, p }); state.op = "update"; state.payload = p; return chain; },
      delete() { calls.push({ op: "delete", table }); state.op = "delete"; return chain; },
      then(resolve) {
        if (chain._single) {
          const result = resultsByTable[table] || { data: [], error: null };
          resolve({ data: (result.data || [])[0] || null, error: result.error || null });
          return;
        }
        if (state.op === "delete") { resolve({ data: null, error: onDelete ? onDelete(table, state) : null }); return; }
        if (state.op === "update") { resolve({ data: null, error: onUpdate ? onUpdate(table, state.payload, state) : null }); return; }
        resolve(resultsByTable[table] || { data: [], error: null });
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
    },
  };
  return { supabase, calls };
}

/* qsa: بديل اختياري لـ document.querySelectorAll، وفير winرgraf من
 * getElementById الإفتراضي للمهتمين بالتفويض على tbody الحقيقي. */
function loadAdminJsSandbox({ resultsByTable = {}, rpcResults = {}, onUpdate = null, onDelete = null, confirm = () => true, qsa = null } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults, onUpdate, onDelete });

  const document = {
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: () => ({}),
    querySelector: () => makeElement(),
    querySelectorAll: qsa || (() => []),
  };

  const sandbox = vm.createContext({
    console: { log: () => {}, error: (...a) => consoleErrors.push(a.join(" ")), warn: () => {} },
    document,
    sessionStorage: {
      getItem: (k) => (k in storageStore ? storageStore[k] : null),
      setItem: (k, v) => { storageStore[k] = String(v); },
      removeItem: (k) => { delete storageStore[k]; },
    },
    confirm,
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    showToast: (m) => toasts.push(m),
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, toasts, consoleErrors, calls };
}

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — Delete & Row-Action Delegation (F-11) Tests\n");

  await testAsync("F-11 source integrity — no onclick=\" remains in admin/admin.js", async () => {
    assert.ok(!adminJsSource.includes('onclick="'), "يجب ألا يبقى أي onclick في admin.js");
    assert.ok(adminJsSource.includes('data-action="'), "الأزرار تُبنى الآن بـ data-action/data-id");
    assert.ok(adminJsSource.includes("handleAdminRowAction"), "handleAdminRowAction يجب أن يكون موجودًا");
  });

  await testAsync("deleteRow — confirmed delete: calls delete().eq(id), toasts success, refreshes", async () => {
    const deleted = [];
    let refreshed = 0;
    const { sandbox, calls, toasts } = loadAdminJsSandbox({
      onDelete: (table, state) => { deleted.push({ table, id: state.filters.id }); return null; },
    });
    await sandbox.deleteRow("universities", "uni-abc", () => { refreshed++; });

    assert.deepStrictEqual(deleted, [{ table: "universities", id: "uni-abc" }]);
    assert.ok(calls.some((c) => c.op === "delete" && c.table === "universities"), "يجب أن يحدث delete على university");
    assert.strictEqual(refreshed, 1, "عند النجاح يجب إعادة تحميل القائمة عبر refreshFn");
    assert.ok(toasts.includes("تم الحذف"));
  });

  await testAsync("deleteRow — DB error: error toast, no refresh", async () => {
    let refreshed = 0;
    const { sandbox, toasts, consoleErrors } = loadAdminJsSandbox({
      onDelete: () => ({ message: "violates RLS or foreign key" }),
    });
    await sandbox.deleteRow("universities", "uni-abc", () => { refreshed++; });

    assert.strictEqual(refreshed, 0, "عند الفشل يجب ألا نحدّث القائمة");
    assert.ok(toasts.some((m) => m.includes("تعذّر الحذف")), "يجب عرض رسالة فشل الحذف");
    assert.ok(consoleErrors.length >= 1, "الخطأ يُسجَّل للمطوّر");
  });

  await testAsync("deleteRow — cancel confirmation: nothing happens", async () => {
    let refreshed = 0;
    const { sandbox, calls, toasts } = loadAdminJsSandbox({ confirm: () => false, onDelete: () => null });
    await sandbox.deleteRow("universities", "uni-abc", () => { refreshed++; });
    await flush();

    assert.strictEqual(refreshed, 0);
    assert.ok(!calls.some((c) => c.op === "delete"), "لا delete عند الإلغاء");
    assert.ok(!toasts.includes("تم الحذف"));
  });

  await testAsync("F-11 delegation — one click listener is bound to each .admin-table tbody", async () => {
    const tbodyMock = makeElement("TBODY");
    const bound = {};
    tbodyMock.addEventListener = (type, cb) => { if (type === "click") bound.click = cb; };
    const { sandbox, calls, toasts } = loadAdminJsSandbox({
      qsa: (sel) => (sel === ".admin-table tbody" ? [tbodyMock] : []),
      onDelete: () => null,
    });

    assert.strictEqual(typeof bound.click, "function", "يجب ربط معالج click واحد على كل tbody");

    const selectsBefore = calls.filter((c) => c.op === "select" && c.table === "faculties").length;
    const fakeBtn = { dataset: { table: "faculties", action: "delete", id: "fac-7" }, closest: (sel) => (sel === "button[data-action]" ? fakeBtn : null) };
    bound.click({ target: fakeBtn });
    await flush();
    await flush();

    assert.ok(calls.some((c) => c.op === "delete" && c.table === "faculties"), "الحذف الفعلي يجب أن ينفَّذ عبر النقرة المفوضة");
    assert.ok(calls.some((c) => c.op === "eq" && c.table === "faculties" && c.col === "id" && c.val === "fac-7"), "نفس المعطيات (table,id) كما كانت مع onclick");
    assert.ok(calls.filter((c) => c.op === "select" && c.table === "faculties").length > selectsBefore, "بعد الحذف تُعاد تحميل قائمة الكليات عبر refreshFn");
    assert.ok(toasts.includes("تم الحذف"));
  });

  await testAsync("handleAdminRowAction — delete universities passes (table,id) as before", async () => {
    const { sandbox, calls, toasts } = loadAdminJsSandbox({ onDelete: () => null });
    const result = sandbox.handleAdminRowAction({ dataset: { table: "universities", action: "delete", id: "uni-1" } });
    assert.ok(result && typeof result.then === "function", "delete يجب أن يُعيد الوعد لتسمح الاختبارات بالانتظار");
    await result;
    await flush();

    assert.ok(calls.some((c) => c.op === "delete" && c.table === "universities"));
    assert.ok(calls.some((c) => c.op === "eq" && c.table === "universities" && c.col === "id" && c.val === "uni-1"));
    assert.ok(toasts.includes("تم الحذف"));
  });

  await testAsync("handleAdminRowAction — course_lessons delete keeps its courseId closure for refresh", async () => {
    const { sandbox, calls } = loadAdminJsSandbox({ onDelete: () => null });
    const result = sandbox.handleAdminRowAction({ dataset: { table: "course_lessons", action: "delete", id: "l9", courseId: "c7" } });
    await result;
    await flush();

    assert.ok(calls.some((c) => c.op === "delete" && c.table === "course_lessons"), "يجب حذف الدرس من course_lessons");
    assert.ok(calls.some((c) => c.op === "eq" && c.table === "course_lessons" && c.col === "id" && c.val === "l9"));
    assert.ok(calls.some((c) => c.op === "select" && c.table === "course_lessons" && c.cols.includes("course_id")), "معيد التحميل يجب أن يعيد تحميل دروس نفس الدورة");
    assert.ok(calls.some((c) => c.op === "eq" && c.table === "course_lessons" && c.col === "course_id" && c.val === "c7"), "دروس الدورة c7 هي ما يُعاد تحميله بالضبط (نفس سلوك onclick السابق)");
  });

  await testAsync("handleAdminRowAction — edit years forwards university/faculty/number/active args (as before)", async () => {
    const { sandbox } = loadAdminJsSandbox();
    sandbox.handleAdminRowAction({
      dataset: { table: "years", action: "edit", id: "y1", universityId: "u1", facultyId: "f1", yearNumber: "3", active: "false" },
    });

    assert.strictEqual(sandbox.document.getElementById("year-edit-id").value, "y1");
    assert.strictEqual(sandbox.document.getElementById("year-university").value, "u1");
    assert.strictEqual(sandbox.document.getElementById("year-number").value, 3);
    assert.strictEqual(sandbox.document.getElementById("year-active").checked, false, "active='false' يجب أن يعني unchecked");
    assert.strictEqual(sandbox.document.getElementById("year-form-title").textContent, "تعديل سنة دراسية");
    assert.strictEqual(sandbox.document.getElementById("year-form-toggle").open, true, "فتح النموذج عبر openAdminAddForm (F-08)");
  });

  await testAsync("handleAdminRowAction — toggle-resource-hidden on reports refreshes reports; on resources it in-place reloads resources", async () => {
    const updates = [];
    const { sandbox, calls } = loadAdminJsSandbox({
      onUpdate: (table, payload, state) => { updates.push({ table, payload, id: state.filters.id }); return null; },
    });

    await sandbox.handleAdminRowAction({ dataset: { table: "reports", action: "toggle-resource-hidden", id: "res-rep", hidden: "true" } });
    await flush();
    assert.strictEqual(updates[0].table, "resources", "التبديل يستهدف جدول resources دائمًا");
    assert.strictEqual(updates[0].id, "res-rep");
    assert.strictEqual(updates[0].payload.status, "published", "إظهار مورد مُخفي = status published");
    assert.ok(calls.some((c) => c.op === "select" && c.table === "reports"), "عند التبديل من جدول البلاغات يجب إعادة تحميل البلاغات (refreshFn)");

    await sandbox.handleAdminRowAction({ dataset: { table: "resources", action: "toggle-resource-hidden", id: "res-in", hidden: "false" } });
    await flush();
    assert.strictEqual(updates[1].table, "resources");
    assert.strictEqual(updates[1].id, "res-in");
    assert.strictEqual(updates[1].payload.status, "hidden", "إخفاء مورد منشور = status hidden");
    assert.ok(calls.some((c) => c.op === "select" && c.table === "resources"), "من جدول الموارد تُعاد التحميل الفعلية عبر loadResources() داخل toggleResourceHidden (سلوك نظير لـ onclick السابق)");
  });

  await testAsync("handleAdminRowAction — edit lesson loads the seeded lesson fields (same as onclick)", async () => {
    const lesson = { id: "l1", course_id: "c7", title: "درس 1", content_type: "video_url", content_url: "https://x.test/1", content_text: null, duration_minutes: 10, sort_order: 1, status: "draft" };
    const { sandbox } = loadAdminJsSandbox({ resultsByTable: { course_lessons: { data: [lesson], error: null } } });
    await sandbox.loadCourseLessons("c7");

    sandbox.handleAdminRowAction({ dataset: { table: "course_lessons", action: "edit", id: "l1" } });

    assert.strictEqual(sandbox.document.getElementById("lesson-edit-id").value, "l1");
    assert.strictEqual(sandbox.document.getElementById("lesson-title").value, "درس 1");
    assert.strictEqual(sandbox.document.getElementById("lesson-content-type").value, "video_url");
    assert.strictEqual(sandbox.document.getElementById("lesson-content-url").value, "https://x.test/1");
    assert.strictEqual(sandbox.document.getElementById("lesson-status").value, "draft");
    assert.strictEqual(sandbox.document.getElementById("lesson-form-toggle").open, true);
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();