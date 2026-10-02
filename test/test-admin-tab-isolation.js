/**
 * test-admin-tab-isolation.js
 * ------------------------------------------------------------------
 * P-B v3 — عزل الجلسات وتنسيق التبويبات في لوحة التحكم
 * ------------------------------------------------------------------
 * يغطّي ما لا يغطّيه test-admin-signout-scope.js:
 *
 *   1) heartbeat: لا signOut ولا ادّعاء على فشل الشبكة أو سبب مجهول —
 *      القفل لا يُعدّ مفقودًا إلا بسبب صريح مُعدَّد من القاعدة.
 *   2) acquireAdminLock(): يُرجع reason الحقيقي ويُشتقّ منه النصّ.
 *   3) التنسيق بين التبويبات: storage + onAuthStateChange +
 *      BroadcastChannel، وكلها مفلترة بـ user_id.
 *   4) تبدّل user_id = فقدان جلسة كامل.
 *   5) إعادة المحاولة: مرة واحدة فقط، بحارس in-flight وزر يدوي — لا حلقة.
 *
 * التشغيل: node test/test-admin-tab-isolation.js
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
    tagName, hidden: true, disabled: false, className: "", value: "", checked: false, open: false,
    selected: false, options: [], dataset: {}, style: {}, _attrs: {}, _children: [], _listeners: {},
    _textContent: "", _innerHTML: "",
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, cb) { (this._listeners[t] = this._listeners[t] || []).push(cb); },
    appendChild(c) { this._children.push(c); return c; }, insertBefore(c) { this._children.unshift(c); return c; },
    remove() {}, reset() { this.value = ""; }, scrollIntoView() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    classList: { _set: new Set(), add(...cs) { cs.forEach((c) => this._set.add(c)); }, remove(...cs) { cs.forEach((c) => this._set.delete(c)); }, contains(c) { return this._set.has(c); } },
  };
  Object.defineProperty(el, "textContent", { get() { return this._textContent; }, set(v) { this._textContent = v; } });
  Object.defineProperty(el, "innerHTML", { get() { return this._innerHTML; }, set(v) { this._innerHTML = v; this._children = []; } });
  return el;
}

const STORAGE_KEY = "sb-abcdefghijklmnop-auth-token";

function loadTabSandbox({ rpcResults = {}, session = null, supabaseUrl = "https://abcdefghijklmnop.supabase.co" } = {}) {
  const signOutCalls = [];
  const calls = [];
  const authStateHandlers = [];
  const intervals = [];
  const channels = [];
  const storageListeners = [];
  const warnings = [];
  const counters = { getSession: 0 };

  class FakeBroadcastChannel {
    constructor(name) { this.name = name; this.onmessage = null; this.posted = []; channels.push(this); }
    postMessage(msg) { this.posted.push(msg); }
    close() {}
  }

  const supabase = {
    supabaseUrl,
    from(table) {
      const chain = {
        select() { return chain; }, eq() { return chain; }, order() { return chain; },
        range() { return chain; }, limit() { return chain; },
        maybeSingle() { chain._single = true; return chain; },
        single() { chain._single = true; return chain; },
        insert() { return chain; }, update() { return chain; }, delete() { return chain; },
        then(resolve) { resolve({ data: chain._single ? null : [], error: null }); },
      };
      return chain;
    },
    rpc: async (fn, params) => {
      calls.push({ op: "rpc", fn, params });
      return rpcResults[fn] || { data: null, error: { message: "unmocked" } };
    },
    auth: {
      getSession: async () => { counters.getSession++; return { data: { session }, error: null }; },
      onAuthStateChange: (cb) => { authStateHandlers.push(cb); return { data: { subscription: {} } }; },
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

  // سجلّ معرّفات admin/index.html الحقيقية: getElementById يجب أن يعيد
  // null لمعرّف غير موجود كما يفعل DOM فعلًا. هذا ما يجعل زر إعادة
  // المحاولة (الذي ينشئه admin.js بنفسه) يعمل كما في المتصفح.
  const registry = {};
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "admin", "index.html"), "utf-8");
  for (const m of htmlSource.matchAll(/\bid="([^"]+)"/g)) registry[m[1]] = makeElement();
  const created = [];
  const document = {
    getElementById: (id) => {
      const hit = created.find((e) => e.id === id);
      if (hit) return hit;
      return registry[id] || null;
    },
    createElement: (tag) => { const el = makeElement(String(tag).toUpperCase()); created.push(el); return el; },
    createTextNode: () => ({}),
    querySelector: () => makeElement(),
    querySelectorAll: () => [],
  };

  const sandbox = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: (m) => warnings.push(m) },
    document,
    window: {
      addEventListener: (type, cb) => { if (type === "storage") storageListeners.push(cb); },
    },
    BroadcastChannel: FakeBroadcastChannel,
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    confirm: () => true,
    URL, URLSearchParams, Date,
    setTimeout, clearTimeout,
    // نقف التقاط نبضات القفل بدل تنفيذها تلقائيًا: نجعل الفحص حتميًا.
    setInterval: (cb, ms) => { intervals.push({ cb, ms }); return intervals.length; },
    clearInterval: () => {},
    showToast: () => {},
    SUBJECT_SEMESTER_LABELS: { first: "أ", second: "ب", summer: "ص" },
    LANGUAGE_LABELS: { ar: "عربي", en: "English" },
    supabaseClient: supabase,
  });

  vm.runInContext(adminJsSource, sandbox, { filename: "admin.js" });

  // checkAuthAndInit() يعمل عند التحميل غير مُنتظر؛ نُصفّر العدّاد بعد
  // استقراره حتى لا تُقاس استدعاءات الإقلاع ضمن عدّادات الفحوص.
  return {
    sandbox, document, supabase, signOutCalls, calls, authStateHandlers,
    intervals, channels, storageListeners, warnings, counters,
    async settle() { await new Promise((r) => setTimeout(r, 0)); counters.getSession = 0; },
    lastHeartbeat: async () => {
      const beat = intervals[intervals.length - 1];
      await beat.cb();
    },
    emitStorage(evt) { storageListeners.forEach((cb) => cb(evt)); },
    emitChannel(msg) { channels.forEach((c) => { if (c.onmessage) c.onmessage({ data: msg }); }); },
    emitAuth(event, sess) { authStateHandlers.forEach((cb) => cb(event, sess)); },
  };
}

const sessionFor = (id) => ({ user: { id }, access_token: "t", expires_at: 0 });

(async () => {
  console.log("AFOQ P-B admin tab isolation — Tests\n");

  // ================= 1) acquireAdminLock: reason حقيقي =================

  const REASONS = [
    ["locked", "هذا الحساب مفتوح حاليًا في تبويب أو جهاز آخر."],
    ["not_authorized", "هذا الحساب لا يملك صلاحية دخول لوحة التحكم."],
    ["mfa_aal2_required", "يلزم إتمام التحقق بخطوتين للمتابعة."],
    ["unauthenticated", "انتهت جلستك، سجّل الدخول من جديد."],
  ];

  for (const [reason, message] of REASONS) {
    await testAsync(`acquire — reason "${reason}" maps to its own approved message`, async () => {
      const h = loadTabSandbox({
        rpcResults: { acquire_admin_session_lock: { data: { acquired: false, reason }, error: null } },
      });
      const res = await h.sandbox.acquireAdminLock();
      assert.strictEqual(res.acquired, false, "acquired must be false");
      assert.strictEqual(res.reason, reason, "the RPC's own reason must be passed through untouched");
      assert.strictEqual(res.message, message, "the message must match the approved wording");
    });
  }

  await testAsync("acquire — RPC error yields the unverified message, never 'locked'", async () => {
    const h = loadTabSandbox({
      rpcResults: { acquire_admin_session_lock: { data: null, error: { message: "network" } } },
    });
    const res = await h.sandbox.acquireAdminLock();
    assert.strictEqual(res.reason, null, "no reason may be invented when the RPC failed");
    assert.strictEqual(res.message, "تعذّر التحقق من قفل الجلسة. حاول مجددًا.");
    assert.ok(!/مفتوح حاليًا/.test(res.message),
      "a failed RPC must never be reported as 'open elsewhere'");
  });

  await testAsync("acquire — an unknown reason falls back to the unverified message", async () => {
    const h = loadTabSandbox({
      rpcResults: { acquire_admin_session_lock: { data: { acquired: false, reason: "brand_new" }, error: null } },
    });
    const res = await h.sandbox.acquireAdminLock();
    assert.strictEqual(res.reason, "brand_new", "the raw reason is still reported for diagnostics");
    assert.strictEqual(res.message, "تعذّر التحقق من قفل الجلسة. حاول مجددًا.");
  });

  // ================= 2) heartbeat =================

  const acquired = { rpcResults: { acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null } } };

  await testAsync("heartbeat — explicit reason not_owner_or_expired ends the session locally", async () => {
    const rpc = Object.assign({}, acquired.rpcResults);
    const h = loadTabSandbox({ rpcResults: rpc });
    await h.sandbox.acquireAdminLock();
    rpc.refresh_admin_session_lock = { data: { ok: false, reason: "not_owner_or_expired" }, error: null };
    await h.lastHeartbeat();
    assert.strictEqual(h.signOutCalls.length, 1, "an explicit reason is proof the lock was lost");
    assert.strictEqual(h.signOutCalls[0][0].scope, "local",
      "losing a lock we owned must be scoped to 'local'");
    assert.ok(/تم إنهاء جلستك الحالية/.test(h.document.getElementById("login-error").textContent),
      "the approved lock-lost wording must be shown");
  });

  await testAsync("heartbeat — explicit reason mfa_aal2_required ends the session with ITS message", async () => {
    const rpc = Object.assign({}, acquired.rpcResults);
    const h = loadTabSandbox({ rpcResults: rpc });
    await h.sandbox.acquireAdminLock();
    rpc.refresh_admin_session_lock = { data: { ok: false, reason: "mfa_aal2_required" }, error: null };
    await h.lastHeartbeat();
    assert.strictEqual(h.signOutCalls.length, 1, "an explicit reason must end the session");
    assert.ok(/إتمام التحقق بخطوتين/.test(h.document.getElementById("login-error").textContent),
      "the AAL2 message must be shown, not the generic lock-lost one");
  });

  for (const [label, response] of [
    ["network error", { data: null, error: { message: "Failed to fetch" } }],
    ["empty data", { data: null, error: null }],
    ["unknown reason", { data: { ok: false, reason: "who_knows" }, error: null }],
  ]) {
    await testAsync(`heartbeat — ${label} keeps the lock and does NOT sign out`, async () => {
      const rpc = Object.assign({}, acquired.rpcResults);
      const h = loadTabSandbox({ rpcResults: rpc });
      await h.sandbox.acquireAdminLock();
      const before = h.calls.filter((c) => c.fn === "refresh_admin_session_lock").length;
      rpc.refresh_admin_session_lock = response;
      await h.lastHeartbeat();
      assert.strictEqual(h.signOutCalls.length, 0,
        `${label} proves nothing about the lock — it must not end the session`);
      assert.ok(!/مفتوح حاليًا/.test(h.document.getElementById("login-error").textContent),
        `${label} must not be reported as 'open elsewhere'`);
      // الدليل على أن القفل لم يُسقَط: نبضة أخرى ما زالت تحاول التحديث.
      await h.lastHeartbeat();
      const after = h.calls.filter((c) => c.fn === "refresh_admin_session_lock").length;
      assert.strictEqual(after, before + 2,
        "the heartbeat must keep refreshing on the next beat instead of dropping the lock");
    });
  }

  await testAsync("heartbeat — ok:true changes nothing", async () => {
    const rpc = Object.assign({}, acquired.rpcResults);
    const h = loadTabSandbox({ rpcResults: rpc });
    await h.sandbox.acquireAdminLock();
    rpc.refresh_admin_session_lock = { data: { ok: true }, error: null };
    await h.lastHeartbeat();
    assert.strictEqual(h.signOutCalls.length, 0, "a successful refresh must not sign out");
  });

  // ================= 3) storage =================

  await testAsync("storage — the auth key is derived from the client URL, not hard-coded", async () => {
    const h = loadTabSandbox();
    assert.strictEqual(h.sandbox.deriveAuthStorageKey(), STORAGE_KEY);
    assert.strictEqual(h.storageListeners.length, 1, "exactly one storage listener must be registered");
  });

  await testAsync("storage — a failure to derive the key is PARTIAL, not fatal", async () => {
    // supabaseUrl=null يجعل new URL(...) يفشل: هذا هو مسار PARTIAL الذي
    // يجب تسجيله في الـLedger، لا أن يُخمَّل مفتاح من الهواء.
    const h = loadTabSandbox({ supabaseUrl: null });
    assert.strictEqual(h.sandbox.deriveAuthStorageKey(), null, "no invented key when derivation fails");
    assert.strictEqual(h.storageListeners.length, 0, "the listener is skipped rather than guessed");
    // المساران الآخران يظلان يعملان:
    assert.strictEqual(h.channels.length, 1, "BroadcastChannel must still be wired");
    assert.ok(h.authStateHandlers.length > 0, "onAuthStateChange must still be wired");
  });

  await testAsync("storage — same user losing the session shows the unauthenticated message", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitStorage({ key: STORAGE_KEY, newValue: null });
    assert.ok(/انتهت جلستك/.test(h.document.getElementById("login-error").textContent),
      "the session-ended message must be shown");
    assert.strictEqual(h.document.getElementById("dashboard").hidden, true,
      "the dashboard must be hidden");
    assert.strictEqual(h.signOutCalls.length, 0,
      "the session is already gone — signOut here would be pointless and wrong");
  });

  await testAsync("storage — an unrelated storage event is ignored", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitStorage({ key: "some_other_app", newValue: null });
    h.emitStorage({ key: STORAGE_KEY, newValue: '{"new":"value"}' });
    assert.strictEqual(h.document.getElementById("dashboard").hidden, true,
      "unrelated keys and non-deleted values must not disturb this tab");
  });

  await testAsync("storage — an event with no known session has no effect", async () => {
    const h = loadTabSandbox();
    await h.settle();
    h.emitStorage({ key: STORAGE_KEY, newValue: null });
    assert.strictEqual(h.signOutCalls.length, 0, "no session means nothing to tear down");
  });

  // ================= 4) onAuthStateChange =================

  await testAsync("auth — a null session after a known one is treated as session loss", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitAuth("SIGNED_OUT", null);
    assert.ok(/انتهت جلستك/.test(h.document.getElementById("login-error").textContent));
    assert.strictEqual(h.document.getElementById("dashboard").hidden, true);
  });

  await testAsync("auth — a DIFFERENT user_id is a full session loss (decision 6)", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitAuth("SIGNED_IN", sessionFor("u-2"));
    assert.ok(/انتهت جلستك/.test(h.document.getElementById("login-error").textContent),
      "switching accounts must tear the old identity down");
    assert.strictEqual(h.document.getElementById("dashboard").hidden, true,
      "no dashboard may survive an identity change");
    // ثم التأكد أن المعرّف الجديد هو المعتمد بعد ذلك
    h.sandbox.broadcastToAdminTabs("lock-released");
    const posted = h.channels[0].posted[h.channels[0].posted.length - 1];
    assert.strictEqual(posted.user_id, "u-2", "only the new identity may be broadcast afterwards");
  });

  await testAsync("auth — the SAME user_id does not tear anything down", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitAuth("TOKEN_REFRESHED", sessionFor("u-1"));
    assert.notStrictEqual(h.document.getElementById("login-error").textContent, "انتهت جلستك، سجّل الدخول من جديد.",
      "a routine token refresh must not look like a session loss");
  });

  // ================= 5) BroadcastChannel =================

  await testAsync("channel — a peer for the SAME user releasing the lock retries exactly once", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitChannel({ type: "lock-released", tab_id: "other-tab", user_id: "u-1" });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 1, "exactly one retry attempt, no loop");
  });

  await testAsync("channel — the in-flight guard blocks a second concurrent retry", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    // نصلان نداءين متزامنين قبل أن تكتمل المحاولة الأولى.
    h.emitChannel({ type: "lock-released", tab_id: "a", user_id: "u-1" });
    h.emitChannel({ type: "lock-released", tab_id: "b", user_id: "u-1" });
    h.emitChannel({ type: "lock-released", tab_id: "c", user_id: "u-1" });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 1,
      "the in-flight guard must collapse concurrent retries into a single attempt");
  });

  await testAsync("channel — a peer for a DIFFERENT user is ignored entirely", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitChannel({ type: "lock-released", tab_id: "x", user_id: "u-999" });
    h.emitChannel({ type: "session-ended", tab_id: "x", user_id: "u-999" });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 0, "another account's tabs must not disturb us");
    assert.strictEqual(h.signOutCalls.length, 0, "and must never cause a signOut here");
  });

  await testAsync("channel — our own echo is ignored", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.sandbox.broadcastToAdminTabs("lock-released");
    const own = h.channels[0].posted[h.channels[0].posted.length - 1];
    assert.strictEqual(own.user_id, "u-1", "the broadcast must carry our own user_id");
    h.emitChannel(own);
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 0, "a tab must not react to its own message");
  });

  await testAsync("channel — lock-acquired is informational and triggers nothing", async () => {
    const h = loadTabSandbox({ session: sessionFor("u-1") });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    h.emitChannel({ type: "lock-acquired", tab_id: "x", user_id: "u-1" });
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 0, "a peer taking the lock is not a retry trigger");
    assert.strictEqual(h.signOutCalls.length, 0, "nor a reason to end this session");
  });

  await testAsync("channel — acquiring the lock broadcasts it with our user_id", async () => {
    const h = loadTabSandbox({
      session: sessionFor("u-1"),
      rpcResults: {
        acquire_admin_session_lock: { data: { acquired: true, session_token: "tok-1" }, error: null },
      },
    });
    await h.settle();
    h.emitAuth("SIGNED_IN", sessionFor("u-1"));
    await h.sandbox.acquireAdminLock();
    const posted = h.channels[0].posted[h.channels[0].posted.length - 1];
    assert.ok(posted, "acquiring the lock must broadcast to peer tabs");
    assert.strictEqual(posted.type, "lock-acquired");
    assert.strictEqual(posted.user_id, "u-1");
  });

  // ================= 6) زر إعادة المحاولة اليدوي =================

  await testAsync("retry — a refused lock offers a visible manual retry button", async () => {
    const h = loadTabSandbox({
      rpcResults: { acquire_admin_session_lock: { data: { acquired: false, reason: "locked" }, error: null } },
    });
    await h.sandbox.enterDashboardWithLock("a@afoq.test");
    const btn = h.document.getElementById("login-retry-btn");
    assert.ok(btn, "the retry button must exist");
    assert.strictEqual(btn.hidden, false, "the retry button must be visible on a refusal");
    assert.ok(btn._listeners.click && btn._listeners.click.length === 1,
      "exactly one click handler — no loop, no timer");
  });

  await testAsync("retry — clicking the button attempts once and re-enables", async () => {
    const h = loadTabSandbox({
      rpcResults: { acquire_admin_session_lock: { data: { acquired: false, reason: "locked" }, error: null } },
    });
    await h.sandbox.enterDashboardWithLock("a@afoq.test");
    await h.settle();
    const btn = h.document.getElementById("login-retry-btn");
    await btn._listeners.click[0]();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(h.counters.getSession, 1, "one click, one attempt");
    assert.strictEqual(btn.disabled, false, "the button must be re-enabled for a second manual try");
  });

  await testAsync("retry — a normal login screen hides the retry button again", async () => {
    const h = loadTabSandbox({
      rpcResults: { acquire_admin_session_lock: { data: { acquired: false, reason: "locked" }, error: null } },
    });
    await h.sandbox.enterDashboardWithLock("a@afoq.test");
    assert.strictEqual(h.document.getElementById("login-retry-btn").hidden, false);
    h.sandbox.showLogin();
    assert.strictEqual(h.document.getElementById("login-retry-btn").hidden, true,
      "the button must not linger on a plain login screen");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
