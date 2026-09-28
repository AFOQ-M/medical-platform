/**
 * test-admin-log-activity.js
 * ------------------------------------------------------------------
 * اختبارات PHASE 1 (M-logActivity) — موثوقية تسجيل نشاط لوحة التحكم.
 * تتحقق من:
 *   - static: تعريف logActivity() في admin/admin.js محصَّن (try/catch +
 *     console.error + return false — لا fire-and-forget صامت ولا رمي)؛
 *   - static: كل مواضع الاستدعاء الـ22 تستخدم await logActivity( ولا
 *     يبقى أي استدعاء عارٍ (غير منتظَر)؛
 *   - سلوكي (vm sandbox): مسار النجاح يُرجع true ويسجّل الحمولة الصحيحة؛
 *     مسار خطأ RLS يُرجع false ويسجّل console.error؛ مسار استثناء يُرجع
 *     false ويسجّل console.error دون رمي؛ غياب currentProfile يُرجع false
 *     دون استدعاء insert.
 *
 * التشغيل: node test/test-admin-log-activity.js
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

/* Mock مصغّر لـ supabaseClient: يكفي from(table).insert(payload) مع
 * نتائج قابلة للتحكم (نجاح / خطأ RLS / استثناء) + stubs لبقية الواجهة
 * حتى يُحمَّل admin.js كاملًا دون أخطاء (نفس نمط test-admin-reports.js). */
function makeLogSupabase({ insertResult = { error: null }, insertThrows = false } = {}) {
  const calls = [];
  const supabase = {
    from: (table) => ({
      insert: async (payload) => {
        calls.push({ table, payload });
        if (insertThrows) throw new Error("boom");
        return insertResult;
      },
    }),
    rpc: async () => ({ data: null, error: { message: "unmocked" } }),
    auth: {
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
    },
  };
  return { supabase, calls };
}

function setupSandbox({ insertResult, insertThrows } = {}) {
  const registry = {};
  const consoleErrors = [];
  const storageStore = {};
  const { supabase, calls } = makeLogSupabase({ insertResult, insertThrows });

  const document = {
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: () => ({}),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
    activeElement: null,
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
    showToast: () => {},
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "إنجليزي" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, consoleErrors, calls };
}

function setProfile(sandbox, profile) {
  vm.runInContext(`currentProfile = ${JSON.stringify(profile)};`, sandbox);
}

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — PHASE 1 M-logActivity Reliability Tests\n");

  // ---- static: التعريف محصَّن ----
  await testAsync("M-logActivity — definition has try/catch + console.error + return false", () => {
    const defStart = adminJsSource.indexOf("async function logActivity(");
    assert.ok(defStart !== -1, "يجب وجود تعريف async function logActivity");
    const defEnd = adminJsSource.indexOf("\n}", defStart);
    assert.ok(defEnd !== -1, "يجب إيجاد نهاية جسم الدالة");
    const defBody = adminJsSource.slice(defStart, defEnd);
    assert.ok(defBody.includes("try {"), "يجب وجود try داخل logActivity");
    assert.ok(defBody.includes("catch"), "يجب وجود catch داخل logActivity");
    assert.ok(defBody.includes("console.error"), "يجب تسجيل الفشل في console.error");
    assert.ok(defBody.includes("return false"), "يجب إرجاع false عند الفشل (لا رمي استثناء)");
  });

  // ---- static: كل مواضع الاستدعاء الـ22 await ----
  // 19 → 22: PHASE 4 أضاف 3 مواضع (warning_created/ban_created/ban_revoked).
  await testAsync("M-logActivity — all 22 call sites use await logActivity(", () => {
    const awaited = (adminJsSource.match(/await logActivity\(/g) || []).length;
    assert.strictEqual(awaited, 22, `يجب أن تكون كل الاستدعاءات await (وُجد ${awaited} من 22)`);
  });

  // ---- static: لا استدعاءات عارية (fire-and-forget) متبقية ----
  await testAsync("M-logActivity — no bare (un-awaited) logActivity( call remains", () => {
    const bare = adminJsSource.split("\n").filter((l) =>
      l.includes("logActivity(") && !l.includes("await logActivity(") && !l.includes("function logActivity(")
    );
    assert.strictEqual(bare.length, 0, `لا يجب بقاء استدعاءات غير منتظرة: ${bare.join(" | ")}`);
  });

  // ---- سلوكي: مسار النجاح ----
  await testAsync("M-logActivity — success path returns true and inserts correct payload", async () => {
    const env = setupSandbox({ insertResult: { error: null } });
    setProfile(env.sandbox, { id: "admin-1", email: "a@b.c", role: "super_admin", active: true });
    const ok = await vm.runInContext("logActivity('test_action','test_target','t1','تفاصيل')", env.sandbox);
    assert.strictEqual(ok, true, "يجب إرجاع true عند نجاح الإدراج");
    assert.strictEqual(env.calls.length, 1, "يجب استدعاء insert مرة واحدة");
    assert.strictEqual(env.calls[0].table, "admin_activity_log");
    // مقارنة حقل-بحقل (الكائن من realm آخر داخل vm — deepStrictEqual يفشل على النموذج الأولي)
    const p = env.calls[0].payload;
    assert.strictEqual(p.actor_user_id, "admin-1");
    assert.strictEqual(p.action, "test_action");
    assert.strictEqual(p.target_type, "test_target");
    assert.strictEqual(p.target_id, "t1");
    assert.strictEqual(p.details, "تفاصيل");
  });

  // ---- سلوكي: target_id/details فارغة تُخزَّن null ----
  await testAsync("M-logActivity — null target_id/details stored as null", async () => {
    const env = setupSandbox({ insertResult: { error: null } });
    setProfile(env.sandbox, { id: "admin-1", role: "super_admin", active: true });
    await vm.runInContext("logActivity('a','b',null,null)", env.sandbox);
    const p = env.calls[0].payload;
    assert.strictEqual(p.actor_user_id, "admin-1");
    assert.strictEqual(p.action, "a");
    assert.strictEqual(p.target_type, "b");
    assert.strictEqual(p.target_id, null);
    assert.strictEqual(p.details, null);
  });

  // ---- سلوكي: خطأ RLS من Supabase ----
  await testAsync("M-logActivity — RLS error returns false and logs console.error (no throw)", async () => {
    const env = setupSandbox({ insertResult: { error: { message: "RLS denied" } } });
    setProfile(env.sandbox, { id: "admin-1", role: "super_admin", active: true });
    const ok = await vm.runInContext("logActivity('a','b',null,null)", env.sandbox);
    assert.strictEqual(ok, false, "يجب إرجاع false عند خطأ RLS");
    assert.ok(env.consoleErrors.some((e) => e.includes("logActivity")), "يجب تسجيل الخطأ في console.error");
  });

  // ---- سلوكي: استثناء من insert ----
  await testAsync("M-logActivity — thrown exception returns false and logs console.error (no throw)", async () => {
    const env = setupSandbox({ insertThrows: true });
    setProfile(env.sandbox, { id: "admin-1", role: "super_admin", active: true });
    const ok = await vm.runInContext("logActivity('a','b',null,null)", env.sandbox);
    assert.strictEqual(ok, false, "يجب إرجاع false عند استثناء");
    assert.ok(env.consoleErrors.some((e) => e.includes("logActivity")), "يجب تسجيل الاستثناء في console.error");
  });

  // ---- سلوكي: غياب currentProfile ----
  await testAsync("M-logActivity — no currentProfile returns false without calling insert", async () => {
    const env = setupSandbox({ insertResult: { error: null } });
    const ok = await vm.runInContext("logActivity('a','b',null,null)", env.sandbox);
    assert.strictEqual(ok, false, "يجب إرجاع false بدون currentProfile");
    assert.strictEqual(env.calls.length, 0, "لا يجب استدعاء insert بدون currentProfile");
  });

  await flush();
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();