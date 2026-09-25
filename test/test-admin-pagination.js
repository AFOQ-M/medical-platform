/**
 * test-admin-pagination.js
 * ------------------------------------------------------------------
 * اختبارات NEW-06 — ترقيم لوحة الأدمن داخل admin/admin.js: استبدال السقف
 * الصامت `.limit(1000)` في loadResources وloadSubjects بنمط جلب كامل عبر
 * `range()` بدفعات (100) مشابه لـ NEW-04، دون أي UI ترقيم جديد. فلاتر
 * admin (بحث/نوع/حالة) تبقى محلية على cache المجمَّعة.
 *
 * شروط القبول من الـspec:
 *   - loadResources / loadSubjects يجمعان عبر range() حتى تكتمل الأفواج؛
 *   - test/test-admin-pagination.js يتحقق من تسلسل range واكتمال الـcache؛
 *   - مجموعات admin السابقة تبقى خضراء (تُشغَّل يدويًا بعد هذا الملف).
 *
 * التشغيل: node test/test-admin-pagination.js
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

function makeElement(tagName = "DIV", doc) {
  const el = {
    tagName, hidden: false, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "", type: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    removeEventListener(t, cb) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== cb); },
    appendChild(c) { this._children.push(c); return c; },
    append(...els) { els.forEach((e) => this._children.push(e)); },
    insertBefore(c) { this._children.unshift(c); return c; },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {},
    focus() { if (doc) doc._setActive(this); },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    classList: {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); }, remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      contains(c) { return this._set.has(c); }, toggle(c) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); },
    },
  };
  Object.defineProperty(el, "textContent", { get() { return this._textContent; }, set(v) { this._textContent = String(v); } });
  Object.defineProperty(el, "innerHTML", { get() { return this._innerHTML; }, set(v) { this._innerHTML = String(v); this._children = []; } });
  Object.defineProperty(el, "children", { get() { return this._children; } });
  return el;
}

/* Supabase وهمي يقطّع pool حقيقيًا حسب range، مع تسجيل كل استدعاءات
 * range/order/limit في الصف نفسه (نفس مذاق admin-drawers لكن بوعي للترقيم). */
function makeAdminPagedSupabase({ resourceCount = 0, subjectCount = 0 } = {}) {
  const calls = [];
  const resourcesPool = Array.from({ length: resourceCount }, (_, i) => ({
    id: "res-" + i,
    title: "مورد رقم " + i,
    type: "book",
    language: "ar",
    file_url: "https://x.test/" + i,
    storage_provider: "google_drive",
    source_type: "official",
    status: "published",
    keywords: "ك",
    subject_id: "subj-" + (i % 3),
    verified: true,
    view_count: 0,
    subjects: {
      id: "subj-" + (i % 3),
      name: "مادة " + (i % 3),
      year_id: "y1",
      years: {
        id: "y1", university_id: "u1", faculty_id: "f1", year_number: 1,
        universities: { name: "جامعة 1" },
        faculties: { name: "كلية 1" },
      },
    },
  }));
  const subjectsPool = Array.from({ length: subjectCount }, (_, i) => ({
    id: "subj-" + i, name: "مادة " + i, code: "c" + i, semester: "first", year_id: "y1", is_active: true,
    years: { year_number: 1, university_id: "u1", faculty_id: "f1", universities: { name: "جامعة 1" }, faculties: { name: "كلية 1" } },
  }));

  function builder(table) {
    const state = { table, filters: {}, order: null, range: null, single: false };
    const chain = {
      select(cols) { state.cols = cols; return chain; },
      eq(c, v) { state.filters[c] = v; return chain; },
      order(c, o) { state.order = { col: c, opts: o }; return chain; },
      range(f, t) { state.range = [f, t]; return chain; },
      limit(n) { calls.push({ table, phase: "limit", n }); return chain; },
      maybeSingle() { state.single = true; return chain; },
      single() { state.single = true; return chain; },
      insert() { return chain; }, update() { return chain; }, delete() { return chain; },
      then(resolve) {
        if (state.range !== null) {
          const pool = table === "resources" ? resourcesPool : subjectsPool;
          const slice = pool.slice(state.range[0], state.range[1] + 1);
          calls.push({ table, phase: "range", from: state.range[0], to: state.range[1], order: state.order, filters: { ...state.filters } });
          resolve({ data: slice, error: null });
          return;
        }
        if (state.single) resolve({ data: null, error: null }); else resolve({ data: [], error: null });
      },
    };
    return chain;
  }
  const supabase = { from: builder };
  supabase.rpc = async (fn, params) => { calls.push({ op: "rpc", fn, params }); return { data: null, error: null }; };
  supabase.auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({ data: { user: null }, error: null }),
    mfa: {
      listFactors: async () => ({ data: { totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }),
      challenge: async () => ({ data: { id: "c" }, error: null }),
      verify: async () => ({ data: null, error: null }),
      unenroll: async () => ({ data: { id: "f" }, error: null }),
    },
  };
  return { supabase, calls };
}

function makeAdminSandbox(supabase) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const document = {
    body: { appendChild() {} },
    getElementById: (id) => registry[id] || (registry[id] = makeElement("DIV", document)),
    createElement: (tag) => makeElement((tag || "DIV").toUpperCase(), document),
    createTextNode: () => ({}),
    querySelector(sel) {
      const m = sel.match(/^#(\S+)\s+tbody$/);
      if (m) return registry[m[1] + "-tbody"] || (registry[m[1] + "-tbody"] = makeElement("TBODY", document));
      const btnM = sel.match(/^\[data-drawer-open="([^"]+)"\]$/);
      if (btnM) return registry[btnM[1] + "-toggle"] || null;
      return null;
    },
    querySelectorAll: () => [],
    contains: () => true,
    get activeElement() { return registry["res-filter-search"] || null; },
  };
  const sandbox = vm.createContext({
    console: { log: () => {}, error: (...a) => consoleErrors.push(a.join(" ")), warn: () => {} },
    document,
    sessionStorage: { getItem: (k) => (k in storageStore ? storageStore[k] : null), setItem: (k, v) => { storageStore[k] = String(v); }, removeItem: (k) => { delete storageStore[k]; } },
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    showToast: (m) => toasts.push(m),
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  });
  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, toasts, consoleErrors, registry, document };
}

async function runInSandbox(sandbox, code) {
  return vm.runInContext(code, sandbox);
}

(async () => {
  console.log("AFOQ Admin Pagination (NEW-06) Tests\n");

  await testAsync("loadResources — 250 موردًا تُجمع بالكامل عبر دفعات range() تسلسلية", async () => {
    const { supabase, calls } = makeAdminPagedSupabase({ resourceCount: 250 });
    const { sandbox } = makeAdminSandbox(supabase);
    await runInSandbox(sandbox, "loadResources()");
    const cache = await runInSandbox(sandbox, "resourcesCache");
    assert.strictEqual(cache.length, 250, "الكاش الكامل بلا سقف 1000");
    const ranges = calls.filter((c) => c.phase === "range" && c.table === "resources");
    assert.deepStrictEqual(ranges.map((c) => [c.from, c.to]), [[0, 99], [100, 199], [200, 299]], "تسلسل range 0-99 ثم 100-199 ثم 200-299");
    assert.strictEqual(cache.map((r) => r.id).join("|"), Array.from({ length: 250 }, (_, i) => "res-" + i).join("|"), "لا فقدان ولا إعادة ترتيب");
  });

  await testAsync("loadResources — الترتيب created_at desc محفوظ عبر الدفعات", async () => {
    const { supabase, calls } = makeAdminPagedSupabase({ resourceCount: 250 });
    const { sandbox } = makeAdminSandbox(supabase);
    await runInSandbox(sandbox, "loadResources()");
    const orderCalls = calls.filter((c) => c.phase === "range" && c.table === "resources");
    assert.ok(orderCalls.every((c) => c.order && c.order.col === "created_at" && c.order.opts.ascending === false), "كل دفعة بنفس order created_at desc");
  });

  await testAsync("loadSubjects — 120 مادة تُجمع بالكامل عبر range()", async () => {
    const { supabase, calls } = makeAdminPagedSupabase({ subjectCount: 120 });
    const { sandbox } = makeAdminSandbox(supabase);
    await runInSandbox(sandbox, "loadSubjects()");
    const cache = await runInSandbox(sandbox, "subjectsCache");
    assert.strictEqual(cache.length, 120, "كاش المواد كامل");
    const ranges = calls.filter((c) => c.phase === "range" && c.table === "subjects");
    assert.deepStrictEqual(ranges.map((c) => [c.from, c.to]), [[0, 99], [100, 199]], "مادتان: 0-99 ثم 100-199");
  });

  await testAsync("لا أي .limit(1000) في مسارات الجداول (لا سقف صامت)", async () => {
    assert.ok(!/.limit\(1000\)/.test(adminJsSource), "admin.js لا يحوي .limit(1000) بعد NEW-06");
    assert.ok(adminJsSource.includes("function loadAdminTableChunked"), "دالة الجلب المجزأ موجودة");
    assert.ok(adminJsSource.includes("loadAdminTableChunked"), "loadResources/loadSubjects تستخدمانها");
  });

  await testAsync("source integrity — لا UI ترقيم جديد في admin (لا pagination markup)", async () => {
    assert.ok(!adminJsSource.includes('id="pagination"'), "لا pagination UI في admin.js");
    assert.ok(adminJsSource.includes(".range("), "النمط يستخدم .range()");
    assert.ok(adminJsSource.includes("ADMIN_TABLE_CHUNK_SIZE"), "حجم الدفعة معرّف واستُخدم");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();