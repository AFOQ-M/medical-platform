/**
 * test-admin-confirm.js
 * ------------------------------------------------------------------
 * اختبارات NEW-02 — نافذة تأكيد الإجراءات المدمرة (Destructive Confirm)
 * داخل admin/admin.js: بديل window.confirm لكل من:
 *   - deleteRow() (حذف صفوف الجداول)؛
 *   - disableMfa() (تعطيل التحقق بخطوتين).
 *
 * تتحقق من:
 *   - showDestructiveConfirm تُرجع فورًا ولا تنفّذ أي إجراء قبل القرار؛
 *   - الإلغاء → لا استدعاء onConfirm (ولا أي استعلام Supabase)؛
 *   - القبول → استدعاء onConfirm مرة واحدة بالضبط، والحذف الفعلي يحدث؛
 *   - النافذة تغلق (hidden) بعد القرار؛
 *   - التركيز يعود للمحفّز (زر delete مثلاً) بعد الإغلاق؛
 *   - semantics dialog (role=aria-modal=aria-labelledby)؛
 *   - Escape/خلفية/زر الإلغاء = إلغاء بلا تنفيذ؛
 *   - لا أي window.confirm باقٍ في admin.js (بحث ختامي)؛
 *   - أمان: لا innerHTML في بناء النافذة (DOM APIs/textContent فقط).
 *
 * التشغيل: node test/test-admin-confirm.js
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

/* عنصر عام بنفس مذاق test-admin-drawers مع دعم بناء النافذة الجديدة:
 * getAttribute/setAttribute/classList/dataset/hidden/addEventListener/
 * appendChild/textContent/children — لا يتطلب querySelector حقيقيًا لأن
 * showDestructiveConfirm يبني كل شيء عبر getElementById. */
function makeElement(tagName = "DIV", doc) {
  const el = {
    tagName, hidden: false, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "", type: "", id: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    removeEventListener(t, cb) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== cb); },
    appendChild(c) { this._children.push(c); return c; },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    focus() { if (doc) doc._setActive(this); },
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

function makeMockSupabase({ resultsByTable = {}, rpcResults = {}, onDelete = null } = {}) {
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
        if (state.op === "update") { resolve({ data: null, error: null }); return; }
        resolve(resultsByTable[table] || { data: [], error: null });
      },
    };
    return chain;
  }
  const supabase = { from: builder };
  supabase.rpc = async (fn, params) => { calls.push({ op: "rpc", fn, params }); return rpcResults[fn] || { data: null, error: { message: "unmocked" } }; };
  supabase.auth = {
    getSession: async () => ({ data: { session: null }, error: { message: "unmocked" } }),
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({ data: { user: null }, error: { message: "unmocked" } }),
    mfa: {
      listFactors: async () => { calls.push({ op: "mfa.listFactors" }); return { data: { totp: [] }, error: null }; },
      getAuthenticatorAssuranceLevel: async () => { calls.push({ op: "mfa.aal" }); return { data: { currentLevel: "aal1" }, error: null }; },
      challenge: async () => ({ data: { id: "c" }, error: null }),
      verify: async () => ({ data: null, error: null }),
      unenroll: async () => ({ data: { id: "f" }, error: null }),
      refreshSession: async () => ({ data: { session: { user: { id: "u" } } }, error: null }),
    },
  };
  return { supabase, calls };
}

function loadAdminJsSandbox({ resultsByTable = {}, rpcResults = {}, onDelete = null, withActiveElement = false } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults, onDelete });

  let active = null;
  const document = {
    body: { appendChild(e) { document._bodyChildren = document._bodyChildren || []; if (e) document._bodyChildren.push(e); } },
    getElementById: (id) => registry[id] || (registry[id] = makeElement("DIV", document)),
    createElement: (tag) => makeElement((tag || "DIV").toUpperCase(), document),
    createTextNode: () => ({}),
    querySelector: () => makeElement("DIV", document),
    querySelectorAll: () => [],
    contains(node) {
      if (node === active) return true;
      return (document._bodyChildren || []).includes(node);
    },
    _setActive(e) { active = e; },
    get activeElement() { return withActiveElement ? (active || registry["mfa-disable-btn"] || null) : null; },
  };
  document.createElement = (tag) => {
    const el = makeElement((tag || "DIV").toUpperCase(), document);
    Object.defineProperty(el, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; if (v) registry[v] = el; },
    });
    return el;
  };
  // getElementById يُنشئ ويُسجّل أيضًا بمعرّفه حتى تتطابق الهوية مع createElement
  {
    const origGet = document.getElementById;
    document.getElementById = (id) => {
      if (registry[id]) return registry[id];
      const el = document.createElement("DIV");
      el.id = id; // السجّل في registry
      return el;
    };
    void origGet;
  }

  const sandbox = vm.createContext({
    console: { log: () => {}, error: (...a) => consoleErrors.push(a.join(" ")), warn: () => {} },
    document,
    sessionStorage: { getItem: (k) => (k in storageStore ? storageStore[k] : null), setItem: (k, v) => { storageStore[k] = String(v); }, removeItem: (k) => { delete storageStore[k]; } },
    confirm: () => { throw new Error("window.confirm must NEVER be called after NEW-02"); },
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    showToast: (m) => toasts.push(m),
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, toasts, consoleErrors, calls, registry, document };
}

/* قراءة نافذة التأكيد من الـdocument المحاكي. */
function confirmOverlay(doc) {
  return doc.getElementById("admin-confirm-overlay");
}
function confirmOk(doc) {
  return doc.getElementById("admin-confirm-ok");
}
function confirmCancel(doc) {
  return doc.getElementById("admin-confirm-cancel");
}
function act(doc, btn) {
  const listeners = btn._listeners && btn._listeners.click;
  assert.ok(listeners && listeners.length, "يجب أن يكون للزر مستمع click");
  listeners[0]();
}

(async () => {
  console.log("AFOQ Admin Destructive Confirm (NEW-02) Tests\n");

  await testAsync("showDestructiveConfirm — returns immediately (no work before decision)", async () => {
    let called = 0;
    const { sandbox } = loadAdminJsSandbox();
    const start = Date.now();
    sandbox.showDestructiveConfirm({ title: "ت", message: "م", onConfirm: () => { called++; } });
    const elapsed = Date.now() - start;
    assert.strictEqual(called, 0, "onConfirm يجب أن لا يُنفَّذ قبل أي قرار");
    assert.ok(elapsed < 1000, "الدالة تعيد فورًا (غير محجوبة)");
  });

  await testAsync("cancel — clicking إلغاء never calls onConfirm and hides the dialog", async () => {
    let called = 0;
    const { sandbox, document: doc } = loadAdminJsSandbox();
    sandbox.showDestructiveConfirm({ title: "تأكيد الحذف", message: "م", onConfirm: () => { called++; } });
    const overlay = confirmOverlay(doc);
    assert.strictEqual(overlay.hidden, false, "النافذة تظهر");
    act(doc, confirmCancel(doc));
    await flush();
    assert.strictEqual(called, 0, "لا استدعاء عند الإلغاء");
    assert.strictEqual(overlay.hidden, true, "النافذة تُغلق بعد الإلغاء");
  });

  await testAsync("accept — clicking تأكيد calls onConfirm EXACTLY once and hides the dialog", async () => {
    let called = 0;
    const { sandbox, document: doc } = loadAdminJsSandbox();
    sandbox.showDestructiveConfirm({ title: "تأكيد الحذف", message: "م", onConfirm: () => { called++; } });
    act(doc, confirmOk(doc));
    await flush();
    assert.strictEqual(called, 1, "onConfirm تُستدعى مرة واحدة بالضبط");
    assert.strictEqual(confirmOverlay(doc).hidden, true, "النافذة تُغلق بعد القبول");
    // ضغطة ثانية على الزر لا تغيّر شيئًا (النافذة مغلقة والـcallback صُفّر)
    act(doc, confirmOk(doc));
    await flush();
    assert.strictEqual(called, 1, "لا استدعاء ثانٍ بعد الإغلاق");
  });

  await testAsync("Escape — closes and cancels (no execution)", async () => {
    let called = 0;
    const { sandbox, document: doc } = loadAdminJsSandbox();
    sandbox.showDestructiveConfirm({ title: "ت", message: "م", onConfirm: () => { called++; } });
    const overlay = confirmOverlay(doc);
    const esc = (overlay._listeners.keydown || []).find((fn) => String(fn).includes("Escape"));
    assert.ok(esc, "يجب أن يكون هناك مستمع keydown يعالج Escape");
    esc({ key: "Escape" });
    await flush();
    assert.strictEqual(called, 0, "Escape = إلغاء بلا تنفيذ");
    assert.strictEqual(overlay.hidden, true);
  });

  await testAsync("backdrop click — closes and cancels (no execution)", async () => {
    let called = 0;
    const { sandbox, document: doc } = loadAdminJsSandbox();
    sandbox.showDestructiveConfirm({ title: "ت", message: "م", onConfirm: () => { called++; } });
    const overlay = confirmOverlay(doc);
    const backdropHandler = (overlay._listeners.click || []).find((fn) => String(fn).includes("target === overlay"));
    assert.ok(backdropHandler, "يجب أن يكون هناك مستمع click على الخلفية");
    backdropHandler({ target: overlay });
    await flush();
    assert.strictEqual(called, 0);
    assert.strictEqual(overlay.hidden, true);
  });

  await testAsync("dialog semantics — role=dialog, aria-modal, aria-labelledby + accessibility", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    sandbox.showDestructiveConfirm({ title: "تأكيد الحذف", message: "نص الرسالة" });
    const overlay = confirmOverlay(doc);
    assert.strictEqual(overlay.getAttribute("role"), "dialog");
    assert.strictEqual(overlay.getAttribute("aria-modal"), "true");
    assert.strictEqual(overlay.getAttribute("aria-labelledby"), "admin-confirm-title");
    const title = doc.getElementById("admin-confirm-title");
    const msg = doc.getElementById("admin-confirm-message");
    assert.strictEqual(title._textContent, "تأكيد الحذف");
    assert.strictEqual(msg._textContent, "نص الرسالة");
    const ok = confirmOk(doc);
    const cancel = confirmCancel(doc);
    assert.strictEqual(ok._textContent, "تأكيد الحذف");
    assert.strictEqual(cancel._textContent, "إلغاء");
  });

  await testAsync("source integrity — no window.confirm remains, dialog built with DOM APIs", async () => {
    assert.ok(!/\bconfirm\s*\(/.test(adminJsSource), "لا يجب بقاء أي confirm( فعلي في admin.js");
    assert.ok(adminJsSource.includes("showDestructiveConfirm"), "الدالة الجديدة موجودة");
    // بحث ختامي صفري في الشيفرة القابلة للتنفيذ (نستبعد سطور التعليقات فقط)
    const execCode = adminJsSource.split("\n").filter((ln) => !ln.trim().startsWith("//")).join("\n");
    assert.ok(!execCode.includes("window.confirm"), "لا window.confirm في الشيفرة القابلة للتنفيذ");
    assert.ok(!execCode.includes("window["), "لا وصول ديناميكي بديل بنفس الروح");
    // بناء آمن xml: كتلة NEW-02 (حتى بداية F-11) لا تستخدم innerHTML
    const new02Start = adminJsSource.indexOf("// NEW-02 — تأكيد الإجراءات المدمرة");
    const f11Start = adminJsSource.indexOf("// F-11: أزرار صفوف");
    assert.ok(new02Start >= 0 && f11Start > new02Start, "حدود نصّية لكتلة NEW-02 وُجدت");
    const new02Block = adminJsSource.slice(new02Start, f11Start).split("\n").filter((ln) => !ln.trim().startsWith("//")).join("\n");
    assert.ok(!new02Block.includes("innerHTML"), "بناء النافذة لا يستخدم innerHTML (DOM APIs فقط)");
  });

  await testAsync("disableMfa — cancel: no network call (listFactors never called)", async () => {
    const { sandbox, calls } = loadAdminJsSandbox();
    await sandbox.disableMfa(); // تُظهر النافذة فقط
    cancelDialogIfOpen(sandbox);
    await flush();
    assert.ok(!calls.some((c) => c.op === "mfa.listFactors"), "الإلغاء لا يُطلق أي استعلام MFA");
  });

  await testAsync("disableMfa — accept: proceeds to the verified-MFA flow", async () => {
    const { sandbox, calls, document: doc } = loadAdminJsSandbox();
    await sandbox.disableMfa();
    act(doc, confirmOk(doc));
    await flush();
    await flush();
    // الحساب في sandbox ليس له factor verified → يصل لـ listFactors ثم يكتفي بالمزامنة
    assert.ok(calls.some((c) => c.op === "mfa.listFactors"), "بعد القبول يُقرأ الـfactor من الخادم");
    assert.ok(!calls.some((c) => c.op === "mfa.unenroll"), "بدون factor verified لا unenroll");
  });

  await testAsync("deleteRow — focus returns to the opener trigger after dialog closes", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox({ withActiveElement: true, onDelete: () => null });
    // محفّز واقعي: زر delete في صف الجدول — داخل document.body كما في المتصفح
    const trigger = doc.createElement("BUTTON");
    trigger.id = "fake-delete-trigger";
    doc.body.appendChild(trigger);
    sandbox.document._setActive(trigger);
    sandbox.deleteRow("universities", "uni-1", () => {});
    assert.strictEqual(confirmOverlay(doc).hidden, false, "النافذة ظهرت");
    act(doc, confirmOk(doc));
    await flush();
    await flush();
    assert.strictEqual(sandbox.document.activeElement, trigger, "التركيز عاد للمحفّز الأصلي");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();

function cancelDialogIfOpen(h) {
  const doc = h.document;
  const overlay = doc && doc.getElementById && doc.getElementById("admin-confirm-overlay");
  if (!overlay || overlay.hidden) return;
  const cancel = doc.getElementById("admin-confirm-cancel");
  if (cancel && cancel._listeners && cancel._listeners.click && cancel._listeners.click.length) {
    cancel._listeners.click[0]();
  }
}