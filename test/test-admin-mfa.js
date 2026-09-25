/**
 * test-admin-mfa.js
 * ------------------------------------------------------------------
 * MFA (P1-7A) — frontend gate regression for admin/admin.js.
 *
 * نطاق الاختبار (Big Pickle): سلوك الواجهة/التدفق/الجلسة فقط:
 *   - account مع factor verified ولم يصل aal2 → شاشة تحقق، ولَيْس الداشبورد؛
 *   - account مع factor verified ووصل aal2 → دخول مباشر للداشبورد؛
 *   - account بلا factor → دخول مباشر (MFA اختياري — لا نفرض تدفقًا)؛
 *   - معالج mfa-verify-form: challenge → verify → refreshMfaState →
 *     شرط aal2 قبل enterDashboardWithLock؛
 *   - updateMfaEnrollVisibility: super_admin لا يرى زر تفعيل؛
 *     بلا factor verified يُعرض زر التفعيل، وبوجوده يُعرض زر التعطيل فقط.
 *
 * لا يختبر الإنفاذ على مستوى قاعدة البيانات (fn_has_permission/
 * fn_is_super_admin ومتطلب aal2 هناك) — ذلك DB-handoff إلى Claude.
 * لا يزور PASS: كل حالة تُفحص فعليًا على الحالة الحقيقية لمتغيرات
 * الواجهة (hidden للـ login-box / mfa-verify-box / dashboard).
 *
 * التشغيل: node test/test-admin-mfa.js
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

/* mfaOptions يعطّل سلوك MFA بشكل قابل للبرمجة لكل اختبار. */
function makeMockSupabase({ resultsByTable = {}, rpcResults = {}, mfaOptions = {} } = {}) {
  const calls = [];
  const {
    factors = [],            // قائمة factors (سيُستخرج منها verified TOTP)
    currentLevel = "aal1",   // مستوى aal الحالي من getAuthenticatorAssuranceLevel
    verifyResult = null,     // null = نجاح، أو { error: { message } } لفشل
  } = mfaOptions;

  function builder(table) {
    const state = { table, filters: {} };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(f, t) { calls.push({ op: "range", table, f, t }); return chain; },
      limit(n) { calls.push({ op: "limit", table, n }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(p) { calls.push({ op: "insert", table, p }); return chain; },
      update(p) { calls.push({ op: "update", table, p }); return chain; },
      delete() { calls.push({ op: "delete", table }); return chain; },
      then(resolve) {
        const result = resultsByTable[table] || { data: [], error: null };
        resolve(chain._single ? { data: (result.data || [])[0] || null, error: result.error || null } : result);
      },
    };
    return chain;
  }
  const supabase = { from: builder };
  supabase.rpc = async (fn, params) => { calls.push({ op: "rpc", fn, params }); return rpcResults[fn] || { data: null, error: { message: "unmocked" } }; };

  let aalLevel = currentLevel;
  supabase.auth = {
    getSession: async () => ({ data: { session: null }, error: null }),
    signOut: async () => ({ error: null }),
    signInWithPassword: async () => ({ data: { user: null }, error: { message: "unmocked" } }),
    mfa: {
      listFactors: async () => { calls.push({ op: "mfa.listFactors" }); return { data: { totp: factors }, error: null }; },
      getAuthenticatorAssuranceLevel: async () => { calls.push({ op: "mfa.aal" }); return { data: { currentLevel: aalLevel }, error: null }; },
      challenge: async () => { calls.push({ op: "mfa.challenge" }); return { data: { id: "c1" }, error: null }; },
      verify: async () => { calls.push({ op: "mfa.verify" }); return verifyResult || { data: null, error: null }; },
      /* يسمح للاختبار بمحاكاة "اكتمل التحقق → أصبح aal2" قبل إعادة refreshMfaState */
      _setAal: (lvl) => { aalLevel = lvl; },
      unenroll: async () => ({ data: { id: "f" }, error: null }),
    },
  };
  return { supabase, calls };
}

function loadAdminJsSandbox({ resultsByTable = {}, rpcResults = {}, mfaOptions = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults, mfaOptions });

  const document = {
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: () => ({}),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
  };

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
  return { sandbox, toasts, consoleErrors, calls, registry };
}

function staffRow(id = "u-staff", role = "staff", active = true, email = "staff@afoq.test") {
  return { id, email, role, active };
}

const VERIFIED_FACTOR = [{ id: "f1", status: "verified", type: "totp" }];
const UNVERIFIED_FACTOR = [{ id: "f2", status: "unverified", type: "totp" }];
const LOCK_OK = { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } };

console.log("AFOQ Admin (admin/admin.js) — MFA Frontend Gate Tests\n");

(async () => {
  await testAsync("verified factor + aal1 → gate shows the MFA verify screen, NOT the dashboard", async () => {
    const staff = staffRow();
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: VERIFIED_FACTOR, currentLevel: "aal1" },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(registry["mfa-verify-box"].hidden, false, "شاشة التحقق يجب أن تظهر");
    assert.strictEqual(registry["login-box"].hidden, true, "شاشة الدخول تُخفى");
    assert.strictEqual(registry["dashboard"].hidden, true, "الداشبورد يجب ألا يظهر قبل التحقق");
  });

  await testAsync("verified factor + aal2 → dashboard directly (no verify screen)", async () => {
    const staff = staffRow();
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: VERIFIED_FACTOR, currentLevel: "aal2" },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(registry["dashboard"].hidden, false, "الداشبورد يجب أن يظهر عند aal2");
    assert.strictEqual(registry["mfa-verify-box"].hidden, true, "لا شاشة تحقق عند aal2");
  });

  await testAsync("no verified factor + aal1 → dashboard directly (MFA optional, not enforced)", async () => {
    const staff = staffRow();
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: UNVERIFIED_FACTOR, currentLevel: "aal1" },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(registry["dashboard"].hidden, false, "دخول مباشر بدون factor verified");
    assert.strictEqual(registry["mfa-verify-box"].hidden, true, "لا تحقق لغير factor verified");
  });

  await testAsync("super_admin with verified factor + aal1 → ALSO gated to MFA verify (post-M8 parity)", async () => {
    // بعد m8 لم يعد super_admin مستثنى من شرط aal2 في fn_is_super_admin/
    // fn_has_permission — الواجهة يجب أن تطابق ذلك: عامل verified + aal1
    // يوقف أي حساب، بما فيه super_admin.
    const superRow = { id: "u-super", email: "super@afoq.test", role: "super_admin", active: true };
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [superRow], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: VERIFIED_FACTOR, currentLevel: "aal1" },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-super", email: "super@afoq.test" });
    assert.strictEqual(registry["mfa-verify-box"].hidden, false, "super_admin ذو عامل verified وaal1 يجب أن يرى شاشة التحقق");
    assert.strictEqual(registry["dashboard"].hidden, true, "لا داشبورد قبل aal2 حتى لـsuper_admin");
  });

  await testAsync("MFA verify form: wrong code → error shown, stays on verify screen", async () => {
    const staff = staffRow();
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: {
        factors: VERIFIED_FACTOR, currentLevel: "aal1",
        verifyResult: { data: null, error: { message: "invalid code" } },
      },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    const code = registry["mfa-verify-code"];
    code.value = "000001";
    const ev = { preventDefault: () => {} };
    await sandbox.document.getElementById("mfa-verify-form")._listeners.submit[0](ev);
    assert.strictEqual(registry["mfa-verify-box"].hidden, false, "يبقى على شاشة التحقق بعد رمز خاطئ");
    assert.strictEqual(registry["dashboard"].hidden, true, "لا داشبورد بعد فشل التحقق");
    assert.ok(registry["mfa-verify-error"].style.display === "block", "يُعرض خطأ رمز التحقق غير الصحيح");
  });

  await testAsync("MFA verify form: valid code lifts session to aal2 → enterDashboardWithLock (acquire lock)", async () => {
    const staff = staffRow();
    const mfaOptions = { factors: VERIFIED_FACTOR, currentLevel: "aal1" };
    const { sandbox, registry, calls } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions,
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    // محاكاة نجاح verify → يصبح aal2، مثلما يفعل Supabase حيًا بعد رمز صحيح.
    sandbox.supabaseClient.auth.mfa._setAal("aal2");
    const code = registry["mfa-verify-code"];
    code.value = "123456";
    const ev = { preventDefault: () => {} };
    await sandbox.document.getElementById("mfa-verify-form")._listeners.submit[0](ev);
    assert.ok(calls.some((c) => c.op === "mfa.challenge") && calls.some((c) => c.op === "mfa.verify"),
      "يجب استدعاء challenge ثم verify");
    assert.strictEqual(registry["dashboard"].hidden, false, "بعد aal2 يظهر الداشبورد");
    assert.ok(calls.some((c) => c.op === "rpc" && c.fn === "acquire_admin_session_lock"),
      "عند بلوغ aal2 يجب إتمام مسار القفل (acquire) قبل عرض الداشبورد");
  });

  await testAsync("verify form with aal still aal1 after verify → refuses dashboard and shows error", async () => {
    const staff = staffRow();
    const { sandbox, registry } = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: VERIFIED_FACTOR, currentLevel: "aal1" },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    // verify ينجح لكن الجلسة لم ترتقِ إلى aal2 (حالة غير طبيعية/معطوبة)
    const code = registry["mfa-verify-code"];
    code.value = "123456";
    const ev = { preventDefault: () => {} };
    await sandbox.document.getElementById("mfa-verify-form")._listeners.submit[0](ev);
    assert.strictEqual(registry["dashboard"].hidden, true, "لا داشبورد إذا بقي aal1");
    assert.ok(String(registry["mfa-verify-error"].style.display) === "block", "يُعرض خطأ عدم اكتمال التحقق");
  });

  await testAsync("updateMfaEnrollVisibility — super_admin never sees the enroll button; enroll/disable are mutually exclusive", async () => {
    const superRow = { id: "u-super", email: "super@afoq.test", role: "super_admin", active: true };
    const superEnv = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [superRow], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: [], currentLevel: "aal1" },
    });
    await superEnv.sandbox.loadCurrentUserAuthorization({ id: "u-super", email: "super@afoq.test" });
    assert.strictEqual(superEnv.registry["mfa-enroll-btn"].hidden, true, "super_admin لا يرى زر تفعيل MFA");

    const staff = staffRow();
    const noFactorEnv = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: [], currentLevel: "aal1" },
    });
    await noFactorEnv.sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(noFactorEnv.registry["mfa-enroll-btn"].hidden, false, "بلا عامل verified يُعرض زر التفعيل");
    assert.strictEqual(noFactorEnv.registry["mfa-disable-btn"].hidden, true, "بلا عامل لا يُعرض زر التعطيل");

    const withFactorEnv = loadAdminJsSandbox({
      resultsByTable: { profiles: { data: [staff], error: null }, user_permissions: { data: [], error: null } },
      rpcResults: LOCK_OK,
      mfaOptions: { factors: VERIFIED_FACTOR, currentLevel: "aal2" },
    });
    await withFactorEnv.sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(withFactorEnv.registry["mfa-enroll-btn"].hidden, true, "بوجود factor verified يُخفى زر التفعيل");
    assert.strictEqual(withFactorEnv.registry["mfa-disable-btn"].hidden, false, "بوجود factor verified يُعرض زر التعطيل");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exitCode = failures > 0 ? 1 : 0;
})();