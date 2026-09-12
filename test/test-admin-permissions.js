/**
 * test-admin-permissions.js
 * ------------------------------------------------------------------
 * اختبارات Regression للوحة التحكم (admin/admin.js) — الجزء 2:
 * تفويض hasPerm()/hasAnyPerm() عبر المسار الحقيقي
 * loadCurrentUserAuthorization() (تعادل fn_has_permission في قاعدة
 * البيانات)، مع تغطية: بلا جلسة، super_admin، صلاحيات عامة / جامعة /
 * كلية، حساب معطَّل، صف صلاحية غير نشط، وفشل قفل الجلسة.
 *
 * التشغيل: node test/test-admin-permissions.js
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

function makeMockSupabase({ resultsByTable = {}, rpcResults = {} } = {}) {
  const calls = [];
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

function loadAdminJsSandbox({ resultsByTable = {}, rpcResults = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeMockSupabase({ resultsByTable, rpcResults });

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
  return { sandbox, toasts, consoleErrors, calls };
}

function staffRow(id = "u-staff", role = "staff", active = true, email = "staff@afoq.test") {
  return { id, email, role, active };
}

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — Authorization & hasPerm/hasAnyPerm Tests\n");

  await testAsync("fresh load (no session) — hasPerm/hasAnyPerm return false for everything", async () => {
    const { sandbox } = loadAdminJsSandbox();
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "view"), false);
    assert.strictEqual(sandbox.hasPerm("academic_structure", "u1", null, "edit"), false);
    assert.strictEqual(sandbox.hasAnyPerm("resources"), false);
  });

  await testAsync("lock failure keeps currentProfile null → hasPerm is false", async () => {
    const staff = staffRow();
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 1, user_id: "u-staff", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: false, session_token: null }, error: { message: "lock held by another admin" } } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "view"), false, "عند فشل القفل يجب ألا تُمنح أي صلاحية");
    assert.strictEqual(sandbox.hasAnyPerm("reports"), false);
    assert.ok(sandbox.document.getElementById("login-error").textContent.includes("يوجد مسؤول آخر"), "عند فشل القفل يجب عرض رسالة 'يوجد مسؤول آخر' في شاشة الدخول");
    assert.strictEqual(sandbox.document.getElementById("dashboard").hidden, true, "الداشبورد يجب ألا يظهر عند فشل القفل");
  });

  await testAsync("inactive profile → log in refused and all permissions denied", async () => {
    const staff = { id: "u-off", email: "off@afoq.test", role: "staff", active: false };
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-off", email: "off@afoq.test" });
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "view"), false, "حساب معطَّل يجب ألا يملك أي صلاحية");
    assert.strictEqual(sandbox.hasAnyPerm("academic_structure"), false);
  });

  await testAsync("staff with a global reports/view grant → only that global action is allowed", async () => {
    const staff = staffRow();
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 1, user_id: "u-staff", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t1" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });

    assert.strictEqual(sandbox.hasPerm("reports", null, null, "view"), true, "global reports/view");
    assert.strictEqual(sandbox.hasPerm("reports", "u1", "f1", "view"), true, "المنح العام يغطي أي جامعة/كلية");
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "edit"), false, "view لا يمنح edit");
    assert.strictEqual(sandbox.hasAnyPerm("reports"), true);
    assert.strictEqual(sandbox.hasAnyPerm("courses"), false, "لا صلاحيات للدورات");
    assert.strictEqual(sandbox.hasPerm("courses", null, null, "view"), false);
  });

  await testAsync("staff with a university-scoped grant → limited to that university only", async () => {
    const staff = staffRow();
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 2, user_id: "u-staff", entity_type: "academic_structure", action: "edit", scope_type: "university", scope_id: "u1", scope_faculty_id: null, active: true }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t2" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });

    assert.strictEqual(sandbox.hasPerm("academic_structure", "u1", null, "edit"), true);
    assert.strictEqual(sandbox.hasPerm("academic_structure", "u2", null, "edit"), false, "المنح لجامعة معينة لا يشمل جامعة أخرى");
    assert.strictEqual(sandbox.hasPerm("academic_structure", "u1", null, "delete"), false);
    assert.strictEqual(sandbox.hasAnyPerm("academic_structure"), true);
  });

  await testAsync("staff with a faculty-scoped grant → allowed only on that faculty", async () => {
    const staff = staffRow();
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 3, user_id: "u-staff", entity_type: "resources", action: "delete", scope_type: "faculty", scope_id: null, scope_faculty_id: "f1", active: true }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t3" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });

    assert.strictEqual(sandbox.hasPerm("resources", "u1", "f1", "delete"), true);
    assert.strictEqual(sandbox.hasPerm("resources", "u1", "f2", "delete"), false, "المنح لكلية معينة لا يشمل كلية أخرى");
    assert.strictEqual(sandbox.hasPerm("resources", null, null, "delete"), false, "فشل بدون facultyId محدد");
    assert.strictEqual(sandbox.hasAnyPerm("resources"), true);
  });

  await testAsync("inactive permission rows are ignored (active:false)", async () => {
    const staff = staffRow();
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 4, user_id: "u-staff", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: false }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t4" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "view"), false, "الصلاحية غير النشطة لا تُمنح");
    assert.strictEqual(sandbox.hasAnyPerm("reports"), false);
  });

  await testAsync("super_admin bypasses permission rows entirely", async () => {
    const superUser = staffRow("u-super", "super_admin", true, "super@afoq.test");
    const { sandbox } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [superUser], error: null },
        user_permissions: { data: [], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t5" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-super", email: "super@afoq.test" });

    assert.strictEqual(sandbox.hasPerm("academic_structure", "u1", null, "delete"), true);
    assert.strictEqual(sandbox.hasPerm("courses", "u2", "f9", "edit"), true);
    assert.strictEqual(sandbox.hasPerm("resources", null, null, "view"), true);
    assert.strictEqual(sandbox.hasPerm("reports", null, null, "edit"), true);
    assert.strictEqual(sandbox.hasAnyPerm("reports"), true);
  });

  await testAsync("authorization loads only the current profile (eq id) — same query parity as fn_has_permission path", async () => {
    const staff = staffRow();
    const { sandbox, calls } = loadAdminJsSandbox({
      resultsByTable: {
        profiles: { data: [staff], error: null },
        user_permissions: { data: [{ id: 5, user_id: "u-staff", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true }], error: null },
      },
      rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "t6" }, error: null } },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-staff", email: "staff@afoq.test" });

    const profileEqs = calls.filter((c) => c.op === "eq" && c.table === "profiles" && c.col === "id");
    assert.strictEqual(profileEqs.length, 1, "ملف adm الصلاحيات يُحمَّل مرة واحدة مع فلتر eq(id)");
    assert.strictEqual(profileEqs[0].val, "u-staff");
    assert.ok(calls.some((c) => c.op === "eq" && c.table === "user_permissions" && c.col === "user_id" && c.val === "u-staff"), "الصلاحيات تُحمَّل للـ user_id الحالي فقط");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();