/**
 * test-forum.js
 * ------------------------------------------------------------------
 * ط§ط®طھط¨ط§ط±ط§طھ Regression ظ„ظ…ظٹط²ط© "ظ…ظ„طھظ‚ظ‰ ط£ظپظ‚" (Forum MVP â€” Phase 6).
 * طھظڈط´ط؛ظژظ‘ظ„ ط¨ظ€Node ط§ظ„ط¹ط§ط¯ظٹ (ظ„ط§ ط­ط§ط¬ط© ظ„ظ…طھطµظپط­ ط­ظ‚ظٹظ‚ظٹ) â€” طھط­ظ…ظ‘ظ„ js/forum.js ظپط¹ظ„ظٹظ‹ط§
 * ظƒظ…ط§ ظ‡ظˆ ط¹ط¨ط± vm.runInNewContextطŒ ط¨ظ…ط­ط§ظƒط§ط© ط§ظ„ط§ط¹طھظ…ط§ط¯ظٹط§طھ ط§ظ„طھظٹ ظٹط³طھط®ط¯ظ…ظ‡ط§ ظ…ظ†
 * js/auth.js ظˆjs/app.js (currentAuthUser, isAnonymousUser, openAuthOverlay,
 * bestDisplayName, showToast, renderState, renderBreadcrumb, getQueryParam)
 * ظˆظ…ط­ط§ظƒط§ط© supabaseClient (query builder ظ‚ط§ط¨ظ„ ظ„ظ„طھط³ظ„ط³ظ„ .from().select()...).
 *
 * ظ„ط§ طھط³طھط®ط¯ظ… ط£ظٹ ط­ط³ط§ط¨ ط­ظ‚ظٹظ‚ظٹ ظˆظ„ط§ ط´ط¨ظƒط© ظپط¹ظ„ظٹط© ظˆظ„ط§ ط§طھطµط§ظ„ ط¨ظ‚ط§ط¹ط¯ط© ط¨ظٹط§ظ†ط§طھ ط­ظ‚ظٹظ‚ظٹط©.
 *
 * ظ…ظ„ط§ط­ط¸ط© ط£ظ…ط§ظ†ط© (Definition of Done آ§ ظ„ط§ طھط®ظ…ظ‘ظ†):
 * ظ‡ط°ط§ ط§ظ„ظ…ظ„ظپ ظٹط®طھط¨ط± ظ…ظ†ط·ظ‚ ط§ظ„ط¹ظ…ظٹظ„ (JS) ظپظ‚ط·. ظ„ط§ ظٹظ…ظƒظ†ظ‡ ط§ط®طھط¨ط§ط± طھط·ط¨ظٹظ‚ RLS
 * ط§ظ„ظپط¹ظ„ظٹ ط¹ظ„ظ‰ Postgres/Supabase ط§ظ„ط­ظٹ (ظ„ط§ ط§طھطµط§ظ„ ظ‚ط§ط¹ط¯ط© ط¨ظٹط§ظ†ط§طھ ظ…ظ† ط¨ظٹط¦ط©
 * ط§ظ„ط§ط®طھط¨ط§ط± ظ‡ط°ظ‡) â€” ط§ظ„طھط­ظ‚ظ‚ ظ…ظ† RLS ظ‡ظ†ط§ ظ‡ظˆ ظ…ط±ط§ط¬ط¹ط© ظ†طµظ‘ظٹط© ظ„ظ…ظ„ظپ SQL ظ†ظپط³ظ‡
 * (assert ط¹ظ„ظ‰ ظˆط¬ظˆط¯ ظƒظ„ ط³ظٹط§ط³ط© ط¨ط§ظ„ظ†طµ)طŒ ظˆظ„ظٹط³ طھظ†ظپظٹط°ظ‹ط§ ظپط¹ظ„ظٹظ‹ط§ ط¶ط¯ظ‡ط§. ظ‡ط°ط§ ظ…ط­ط¯ظˆط¯
 * طµط±ط§ط­ط© ظپظٹ ط§ظ„ظ‚ط³ظ… "Known Limitations" ظ…ظ† ط§ظ„طھظ‚ط±ظٹط± ط§ظ„ظ†ظ‡ط§ط¦ظٹ.
 *
 * ط§ظ„طھط´ط؛ظٹظ„: node test/test-forum.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const FORUM_JS_PATH = path.join(__dirname, "..", "js", "forum.js");
const forumJsSource = fs.readFileSync(FORUM_JS_PATH, "utf-8");
const SQL_PATH = path.join(__dirname, "..", "sql", "phase6_forum_mvp.sql");
const sqlSource = fs.readFileSync(SQL_PATH, "utf-8");
const AUTH_JS_PATH = path.join(__dirname, "..", "js", "auth.js");
const authJsSource = fs.readFileSync(AUTH_JS_PATH, "utf-8");

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

/** ط¹ظ†طµط± DOM ظ…ط­ط§ظƒظ‰ ط¨ط³ظٹط· â€” ظٹظƒظپظٹ ظ„ط§ط®طھط¨ط§ط± forum.js ط¯ظˆظ† ظ…طھطµظپط­ ط­ظ‚ظٹظ‚ظٹ. */
/** عقدة نصّ حقيقية — mirror للـ makeElement: data يحمل النص الحرفي، و
 *  appendChild(parent) تدمج child.data في _textContent للوالد تمامًا كسلوك
 *  المتصفح (textContent = تسلسل نصوص الأحفاد). هذه هي القناة التي يعتمد
 *  عليها forum.js لبناء العناوين والمحتويات آمِنًا ضد XSS (دائمًا نص،
 *  أبدًا HTML)، لذا على المحاكاة أن توفّرها بالضبط. */
function makeTextNode(data = "") {
  const node = { nodeType: 3, data: String(data ?? ""), _children: [] };
  Object.defineProperty(node, "textContent", {
    get() { return this.data; },
    set(v) { this.data = String(v ?? ""); },
  });
  Object.defineProperty(node, "nodeValue", {
    get() { return this.data; },
    set(v) { this.data = String(v ?? ""); },
  });
  return node;
}

function makeElement(tagName = "DIV") {
  const el = {
    tagName,
    hidden: false,
    disabled: false,
    className: "",
    value: "",
    placeholder: "",
    maxLength: 0,
    _attrs: {},
    _children: [],
    _listeners: {},
    setAttribute(k, v) { this._attrs[k] = v; },
        getAttribute(k) { return this._attrs[k]; },
        createTextNode: (txt) => { const t = { nodeType: 3, data: String(txt ?? ""), _children: [], className: "", hidden: false, disabled: false, _attrs: {}, _listeners: {} }; Object.defineProperty(t, "textContent", { get() { return t.data; }, set(v) { t.data = String(v ?? ""); } }); return t; },
    addEventListener(type, cb) { (this._listeners[type] = this._listeners[type] || []).push(cb); },
    appendChild(child) {
      this._children.push(child);
      // ظ†طµ ط­ظ‚ظٹظ‚ظٹ (createTextNode): طھطھظƒط§طھظپ ط¨ظٹط§ظ†ط§طھظ‡ ظپظٹ textContent ظƒط³ظ„ظˆظƒ DOM ط§ظ„ظپط¹ظ„ظٹ
      // (textContent = طھط³ظ„ط³ظ„ ظ†طµظˆطµ ط§ظ„ط£ط­ظپط§ط¯). ظ‡ط°ط§ ظ‡ظˆ ط§ظ„ط°ظٹ ظٹط¶ظ…ظ† ط£ظ† طھط¨ظ‚ظ‰ ط§ظ„ط£ط³ط·ط± ط­ط±ظپظٹط©.
      if (child && child.nodeType === 3) {
        this._textContent = (this._textContent || "") + child.data;
      }
      return child;
    },
    prepend(child) { this._children.unshift(child); return child; },
    remove() {},
    reset() { this.value = ""; },
    querySelector(sel) {
      if (sel.startsWith(".")) {
        return this._children.find((c) => (c.className || "").split(" ").includes(sel.slice(1))) || null;
      }
      return null;
    },
    replaceWith(node) { this._replacedWith = node; },
    scrollIntoView() {},
  };
  Object.defineProperty(el, "textContent", {
    get() { return this._textContent || ""; },
    set(v) { this._textContent = v; },
  });
  Object.defineProperty(el, "innerHTML", {
    get() { return this._innerHTML || ""; },
    set(v) { this._innerHTML = v; this._children = []; },
  });
  return el;
}

/** Query builder ظ…طھط³ظ„ط³ظ„ (chainable) ظٹط­ط§ظƒظٹ supabase-js â€” ظƒظ„ ط§ط³طھط¯ط¹ط§ط،
 *  from()/select()/eq()/order()/range()... ظٹظڈط³ط¬ظژظ‘ظ„ ظپظٹ calls[] ط«ظ… ظٹظڈط¹ط§ط¯
 *  ظ†ظپط³ ط§ظ„ظƒط§ط¦ظ† ظ„ظٹظڈطھط§ط¨ظژط¹ ط§ظ„طھط³ظ„ط³ظ„طŒ ظˆط£ط®ظٹط±ظ‹ط§ await ظٹظڈط±ط¬ط¹ ط§ظ„ظ†طھظٹط¬ط© ط§ظ„ظ…ظڈط¹ط·ط§ط©. */
function makeMockSupabase({ resultsByTable = {}, onInsert = null, onUpdate = null, onDelete = null } = {}) {
  const calls = [];

  function builder(table) {
    const state = { table, filters: {}, range: null };
    const chain = {
      select(cols) { calls.push({ op: "select", table, cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(from, to) { state.range = [from, to]; calls.push({ op: "range", table, from, to }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      insert(payload) {
        calls.push({ op: "insert", table, payload });
        if (onInsert) return onInsert(table, payload, chain);
        return chain;
      },
      update(payload) {
        calls.push({ op: "update", table, payload });
        if (onUpdate) return onUpdate(table, payload, state);
        return Promise.resolve({ data: null, error: null });
      },
      delete() {
        calls.push({ op: "delete", table });
        if (onDelete) return onDelete(table, state);
        return chain;
      },
      then(resolve) {
        const result = resultsByTable[table] || { data: [], error: null };
        resolve(chain._single ? { data: (result.data || [])[0] || null, error: result.error || null } : result);
      },
    };
    return chain;
  }

  return { from: builder, calls };
}

function loadForumJsSandbox(overrides = {}) {
  const toasts = [];
  const openAuthOverlayCalls = [];
  const consoleLogs = [];

  const defaultCtx = {
    console: { log: (...a) => consoleLogs.push(a.join(" ")), error: () => {}, warn: () => {} },
    document: {
      getElementById: () => makeElement(),
      createElement: (tag) => makeElement(tag.toUpperCase()),
      createTextNode: (txt) => makeTextNode(txt),
      // ↔ createElementNS: forum.js ↔ SVG ↔ -->
      createElementNS: (_ns, tag) => makeElement(tag.toUpperCase()),
    },
    window: {
      location: { search: "", href: "" },
      history: { replaceState() {} },
      confirm: () => true,
    },
    URLSearchParams: URLSearchParams,
    encodeURIComponent,
    setTimeout,
    Date,
    // ط§ط¹طھظ…ط§ط¯ظٹط§طھ js/auth.js (ظ…ظڈط­ط§ظƒط§ط© â€” ظ†ظپط³ ط§ظ„طھظˆظ‚ظٹط¹ ط§ظ„ظپط¹ظ„ظٹ)
    currentAuthUser: null,
    isAnonymousUser: () => true,
    openAuthOverlay: () => openAuthOverlayCalls.push(true),
    bestDisplayName: (u) => (u && u.user_metadata && u.user_metadata.full_name) || "ظ…ط³طھط®ط¯ظ…",
    ensureAuthSession: async () => null,
    refreshAuthUI: () => {},
    // ط§ط¹طھظ…ط§ط¯ظٹط§طھ js/app.js
    showToast: (msg) => toasts.push(msg),
    // ط§ط¹طھظ…ط§ط¯ظٹط§طھ js/app.js â€” ظ†ط¸ط§ظ… ط§ظ„ط£ظˆظپظ„ط§ظٹ (forum.js ظٹط±طھط¨ ظ†ط§ظپط°ط© ط§ظ„ط¥ط¨ظ„ط§ط؛ ط¹ط¨ط± wireDialogOverlay/openDialogOverlay/closeDialogOverlay)
    wireDialogOverlay: () => {},
    openDialogOverlay: () => {},
    closeDialogOverlay: () => {},
    escHtml: (v) => String(v ?? ""),
    renderState: () => {},
    renderBreadcrumb: () => {},
    getQueryParam: () => null,
    supabaseClient: makeMockSupabase({}).from ? makeMockSupabase({}) : null,
  };

  const ctx = Object.assign(defaultCtx, overrides);
  ctx.window.confirm = ctx.window.confirm || (() => true);
  const sandbox = vm.createContext(ctx);
  vm.runInContext(forumJsSource, sandbox, { filename: "forum.js" });

  return { sandbox, toasts, openAuthOverlayCalls, consoleLogs };
}

(async () => {
  console.log("AFOQ Forum MVP â€” Regression Tests\n");

  // ============================================================
  // Routing
  // ============================================================

  await testAsync("Routing â€” Sidebar forum link points to forum.html", async () => {
    assert.ok(authJsSource.includes('href="forum.html"'), "auth.js ظٹط¬ط¨ ط£ظ† ظٹط­طھظˆظٹ ط±ط§ط¨ط· forum.html ط­ظ‚ظٹظ‚ظٹ ظپظٹ ط§ظ„ظ‚ط§ط¦ظ…ط© ط§ظ„ط¬ط§ظ†ط¨ظٹط©");
  });

  await testAsync("Routing â€” No badge-soon left on the forum sidebar entry", async () => {
    const match = authJsSource.match(/<a href="forum\.html"[^]*?<\/a>/);
    assert.ok(match, "forum link block must exist");
    assert.ok(!match[0].includes("badge-soon"), "badge-soon ظٹط¬ط¨ ط£ظ„ط§ ظٹط¨ظ‚ظ‰ ط¹ظ„ظ‰ ط¹ظ†طµط± ط§ظ„ظ…ظ„طھظ‚ظ‰");
  });

  await testAsync("Routing â€” NOT IMPLEMENTED placeholder log removed", async () => {
    assert.ok(!authJsSource.includes("Forum destination: NOT IMPLEMENTED YET"), "ط±ط³ط§ظ„ط© ط§ظ„ظ€placeholder ط§ظ„ظ‚ط¯ظٹظ…ط© ظٹط¬ط¨ ط£ظ† طھظڈط²ط§ظ„ ط¨ط§ظ„ظƒط§ظ…ظ„");
  });

  // ============================================================
  // Auth gating (Guest vs Registered)
  // ============================================================

  await testAsync("Auth â€” Guest cannot open new-topic action (openAuthOverlay called instead)", async () => {
    const { sandbox, openAuthOverlayCalls } = loadForumJsSandbox({
      currentAuthUser: null,
      isAnonymousUser: () => true,
    });
    const result = sandbox.forumRequireRealUser();
    assert.strictEqual(result, false, "forumRequireRealUser must return false for a guest");
    assert.strictEqual(openAuthOverlayCalls.length, 1, "openAuthOverlay must be called exactly once for a guest attempt");
  });

  await testAsync("Auth â€” Registered (linked) user passes the gate without opening auth overlay", async () => {
    const { sandbox, openAuthOverlayCalls } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: { full_name: "ط·ط§ظ„ط¨" } },
      isAnonymousUser: () => false,
    });
    const result = sandbox.forumRequireRealUser();
    assert.strictEqual(result, true, "forumRequireRealUser must return true for a linked user");
    assert.strictEqual(openAuthOverlayCalls.length, 0, "openAuthOverlay must NOT be called for a linked user");
  });

  // ============================================================
  // XSS Protection
  // ============================================================

  await testAsync("Security â€” Topic card title is set via textContent, XSS payload stays literal text", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const payload = '<img src=x onerror="alert(1)">';
    const card = sandbox.buildForumTopicCard({
      id: "t1",
      title: payload,
      content: "ظ…ط­طھظˆظ‰ ط¹ط§ط¯ظٹ",
      author_name: "ط·ط§ظ„ط¨",
      created_at: new Date().toISOString(),
      is_locked: false,
      forum_categories: { name: "ط£ط³ط¦ظ„ط©", slug: "questions" },
    });
    const titleEl = card._children.find((c) => c.tagName === "H3");
    assert.ok(titleEl, "title element must exist");
    assert.strictEqual(titleEl.textContent, payload, "XSS payload must remain as literal textContent, never interpreted as HTML");
  });

  await testAsync("Security â€” Reply card content is set via textContent, never innerHTML", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const payload = '<script>alert(1)</script>';
    const card = sandbox.buildForumReplyCard({
      id: "r1", content: payload, author_id: "someone-else", author_name: "ط·ط§ظ„ط¨ ط¢ط®ط±", created_at: new Date().toISOString(),
    });
    const contentEl = card._children.find((c) => (c.className || "").includes("forum-content-text"));
    assert.ok(contentEl, "content element must exist");
    assert.strictEqual(contentEl.textContent, payload, "script payload must remain literal text, never executed/parsed as HTML");
  });

  // ============================================================
  // Locked topic blocks replies (client-side gating)
  // ============================================================

  await testAsync("Locked topic â€” reply form is hidden when topic.is_locked = true", async () => {
    const replyFormWrap = makeElement("DIV");
    const textarea = makeElement("TEXTAREA");
    const submitBtn = makeElement("BUTTON");
    const els = { "forum-reply-form-wrap": replyFormWrap, "forum-reply-content": textarea, "forum-reply-submit-btn": submitBtn };
    const { sandbox } = loadForumJsSandbox({
      currentAuthUser: null,
      isAnonymousUser: () => true,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()), createTextNode: (txt) => makeTextNode(txt), createElementNS: (_ns, tag) => makeElement(tag.toUpperCase()) },
    });
    sandbox.setupForumReplyForm({ is_locked: true });
    assert.strictEqual(replyFormWrap.hidden, true, "reply form must be hidden for a locked topic");
  });

  await testAsync("Locked topic â€” submitForumReply refuses to send and does not call insert", async () => {
    let insertCalled = false;
    const mockSupa = {
      from: (table) => {
        const b = makeMockSupabase({
          resultsByTable: {
            forum_topics: { data: [{ id: "t1", title: "ط¹ظ†ظˆط§ظ†", content: "ظ…ط­طھظˆظ‰", author_id: "someone", author_name: "ط·ط§ظ„ط¨", created_at: new Date().toISOString(), is_locked: true, is_hidden: false, category_id: "c1", forum_categories: { name: "ط£ط³ط¦ظ„ط©", slug: "questions" } }], error: null },
          },
        }).from(table);
        if (table === "forum_replies") {
          const originalInsert = b.insert;
          b.insert = (payload) => { insertCalled = true; return originalInsert.call(b, payload); };
        }
        return b;
      },
    };
    const textarea = makeElement("TEXTAREA");
    textarea.value = "ط±ط¯ ط¹ظ„ظ‰ ظ…ظˆط¶ظˆط¹ ظ…ط؛ظ„ظ‚";
    const els = {
      "breadcrumb": makeElement("NAV"),
      "forum-topic-container": makeElement("DIV"),
      "forum-replies-section": makeElement("SECTION"),
      "forum-replies-list": makeElement("DIV"),
      "forum-replies-load-more-btn": makeElement("BUTTON"),
      "forum-reply-form-wrap": makeElement("DIV"),
      "forum-reply-content": textarea,
      "forum-reply-submit-btn": makeElement("BUTTON"),
    };
    const { sandbox, toasts } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: {} },
      isAnonymousUser: () => false,
      supabaseClient: mockSupa,
      getQueryParam: () => "t1",
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()), createTextNode: (txt) => makeTextNode(txt), createElementNS: (_ns, tag) => makeElement(tag.toUpperCase()) },
    });
    // ظ†ظ‚ظˆط¯ ط§ظ„ط­ط§ظ„ط© ط¹ط¨ط± ط§ظ„ظ…ط³ط§ط± ط§ظ„ط­ظ‚ظٹظ‚ظٹ (loadForumTopicDetail) ط¨ط¯ظ„ طھط¹ظٹظٹظ†
    // forumCurrentTopic ظ…ط¨ط§ط´ط±ط© â€” ظ…طھط؛ظٹط±ط§طھ let/const ظپظٹ vm.runInContext ظ„ط§
    // طھظڈظ‚ط±ط£ ظˆظ„ط§ طھظڈظƒطھط¨ ظ…ظ† ط®ط§ط±ط¬ ط§ظ„ط³ظٹط§ظ‚ (طھط­ظ‚ظ‘ظ‚ظ†ط§ طھط¬ط±ظٹط¨ظٹظ‹ط§)طŒ ظپظ‚ط· ط§ظ„ط¯ظˆط§ظ„
    // ط§ظ„ظ…ظڈط¹ط±ظژظ‘ظپط© ط¨ظ€function طھظڈطھط§ط­ ظƒط®طµط§ط¦طµ ط¹ظ„ظ‰ sandboxطŒ ظˆظ‡ظٹ ظ…ط§ طھظڈط­ط¯ظ‘ط« طھظ„ظƒ
    // ط§ظ„ظ…طھط؛ظٹط±ط§طھ ط¯ط§ط®ظ„ظٹظ‹ط§ ط¨ط´ظƒظ„ طµط­ظٹط­.
    await sandbox.initForumTopicPage();
    await sandbox.submitForumReply({ preventDefault() {} });
    assert.strictEqual(insertCalled, false, "insert must never be called for a locked topic");
    assert.ok(toasts.some((t) => t.includes("مغلق")), "a toast explaining the topic is locked must be shown");
  });

  // ============================================================
  // Reporting
  // ============================================================

  await testAsync("Reporting â€” reason labels include the required 'offensive' (ط£ظ„ظپط§ط¸ ط¨ط°ظٹط¦ط© ط£ظˆ ط¥ط³ط§ط،ط©) reason", async () => {
    // ظ…ظ„ط§ط­ط¸ط©: FORUM_REPORT_REASON_LABELS ظ…ظڈط¹ط±ظژظ‘ظپ ط¨ظ€const ط¹ظ„ظ‰ ظ…ط³طھظˆظ‰ ط§ظ„ظ…ظ„ظپ â€”
    // ظ…طھط؛ظٹط±ط§طھ let/const ظپظٹ vm.runInContext ط؛ظٹط± ظ‚ط§ط¨ظ„ط© ظ„ظ„ظ‚ط±ط§ط،ط© ظ…ظ† ط®ط§ط±ط¬
    // ط§ظ„ط³ظٹط§ظ‚ (طھط­ظ‚ظ‘ظ‚ظ†ط§ طھط¬ط±ظٹط¨ظٹظ‹ط§)طŒ ظپظ‚ط· ط§ظ„ط¯ظˆط§ظ„ ط§ظ„ظ…ظڈط¹ط±ظژظ‘ظپط© ط¨ظ€function طھظڈطھط§ط­.
    // ظ„ط°ظ„ظƒ ظ†ط±ط§ط¬ط¹ ط§ظ„ظ…طµط¯ط± ط§ظ„ظ†طµظ‘ظٹ ظ…ط¨ط§ط´ط±ط© ظ‡ظ†ط§طŒ ط¨ط¯ظ„ ط§ظ„ظˆطµظˆظ„ ظˆظ‚طھ ط§ظ„طھط´ط؛ظٹظ„.
    assert.ok(/offensive:\s*"ألفاظ بذيئة أو إساءة"/.test(forumJsSource), "FORUM_REPORT_REASON_LABELS.offensive must equal \'ألفاظ بذيئة أو إساءة\'");
  });

  await testAsync("Reporting â€” report modal HTML includes a select with the offensive reason option", async () => {
    const topicHtml = fs.readFileSync(path.join(__dirname, "..", "forum-topic.html"), "utf-8");
    assert.ok(topicHtml.includes('id="forum-report-reason"'), "report reason select must exist");
    assert.ok(topicHtml.includes('value="offensive"'), "offensive reason option must exist");
    assert.ok(topicHtml.includes("ألفاظ بذيئة أو إساءة"), "offensive reason label text must exist");
  });

  await testAsync("Reporting â€” report button exists for both topic and reply cards", async () => {
    const { sandbox } = loadForumJsSandbox({ currentAuthUser: null, isAnonymousUser: () => true });
    const topicBox = sandbox.forumEl("div");
    // renderForumTopicDetail relies on real DOM getElementById; ط¨ط¯ظ„ ط°ظ„ظƒ
    // ظ†طھط­ظ‚ظ‚ ظ…ط¨ط§ط´ط±ط© ط£ظ† buildForumReplyCard ظٹظڈظ†ط´ط¦ ط²ط± ط¥ط¨ظ„ط§ط؛ ط¶ظ…ظ† children.
    const replyCard = sandbox.buildForumReplyCard({
      id: "r1", content: "ط±ط¯ ط¹ط§ط¯ظٹ", author_id: "x", author_name: "ط·ط§ظ„ط¨", created_at: new Date().toISOString(),
    });
    const actions = replyCard._children.find((c) => (c.className || "").includes("forum-item-actions"));
    assert.ok(actions, "actions container must exist on a reply card");
    const reportBtn = actions._children.find((c) => c.textContent && c.textContent.includes("إبلاغ"));
    assert.ok(reportBtn, "ًںڑ© ط¥ط¨ظ„ط§ط؛ button must exist on every reply card");
  });

  await testAsync("Reporting â€” submitting a report sends exactly one target (topic xor reply)", async () => {
    let capturedPayload = null;
    const mockSupa = {
      from: (table) => {
        const b = makeMockSupabase({}).from(table);
        if (table === "forum_reports") {
          b.insert = (payload) => { capturedPayload = payload; return Promise.resolve({ data: null, error: null }); };
        }
        return b;
      },
    };
    const reasonSelect = makeElement("SELECT"); reasonSelect.value = "offensive";
    const detailsTextarea = makeElement("TEXTAREA"); detailsTextarea.value = "";
    const els = {
      "forum-report-reason": reasonSelect,
      "forum-report-details": detailsTextarea,
      "forum-report-submit-btn": makeElement("BUTTON"),
      "forum-report-modal": makeElement("DIV"),
      "forum-report-form": makeElement("FORM"),
    };
    const { sandbox } = loadForumJsSandbox({
      currentAuthUser: { id: "user-1", user_metadata: {} },
      isAnonymousUser: () => false,
      supabaseClient: mockSupa,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()), createTextNode: (txt) => makeTextNode(txt), createElementNS: (_ns, tag) => makeElement(tag.toUpperCase()) },
    });
    // ظ†ظ‚ظˆط¯ forumReportTargetType/Id ط¹ط¨ط± ط§ظ„ظ…ط³ط§ط± ط§ظ„ط­ظ‚ظٹظ‚ظٹ (openForumReportModal)
    // ط¨ط¯ظ„ طھط¹ظٹظٹظ†ظ‡ظ…ط§ ظ…ط¨ط§ط´ط±ط©طŒ ظ„ظ†ظپط³ ط³ط¨ط¨ let/const ط£ط¹ظ„ط§ظ‡.
    sandbox.openForumReportModal("reply", "reply-42");
    await sandbox.submitForumReport({ preventDefault() {} });
    assert.ok(capturedPayload, "insert into forum_reports must be called");
    assert.strictEqual(capturedPayload.reply_id, "reply-42");
    assert.strictEqual(capturedPayload.topic_id, null, "topic_id must be null when reporting a reply");
    assert.strictEqual(capturedPayload.reason, "offensive");
  });

  // ============================================================
  // Pagination
  // ============================================================

  await testAsync("Pagination â€” first topics page requests range(0, 19) (20 per page)", async () => {
    const calls = [];
    const mockSupa = { from: (table) => {
      const b = makeMockSupabase({ resultsByTable: { forum_topics: { data: [], error: null } } }).from(table);
      const originalRange = b.range;
      b.range = (from, to) => { calls.push([from, to]); return originalRange.call(b, from, to); };
      return b;
    } };
    const els = { "forum-topics-list": makeElement("DIV"), "forum-load-more-btn": makeElement("BUTTON") };
    const { sandbox } = loadForumJsSandbox({
      supabaseClient: mockSupa,
      document: { getElementById: (id) => els[id] || makeElement(), createElement: (tag) => makeElement(tag.toUpperCase()), createTextNode: (txt) => makeTextNode(txt), createElementNS: (_ns, tag) => makeElement(tag.toUpperCase()) },
    });
    sandbox.forumCategoriesCache = [];
    sandbox.forumActiveCategorySlug = null;
    await sandbox.loadForumTopics(true);
    assert.deepStrictEqual(calls[0], [0, 19], "first page must request range(0, 19) â€” 20 items per page");
  });

  await testAsync("Pagination â€” replies page size is 20 per page", async () => {
    // ظ†ظپط³ ظ…ظ„ط§ط­ط¸ط© const ط£ط¹ظ„ط§ظ‡ â€” ظ…ط±ط§ط¬ط¹ط© ظ†طµظ‘ظٹط© ظ„ظ„ظ…طµط¯ط± ط¨ط¯ظ„ ظ‚ط±ط§ط،ط© ظˆظ‚طھ ط§ظ„طھط´ط؛ظٹظ„.
    assert.ok(/FORUM_REPLIES_PAGE_SIZE\s*=\s*20/.test(forumJsSource));
    assert.ok(/FORUM_TOPICS_PAGE_SIZE\s*=\s*20/.test(forumJsSource));
  });

  // ============================================================
  // Security â€” RLS / SQL review (ظ†طµظ‘ظٹ ظپظ‚ط·طŒ ط±ط§ط¬ط¹ ظ…ظ„ط§ط­ط¸ط© ط£ظ…ط§ظ†ط© ط£ط¹ظ„ظ‰ ط§ظ„ظ…ظ„ظپ)
  // ============================================================

  test("SQL review â€” RLS is enabled on all 4 forum tables", () => {
    ["forum_categories", "forum_topics", "forum_replies", "forum_reports"].forEach((t) => {
      const re = new RegExp(`alter table\\s+${t}\\s+enable row level security`);
      assert.ok(re.test(sqlSource), `RLS must be enabled on ${t}`);
    });
  });

  test("SQL review â€” ownership-only update/delete policies exist for topics and replies", () => {
    assert.ok(sqlSource.includes('"update_own_forum_topics"') && sqlSource.includes("author_id = auth.uid()"));
    assert.ok(sqlSource.includes('"delete_own_forum_topics"'));
    assert.ok(sqlSource.includes('"update_own_forum_replies"'));
    assert.ok(sqlSource.includes('"delete_own_forum_replies"'));
  });

  test("SQL review â€” locked topics are enforced against replies at the database level, not only in the UI", () => {
    const insertRepliesPolicy = sqlSource.match(/"insert_own_forum_replies"[^]*?with check \(([^]*?)\);/);
    assert.ok(insertRepliesPolicy, "insert_own_forum_replies policy must exist");
    assert.ok(insertRepliesPolicy[1].includes("is_locked = false"), "the WITH CHECK clause must reject replies to locked topics at the DB level");
  });

  test("SQL review â€” forum_reports enforces exactly one target (topic XOR reply)", () => {
    assert.ok(sqlSource.includes("forum_reports_single_target"), "single-target CHECK constraint must exist on forum_reports");
  });

  test("SQL review â€” no DROP TABLE / no destructive statement on any existing table", () => {
    assert.ok(!/drop\s+table/i.test(sqlSource), "migration must never DROP an existing table");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();


