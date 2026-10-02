/**
 * test-admin-signout-scope.js
 * ------------------------------------------------------------------
 * Regression — ADMIN-FIX-1 + P-B v3 (نطاق signOut في لوحة التحكم):
 *
 * ADMIN-FIX-1 كان يثبّت ثلاثة مواضع بـscope:"local". قرار P-B (ب) يقلب
 * اثنين منها إلى **لا signOut إطلاقًا**، لأن قاعدة P-B هي: التبويب الذي
 * لم يملك القفل لا يستدعي signOut — فجلسة حيّة في تبويب آخر أو على جهاز
 * آخر يجب ألا تُنزع.:
 *
 *   - فشل acquire        : كان signOut محلي  -> الآن صفر استدعاء
 *   - فشل تحميل profiles  : كان signOut محلي  -> الآن صفر استدعاء
 *   - forceLockLogout     : signOut محلي      -> يبقى (كان يملك القفل وفقده)
 *
 * ويبقى بلا scope عمدًا (ومقصود): تعطيل الحساب، والخروج اليدوي — كلاهما
 * إبطال شامل بنيّة المستخدم لا فشل عابر.
 *
 * الفحص مزدوج:
 *   (أ) سلوكي — تشغيل admin/admin.js داخل vm sandbox مع supabaseClient
 *       وهمي يسجّل وسائط signOut، ثم استدعاء المسارات فعليًا.
 *   (ب) ثابت — تثبيت عدد/مواضع استدعاءات signOut في المصدر.
 *
 * التشغيل: node test/test-admin-signout-scope.js
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

function test(name, fn) {
  try {
    fn();
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

// supabaseClient وهمي: signOut يسجّل الوسائط التي استُدعيت بها فعليًا
function loadSandbox({ rpcResults = {}, resultsByTable = {}, session = null } = {}) {
  const signOutCalls = [];
  const calls = [];
  const authStateHandlers = [];

  const supabase = {
    // مطلوب لـderiveAuthStorageKey(): بدونه يعود null ويُتخطّى مستمع storage
    supabaseUrl: "https://abcdefghijklmnop.supabase.co",
    from(table) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, order() { return chain; },
        range() { return chain; }, limit() { return chain; },
        maybeSingle() { chain._single = true; return chain; },
        single() { chain._single = true; return chain; },
        insert() { return chain; }, update() { return chain; }, delete() { return chain; },
        then(resolve) {
          const result = resultsByTable[table] || { data: [], error: null };
          const rows = result.data || [];
          resolve({
            data: chain._single ? (rows[0] || null) : rows,
            error: result.error || null,
          });
        },
      };
      return chain;
    },
    rpc: async (fn, params) => {
      calls.push({ op: "rpc", fn, params });
      return rpcResults[fn] || { data: null, error: { message: "unmocked" } };
    },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      onAuthStateChange: (_cb) => { authStateHandlers.push(_cb); return { data: { subscription: {} } }; },
      // ---- نقطة الفحص الأساسية: نسجّل الوسائط كما وصلت ----
      signOut: async (...args) => { signOutCalls.push(args); return { error: null }; },
      signInWithPassword: async () => ({ data: { user: null }, error: { message: "unmocked" } }),
      mfa: {
        listFactors: async () => ({ data: { totp: [] }, error: null }),
        getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" }, error: null }),
        challenge: async () => ({ data: { id: "c" }, error: null }),
        verify: async () => ({ data: null, error: null }),
      },
    },
  };

  const registry = {};
  const document = {
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(String(tag).toUpperCase()),
    createTextNode: () => ({}),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
  };

  const storageListeners = [];
  const windowStub = {
    addEventListener: (type, cb) => { if (type === "storage") storageListeners.push(cb); },
  };

  const sandbox = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: () => {} },
    document,
    window: windowStub,
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    confirm: () => true,
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval: () => {},
    showToast: () => {},
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "English" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });
  return { sandbox, signOutCalls, calls, document, authStateHandlers, storageListeners };
}

// استخراج جسم دالة من المصدر، ليبقى الفحص ثابتًا وغير هشّ أمام تغيّر
// أرقام الأسطر.
// يزيل التعليقات قبل الفحص: كلمة "signOut" مذكورة في تعليقات تشرح
// سبب عدم استدعائها، والفحص هنا عن *الاستدعاءات* لا عن الكلام عنها.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function functionBody(name) {
  const start = adminJsSource.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name}() must exist in admin/admin.js`);
  const braceStart = adminJsSource.indexOf("{", start);
  let depth = 0;
  for (let i = braceStart; i < adminJsSource.length; i++) {
    if (adminJsSource[i] === "{") depth++;
    else if (adminJsSource[i] === "}") {
      depth--;
      if (depth === 0) return adminJsSource.slice(braceStart, i + 1);
    }
  }
  assert.fail(`could not extract the body of ${name}()`);
}

function codeOf(name) {
  return stripComments(functionBody(name));
}

const LOCKED_MSG = "هذا الحساب مفتوح حاليًا في تبويب أو جهاز آخر.";

(async () => {
  console.log("AFOQ Admin signOut scope (ADMIN-FIX-1 + P-B) — Regression Tests\n");

  // ================= (أ) فحوص سلوكية =================

  await testAsync("behavior — acquire failure does NOT call signOut at all (P-B)", async () => {
    // قاعدة P-B (ب): هذا التبويب لم يملك القفل، فأي signOut كان يخلع جلسة
    // قد تكون حيّة في تبويب آخر لنفس الحساب أو على جهاز آخر.
    const { sandbox, signOutCalls } = loadSandbox({
      rpcResults: {
        acquire_admin_session_lock: { data: { acquired: false, reason: "locked" }, error: null },
      },
    });
    await sandbox.enterDashboardWithLock("admin@afoq.test");
    assert.strictEqual(signOutCalls.length, 0,
      "acquire failure must NOT call signOut — this tab never held the lock");
  });

  await testAsync("behavior — acquire failure still refuses to show the dashboard", async () => {
    // الضمان الأمني الذي طلب التفويض الحفاظ عليه: session بلا قفل لا تدخل.
    const { sandbox, document } = loadSandbox({
      rpcResults: {
        acquire_admin_session_lock: { data: { acquired: false, reason: "locked" }, error: null },
      },
    });
    await sandbox.enterDashboardWithLock("admin@afoq.test");
    assert.strictEqual(document.getElementById("dashboard").hidden, true,
      "dashboard must stay hidden when the lock was not acquired");
    assert.ok(document.getElementById("login-error").textContent.includes("هذا الحساب مفتوح"),
      "the refusal message must still be shown on acquire failure");
  });

  await testAsync("behavior — forceLockLogout (lock lost after owning it) signs out with scope:'local'", async () => {
    const { sandbox, signOutCalls } = loadSandbox();
    await sandbox.forceLockLogout("terminated");
    assert.strictEqual(signOutCalls.length, 1, "forceLockLogout must call signOut exactly once");
    assert.strictEqual(signOutCalls[0].length, 1, "signOut must receive exactly one options argument");
    assert.strictEqual(signOutCalls[0][0].scope, "local",
      "forceLockLogout must be scoped to 'local' so other devices keep their sessions");
  });

  await testAsync("behavior — forceLockLogout does not release the lock it already lost", async () => {
    // سلوك غير متغيّر: لا release في forceLockLogout (حماية من سباق F5).
    const { sandbox, calls } = loadSandbox();
    await sandbox.forceLockLogout("terminated");
    assert.ok(!calls.some((c) => c.op === "rpc" && c.fn === "release_admin_session_lock"),
      "forceLockLogout must NOT call release_admin_session_lock");
  });

  await testAsync("behavior — profile-load failure does NOT call signOut (P-B)", async () => {
    // ADMIN-FIX-1 كان يوقّعه بـscope:"local". P-B (3): الاستدعاء يسبق
    // enterDashboardWithLock، فهذا التبويب لم يستحوذ على قفل بعد.
    const { sandbox, signOutCalls, document } = loadSandbox();
    await sandbox.loadCurrentUserAuthorization({ id: "u-1", email: "a@afoq.test" });
    assert.strictEqual(signOutCalls.length, 0,
      "profile-load failure must NOT call signOut — no lock was ever acquired here");
    assert.ok(document.getElementById("login-error").textContent.includes("تعذّر تحميل صلاحيات"),
      "the profile-load failure must be shown as an error message");
  });

  await testAsync("behavior — inactive account stays UNSCOPED (deliberate deactivation)", async () => {
    // إبطال شامل مقصود: تعطيل الحساب قرار إداري يجب أن يُخرج من كل الأجهزة.
    const { sandbox, signOutCalls, document } = loadSandbox({
      resultsByTable: {
        profiles: { data: [{ id: "u-1", email: "a@afoq.test", role: "super_admin", active: false }], error: null },
      },
    });
    await sandbox.loadCurrentUserAuthorization({ id: "u-1", email: "a@afoq.test" });
    assert.strictEqual(signOutCalls.length, 1, "inactive-account path must call signOut exactly once");
    assert.strictEqual(signOutCalls[0].length, 0,
      "inactive-account signOut must receive NO options (scope must stay global)");
    assert.strictEqual(signOutCalls[0][0], undefined,
      "inactive-account signOut must not receive a scope option");
    assert.ok(document.getElementById("login-error").textContent.includes("معطَّل"),
      "the inactive-account message must still be shown");
  });

  await testAsync("behavior — manual logout stays UNSCOPED", async () => {
    const { sandbox, document, signOutCalls } = loadSandbox();
    const btn = document.getElementById("logout-btn");
    assert.ok(btn._listeners.click && btn._listeners.click.length === 1,
      "logout button must have exactly one click handler");
    await btn._listeners.click[0]();
    assert.strictEqual(signOutCalls.length, 1, "manual logout must call signOut exactly once");
    assert.strictEqual(signOutCalls[0].length, 0,
      "manual logout must call signOut() with NO arguments (scope intentionally unchanged)");
    assert.strictEqual(signOutCalls[0][0], undefined,
      "manual logout must not receive a scope option");
  });

  // ================= (ب) فحوص ثابتة على المصدر =================

  test("source — forceLockLogout() uses signOut({ scope: \"local\" })", () => {
    const body = codeOf("forceLockLogout");
    assert.ok(body.includes('signOut({ scope: "local" })'),
      "forceLockLogout must call signOut with scope:'local'");
    assert.ok(!/signOut\(\s*\)/.test(body),
      "forceLockLogout must not contain a bare signOut() call");
  });

  test("source — enterDashboardWithLock() contains NO signOut call (P-B)", () => {
    const body = codeOf("enterDashboardWithLock");
    assert.ok(!/signOut/.test(body),
      "enterDashboardWithLock must not call signOut at all — it never owned the lock");
  });

  test("source — the profile-failure branch has no signOut, the inactive branch keeps an unscoped one", () => {
    const body = codeOf("loadCurrentUserAuthorization");
    // نتأكد أن الفرعين متمايزان فعلاً في المصدر، لا أن العدد فقط صحيح.
    const failIdx = body.indexOf("profileError || !profile");
    const inactiveIdx = body.indexOf("!profile.active");
    assert.ok(failIdx > -1, "the profile-failure branch must exist");
    assert.ok(inactiveIdx > failIdx, "the inactive branch must come after the failure branch");

    const failBranch = body.slice(failIdx, inactiveIdx);
    const inactiveBranch = body.slice(inactiveIdx);

    assert.ok(!/signOut/.test(failBranch),
      "the profile-load-failure branch must contain no signOut call at all");

    assert.ok(/auth\.signOut\(\s*\)/.test(inactiveBranch),
      "the inactive-account branch must keep an UNSCOPED signOut()");
    assert.ok(!/signOut\(\{/.test(inactiveBranch),
      "the inactive-account branch must NOT gain a scope option");
  });

  test("source — exactly ONE scoped signOut call site remains (forceLockLogout)", () => {
    const matches = adminJsSource.match(/signOut\(\{\s*scope:\s*"local"\s*\}\)/g) || [];
    assert.strictEqual(matches.length, 1,
      "exactly 1 signOut call site may be scoped to 'local' " +
      "(forceLockLogout — the only site that follows a real lock acquisition)");
  });

  test("source — exactly two unscoped signOut() sites remain (inactive + manual logout)", () => {
    const bare = adminJsSource.match(/auth\.signOut\(\s*\)/g) || [];
    assert.strictEqual(bare.length, 2,
      "exactly 2 unscoped signOut() calls must remain (inactive-account, manual-logout)");
    assert.strictEqual((adminJsSource.match(/auth\.signOut\(/g) || []).length, 3,
      "admin/admin.js must contain exactly 3 signOut call sites (1 scoped + 2 intentionally unscoped)");
  });

  test("source — the inactive-account signOut() is not given a scope", () => {
    const idx = adminJsSource.indexOf('showLogin("هذا الحساب معطَّل');
    assert.ok(idx > -1, "the inactive-account message must exist");
    const block = adminJsSource.slice(idx, idx + 300);
    assert.ok(/auth\.signOut\(\s*\);/.test(block),
      "the inactive-account signOut() must stay unscoped");
  });

  test("source — the manual-logout signOut() is still unscoped and preceded by releaseAdminLock()", () => {
    const idx = adminJsSource.indexOf('document.getElementById("logout-btn")');
    assert.ok(idx > -1, "the logout button handler must exist");
    const block = adminJsSource.slice(idx, idx + 500);
    assert.ok(/await releaseAdminLock\(\);/.test(block),
      "manual logout must still release the lock first");
    assert.ok(/await supabaseClient\.auth\.signOut\(\s*\);/.test(block),
      "manual logout must still call an UNSCOPED signOut()");
    assert.ok(!/signOut\(\{/.test(block),
      "manual logout must not gain a scope option");
  });

  test("messages — all four M21 reason strings are present verbatim", () => {
    for (const reason of ["locked", "not_authorized", "mfa_aal2_required", "unauthenticated"]) {
      assert.ok(adminJsSource.includes(`${reason}:`),
        `the reason key "${reason}" must exist in LOCK_REFUSAL_MESSAGES`);
    }
    assert.ok(adminJsSource.includes(LOCKED_MSG),
      "the M21 approved 'locked' wording must be used verbatim");
    assert.ok(adminJsSource.includes('"تعذّر التحقق من قفل الجلسة. حاول مجددًا."'),
      "the approved unverified-fallback wording must be used verbatim");
  });

  test("messages — an unknown reason falls back to the unverified wording, never to 'locked'", () => {
    // السؤال الذي يميّز P-B: سبب مجهول يجب ألا يُنسب إلى «مفتوح في مكان آخر».
    const body = functionBody("lockRefusalMessage");
    assert.ok(body.includes("LOCK_REFUSAL_MESSAGES[reason]"),
      "the lookup must be by the RPC's own reason string");
    assert.ok(body.includes("|| LOCK_UNVERIFIED_MESSAGE"),
      "an unknown reason must fall back to LOCK_UNVERIFIED_MESSAGE");
  });

  test("scope — lock TTL, heartbeat and token key are untouched", () => {
    assert.ok(adminJsSource.includes("const LOCK_HEARTBEAT_MS = 25000;"),
      "heartbeat interval must remain 25000ms");
    assert.ok(adminJsSource.includes('const LOCK_TOKEN_STORAGE_KEY = "p17b_admin_session_lock_token"'),
      "sessionStorage token key must remain unchanged");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
