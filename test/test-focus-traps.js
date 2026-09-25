/**
 * test-focus-traps.js
 * ------------------------------------------------------------------
 * NEW-01 — اختبارات "فخاخ التركيز" للطبقات العائمة في الموقع العام:
 *   auth-overlay (نافذة "كيف تريد المتابعة؟")، global-search-overlay
 *   (البحث الشامل من الهيدر)، وaccount-sidebar (القائمة الجانبية).
 *
 * تُشغَّل بـNode العادي — تحمّل js/auth.js وjs/app.js فعليًا كما هما
 * عبر vm.runInContext بمحاكاة DOM غنية (تتبّع التركيز + querySelectorAll
 * + contains + dataset) لأن كلا الملفين يسجّلان حارس focusin عامًا في
 * أعلى مستوى، وتتحقق من سلوك الفخ واقعيًا (Tab/Shift+Tab/Escape/استعادة
 * التركيز/منع الهروب خارج الطبقة المفتوحة).
 *
 * لا تستخدم أي شبكة فاعية — كل استدعاءات Supabase محاكاة ولا يُطلق أي
 * DOMContentLoaded.
 *
 * التشغيل: node test/test-focus-traps.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const AUTH_JS_PATH = path.join(__dirname, "..", "js", "auth.js");
const APP_JS_PATH = path.join(__dirname, "..", "js", "app.js");
const authJsSource = fs.readFileSync(AUTH_JS_PATH, "utf-8");
const appJsSource = fs.readFileSync(APP_JS_PATH, "utf-8");

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

function testAsync(name, fn) {
  return Promise.resolve(fn())
    .then(() => { console.log(`  PASS  ${name}`); passed++; })
    .catch((err) => { console.log(`  FAIL  ${name}`); console.log(`        ${err.message}`); failures++; });
}

function tabEvent(shiftKey, currentTarget) {
  return { key: "Tab", shiftKey, currentTarget, preventDefault() { this._prevented = true; } };
}

function escapeEvent(currentTarget) {
  return { key: "Escape", currentTarget, preventDefault() { this._prevented = true; } };
}

/**
 * يعيد بيئة تحمّل js/auth.js ثم js/app.js معًا (نفس ترتيب تحميل الصفحات
 * العامة فعليًا) داخل محاكاة DOM غنية تدعم: id تلقائي، innerHTML يلتقط
 * id="..."، querySelectorAll للعناصر التفاعلية، contains، dataset،
 * تتبّع activeElement، وتخزين مستمعي الأحداث على العنصر والمستند.
 */
function loadFocusTrapSandbox() {
  const domElements = {};
  const bodyChildren = [];
  const activeElementRef = { current: null };
  const docListeners = {};

  function isInteractive(c) {
    return c && (c.tagName === "BUTTON" || c.tagName === "INPUT" || c.tagName === "SELECT"
      || c.tagName === "TEXTAREA" || (c.tagName === "A" && c._attrs && c._attrs.href !== undefined)
      || (c.dataset && c.dataset.tabindex !== undefined));
  }

  function collectInteractiveChildren(el) {
    const found = [];
    const stack = [el];
    while (stack.length) {
      const node = stack.pop();
      (node._children || []).forEach((c) => {
        if (isInteractive(c)) found.push(c);
        if (c._children && c._children.length) stack.push(c);
      });
    }
    return found;
  }

  function makeElement(initialId, tagName = "DIV") {
    const el = {
      tagName,
      hidden: false,
      className: "",
      _attrs: {},
      _children: [],
      _listeners: {},
      dataset: {},
      alt: undefined,
      src: undefined,
      referrerPolicy: undefined,
      onerror: null,
      value: "",
      closest() { return null; },
      offsetParent: {}, // غير فارغ → "visible" كما في المتصفح لبطاقة غير مخفية
      contains(node) {
        if (node === el) return true;
        return (el._children || []).some((c) => (c === node) || (c.contains && c.contains(node)));
      },
      setAttribute(k, v) { this._attrs[k] = String(v); },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
      appendChild(child) { this._children.push(child); if (child.id) domElements[child.id] = child; return child; },
      replaceWith() {},
      focus() { activeElementRef.current = this; },
      querySelector(sel) {
        if (sel.startsWith("#")) return domElements[sel.slice(1)] || null;
        if (/^button, input, select, textarea, a\[href\]$/.test(sel)) {
          return collectInteractiveChildren(this)[0] || null;
        }
        return this._children.find((c) => c.tagName === sel.toUpperCase()) || null;
      },
      querySelectorAll(sel) {
        const likeInteractive = /button|input|select|textarea|a\[href\]|tabindex/.test(sel);
        if (likeInteractive) return collectInteractiveChildren(this);
        return [];
      },
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
        toggle(c, force) {
          const shouldHave = force !== undefined ? force : !this._classes.has(c);
          if (shouldHave) this._classes.add(c); else this._classes.delete(c);
        },
      },
    };
    Object.defineProperty(el, "id", {
      get() { return this._id || ""; },
      set(v) { this._id = v; if (v) domElements[v] = this; },
    });
    if (initialId) el.id = initialId;
    Object.defineProperty(el, "textContent", {
      get() { return this._textContent || ""; },
      set(v) { this._textContent = v; if (v === "") this._children = []; },
    });
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

  domElements["account-trigger"] = makeElement("account-trigger", "BUTTON");
  activeElementRef.current = domElements["account-trigger"];

  const mockDocument = {
    getElementById(id) { return domElements[id] || null; },
    createElement(tag) { return makeElement("", tag.toUpperCase()); },
    createElementNS(_ns, tag) { return makeElement("", tag.toUpperCase()); },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    body: { appendChild(el) { bodyChildren.push(el); } },
    addEventListener(type, cb) { (docListeners[type] = docListeners[type] || []).push(cb); },
    contains(node) {
      if (bodyChildren.includes(node)) return true;
      return Object.values(domElements).includes(node);
    },
    get activeElement() { return activeElementRef.current; },
  };

  const sandbox = {
    console: { ...console, log: () => {}, error: () => {}, warn: () => {} },
    URLSearchParams,
    URL,
    window: {
      location: { href: "https://afoq-m.pages.dev/index.html", search: "", pathname: "/index.html" },
      history: { replaceState() {} },
    },
    document: mockDocument,
    supabaseClient: {
      auth: {
        async getSession() { return { data: { session: null }, error: null }; },
        async signInAnonymously() { return { data: { session: { user: { id: "anon-1", is_anonymous: true, identities: [] } } }, error: null }; },
        async linkIdentity() { return { data: null, error: { message: "mock" } }; },
        async signInWithOAuth() { return { data: { url: "https://mock/" }, error: null }; },
        async signOut() { return { error: null }; },
        onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      },
    },
    sessionStorage: { setItem() {}, getItem() { return null; } },
    localStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    showToast() {},
    setTimeout,
    clearTimeout,
  };

  vm.createContext(sandbox);
  vm.runInContext(authJsSource, sandbox, { filename: "js/auth.js" });
  vm.runInContext(appJsSource, sandbox, { filename: "js/app.js" });

  return {
    sandbox,
    domElements,
    bodyChildren,
    fireDocFocusin: (target) => (docListeners.focusin || []).forEach((cb) => cb({ target })),
  };
}

function lastFocusableIndex(list) {
  return list.length - 1;
}

console.log("AFOQ Focus Traps (NEW-01) — auth-overlay / global-search / account-sidebar\n");

(async () => {
  // ---------------- auth-overlay ----------------
  {
    const { sandbox, domElements, fireDocFocusin } = loadFocusTrapSandbox();
    await testAsync("auth-overlay — open focuses first focusable (Google btn) and tracks opener", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAuthOverlay();
      const overlay = domElements["auth-overlay"];
      assert.ok(overlay, "auth-overlay built");
      assert.strictEqual(overlay.hidden, false, "overlay visible");
      assert.strictEqual(sandbox.isLinkedAccountUser(), false);
      assert.strictEqual(sandbox.document.activeElement.id, "auth-google-btn",
        "focus must land on the first focusable (auth-google-btn), got: " + sandbox.document.activeElement.id);
    });
  }

  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("auth-overlay — Tab from last wraps to first focusable", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAuthOverlay();
      const overlay = domElements["auth-overlay"];
      domElements["auth-guest-btn"].focus();
      const ev = tabEvent(false, overlay);
      overlay._listeners.keydown[0](ev);
      assert.strictEqual(sandbox.document.activeElement.id, "auth-google-btn", "Tab from last must wrap to first");
    });
  }

  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("auth-overlay — Shift+Tab from first wraps to last focusable", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAuthOverlay();
      const overlay = domElements["auth-overlay"];
      domElements["auth-google-btn"].focus();
      const ev = tabEvent(true, overlay);
      overlay._listeners.keydown[0](ev);
      assert.strictEqual(sandbox.document.activeElement.id, "auth-guest-btn", "Shift+Tab from first must wrap to last");
    });
  }

  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("auth-overlay — Escape closes and restores focus to opener", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAuthOverlay();
      const overlay = domElements["auth-overlay"];
      sandbox.document.activeElement = overlay; // noop guard
      const ev = escapeEvent(overlay);
      overlay._listeners.keydown[0](ev);
      assert.strictEqual(overlay.hidden, true, "overlay hidden after Escape");
      assert.strictEqual(sandbox.document.activeElement.id, "account-trigger", "focus restored to opener");
    });
  }

  {
    const { sandbox, domElements, fireDocFocusin } = loadFocusTrapSandbox();
    await testAsync("auth-overlay — focusin on outside element is pulled back into the layer", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAuthOverlay();
      const overlay = domElements["auth-overlay"];
      const outside = makeOutsider();
      fireDocFocusin(outside);
      assert.ok(sandbox.document.activeElement.id === "auth-google-btn", "activeElement pulled back into overlay: " + sandbox.document.activeElement.id);
    });
  }

  // ---------------- account-sidebar ----------------
  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("account-sidebar — open focuses close button; Tab wraps within sidebar", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAccountSidebar();
      const sidebar = domElements["account-sidebar"];
      assert.strictEqual(sidebar.hidden, false, "sidebar panel visible");
      assert.strictEqual(sandbox.document.activeElement.id, "account-sidebar-close", "focus lands on close button first");

      // آخر عنصر تفاعلي مُبني داخل القائمة (زر تسجيل الخروج) → Tab يلتف لأول (زر الإغلاق)
      domElements["account-sidebar-signout"].focus();
      const ev = tabEvent(false, sidebar);
      sidebar._listeners.keydown[0](ev);
      assert.strictEqual(sandbox.document.activeElement.id, "account-sidebar-close", "Tab from last wraps to first (close btn)");
    });
  }

  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("account-sidebar — Escape/close restores focus to opener trigger", async () => {
      domElements["account-trigger"].focus();
      sandbox.openAccountSidebar();
      const sidebar = domElements["account-sidebar"];
      const ev = escapeEvent(sidebar);
      sidebar._listeners.keydown[0](ev);
      assert.strictEqual(sidebar.hidden, true, "sidebar panel hidden after Escape");
      assert.strictEqual(sandbox.document.activeElement.id, "account-trigger", "focus restored to account-trigger");
      assert.strictEqual(domElements["account-trigger"].getAttribute("aria-expanded"), "false");
    });
  }

  // ---------------- global-search-overlay ----------------
  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("global-search — open focuses input (after timeout) and tracks opener", async () => {
      domElements["account-trigger"].focus();
      sandbox.buildGlobalSearchOverlay();
      sandbox.openGlobalSearchOverlay();
      const overlay = domElements["global-search-overlay"];
      assert.strictEqual(overlay.hidden, false, "overlay visible");
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(sandbox.document.activeElement.id, "global-search-input", "input receives focus");
    });
  }

  {
    const { sandbox, domElements } = loadFocusTrapSandbox();
    await testAsync("global-search — Escape closes via the overlay wire (wireDialogOverlay sibling)", async () => {
      domElements["account-trigger"].focus();
      sandbox.buildGlobalSearchOverlay();
      const overlay = domElements["global-search-overlay"];
      sandbox.openGlobalSearchOverlay();
      const ev = escapeEvent(overlay);
      // wireDialogOverlay يسجّل مستمع keydown بنفسه في buildGlobalSearchOverlay
      const trapHandler = (overlay._listeners.keydown || []).find((fn) => String(fn).includes("Keydown") || String(fn).includes("closeDialogOverlay") || String(fn).includes("Escape"));
      assert.ok(trapHandler, "a keydown handler (trap/Escape) must be wired on the global-search overlay");
      trapHandler(ev);
      assert.strictEqual(overlay.hidden, true, "overlay hidden after Escape");
      assert.strictEqual(sandbox.document.activeElement.id, "account-trigger", "focus restored to opener");
    });
  }

  {
    const { sandbox, domElements, fireDocFocusin } = loadFocusTrapSandbox();
    await testAsync("global-search — focusin on outside element is pulled back into the layer", async () => {
      domElements["account-trigger"].focus();
      sandbox.buildGlobalSearchOverlay();
      sandbox.openGlobalSearchOverlay();
      const overlay = domElements["global-search-overlay"];
      fireDocFocusin(makeOutsider());
      const active = sandbox.document.activeElement;
      assert.ok(active && (active.id === "global-search-input" || overlay.contains(active)),
        "activeElement must remain inside the global-search layer, got: " + (active && active.id));
    });
  }

  // ---------------- source-integrity ----------------
  test("NEW-01 source integrity — no inline onclick on floating layers; traps defined in JS files", () => {
    assert.ok(!/onclick=.?[Oo]pen(GlobalSearch|Auth)|onclick=.?[Oo]penAccountSidebar/.test(appJsSource + authJsSource),
      "no inline onclick handlers for floating layers");
    assert.ok(authJsSource.includes("_trapAuthLayerFocus"), "auth.js defines a Tab trap");
    assert.ok(authJsSource.includes('document.addEventListener("focusin"'), "auth.js registers a focusin guard");
    assert.ok(appJsSource.includes("wireDialogOverlay(overlay)"), "app.js wires the dialog trap family into global-search");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();

// أدوات مساعدة (خارج scope الحمل المتزامن لكنها تُستخدم قبلها أعلاه؟ لا —

// تُعرَّف هنا كمساعدات عامة). تتراجع إلى قائمة عناصر المحاكاة التفاعلية
// أسفل الطبقة لفحص "الالتفاف"، وتنبني العناصر الخارجية خارج DOM المحاكي
// لضمان عدم انتمائها للطبقة المفتوحة في اختبار focusin.

function collectForTest(sandbox, overlay) {
  const seen = new Set();
  const out = [];
  const stack = [overlay];
  while (stack.length) {
    const node = stack.pop();
    (node._children || []).forEach((c) => {
      if (seen.has(c)) return;
      seen.add(c);
      if (c.tagName === "BUTTON" || c.tagName === "A" || c.tagName === "INPUT"
        || c.tagName === "SELECT" || c.tagName === "TEXTAREA") out.push(c);
      if (c._children && c._children.length) stack.push(c);
    });
  }
  return out;
}

function makeOutsider() {
  return {
    id: "outside-element",
    tagName: "DIV",
    _children: [],
    hidden: false,
    contains() { return false; },
  };
}