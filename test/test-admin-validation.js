/**
 * test-admin-validation.js
 * ------------------------------------------------------------------
 * اختبارات NEW-03 — التحقق الخفيف من حقول النماذج داخل admin/admin.js:
 *   - validateResourceForm(): title مطلوب غير فارغ بعد trim؛
 *     file_url مطلوب عند source_type !== "link" بصيغة http(s) أو
 *     مسار نسبي يبدأ بـ "/".
 *   - validateCourseForm(): title مطلوب غير فارغ بعد trim.
 *
 * التحقق من شروط القبول في الـspec:
 *   - يُركّب validateResourceForm()/validateCourseForm() وتُستدعى عند submit؛
 *     submit يُمنع عند الخطأ ولا يرسل أي شبكة.
 *   - title فارغ يُرفض؛ file_url سيئ يُرفض؛ title + رابط صحيح يمرّان.
 *   - لا console.error على طول مسار الرفض.
 *   - علامات إتاحة: العنصر بمعرّف "<field>-error" يظهر بجانب الحقل مع
 *     aria-invalid/aria-describedby عند الخطأ، ويُمسح عند الصحة.
 *   - بقاء مسار الحفظ الفعلي يعمل عند البيانات الصحيحة (insert يُرسل).
 *
 * التشغيل: node test/test-admin-validation.js
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

function makeElement(tagName = "DIV", doc) {
  const el = {
    tagName, hidden: false, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "", type: "", id: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    removeEventListener(t, cb) { this._listeners[t] = (this._listeners[t] || []).filter((f) => f !== cb); },
    appendChild(c) { this._children.push(c); return c; }, insertBefore(c) { this._children.unshift(c); return c; },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {},
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

function makeMockSupabase({ resultsByTable = {}, rpcResults = {} } = {}) {
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
      insert(p) { calls.push({ op: "insert", table, p }); state.op = "insert"; state.payload = p; return chain; },
      update(p) { calls.push({ op: "update", table, p }); state.op = "update"; state.payload = p; return chain; },
      delete() { calls.push({ op: "delete", table }); state.op = "delete"; return chain; },
      then(resolve) {
        if (chain._single) {
          const result = resultsByTable[table] || { data: [], error: null };
          resolve({ data: (result.data || [])[0] || null, error: result.error || null });
          return;
        }
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
      listFactors: async () => ({ data: { totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }),
      challenge: async () => ({ data: { id: "c" }, error: null }),
      verify: async () => ({ data: null, error: null }),
      unenroll: async () => ({ data: { id: "f" }, error: null }),
      refreshSession: async () => ({ data: { session: { user: { id: "u" } } }, error: null }),
    },
  };
  return { supabase, calls };
}

function loadAdminJsSandbox({ resultsByTable = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable });

  const registerIdAccessor = (el) => {
    Object.defineProperty(el, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; if (v) registry[v] = el; },
    });
    return el;
  };
  const document = {
    body: { appendChild(e) { document._bodyChildren = document._bodyChildren || []; if (e) document._bodyChildren.push(e); } },
    getElementById(id) {
      if (registry[id]) return registry[id];
      const el = registerIdAccessor(makeElement("DIV", document));
      el.id = id;
      return el;
    },
    createElement: (tag) => registerIdAccessor(makeElement((tag || "DIV").toUpperCase(), document)),
    createTextNode: () => ({}),
    querySelector: () => makeElement("DIV", document),
    querySelectorAll: () => [],
    _setActive(e) { document._active = e; },
    get activeElement() { return document._active || null; },
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
  return { sandbox, toasts, consoleErrors, calls, registry, document };
}

function setResForm(document, { title, sourceType, fileUrl, subject = "s1" } = {}) {
  document.getElementById("res-edit-id").value = "";
  document.getElementById("res-title").value = title || "";
  document.getElementById("res-source-type").value = sourceType || "student";
  document.getElementById("res-file-url").value = fileUrl || "";
  document.getElementById("res-subject").value = subject;
}
function submitResForm(document) {
  const form = document.getElementById("res-form");
  assert.ok(form && form._listeners && form._listeners.submit && form._listeners.submit.length,
    "يجب أن يكون submit مربوطًا على res-form");
  return form._listeners.submit[0]({ currentTarget: form, preventDefault() {} });
}
function setCourseForm(document, { title } = {}) {
  document.getElementById("course-edit-id").value = "";
  document.getElementById("course-title").value = title || "";
}
function fieldErrorValue(document, fieldId) {
  const el = document.getElementById(fieldId + "-error");
  return el ? { text: el.textContent, hidden: el.hidden } : null;
}

(async () => {
  console.log("AFOQ Admin Field Validation (NEW-03) Tests\n");

  await testAsync("validateResourceForm — رفض title فارغ (return false + خطأ بجانب الحقل + aria-invalid)", async () => {
    const { sandbox, document: doc, consoleErrors } = loadAdminJsSandbox();
    setResForm(doc, { title: "   ", fileUrl: "https://x.test/a" });
    const ok = sandbox.validateResourceForm();
    assert.strictEqual(ok, false, "title فارغ (بعد trim) يجب أن يُرفض");
    const err = fieldErrorValue(doc, "res-title");
    assert.ok(err && err.text.length > 0 && !err.hidden, "رسالة خطأ عربية يجب أن تظهر بجانب الحقل");
    assert.strictEqual(doc.getElementById("res-title").getAttribute("aria-invalid"), "true", "aria-invalid=true عند الخطأ");
    assert.strictEqual(doc.getElementById("res-title").getAttribute("aria-describedby"), "res-title-error", "aria-describedby يشير لعنصر الخطأ");
    assert.strictEqual(consoleErrors.length, 0, "لا console.error عند الرفض");
  });

  await testAsync("validateResourceForm — رفض file_url سيئ (return false + لا شبكة للرسالة)", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    setResForm(doc, { title: "مورد صحيح", fileUrl: "ليس-رابطا-على-الإطلاق" });
    const ok = sandbox.validateResourceForm();
    assert.strictEqual(ok, false, "file_url غير صالح يجب أن يُرفض");
    const err = fieldErrorValue(doc, "res-file-url");
    assert.ok(err && err.text.length > 0 && !err.hidden, "رسالة خطأ عربية لرابط الملف");
  });

  await testAsync("validateResourceForm — title + رابط http صحيح يمرّان (return true)", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    setResForm(doc, { title: "مورد صحيح", fileUrl: "https://x.test/a" });
    const ok = sandbox.validateResourceForm();
    assert.strictEqual(ok, true);
    assert.strictEqual(doc.getElementById("res-title").getAttribute("aria-invalid"), null, "لا aria-invalid عند الصحة");
    assert.strictEqual(fieldErrorValue(doc, "res-title").text, "", "لا نص خطأ عند الصحة");
  });

  await testAsync("validateResourceForm — مسار نسبي /... مقبول في الصيغة (كما في الـspec)", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    setResForm(doc, { title: "مورد", fileUrl: "/uploads/notes.pdf" });
    assert.strictEqual(sandbox.validateResourceForm(), true, "المسار النسبي /... يمرّ في التحقق (spec NEW-03)");
  });

  await testAsync("validateResourceForm — source_type === 'link' لا يتطلب file_url", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    setResForm(doc, { title: "مورد", sourceType: "link", fileUrl: "" });
    assert.strictEqual(sandbox.validateResourceForm(), true, "لا يلزم file_url عندما source_type=link");
  });

  await testAsync("validateCourseForm — رفض title فارغ وقبول غير فارغ", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    const courseTitle = doc.getElementById("course-title");
    courseTitle.value = "   ";
    assert.strictEqual(sandbox.validateCourseForm(), false, "title دورة فارغ يجب أن يُرفض");
    assert.strictEqual(courseTitle.getAttribute("aria-invalid"), "true");
    courseTitle.value = "دورة رسمية";
    assert.strictEqual(sandbox.validateCourseForm(), true, "title غير فارغ يمرّ");
    assert.strictEqual(fieldErrorValue(doc, "course-title").text, "", "لا رسالة عند الصحة");
  });

  await testAsync("submit res-form — بيانات خاطئة تمنع الإرسال ولا ترسل أي شبكة", async () => {
    const { sandbox, document: doc, calls, toasts } = loadAdminJsSandbox();
    setResForm(doc, { title: "", fileUrl: "bad-url" });
    await submitResForm(doc);
    await flush();
    await flush();
    assert.strictEqual(calls.length, 0, "لا أي استعلام Supabase عند خطأ التحقق");
    assert.ok(!toasts.some((t) => t.includes("تمت إضافة") && !t.includes("خطأ")), "لا رسالة نجاح خاطئة");
  });

  await testAsync("submit res-form — بيانات صحيحة تُرسل insert وحفظ فعلي يعمل", async () => {
    const { sandbox, document: doc, calls, toasts } = loadAdminJsSandbox({ resultsByTable: { resources: { data: [{ id: "r1" }], error: null } } });
    setResForm(doc, { title: "مورد صحيح", fileUrl: "https://x.test/a" });
    await submitResForm(doc);
    await flush();
    await flush();
    assert.ok(calls.some((c) => c.op === "insert" && c.table === "resources"), "insert لا يزال يُرسل مع البيانات الصحيحة");
    assert.ok(toasts.some((t) => t.includes("تمت إضافة المورد")), "رسالة النجاح تظهر");
  });

  await testAsync("submit course-form — بيانات صحيحة تُرسل insert إلى courses", async () => {
    const { sandbox, document: doc, calls } = loadAdminJsSandbox({ resultsByTable: { courses: { data: [{ id: "c1" }], error: null } } });
    setCourseForm(doc, { title: "دورة سليمة" });
    const form = doc.getElementById("course-form");
    await form._listeners.submit[0]({ currentTarget: form, preventDefault() {} });
    await flush();
    await flush();
    assert.ok(calls.some((c) => c.op === "insert" && c.table === "courses"), "insert للدورة مع البيانات الصحيحة");
  });

  await testAsync("النقاط المربوطة: blur/input/change تُستدعى validate* عند أحداث الحقول", async () => {
    const { sandbox, document: doc } = loadAdminJsSandbox();
    const checkWired = (id, type) => {
      const el = doc.getElementById(id);
      return el && el._listeners[type] && el._listeners[type].length > 0;
    };
    assert.ok(checkWired("res-title", "blur"), "blur مربوط على res-title");
    assert.ok(checkWired("res-title", "input"), "input مربوط على res-title");
    assert.ok(checkWired("res-file-url", "blur"), "blur مربوط على res-file-url");
    assert.ok(checkWired("res-file-url", "input"), "input مربوط على res-file-url");
    assert.ok(checkWired("res-source-type", "change"), "change مربوط على res-source-type");
    assert.ok(checkWired("course-title", "blur"), "blur مربوط على course-title");
    assert.ok(checkWired("course-title", "input"), "input مربوط على course-title");
  });

  await testAsync("سلامة المصدر: الدوال الجديدة موجودة وsetCustomValidity/aria-describedby مستخدمان في admin.js", async () => {
    assert.ok(adminJsSource.includes("function validateResourceForm"), "admin.js يجب أن يعرّف validateResourceForm");
    assert.ok(adminJsSource.includes("function validateCourseForm"), "admin.js يجب أن يعرّف validateCourseForm");
    assert.ok(adminJsSource.includes("setCustomValidity"), "setCustomValidity مستخدمة");
    assert.ok(adminJsSource.includes("aria-describedby"), "aria-describedby مستخدمة");
    assert.ok(/if \(!validateResourceForm\(\)\) return/.test(adminJsSource), "submit res-form يستدعي الفحص");
    assert.ok(/if \(!validateCourseForm\(\)\) return/.test(adminJsSource), "submit course-form يستدعي الفحص");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();