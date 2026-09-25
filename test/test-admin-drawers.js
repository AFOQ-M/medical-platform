/**
 * test-admin-drawers.js
 * ------------------------------------------------------------------
 * اختبارات G-14 — نافذة السحب (Drawer) لنماذج "المورد" و"الدورة".
 * نطاق G-14 الحُصري: النموذجان الطويلان فقط (Resource + Course)
 * يفتحان داخل Drawer منزلق (slide-over). الكيانات البسيطة
 * (جامعة/كلية/سنة/مادة/درس) تبقى <details> قابلة للطيّ ولا تتحول
 * إلى Drawer.
 *
 * تتحقق من:
 *   - النطاق الحصري (drawer-لمورد/دورة فقط، <details> للباقي)؛
 *   - سيمانتيك الحوار (role=dialog, aria-modal, labelled, backdrop, close)؛
 *   - open/close (class open، hidden، aria-hidden، استعادة تركيز)؛
 *   - يفخّ التركيز: Tab يلف من آخر إلى أول، Shift+Tab من أول إلى آخر؛
 *   - Escape يغلق؛ النقر على الـbackdrop يغلق؛ زر الإغلاق الصريح يغلق؛
 *   - الحفظ الناجح يغلق الـdrawer (مورد/دورة)؛
 *   - إلغاء/إعادة الضبط يغلق الـdrawer؛
 *   - فتح التعديل (editResource) عبر الـdrawer.
 *
 * التشغيل: node test/test-admin-drawers.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ADMIN_JS_PATH = path.join(__dirname, "..", "admin", "admin.js");
const ADMIN_HTML_PATH = path.join(__dirname, "..", "admin", "index.html");
const adminJsSource = fs.readFileSync(ADMIN_JS_PATH, "utf-8");
const adminHtmlSource = fs.readFileSync(ADMIN_HTML_PATH, "utf-8");

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

/* عنصر عام يشبه DOM حقيقيًا بقدر ما تحتاجه اختبارات الـdrawer:
 * getAttribute/setAttribute، classList، dataset، hidden، open،
 * addEventListener، appendChild، innerHTML/textContent، options. */
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
  Object.defineProperty(el, "innerHTML", { get() { return this._innerHTML; }, set(v) { this._innerHTML = String(v); this._children = []; if (this.tagName === "SELECT" && v === "") this.options = []; } });
  Object.defineProperty(el, "children", { get() { return this._children; } });
  return el;
}

/* بناء overlay بصمامه نظير admin/index.html: overlay يحوي backdrop و
 * aside.admin-drawer الذي بدوره يحوي focusables (أزرار/حقول). */
function makeDrawerOverlay(id, focusables, doc) {
  const overlay = makeElement("DIV", doc);
  overlay.id = id;
  overlay.hidden = true;
  overlay.className = "admin-drawer-overlay";
  overlay._attrs = { role: "dialog", "aria-modal": "true", "aria-labelledby": id + "-title" };
  const backdrop = makeElement("DIV", doc);
  backdrop.className = "admin-drawer-backdrop";
  backdrop.dataset.drawerClose = id;
  const aside = makeElement("ASIDE", doc);
  aside.className = "admin-drawer";
  const closeBtn = makeElement("BUTTON", doc);
  closeBtn.className = "admin-drawer-close";
  closeBtn.dataset.drawerClose = id;
  closeBtn.setAttribute("aria-label", "إغلاق");
  aside._children = focusables.slice();
  overlay._children = [backdrop, aside];
  overlay.querySelectorAll = (sel) => {
    if (sel === "aside.admin-drawer") return [aside];
    if (sel.startsWith("a[href], button")) return Array.from(aside._children);
    if (sel === "button, input, select, textarea, a[href]") return Array.from(aside._children);
    return [];
  };
  overlay.querySelector = (sel) => {
    if (sel === "aside.admin-drawer") return aside;
    if (sel === "button, input, select, textarea, a[href]") return aside._children[0] || null;
    return null;
  };
  aside.querySelector = (sel) => {
    if (sel === "button, input, select, textarea, a[href]") return aside._children[0] || null;
    return null;
  };
  overlay._aside = aside;
  overlay._backdrop = backdrop;
  overlay._closeBtn = closeBtn;
  return overlay;
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
      limit() { calls.push({ op: "limit", table }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(p) { calls.push({ op: "insert", table, p }); return chain; },
      update(p) { calls.push({ op: "update", table, p }); return chain; },
      then(resolve) {
        if (chain._single) {
          const r = resultsByTable[table] || { data: [], error: null };
          resolve({ data: (r.data || [])[0] || null, error: r.error || null });
          return;
        }
        const r = resultsByTable[table] || { data: [], error: null };
        let data = r.data || [];
        if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
        resolve({ data, error: r.error || null });
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

function setupDrawerSandbox({ focusables = [], resultsByTable = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const state = { active: null };
  const { supabase, calls } = makeMockSupabase({ resultsByTable });

  const document = {
    _active: null,
    _setActive(el) { this._active = el; state.active = el; },
    get activeElement() { return this._active; },
    getElementById: (id) => registry[id] || (registry[id] = makeElement("DIV", document)),
    createElement: (tag) => makeElement(tag.toUpperCase(), document),
    createTextNode: () => ({}),
    querySelector(sel) {
      const m = sel.match(/^\[data-drawer-open="([^"]+)"\]$/);
      if (m) return registry[m[1] + "-toggle"] || null;
      const tbodyM = sel.match(/^#(\S+)\s+tbody$/);
      if (tbodyM) return registry[tbodyM[1] + "-tbody"] || (registry[tbodyM[1] + "-tbody"] = makeElement("TBODY", document));
      return null;
    },
    querySelectorAll(sel) {
      if (sel === "[data-drawer-open]") {
        return ["res", "course"].map((k) => registry[k + "-toggle"]);
      }
      if (sel === "[data-drawer-close]") {
        return ["res", "course"].map((k) => registry[k + "-form-drawer"]._backdrop).concat(["res", "course"].map((k) => registry[k + "-form-drawer"]._closeBtn));
      }
      if (sel === ".admin-table tbody") return [];
      return [];
    },
  };

  // النمذجة المطابقة لـ admin/index.html: trigger = زر بمعرّف "res-form-toggle"
  focusables.forEach((f) => {
    f.focus = function () { document._setActive(this); };
  });
  ["res", "course"].forEach((k) => {
    const drawerId = k + "-form-drawer";
    const overlay = makeDrawerOverlay(drawerId, focusables, document);
    registry[drawerId] = overlay;
    const trigger = makeElement("BUTTON", document);
    trigger.className = "admin-drawer-trigger";
    trigger.id = k + "-form-toggle";
    trigger.dataset.drawerOpen = drawerId;
    registry[k + "-toggle"] = trigger;
    registry[drawerId + "-toggle"] = trigger;
  });
  // مرجع إضافي بالمعرّفات الحقيقية المستخدمة في admin.js
  registry["res-form-toggle"] = registry["res-toggle"];
  registry["course-form-toggle"] = registry["course-toggle"];
  // عناصر لوحة التحكم الأساسية (escHtml/form 등을 لصقها عند الطلب)
  registry["res-form-drawer-title"] = null;

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
  return { sandbox, toasts, consoleErrors, calls, registry, document, state };
}

(async () => {
  console.log("AFOQ Admin — G-14 Resource/Course Drawers Tests\n");

  // ====== النطاق الحصري (Scope) ======
  await testAsync("G-14 scope — Resource + Course use drawers; short entities stay <details>", async () => {
    for (const id of ["res-form-toggle", "course-form-toggle"]) {
      assert.ok(adminHtmlSource.includes(`data-drawer-open="${id.replace("-toggle", "-drawer")}"`), `${id} يجب أن يكون محفّزًا لفتح drawer`);
    }
    for (const id of ["uni-form-toggle", "fac-form-toggle", "year-form-toggle", "subj-form-toggle", "lesson-form-toggle"]) {
      assert.ok(adminHtmlSource.includes(`<details class="admin-form-toggle" id="${id}"`), `${id} يجب أن يبقى <details>`);
      assert.ok(!new RegExp(`id="${id}"[^>]*data-drawer-open`).test(adminHtmlSource), `${id} يجب ألا يحمل data-drawer-open`);
    }
    assert.ok(adminHtmlSource.includes('id="res-form-drawer"'), "يجب وجود drawer المورد");
    assert.ok(adminHtmlSource.includes('id="course-form-drawer"'), "يجب وجود drawer الدورة");
    for (const id of ["uni-form-drawer", "fac-form-drawer", "year-form-drawer", "subj-form-drawer", "lesson-form-drawer"]) {
      assert.ok(!adminHtmlSource.includes(`id="${id}"`), `${id} يجب ألا يوجد`);
    }
  });

  await testAsync("G-14 dialog semantics — role=dialog, aria-modal, labelled, close buttons, backdrop", async () => {
    for (const id of ["res-form-drawer", "course-form-drawer"]) {
      const titleId = id.replace("-drawer", "-title");
      assert.ok(adminHtmlSource.includes(`role="dialog" aria-modal="true" aria-labelledby="${titleId}"`), `${id}: role/aria-modal/labelled`);
      assert.ok(adminHtmlSource.includes(`class="admin-drawer-backdrop" data-drawer-close="${id}"`), `${id}: backdrop يغلق`);
      assert.ok(adminHtmlSource.includes(`class="admin-drawer-close" data-drawer-close="${id}"`), `${id}: زر إغلاق صريح`);
    }
  });

  // ====== open / close ======
  await testAsync("G-14 — openAdminDrawer adds .open class, unhides, sets aria-hidden=false, binds keydown", async () => {
    const { sandbox, registry } = setupDrawerSandbox({ focusables: [makeElement("BUTTON"), makeElement("INPUT")] });
    sandbox.openAdminDrawer("res-form-drawer");
    const ov = registry["res-form-drawer"];
    assert.ok(ov.classList.contains("open"), "يجب إضافة class open (الـCSS يعتمد عليه للإظهار)");
    assert.strictEqual(ov.hidden, false, "يجب إزالة hidden");
    assert.strictEqual(ov._attrs["aria-hidden"], "false");
    assert.strictEqual(ov.dataset.drawerId, "res-form-drawer");
    assert.ok(ov._listeners.keydown && ov._listeners.keydown.length >= 1, "يجب ربط معالج keydown للـEscape/Tab");
  });

  await testAsync("G-14 — openAdminDrawer moves focus to first focusable", async () => {
    const first = makeElement("BUTTON");
    const second = makeElement("INPUT");
    const { sandbox, document } = setupDrawerSandbox({ focusables: [first, second] });
    sandbox.openAdminDrawer("course-form-drawer");
    await flush();
    assert.strictEqual(document.activeElement, first, "التركيز يجب أن ينتقل لأول عنصر تفاعلي داخل الـdrawer");
  });

  await testAsync("G-14 — closeAdminDrawer removes .open, hides, and restores focus to trigger", async () => {
    const { sandbox, registry, document, state } = setupDrawerSandbox({ focusables: [makeElement("BUTTON")] });
    const trigger = registry["res-toggle"];
    sandbox.openAdminDrawer("res-form-drawer");
    sandbox.closeAdminDrawer("res-form-drawer");
    const ov = registry["res-form-drawer"];
    assert.ok(!ov.classList.contains("open"), "يجب إزالة class open عند الإغلاق");
    assert.strictEqual(ov.hidden, true, "يجب إعادة hidden");
    assert.strictEqual(document.activeElement, trigger, "يجب استعادة التركيز إلى زر المحفّز");
  });

  // ====== فخّ التركيز ======
  await testAsync("G-14 — Trap: Tab from last wraps to first; Shift+Tab from first wraps to last", async () => {
    const focusables = [makeElement("BUTTON"), makeElement("INPUT"), makeElement("BUTTON")];
    const { sandbox, document } = setupDrawerSandbox({ focusables });
    const [first, , last] = focusables;
    let prevented = 0;
    const prevent = () => prevented++;

    document._setActive(last);
    sandbox.trapAdminDrawerFocus("res-form-drawer", { key: "Tab", shiftKey: false, preventDefault: prevent });
    assert.strictEqual(document.activeElement, first, "Tab من آخر عنصر يجب أن يلف إلى الأول");

    document._setActive(first);
    sandbox.trapAdminDrawerFocus("res-form-drawer", { key: "Tab", shiftKey: true, preventDefault: prevent });
    assert.strictEqual(document.activeElement, last, "Shift+Tab من أول عنصر يجب أن يلف إلى الأخير");
    assert.ok(prevented >= 2, `يجب preventDefault على الالتفاف (حصل ${prevented})`);
  });

  await testAsync("G-14 — Trap: Tab in the middle stays put (no hijack)", async () => {
    const focusables = [makeElement("BUTTON"), makeElement("INPUT"), makeElement("BUTTON")];
    const { sandbox, document } = setupDrawerSandbox({ focusables });
    const mid = focusables[1];
    let prevented = 0;
    document._setActive(mid);
    sandbox.trapAdminDrawerFocus("res-form-drawer", { key: "Tab", shiftKey: false, preventDefault: () => prevented++ });
    assert.strictEqual(document.activeElement, mid, "التركيز في المنتصف يجب أن يبقى كما هو");
    assert.strictEqual(prevented, 0, "لا preventDefault في منتصف القائمة");
  });

  await testAsync("G-14 — Escape closes the drawer via keydown handler", async () => {
    const { sandbox, registry } = setupDrawerSandbox({ focusables: [makeElement("BUTTON")] });
    sandbox.openAdminDrawer("res-form-drawer");
    const ov = registry["res-form-drawer"];
    ov._listeners.keydown[0]({ key: "Escape", preventDefault: () => {}, currentTarget: ov });
    assert.strictEqual(ov.hidden, true, "Escape يجب أن يغلق الـdrawer");
    assert.ok(!ov.classList.contains("open"));
  });

  await testAsync("G-14 — backdrop / explicit close button binding (data-drawer-close click → close)", async () => {
    const { sandbox, registry } = setupDrawerSandbox({ focusables: [makeElement("BUTTON")] });
    sandbox.openAdminDrawer("res-form-drawer");
    const ov = registry["res-form-drawer"];
    // wireAdminDrawers يربط click على [data-drawer-close] (backdrop + close button)
    const backdrop = ov._backdrop;
    const closeBtn = ov._closeBtn;
    const clicks = (backdrop._listeners.click || []).concat(closeBtn._listeners.click || []);
    assert.ok(clicks.length >= 1, "الـbackdrop وزر الإغلاق يجب أن يكونا مربوطين بالـclick");
    for (const cb of clicks) cb();
    assert.strictEqual(ov.hidden, true, "النقر على الـbackdrop/الإغلاق يجب أن يغلق الـdrawer");
    assert.ok(!ov.classList.contains("open"));
  });

  await testAsync("G-14 — openAdminAddForm routes drawer triggers to openAdminDrawer", async () => {
    const { sandbox, registry } = setupDrawerSandbox({ focusables: [makeElement("BUTTON")] });
    sandbox.openAdminAddForm("res-form-toggle");
    const ov = registry["res-form-drawer"];
    assert.ok(ov.classList.contains("open"), "محفّز 'إضافة مورد' يجب أن يفتح drawer (وليس details)");
  });

  await testAsync("G-14 — openAdminAddForm keeps <details> open for short entities (no drawer)", async () => {
    const { sandbox, document } = setupDrawerSandbox();
    const detailsEl = { dataset: {}, open: false, scrollIntoView() {} };
    document.getElementById = () => detailsEl;
    sandbox.openAdminAddForm("uni-form-toggle");
    assert.strictEqual(detailsEl.open, true, "النموذج البسيط يجب أن يفتح details.open=true");
    assert.strictEqual(document.activeElement, null, "لا تركيز/فتح drawer للنماذج البسيطة");
  });

  // ====== سلوك الحفظ/الإلغاء ======
  await testAsync("G-14 — successful resource save closes the drawer", async () => {
    const { sandbox, registry, calls, toasts } = setupDrawerSandbox();
    seedResFormFields(registry);
    sandbox.openAdminDrawer("res-form-drawer");
    const form = registry["res-form"];
    assert.ok(form._listeners.submit && form._listeners.submit.length, "يجب ربط submit على res-form");
    await Promise.all(form._listeners.submit.map((cb) => cb({ preventDefault() {}, currentTarget: form })));
    await flush();
    await flush();
    assert.ok(calls.some((c) => c.op === "insert" && c.table === "resources"), "يجب إرسال insert للمورد");
    assert.strictEqual(registry["res-form-drawer"].hidden, true, "بعد الحفظ الناجح يجب إغلاق الـdrawer");
    assert.ok(!registry["res-form-drawer"].classList.contains("open"), "open يجب أن يُزال بعد الحفظ");
    assert.ok(toasts.some((t) => t.includes("تمت إضافة المورد")), "يجب عرض رسالة نجاح الإضافة");
  });

  await testAsync("G-14 — resetResForm (cancel/edit-cancel) closes the drawer", async () => {
    const { sandbox, registry } = setupDrawerSandbox();
    sandbox.openAdminDrawer("res-form-drawer");
    sandbox.resetResForm();
    assert.strictEqual(registry["res-form-drawer"].hidden, true, "إلغاء/إعادة تعيين نموذج المورد يجب أن يغلق الـdrawer");
  });

  await testAsync("G-14 — successful course save closes the course drawer", async () => {
    const { sandbox, registry, calls, toasts } = setupDrawerSandbox();
    seedCourseFormFields(registry);
    sandbox.openAdminDrawer("course-form-drawer");
    const form = registry["course-form"];
    assert.ok(form._listeners.submit && form._listeners.submit.length, "يجب ربط submit على course-form");
    await Promise.all(form._listeners.submit.map((cb) => cb({ preventDefault() {}, currentTarget: form })));
    await flush();
    await flush();
    assert.ok(calls.some((c) => c.op === "insert" && c.table === "courses"), "يجب إرسال insert للدورة");
    assert.strictEqual(registry["course-form-drawer"].hidden, true, "بعد الحفظ الناجح يجب إغلاق drawer الدورة");
    assert.ok(toasts.some((t) => t.includes("تمت إضافة الدورة")), "يجب عرض رسالة نجاح الإضافة");
  });

  await testAsync("G-14 — resetCourseForm (cancel) closes the course drawer", async () => {
    const { sandbox, registry } = setupDrawerSandbox();
    sandbox.openAdminDrawer("course-form-drawer");
    sandbox.resetCourseForm();
    assert.strictEqual(registry["course-form-drawer"].hidden, true, "إلغاء نموذج الدورة يجب أن يغلق الـdrawer");
  });

  await testAsync("G-14 — editResource opens the drawer (edit flow uses drawer)", async () => {
    const { sandbox, registry, calls } = setupDrawerSandbox({ resultsByTable: {
      resources: {
        data: [{ id: "res-1", subject_id: "s1", title: "مورد للتحرير", type: "book", language: "ar", file_url: "https://x.test/a", storage_provider: "google_drive", source_type: "student", status: "published", keywords: "ك", verified: true, view_count: 3, subjects: { id: "s1", name: "مادة 1", year_id: "y1", is_active: true, years: { id: "y1", university_id: "u1", faculty_id: "f1", year_number: 1, is_active: true, universities: { name: "جامعة 1" }, faculties: { name: "كلية 1" } } } }],
        error: null,
      },
    } });
    seedResFormFields(registry);
    await sandbox.loadResources();
    await flush();
    sandbox.editResource("res-1");
    const ov = registry["res-form-drawer"];
    assert.ok(ov.classList.contains("open"), "تعديل المورد يجب أن يفتح الـdrawer");
    assert.strictEqual(ov._attrs["aria-hidden"], "false");
    assert.strictEqual(registry["res-edit-id"].value, "res-1", "يجب تحميل معرف المورد المراد تعديله");
    assert.strictEqual(registry["res-title"].value, "مورد للتحرير");
    assert.ok(calls.some((c) => c.op === "select" && c.table === "resources"), "تعديل المورد يجب أن يعيد تحميل الموارد أولًا");
  });

  // ====== نزاهة المصدر ======
  await testAsync("G-14 — source integrity: drawer logic in admin.js, no onclick, focus trap present", async () => {
    assert.ok(!adminJsSource.includes("admin-drawer-panel"), "لا يجب استخدام class قديم admin-drawer-panel في admin.js");
    assert.ok(!adminJsSource.includes('onclick="'), "لا onclick");
    assert.ok(adminJsSource.includes("function trapAdminDrawerFocus"), "trapAdminDrawerFocus موجودة");
    assert.ok(adminJsSource.includes('event.key === "Escape"') || adminJsSource.includes("event.key === \"Escape\""), "Escape يغلق");
    assert.ok(adminJsSource.includes("focusable"), "الـdrawer يدعم الترقيم القابل للتركيز");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();

/* تعبئة حقول نموذج المورد بالأسماء الحقيقية المذكورة في admin.js. */
function seedResFormFields(registry) {
  const fields = ["res-edit-id", "res-university", "res-faculty", "res-year", "res-subject", "res-title", "res-type", "res-language", "res-file-url", "res-storage-provider", "res-source-type", "res-status", "res-keywords", "res-verified", "res-submit-btn", "res-cancel-btn", "res-form-title"];
  fields.forEach((id) => { registry[id] = registry[id] || makeElement(id === "res-submit-btn" ? "BUTTON" : id === "res-form-title" ? "H3" : "INPUT"); });
  registry["res-university"].value = "u1";
  registry["res-faculty"].value = "f1";
  registry["res-year"].value = "y1";
  registry["res-subject"].value = "s1";
  registry["res-title"].value = "مورد جديد";
  registry["res-type"].value = "book";
  registry["res-language"].value = "ar";
  registry["res-file-url"].value = "https://drive.google.com/file/d/abc/view";
  registry["res-storage-provider"].value = "google_drive";
  registry["res-source-type"].value = "student";
  registry["res-status"].value = "published";
  registry["res-submit-btn"].type = "submit";
  const form = registry["res-form"] = registry["res-form"] || makeElement("FORM");
  form.querySelector = (sel) => (sel === 'button[type="submit"]' ? registry["res-submit-btn"] : null);
}

function seedCourseFormFields(registry) {
  const fields = ["course-edit-id", "course-cover-url", "course-title", "course-instructor", "course-language", "course-status", "course-sort-order", "course-short-desc", "course-description", "course-submit-btn", "course-cancel-btn", "course-form-title"];
  fields.forEach((id) => { registry[id] = registry[id] || makeElement(id === "course-submit-btn" ? "BUTTON" : id === "course-form-title" ? "H3" : "INPUT"); });
  registry["course-title"].value = "دورة جديدة";
  registry["course-status"].value = "draft";
  registry["course-sort-order"].value = 0;
  registry["course-submit-btn"].type = "submit";
  const form = registry["course-form"] = registry["course-form"] || makeElement("FORM");
  form.querySelector = (sel) => (sel === 'button[type="submit"]' ? registry["course-submit-btn"] : null);
}

function docProto(el) { return Object.getPrototypeOf ? { __proto__: el } : el; }