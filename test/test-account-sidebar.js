/**
 * test-account-sidebar.js
 * ------------------------------------------------------------------
 * اختبارات Regression لميزة "القائمة الجانبية للحساب + تسجيل الخروج"
 * (Sidebar / Drawer من اليمين تحل محل فتح نافذة تسجيل الدخول لمستخدم
 * Google مرتبط فعليًا، + زر تسجيل خروج حقيقي عبر Supabase signOut()).
 *
 * تُشغَّل بـNode العادي (لا حاجة لمتصفح حقيقي أو حساب Google فعلي) —
 * تحمّل js/auth.js فعليًا كما هو عبر vm.runInNewContext، بمحاكاة DOM أغنى
 * من test-google-auth-state.js (تدعم innerHTML القائم على id + التقاط
 * مستمعي الأحداث + تتبّع التركيز) لأن القائمة الجانبية تُبنى بالكامل عبر
 * innerHTML ثم querySelector/getElementById بمعرّفات فعلية، على عكس
 * نافذة المصادقة الأبسط.
 *
 * لا تستخدم أي حساب Google حقيقي ولا شبكة فعلية — كل استدعاءات Supabase
 * مُحاكاة (mocked) محليًا فقط.
 *
 * التشغيل: node test/test-account-sidebar.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const AUTH_JS_PATH = path.join(__dirname, "..", "js", "auth.js");
const authJsSource = fs.readFileSync(AUTH_JS_PATH, "utf-8");

let failures = 0;
let passed = 0;

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

/**
 * محاكاة DOM أغنى: تدعم innerHTML (تُحلَّل بحثًا عن id="..." فقط — كافٍ
 * لأن كل كود auth.js يصل للعناصر الديناميكية عبر id حصرًا)، والتقاط
 * مستمعي الأحداث الفعليين (بدل تجاهلها) حتى يمكن للاختبارات محاكاة
 * ضغطة/Escape/ضغط خارج القائمة فعليًا، وتتبّع focus()/activeElement.
 */
function loadAuthJsWithMockSession({ initialSession = null } = {}) {
  const domElements = {};
  const activeElementRef = { current: null };

  function makeElement(initialId, tagName = "DIV") {
    const el = {
      tagName,
      hidden: false,
      className: "",
      _attrs: {},
      _children: [],
      _listeners: {},
      alt: undefined,
      src: undefined,
      referrerPolicy: undefined,
      onerror: null,
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener(type, cb) {
        (this._listeners[type] = this._listeners[type] || []).push(cb);
      },
      appendChild(child) { this._children.push(child); return child; },
      replaceWith(node) { this._replacedWith = node; },
      focus() { activeElementRef.current = this; },
      querySelector(sel) {
        if (sel.startsWith("#")) return domElements[sel.slice(1)] || null;
        return this._children.find((c) => c.tagName === sel.toUpperCase()) || null;
      },
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        toggle(c, force) {
          const shouldHave = force !== undefined ? force : !this._classes.has(c);
          if (shouldHave) this._classes.add(c); else this._classes.delete(c);
        },
      },
    };
    Object.defineProperty(el, "textContent", {
      get() { return this._textContent || ""; },
      set(v) { this._textContent = v; if (v === "") this._children = []; },
    });
    // id: يُسجَّل العنصر في domElements المشترك فور تعيين id عليه — سواء
    // عند الإنشاء (makeElement(id, ...)) أو لاحقًا (overlay.id = "..."
    // كما يفعل buildAuthOverlay/buildAccountSidebar فعليًا)، حتى يعمل
    // document.getElementById(id) على نفس العنصر في كلتا الحالتين.
    Object.defineProperty(el, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; if (v) domElements[v] = this; },
    });
    if (initialId) el.id = initialId;
    // innerHTML: تحلّل فقط id="..." (+ اسم الوسم المقابل) من القالب
    // الساكن في buildAccountSidebar/buildAuthOverlay، وتسجّل كل عنصر
    // ناتج في domElements المشترك — يكفي هذا تمامًا لأن auth.js لا يصل
    // لأي عنصر ديناميكي إلا عبر id (document.getElementById أو
    // querySelector("#...")). لا حاجة لمحاكاة شجرة DOM حقيقية.
    Object.defineProperty(el, "innerHTML", {
      get() { return this._innerHTML || ""; },
      set(html) {
        this._innerHTML = html;
        const re = /<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g;
        let m;
        while ((m = re.exec(html))) {
          const [, tag, childId] = m;
          const child = makeElement(childId, tag.toUpperCase());
          this._children.push(child);
          domElements[childId] = child;
        }
      },
    });
    return el;
  }

  domElements["account-trigger"] = makeElement("account-trigger");
  domElements["account-trigger"].textContent = "👤";
  activeElementRef.current = domElements["account-trigger"];

  const bodyChildren = [];
  const mockDocument = {
    getElementById(id) { return domElements[id] || null; },
    createElement(tag) { return makeElement("created-" + tag, tag.toUpperCase()); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    body: { appendChild(el) { bodyChildren.push(el); } },
    _listeners: {},
    addEventListener(type, cb) {
      (this._listeners[type] = this._listeners[type] || []).push(cb);
    },
    get activeElement() { return activeElementRef.current; },
  };

  let authStateCallback = null;
  let signOutResult = { error: null };
  const mockSupabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: initialSession }, error: null };
      },
      async signInAnonymously() {
        return { data: { session: { user: { id: "anon-1", is_anonymous: true, identities: [] } } }, error: null };
      },
      async linkIdentity() {
        return { data: null, error: { message: "mock: not exercised" } };
      },
      async signInWithOAuth() {
        return { data: { url: "https://mock-oauth/" }, error: null };
      },
      async signOut() {
        return signOutResult;
      },
      onAuthStateChange(cb) {
        authStateCallback = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };

  const toasts = [];
  const consoleLogs = [];
  const sandbox = {
    console: { ...console, log: (...args) => { consoleLogs.push(args.join(" ")); }, error: () => {} },
    URLSearchParams,
    URL,
    window: {
      location: { href: "https://afoq-m.github.io/medical-platform/courses.html", search: "", pathname: "/medical-platform/courses.html" },
      history: { replaceState() {} },
    },
    document: mockDocument,
    supabaseClient: mockSupabaseClient,
    sessionStorage: { setItem() {}, getItem() { return null; } },
    showToast(msg) { toasts.push(msg); },
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(authJsSource, sandbox, { filename: "js/auth.js" });

  return {
    sandbox,
    domElements,
    toasts,
    consoleLogs,
    setSignOutResult: (r) => { signOutResult = r; },
    triggerAuthStateChange: (session) => authStateCallback && authStateCallback(session ? "SIGNED_IN" : "SIGNED_OUT", session),
    fireKeydown: (key) => (mockDocument._listeners.keydown || []).forEach((cb) => cb({ key })),
  };
}

const GUEST_SESSION = null;
const GOOGLE_SESSION = {
  user: {
    id: "u1", is_anonymous: false, email: "student@example.com",
    identities: [{ provider: "google" }],
    user_metadata: { full_name: "سارة أحمد", avatar_url: "https://lh3.googleusercontent.com/a/mock-avatar" },
  },
};

console.log("AFOQ Account Sidebar + Sign Out — Regression Tests\n");

(async () => {
  // --- Test A: ضيف → الضغط على زر الحساب يفتح نافذة تسجيل الدخول ---
  await testAsync("Test A — Guest: account trigger opens the login modal, not the sidebar", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GUEST_SESSION });
    await sandbox.ensureAuthSession(); // يبدأ كضيف (Anonymous)
    sandbox.openAuthOverlay();
    const overlay = domElements["auth-overlay"];
    assert.ok(overlay, "auth-overlay must be built");
    assert.strictEqual(overlay.hidden, false, "login modal must be visible for a guest");
    assert.strictEqual(domElements["account-sidebar"], undefined, "account sidebar must not be built for a guest");
  });

  // --- Test B: مستخدم Google مرتبط → الضغط على زر الحساب يفتح القائمة الجانبية ---
  await testAsync("Test B — Google authenticated: account trigger opens the sidebar", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAuthOverlay();
    const sidebar = domElements["account-sidebar"];
    assert.ok(sidebar, "account-sidebar must be built for a linked Google user");
    assert.strictEqual(sidebar.hidden, false, "sidebar must be visible");
    assert.strictEqual(domElements["auth-overlay"], undefined, "login modal must never be built/opened for an authenticated user");
  });

  // --- Test C: القائمة تعرض الصورة والاسم الصحيحين ---
  await testAsync("Test C — Sidebar shows avatar + display name", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    assert.strictEqual(domElements["account-sidebar-name"].textContent, "سارة أحمد");
    const img = domElements["account-sidebar-avatar-wrap"]._children.find((c) => c.tagName === "IMG");
    assert.ok(img, "an <img> must be appended for the avatar");
    assert.strictEqual(img.src, "https://lh3.googleusercontent.com/a/mock-avatar");
  });

  // --- Test D: روابط التنقل في القائمة تستخدم المسارات الفعلية الصحيحة ---
  await testAsync("Test D — Sidebar navigation URLs match the project's real pages", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    const html = domElements["account-sidebar"]._innerHTML;
    assert.ok(html.includes('href="index.html"'), "الرئيسية يجب أن تشير إلى index.html");
    assert.ok(html.includes('href="platform.html"'), "الموارد يجب أن تشير إلى platform.html (مدخل الهيكل الأكاديمي الحالي)، لا صفحة جديدة");
    assert.ok(html.includes('href="courses.html"'), "الدورات يجب أن تشير إلى courses.html");
    assert.ok(html.includes('href="favorites.html"'), "المفضلة يجب أن تشير إلى favorites.html");
    assert.ok(!html.includes('href="forum.html"'), "forum.html غير موجودة بعد، ويجب ألا يُشار إليها كرابط حقيقي");
  });

  // --- Test D2: رابط "الملتقى" لا يكسر شيئًا ويسجّل حالته بوضوح ---
  await testAsync("Test D2 — Forum entry never navigates and logs its NOT IMPLEMENTED status", async () => {
    const { sandbox, domElements, consoleLogs, toasts } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    const forumBtn = domElements["account-sidebar-forum"];
    assert.strictEqual(forumBtn.tagName, "BUTTON", "forum entry must be a button (no real href), not a broken link");
    forumBtn._listeners.click[0]();
    assert.ok(consoleLogs.some((l) => l.includes("Forum destination: NOT IMPLEMENTED YET")));
    assert.ok(toasts.length > 0, "should show a toast instead of navigating anywhere");
  });

  // --- Test E: تسجيل الخروج يستدعي Supabase signOut() فعليًا ---
  await testAsync("Test E — Sign out calls supabaseClient.auth.signOut()", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    let signOutCalled = false;
    sandbox.supabaseClient.auth.signOut = async () => { signOutCalled = true; return { error: null }; };
    sandbox.openAccountSidebar();
    await domElements["account-sidebar-signout"]._listeners.click[0]();
    assert.strictEqual(signOutCalled, true);
  });

  // --- Test F: بعد نجاح تسجيل الخروج → القائمة تُغلق وتُستعاد حالة الضيف ---
  await testAsync("Test F — After sign out: sidebar closes and guest UI is restored", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    assert.strictEqual(domElements["account-sidebar"].hidden, false);

    await domElements["account-sidebar-signout"]._listeners.click[0]();

    assert.strictEqual(domElements["account-sidebar"].hidden, true, "sidebar must close after successful sign out");
    const trigger = domElements["account-trigger"];
    assert.strictEqual(trigger.classList._classes.has("account-linked"), false, "guest UI must be restored on account-trigger");
    assert.strictEqual(sandbox.isLinkedAccountUser(), false, "currentAuthUser must no longer be a linked account after sign out");
  });

  // --- Test G: Escape يغلق القائمة ---
  await testAsync("Test G — Escape key closes the sidebar", async () => {
    const { sandbox, domElements, fireKeydown } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    assert.strictEqual(domElements["account-sidebar"].hidden, false);
    fireKeydown("Escape");
    assert.strictEqual(domElements["account-sidebar"].hidden, true);
  });

  // --- Test H: الضغط خارج القائمة (على الـoverlay) يغلقها ---
  await testAsync("Test H — Outside click (overlay) closes the sidebar", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.openAccountSidebar();
    assert.strictEqual(domElements["account-sidebar"].hidden, false);
    domElements["account-sidebar-overlay"]._listeners.click[0]();
    assert.strictEqual(domElements["account-sidebar"].hidden, true);
  });

  // --- Test I: نجاح Google OAuth (استعادة جلسة) يُفعّل الحالة الموثّقة مباشرة، بلا نافذة تسجيل دخول متبقية ---
  await testAsync("Test I — Restored Google session on load never leaves the login modal open", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.refreshAuthUI();
    assert.strictEqual(domElements["auth-overlay"], undefined, "no login modal should ever be built on a page load that already has a linked session");
    assert.strictEqual(sandbox.isLinkedAccountUser(), true);
  });

  // --- Test J: بعد إعادة تحميل الصفحة بجلسة Google موجودة، واجهة الحساب تبقى authenticated ---
  await testAsync("Test J — Authenticated page reload keeps authenticated UI (avatar+name), sidebar opens on demand", async () => {
    const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.refreshAuthUI();
    assert.strictEqual(domElements["account-trigger"].classList._classes.has("account-linked"), true);
    sandbox.openAuthOverlay();
    assert.strictEqual(domElements["account-sidebar"].hidden, false, "clicking the account trigger after reload must open the sidebar directly");
  });

  // --- Test K: فشل تسجيل الخروج لا يكسر الواجهة ولا يُظهر تفاصيل حساسة ---
  await testAsync("Test K — Sign out failure shows a generic toast, never throws, never leaks tokens", async () => {
    const { sandbox, domElements, toasts } = loadAuthJsWithMockSession({ initialSession: GOOGLE_SESSION });
    await sandbox.ensureAuthSession();
    sandbox.supabaseClient.auth.signOut = async () => ({ error: { message: "network error", access_token: "SHOULD-NEVER-BE-LOGGED" } });
    sandbox.openAccountSidebar();
    await assert.doesNotReject(() => domElements["account-sidebar-signout"]._listeners.click[0]());
    assert.ok(toasts.some((t) => !t.includes("SHOULD-NEVER-BE-LOGGED")));
    assert.strictEqual(domElements["account-sidebar"].hidden, false, "sidebar stays open/UI intact when sign out fails");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();
