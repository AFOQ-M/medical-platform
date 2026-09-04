/**
 * test-google-auth-state.js
 * ------------------------------------------------------------------
 * اختبارات Regression لإصلاح "الواجهة لا تُظهر حالة Google بعد العودة
 * من OAuth". تُشغَّل بـNode العادي (لا حاجة لمتصفح حقيقي أو حساب Google
 * فعلي) — تحمّل js/auth.js فعليًا كما هو عبر vm.runInNewContext بمحاكاة
 * بسيطة لـdocument/window/supabaseClient، ثم تُشغّل دوال الملف الحقيقية.
 *
 * لا تستخدم أي حساب Google حقيقي ولا شبكة فعلية — كل استدعاءات Supabase
 * مُحاكاة (mocked) محليًا فقط.
 *
 * التشغيل: node test/test-google-auth-state.js
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

/** يبني بيئة (sandbox) جديدة تمامًا لكل اختبار — لا تسريب حالة بين
 *  الاختبارات (كل اختبار يحمّل auth.js من جديد بمحاكاة مختلفة). */
function loadAuthJsWithMockSession({ initialSession = null, anonymousSignInResult = null } = {}) {
  const domElements = {};

  function makeElement(id, tagName = "DIV") {
    const el = {
      id,
      tagName,
      hidden: false,
      textContent: "",
      className: "",
      _attrs: {},
      _children: [],
      alt: undefined,
      src: undefined,
      referrerPolicy: undefined,
      onerror: null,
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener() {},
      appendChild(child) { this._children.push(child); return child; },
      replaceWith() { /* لا حاجة لمحاكاة إزالة فعلية في هذه الاختبارات */ },
      querySelector() { return makeElement("mock-child"); },
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
    // textContent = "" يُفرغ الأبناء المُحاكاة أيضًا — يطابق سلوك DOM
    // الحقيقي الذي يستخدمه auth.js فعليًا (trigger.textContent = "").
    Object.defineProperty(el, "textContent", {
      get() { return this._textContent || ""; },
      set(v) { this._textContent = v; if (v === "") this._children = []; },
    });
    return el;
  }

  // العناصر الثابتة التي يحتاجها auth.js فعليًا من DOM أي صفحة عامة
  domElements["account-trigger"] = makeElement("account-trigger");
  domElements["account-trigger"].textContent = "👤"; // القيمة الأصلية في index.html

  const mockDocument = {
    getElementById(id) {
      if (!domElements[id]) return null;
      return domElements[id];
    },
    createElement(tag) { return makeElement("created-" + tag, tag.toUpperCase()); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    body: { appendChild() {} },
    addEventListener() {},
  };

  let authStateCallback = null;
  const mockSupabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: initialSession }, error: null };
      },
      async signInAnonymously() {
        if (anonymousSignInResult) return anonymousSignInResult;
        return { data: { session: { user: { id: "anon-1", is_anonymous: true, identities: [] } } }, error: null };
      },
      async linkIdentity() {
        return { data: null, error: { message: "mock: linkIdentity not exercised in this test" } };
      },
      async signInWithOAuth() {
        return { data: { url: "https://mock-oauth/" }, error: null };
      },
      onAuthStateChange(cb) {
        authStateCallback = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },
  };

  const sandbox = {
    console,
    URLSearchParams,
    window: {
      location: { href: "https://afoq-m.github.io/medical-platform/index.html", search: "", pathname: "/medical-platform/index.html" },
      history: { replaceState() {} },
    },
    document: mockDocument,
    supabaseClient: mockSupabaseClient,
    sessionStorage: { setItem() {}, getItem() { return null; } },
    showToast() {}, // معرَّفة أصلاً في js/app.js، غير محمَّلة هنا — محاكاة فارغة كافية لهذه الاختبارات
    setTimeout,
    clearTimeout,
  };
  sandbox.window.location.search = "";

  vm.createContext(sandbox);
  vm.runInContext(authJsSource, sandbox, { filename: "js/auth.js" });

  return { sandbox, domElements, triggerAuthStateChange: (session) => authStateCallback && authStateCallback("SIGNED_IN", session) };
}

console.log("AFOQ Google Auth State — Regression Tests\n");

// --- Test A: لا جلسة مصادقة على الإطلاق → Anonymous Auth يعمل كما كان ---
test("Test A — No session: falls back to Anonymous Auth, currentAuthUser becomes anonymous", async () => {
  const { sandbox } = loadAuthJsWithMockSession({ initialSession: null });
  const user = await sandbox.ensureAuthSession();
  assert.strictEqual(user.is_anonymous, true, "expected anonymous user when no session exists");
  assert.strictEqual(sandbox.isAnonymousUser(), true);
});

// --- Test B: جلسة Google موجودة أصلًا → لا إنشاء Anonymous جديدة ---
test("Test B — Existing Google session: no new anonymous session is created", async () => {
  let anonymousWasCalled = false;
  const googleSession = { user: { id: "u1", is_anonymous: false, identities: [{ provider: "google" }] } };
  const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: googleSession });
  // نلفّ signInAnonymously لنكتشف إن استُدعيت خطأً
  const originalSignIn = sandbox.supabaseClient.auth.signInAnonymously;
  sandbox.supabaseClient.auth.signInAnonymously = async (...args) => {
    anonymousWasCalled = true;
    return originalSignIn(...args);
  };

  const user = await sandbox.ensureAuthSession();
  assert.strictEqual(anonymousWasCalled, false, "signInAnonymously must NOT be called when a session already exists");
  assert.strictEqual(user.is_anonymous, false);
});

// --- Test C: currentAuthUser يصبح Google user فعليًا بعد getSession() ---
test("Test C — currentAuthUser becomes the Google user after session restore", async () => {
  const googleSession = { user: { id: "u1", is_anonymous: false, identities: [{ provider: "google" }] } };
  const { sandbox } = loadAuthJsWithMockSession({ initialSession: googleSession });
  await sandbox.ensureAuthSession();
  assert.strictEqual(sandbox.isAnonymousUser(), false);
  assert.strictEqual(sandbox.hasLinkedGoogleIdentity(), true);
});

// --- Test D: بعد استعادة الجلسة، الواجهة (زر الحساب) تعكس الحالة فعليًا ---
// هذا هو الاختبار المباشر لسبب المشكلة الأولى المُبلَّغ عنها، مُحدَّث الآن
// ليطابق التصميم الفعلي (صورة + اسم، لا مجرد رمز ✓).
test("Test D — UI state propagation: account trigger shows avatar + name when linked", async () => {
  const googleSession = {
    user: {
      id: "u1", is_anonymous: false, email: "student@example.com",
      identities: [{ provider: "google" }],
      user_metadata: { full_name: "سارة أحمد", avatar_url: "https://lh3.googleusercontent.com/a/mock-avatar" },
    },
  };
  const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: googleSession });

  sandbox.supabaseClient.auth.onAuthStateChange(() => {});
  await sandbox.ensureAuthSession();
  sandbox.refreshAuthUI();

  const trigger = domElements["account-trigger"];
  assert.strictEqual(trigger.classList._classes.has("account-linked"), true,
    "account-linked class must be toggled on once a Google identity is active");
  const img = trigger._children.find((c) => c.tagName === "IMG");
  assert.ok(img, "an <img> must be appended for the avatar");
  assert.strictEqual(img.src, "https://lh3.googleusercontent.com/a/mock-avatar");
  assert.strictEqual(img.referrerPolicy, "no-referrer");
  const nameSpan = trigger._children.find((c) => c.className === "account-name");
  assert.ok(nameSpan, "a name span must be appended");
  assert.strictEqual(nameSpan.textContent, "سارة أحمد");
  assert.strictEqual(trigger.getAttribute("aria-label"), "الحساب — سارة أحمد");
});

// --- Test D2: نفس الشيء عبر onAuthStateChange حي، مع fallback (لا صورة، لا اسم) ---
test("Test D2 — Live SIGNED_IN event + safe fallbacks when no avatar/name metadata exists", async () => {
  const { sandbox, domElements, triggerAuthStateChange } = loadAuthJsWithMockSession({ initialSession: null });
  await sandbox.ensureAuthSession(); // يبدأ كضيف
  sandbox.supabaseClient.auth.onAuthStateChange((_e, session) => {
    sandbox.currentAuthUser = session ? session.user : null;
    sandbox.refreshAuthUI();
  });

  const trigger = domElements["account-trigger"];
  assert.strictEqual(trigger.textContent, "👤"); // لا يزال ضيفًا حتى الآن

  // مستخدم Google بلا أي user_metadata إطلاقًا (سيناريو fallback الكامل)
  const bareGoogleUser = { id: "u2", is_anonymous: false, email: "a.person@example.com", identities: [{ provider: "google" }] };
  triggerAuthStateChange({ user: bareGoogleUser });

  assert.strictEqual(trigger.classList._classes.has("account-linked"), true);
  const img = trigger._children.find((c) => c.tagName === "IMG");
  assert.strictEqual(img, undefined, "no <img> should be appended when there is no safe avatar URL");
  const nameSpan = trigger._children.find((c) => c.className === "account-name");
  assert.strictEqual(nameSpan.textContent, "a.person", "must fall back to the email local-part, never the full email");
});

// --- Test D3: رابط صورة غير آمن (مثل javascript:) يُرفض تمامًا ---
test("Test D3 — Unsafe avatar URL (javascript:) is rejected, never assigned to img.src", async () => {
  const googleSession = {
    user: {
      id: "u3", is_anonymous: false,
      identities: [{ provider: "google" }],
      user_metadata: { name: "طالب", avatar_url: "javascript:alert(1)" },
    },
  };
  const { sandbox, domElements } = loadAuthJsWithMockSession({ initialSession: googleSession });
  await sandbox.ensureAuthSession();
  sandbox.refreshAuthUI();

  const trigger = domElements["account-trigger"];
  const img = trigger._children.find((c) => c.tagName === "IMG");
  assert.strictEqual(img, undefined, "an unsafe URL scheme must never reach img.src");
});

// --- Test E: هوية Google مرتبطة أصلًا → لا محاولة ربط مكررة ---
test("Test E — Already linked: continueWithProvider short-circuits, no network call", async () => {
  const googleSession = { user: { id: "u1", is_anonymous: false, identities: [{ provider: "google" }] } };
  const { sandbox } = loadAuthJsWithMockSession({ initialSession: googleSession });
  await sandbox.ensureAuthSession();

  let linkIdentityCalled = false;
  let signInWithOAuthCalled = false;
  sandbox.supabaseClient.auth.linkIdentity = async () => { linkIdentityCalled = true; return { data: null, error: null }; };
  sandbox.supabaseClient.auth.signInWithOAuth = async () => { signInWithOAuthCalled = true; return { data: null, error: null }; };

  const result = await sandbox.continueWithGoogle();
  assert.strictEqual(result.alreadyLinked, true);
  assert.strictEqual(linkIdentityCalled, false, "must not call linkIdentity when already linked");
  assert.strictEqual(signInWithOAuthCalled, false, "must not call signInWithOAuth when already linked");
});

// --- Test F: إلغاء OAuth (?error=access_denied) → الموقع يبقى سليمًا، الجلسة الحالية لا تُفسد ---
test("Test F — OAuth cancellation param is consumed safely without touching the session", () => {
  const { sandbox } = loadAuthJsWithMockSession({ initialSession: null });
  sandbox.window.location.search = "?error=access_denied&error_description=User+cancelled";
  let toastMessage = null;
  sandbox.showToast = (msg) => { toastMessage = msg; };

  // إعادة تعريف consumeOAuthRedirectError داخل نفس sandbox بعد تركيب showToast
  // الجديد (الدالة الأصلية تلتقط showToast من scope الوقت الذي عُرِّفت فيه،
  // وبما أنها كلها global في نفس vm context، هذا يعمل صحيحًا).
  assert.doesNotThrow(() => sandbox.consumeOAuthRedirectError());
  assert.strictEqual(toastMessage, "تم إلغاء تسجيل الدخول.");
  // currentAuthUser لم يُمس إطلاقًا بهذه الدالة: لا حالة ضيف ولا Google
  // نشأت من مجرد استدعاء consumeOAuthRedirectError (ملاحظة: currentAuthUser
  // نفسها متغيّر `let` داخل vm context ولا يظهر كخاصية على sandbox، لذا
  // نتحقق من أثره عبر الدالتين العامتين بدل قراءته مباشرة).
  assert.strictEqual(sandbox.isAnonymousUser(), false);
  assert.strictEqual(sandbox.hasLinkedGoogleIdentity(), false);
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
