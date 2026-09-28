/**
 * test-admin-moderation-ui.js
 * ------------------------------------------------------------------
 * اختبارات Phase 4 — واجهة الوساطة (تحذيرات + حظر + إلغاء) داخل تبويب
 * البلاغات في لوحة التحكم (admin/admin.js + admin/index.html).
 *
 * تتحقق من:
 *   - موقع قسم الوساطة داخل #panel-reports (لا تبويب جديد)؛
 *   - بوابة الرؤية = مرآة دقيقة لمسندات RLS (reports/view للقراءة،
 *     reports/edit للكتابة — لا نظام صلاحيات ثانٍ)؛
 *   - عمليات DB عبر RLS القائم فقط: INSERT user_warnings/user_bans،
 *     UPDATE user_bans (إلغاء) — لا DELETE، لا RPC جديد، لا كائنات DB؛
 *   - الحالة النشطة للحظر من fn_user_active_ban (RPC) — لا تكرار للحساب؛
 *   - تحذيرات ثابتة (لا تعديل/حذف) + لا مدد مفروضة (F2) + لا auto-ban (F1)؛
 *   - التدقيق عبر logActivity (warning_created/ban_created/ban_revoked)؛
 *   - البحث بالبريد مقيد بـ super_admin (قيود profiles RLS)؛
 *   - نصوص تأكيد دقيقة (confirmLabel — لا كلمات مضللة)؛
 *   - زر "إدارة المستخدم" على صفوف بلاغات المنتدى (author_id).
 *
 * التشغيل: node test/test-admin-moderation-ui.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ADMIN_JS_PATH = path.join(__dirname, "..", "admin", "admin.js");
const INDEX_HTML_PATH = path.join(__dirname, "..", "admin", "index.html");
const adminJsSource = fs.readFileSync(ADMIN_JS_PATH, "utf-8");
const indexHtmlSource = fs.readFileSync(INDEX_HTML_PATH, "utf-8");

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

/* mock supabase مع دعم insert/update/delete + تطبيق فلاتر eq (سلوك أقرب
 * للواقع — يسمح باختبار البحث بالبريد وتحميل الصلاحيات بدقة). */
function makeMockSupabase({ resultsByTable = {}, rpcResults = {} } = {}) {
  const calls = [];
  const inserts = [];
  const updates = [];
  const deletes = [];
  function builder(table) {
    const state = { table, filters: {}, op: null, payload: null };
    const chain = {
      select(cols) { if (!state.op) state.op = "select"; calls.push({ op: "select", table, cols }); return chain; },
      insert(payload) { state.op = "insert"; state.payload = payload; calls.push({ op: "insert", table, payload }); return chain; },
      update(payload) { state.op = "update"; state.payload = payload; calls.push({ op: "update", table, payload }); return chain; },
      delete() { state.op = "delete"; calls.push({ op: "delete", table }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ op: "eq", table, col, val }); return chain; },
      order(col, opts) { calls.push({ op: "order", table, col, opts }); return chain; },
      range(f, t) { state.range = [f, t]; calls.push({ op: "range", table, f, t }); return chain; },
      limit(n) { calls.push({ op: "limit", table, n }); return chain; },
      maybeSingle() { chain._single = "maybeSingle"; return chain; },
      single() { chain._single = "single"; return chain; },
      then(resolve) {
        const result = resultsByTable[table] || { data: [], error: null };
        if (state.op === "insert") {
          inserts.push({ table, payload: state.payload });
          const inserted = { id: "new-" + table, ...state.payload };
          resolve({ data: chain._single ? inserted : [inserted], error: null });
          return;
        }
        if (state.op === "update") {
          updates.push({ table, payload: state.payload, filters: state.filters });
          resolve({ data: [], error: null });
          return;
        }
        if (state.op === "delete") {
          deletes.push({ table, filters: state.filters });
          resolve({ data: [], error: null });
          return;
        }
        let data = result.data || [];
        for (const [col, val] of Object.entries(state.filters)) {
          data = data.filter((row) => row && row[col] === val);
        }
        if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
        if (chain._single) {
          resolve({ data: data[0] || null, error: result.error || null });
          return;
        }
        resolve({ data, error: result.error || null });
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
      unenroll: async () => ({ error: null }),
    },
  };
  return { supabase, calls, inserts, updates, deletes };
}

function setupSandbox({ resultsByTable = {}, rpcResults = {} } = {}) {
  const registry = {};
  const toasts = [];
  const consoleErrors = [];
  const storageStore = {};
  const tbody = makeElement("TBODY");
  const querySelectorResults = { "#reports-table tbody": tbody };
  const { supabase, calls, inserts, updates, deletes } = makeMockSupabase({ resultsByTable, rpcResults });

  const document = {
    body: { appendChild() {} },
    getElementById: (id) => registry[id] || (registry[id] = makeElement()),
    createElement: (tag) => makeElement(tag.toUpperCase()),
    createTextNode: () => ({}),
    querySelector: (sel) => querySelectorResults[sel] || makeElement(),
    querySelectorAll: () => [],
    contains: () => true,
    activeElement: null,
  };
  registry["reports-tab-badge"] = makeElement("SPAN");
  registry["reports-tab-badge"].hidden = true;

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
  return { sandbox, toasts, consoleErrors, calls, inserts, updates, deletes, tbody, registry };
}

/* ---- بيانات نموذجية ---- */
const MOD1 = { id: "mod1", email: "mod@afoq.test", role: "staff", active: true };
const MOD1_PERMS = [
  { user_id: "mod1", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true },
  { user_id: "mod1", entity_type: "reports", action: "edit", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true },
];
const MOD2 = { id: "mod2", email: "viewonly@afoq.test", role: "staff", active: true };
const MOD2_PERMS = [
  { user_id: "mod2", entity_type: "reports", action: "view", scope_type: "global", scope_id: null, scope_faculty_id: null, active: true },
];
const STAFF1 = { id: "staff1", email: "noperm@afoq.test", role: "staff", active: true };
const SA1 = { id: "sa1", email: "sa@afoq.test", role: "super_admin", active: true };

const WARNINGS = [
  { id: "w1", user_id: "target-user-1", reason: "إساءة متكررة", created_at: "2026-01-01T10:00:00Z", issued_by: "mod1" },
];
const BANS = [
  { id: "b1", user_id: "target-user-1", reason: "تجاوز", starts_at: "2026-01-01T00:00:00Z", expires_at: null, revoked_at: null, revoked_by: null, revoke_reason: null, created_at: "2026-01-01T00:00:00Z" },
  { id: "b2", user_id: "target-user-1", reason: "قديم", starts_at: "2025-01-01T00:00:00Z", expires_at: "2025-02-01T00:00:00Z", revoked_at: null, revoked_by: null, revoke_reason: null, created_at: "2025-01-01T00:00:00Z" },
  { id: "b3", user_id: "target-user-1", reason: "ملغى", starts_at: "2025-03-01T00:00:00Z", expires_at: null, revoked_at: "2025-04-01T00:00:00Z", revoked_by: "mod1", revoke_reason: "خطأ في التقدير", created_at: "2025-03-01T00:00:00Z" },
];
const ACTIVE_BAN_RPC = { data: { id: "b1", reason: "تجاوز", starts_at: "2026-01-01T00:00:00Z", expires_at: null }, error: null };
const COUNT_RPC = { data: 1, error: null };
const LOCK_RPC = { acquire_admin_session_lock: { data: { acquired: true, session_token: "t" }, error: null } };

function forumReport(id, { reason = "offensive", details = null, status = "pending", created_at, isTopic = true, title = "موضوع Y", author_id = "author-1", author_name = "مؤلف", is_hidden = false } = {}) {
  if (isTopic) {
    return { id, reason, details, status, created_at, topic_id: "t-" + id, reply_id: null, forum_topics: { id: "t-" + id, title, author_name, author_id, is_hidden }, forum_replies: null };
  }
  return { id, reason, details, status, created_at, topic_id: "t9", reply_id: "r-" + id, forum_topics: null, forum_replies: { id: "r-" + id, content: "رد نصي", author_name, author_id, is_hidden, topic_id: "t9" } };
}

async function authAs(env, profile, perms) {
  await env.sandbox.loadCurrentUserAuthorization({ id: profile.id, email: profile.email });
  await flush();
}

// الوصول إلى عنصر عبر document.getElementById الخاص بالـ sandbox — يضمن
// إنشاء العنصر في السجل (getElementById يخلق العنصر عند أول طلب) بدل
// القراءة المباشرة من env.registry التي تفشل قبل أول استدعاء.
function el(env, id) {
  return env.sandbox.document.getElementById(id);
}

(async () => {
  console.log("AFOQ Admin (admin/admin.js) — Phase 4 Moderation UI Tests\n");

  /* ==================== STATIC — البنية والمصدر ==================== */

  await testAsync("M16-UI — moderation section lives inside #panel-reports (no new tab)", async () => {
    assert.ok(indexHtmlSource.includes('id="moderation-section"'), "قسم الوساطة موجود في index.html");
    const panelReports = indexHtmlSource.slice(indexHtmlSource.indexOf('id="panel-reports"'), indexHtmlSource.indexOf('id="panel-users"'));
    assert.ok(panelReports.includes('id="moderation-section"'), "قسم الوساطة داخل panel-reports");
    assert.ok(!indexHtmlSource.includes('id="tab-moderation"'), "لا تبويب جديد للوساطة");
    assert.ok(!indexHtmlSource.includes('data-tab="moderation"'), "لا زر تبويب جديد");
    assert.ok(indexHtmlSource.includes('id="mod-search-input"'), "حقل البحث موجود");
    assert.ok(indexHtmlSource.includes('id="mod-user-panel"'), "حاوية لوحة المستخدم موجودة");
  });

  await testAsync("M16-UI — moderation functions exist in admin.js", async () => {
    const fns = ["canReadModeration", "canWriteModeration", "showModerationSection", "openModerationForUser",
      "searchModerationUser", "loadModerationForUser", "renderModerationPanel", "submitModerationWarning",
      "submitModerationBan", "revokeModerationBan", "banStatus"];
    for (const fn of fns) {
      assert.ok(adminJsSource.includes(`function ${fn}`) || adminJsSource.includes(`async function ${fn}`), `${fn} يجب أن تكون معرّفة`);
    }
  });

  await testAsync("M16-UI — read/write gates mirror RLS predicates exactly (global view/edit)", async () => {
    assert.ok(adminJsSource.includes('hasPerm("reports", null, null, "view")'), "القراءة = reports/view عالمية (مرآة مسند السياسة)");
    assert.ok(adminJsSource.includes('hasPerm("reports", null, null, "edit")'), "الكتابة = reports/edit عالمية (مرآة مسند السياسة)");
    assert.ok(adminJsSource.includes('currentProfile.role === "super_admin"'), "super_admin يبقى على مساره الحالي");
  });

  await testAsync("M16-UI — DB ops use existing RLS paths only: INSERT warnings/bans, UPDATE revoke, no DELETE", async () => {
    assert.ok(/from\("user_warnings"\)\.insert\(/.test(adminJsSource), "التحذير عبر INSERT user_warnings");
    assert.ok(/from\("user_bans"\)\.insert\(/.test(adminJsSource), "الحظر عبر INSERT user_bans");
    assert.ok(/from\("user_bans"\)\.update\(/.test(adminJsSource), "الإلغاء عبر UPDATE user_bans");
    assert.ok(!/from\("user_bans"\)\.delete\(\)/.test(adminJsSource), "لا DELETE على user_bans (التاريخ محفوظ)");
    assert.ok(!/from\("user_warnings"\)\.(update|delete)\(\)/.test(adminJsSource), "لا تعديل/حذف تحذيرات (ثابتة — F1)");
    assert.ok(adminJsSource.includes("issued_by: currentProfile.id"), "issued_by = هوية المشرف الحالي");
  });

  await testAsync("M16-UI — active ban comes from fn_user_active_ban RPC (no duplicated JS predicate)", async () => {
    assert.ok(adminJsSource.includes('rpc("fn_user_active_ban"'), "الحالة النشطة عبر RPC fn_user_active_ban");
    assert.ok(adminJsSource.includes('rpc("fn_user_warning_count"'), "عدد التحذيرات عبر RPC fn_user_warning_count");
  });

  await testAsync("M16-UI — no auto-ban, no fixed duration ladder (F1/F2), no new DB objects", async () => {
    assert.ok(!adminJsSource.includes("trg_user_warnings_auto_ban"), "لا trigger حظر تلقائي");
    assert.ok(!adminJsSource.includes("auto_ban") && !adminJsSource.includes("autoBan"), "لا منطق auto-ban");
    assert.ok(!/86400000\s*\*\s*(7|30)/.test(adminJsSource), "لا سلم مدد مفروضة (7/30 يومًا)");
    assert.ok(!/create\s+(table|function|policy|index|trigger)/i.test(adminJsSource), "لا CREATE TABLE/FUNCTION/POLICY في admin.js");
  });

  await testAsync("M16-UI — audit via logActivity with precise actions", async () => {
    assert.ok(adminJsSource.includes('"warning_created"'), "تدقيق warning_created");
    assert.ok(adminJsSource.includes('"ban_created"'), "تدقيق ban_created");
    assert.ok(adminJsSource.includes('"ban_revoked"'), "تدقيق ban_revoked");
  });

  await testAsync("M16-UI — email search gated to super_admin (profiles RLS = self-or-super)", async () => {
    assert.ok(adminJsSource.includes('currentProfile?.role !== "super_admin"'), "البحث بالبريد مقيد بـ super_admin");
  });

  await testAsync("M16-UI — no misleading wording: revoke uses explicit confirmLabel", async () => {
    assert.ok(adminJsSource.includes('confirmLabel: "تأكيد إلغاء الحظر"'), "نص تأكيد الإلغاء دقيق (ليس تأكيد الحذف)");
    assert.ok(adminJsSource.includes("confirmLabel"), "showDestructiveConfirm يدعم confirmLabel");
    assert.ok(adminJsSource.includes("inputPlaceholder"), "showDestructiveConfirm يدعم inputPlaceholder");
  });

  await testAsync("M16-UI — loadReports fetches author_id for forum content", async () => {
    assert.ok(adminJsSource.includes("author_name, author_id"), "author_id في select بلاغات المنتدى");
  });

  /* ==================== SANDBOX — السلوك الفعلي ==================== */

  await testAsync("M16-UI — loadModerationForUser renders warnings, bans history and active status", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    await env.sandbox.loadModerationForUser("target-user-1", "مؤلف");
    await flush();

    const panelHtml = el(env, "mod-user-panel")._innerHTML;
    assert.ok(panelHtml.includes("المستخدم:"), "رأس الهوية معروض");
    assert.ok(panelHtml.includes("حظر نشط — دائم"), "الحالة النشطة (دائم) معروضة من RPC");
    assert.ok(panelHtml.includes("عدد التحذيرات: 1"), "عدد التحذيرات معروض من RPC");
    assert.ok(panelHtml.includes("mod-add-warning-btn"), "زر إضافة تحذير ظاهر (يملك edit)");
    assert.ok(panelHtml.includes("mod-create-ban-btn"), "زر إنشاء حظر ظاهر (يملك edit)");
    assert.ok(panelHtml.includes("mod-revoke-ban-btn"), "زر إلغاء الحظر ظاهر (يوجد حظر نشط)");

    const warnRows = el(env, "mod-warnings-tbody")._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(warnRows.length, 1, "صف تحذير واحد");
    assert.ok(warnRows[0]._children.some((td) => td.textContent.includes("إساءة متكررة")), "سبب التحذير معروض");

    const banRows = el(env, "mod-bans-tbody")._children.filter((c) => c.tagName === "TR");
    assert.strictEqual(banRows.length, 3, "ثلاثة صفوف حظر (نشط + منتهي + مُلغى)");
    const labels = banRows.map((tr) => tr._children[3]._children[0].textContent);
    assert.ok(labels.some((l) => l.includes("نشط")), "شارة نشط موجودة");
    assert.ok(labels.some((l) => l.includes("منتهي")), "شارة منتهي موجودة");
    assert.ok(labels.some((l) => l.includes("مُلغى")), "شارة مُلغى موجودة");
  });

  await testAsync("M16-UI — view-only moderator (reports/view global, no edit) gets read-only panel", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD2], error: null },
        user_permissions: { data: MOD2_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD2, MOD2_PERMS);
    await env.sandbox.loadModerationForUser("target-user-1");
    await flush();

    const panelHtml = el(env, "mod-user-panel")._innerHTML;
    assert.ok(panelHtml.includes("وضع القراءة فقط"), "رسالة القراءة فقط معروضة");
    assert.ok(!panelHtml.includes("mod-add-warning-btn"), "لا زر إضافة تحذير لقراءة فقط");
    assert.ok(!panelHtml.includes("mod-create-ban-btn"), "لا زر إنشاء حظر لقراءة فقط");
    assert.ok(!panelHtml.includes("mod-revoke-ban-btn"), "لا زر إلغاء لقراءة فقط");
  });

  await testAsync("M16-UI — submitModerationWarning inserts with issued_by and logs warning_created", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    el(env, "mod-warning-reason").value = "سبب الاختبار";
    await env.sandbox.submitModerationWarning("target-user-1");
    await flush();

    const ins = env.inserts.find((i) => i.table === "user_warnings");
    assert.ok(ins, "تم استدعاء INSERT على user_warnings");
    assert.strictEqual(ins.payload.user_id, "target-user-1");
    assert.strictEqual(ins.payload.issued_by, "mod1");
    assert.strictEqual(ins.payload.reason, "سبب الاختبار");
    const log = env.inserts.find((i) => i.table === "admin_activity_log");
    assert.ok(log && log.payload.action === "warning_created", "تدقيق warning_created عبر logActivity");
    assert.ok(env.toasts.some((t) => t.includes("تم إضافة التحذير")), "رسالة نجاح معروضة");
  });

  await testAsync("M16-UI — submitModerationBan permanent inserts with expires_at null and logs ban_created", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    el(env, "mod-ban-reason").value = "سبب الحظر";
    el(env, "mod-ban-type").value = "permanent";
    el(env, "mod-ban-starts").value = "";
    await env.sandbox.submitModerationBan("target-user-1");
    await flush();

    const ins = env.inserts.find((i) => i.table === "user_bans");
    assert.ok(ins, "تم استدعاء INSERT على user_bans");
    assert.strictEqual(ins.payload.user_id, "target-user-1");
    assert.strictEqual(ins.payload.issued_by, "mod1");
    assert.strictEqual(ins.payload.reason, "سبب الحظر");
    assert.strictEqual(ins.payload.expires_at, null, "الحظر الدائم = expires_at null (F2 — مدة حرة)");
    assert.ok(ins.payload.starts_at, "starts_at محدد");
    const log = env.inserts.find((i) => i.table === "admin_activity_log");
    assert.ok(log && log.payload.action === "ban_created", "تدقيق ban_created عبر logActivity");
  });

  await testAsync("M16-UI — submitModerationBan temporary inserts with expires_at and validates order", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    el(env, "mod-ban-reason").value = "حظر مؤقت";
    el(env, "mod-ban-type").value = "temporary";
    el(env, "mod-ban-starts").value = "2026-10-01T10:00";
    el(env, "mod-ban-expires").value = "2026-12-31T23:59";
    await env.sandbox.submitModerationBan("target-user-1");
    await flush();

    const ins = env.inserts.find((i) => i.table === "user_bans");
    assert.ok(ins, "تم استدعاء INSERT على user_bans");
    assert.ok(ins.payload.expires_at, "الحظر المؤقت = expires_at محدد");
    assert.ok(new Date(ins.payload.expires_at) > new Date(ins.payload.starts_at), "الانتهاء بعد البداية");

    // انتهاء قبل البداية → رفض بدون INSERT
    const before = env.inserts.length;
    el(env, "mod-ban-expires").value = "2026-09-01T10:00";
    await env.sandbox.submitModerationBan("target-user-1");
    await flush();
    assert.strictEqual(env.inserts.length, before, "لا INSERT عند انتهاء قبل البداية");
    assert.ok(env.toasts.some((t) => t.includes("يجب أن يكون الانتهاء بعد البداية")), "رسالة تحقق معروضة");
  });

  await testAsync("M16-UI — revokeModerationBan updates revoked_* fields (no delete) and logs ban_revoked", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    await env.sandbox.revokeModerationBan("b1", "target-user-1", "سبب الإلغاء");
    await flush();

    const upd = env.updates.find((u) => u.table === "user_bans");
    assert.ok(upd, "تم استدعاء UPDATE على user_bans");
    assert.strictEqual(upd.filters.id, "b1");
    assert.ok(upd.payload.revoked_at, "revoked_at محدد");
    assert.strictEqual(upd.payload.revoked_by, "mod1");
    assert.strictEqual(upd.payload.revoke_reason, "سبب الإلغاء");
    assert.strictEqual(env.deletes.length, 0, "لا DELETE إطلاقًا");
    const log = env.inserts.find((i) => i.table === "admin_activity_log");
    assert.ok(log && log.payload.action === "ban_revoked", "تدقيق ban_revoked عبر logActivity");
  });

  await testAsync("M16-UI — ban history filter works locally (revoked/expired/active)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    await env.sandbox.loadModerationForUser("target-user-1");
    await flush();

    const filter = el(env, "mod-ban-filter");
    const countRows = () => el(env, "mod-bans-tbody")._children.filter((c) => c.tagName === "TR").length;
    assert.strictEqual(countRows(), 3, "الكل = 3 صفوف");

    filter.value = "revoked";
    filter._listeners.change[0]();
    await flush();
    assert.strictEqual(countRows(), 1, "فلتر مُلغى = صف واحد");

    filter.value = "expired";
    filter._listeners.change[0]();
    await flush();
    assert.strictEqual(countRows(), 1, "فلتر منتهي = صف واحد");

    filter.value = "active";
    filter._listeners.change[0]();
    await flush();
    assert.strictEqual(countRows(), 1, "فلتر نشط = صف واحد (b1)");
  });

  await testAsync("M16-UI — searchModerationUser by UUID loads the moderation panel", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD1], error: null },
        user_permissions: { data: MOD1_PERMS, error: null },
        user_warnings: { data: WARNINGS, error: null },
        user_bans: { data: BANS, error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: ACTIVE_BAN_RPC, fn_user_warning_count: COUNT_RPC },
    });
    await authAs(env, MOD1, MOD1_PERMS);
    el(env, "mod-search-input").value = "11111111-2222-3333-4444-555555555555";
    await env.sandbox.searchModerationUser();
    await flush();

    assert.ok(el(env, "mod-user-panel")._innerHTML.includes("المستخدم:"), "لوحة الوساطة حُمّلت بعد البحث");
    assert.ok(env.calls.some((c) => c.op === "select" && c.table === "user_warnings"), "استعلام التحذيرات نُفّذ");
  });

  await testAsync("M16-UI — email search rejected for non-super-admin (no profiles query)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [MOD2], error: null },
        user_permissions: { data: MOD2_PERMS, error: null },
        user_warnings: { data: [], error: null },
        user_bans: { data: [], error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: { data: null, error: null }, fn_user_warning_count: { data: 0, error: null } },
    });
    await authAs(env, MOD2, MOD2_PERMS);
    el(env, "mod-search-input").value = "someone@afoq.com";
    await env.sandbox.searchModerationUser();
    await flush();

    assert.ok(env.toasts.some((t) => t.includes("البحث بالبريد متاح للمشرف العام فقط")), "رسالة رفض البحث بالبريد");
    assert.ok(!env.calls.some((c) => c.op === "select" && c.table === "profiles" && c.cols === "id"), "لا استعلام profiles بالبريد");
  });

  await testAsync("M16-UI — email search works for super_admin (profiles lookup then moderation load)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [SA1, { id: "target-user-1", email: "target@afoq.com", role: "staff", active: true }], error: null },
        user_permissions: { data: [], error: null },
        user_warnings: { data: [], error: null },
        user_bans: { data: [], error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: { data: null, error: null }, fn_user_warning_count: { data: 0, error: null } },
    });
    await authAs(env, SA1, []);
    el(env, "mod-search-input").value = "target@afoq.com";
    await env.sandbox.searchModerationUser();
    await flush();

    assert.ok(el(env, "mod-user-panel")._innerHTML.includes("المستخدم:"), "لوحة الوساطة حُمّلت بعد البحث بالبريد");
    const emailLookup = env.calls.filter((c) => c.op === "select" && c.table === "profiles" && c.cols === "id");
    assert.ok(emailLookup.length >= 1, "تم البحث في profiles بالبريد");
  });

  await testAsync("M16-UI — 'إدارة المستخدم' button appears on forum report rows for moderators (content cell)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [SA1], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [], error: null },
        forum_reports: { data: [forumReport("2", { status: "pending", created_at: "2026-01-02T00:00:00Z", title: "موضوع معلق", author_id: "author-1", author_name: "مؤلف" })], error: null },
        user_warnings: { data: [], error: null },
        user_bans: { data: [], error: null },
      },
      rpcResults: { ...LOCK_RPC, fn_user_active_ban: { data: null, error: null }, fn_user_warning_count: { data: 0, error: null } },
    });
    await authAs(env, SA1, []);
    await env.sandbox.loadReports();
    await flush();

    const tr = env.tbody._children.filter((c) => c.tagName === "TR")[0];
    const contentTd = tr._children.find((td) => td.getAttribute("data-label") === "المحتوى المُبلَّغ عنه");
    const authorLine = contentTd._children.find((c) => c.className === "mod-author-line");
    assert.ok(authorLine, "سطر هوية المؤلف داخل خلية المحتوى");
    const modBtn = authorLine._children.find((c) => c.tagName === "BUTTON" && c.textContent.includes("إدارة المستخدم"));
    assert.ok(modBtn, "زر إدارة المستخدم في خلية المحتوى");
    assert.ok(authorLine._children.some((c) => c.textContent.includes("بواسطة: مؤلف")), "هوية المؤلف معروضة");

    // النقر يفتح لوحة الوساطة للمؤلف
    modBtn._listeners.click[0]();
    await flush();
    assert.strictEqual(el(env, "mod-search-input").value, "author-1", "حقل البحث يُعبأ بمعرّف المؤلف");
    assert.ok(el(env, "mod-user-panel")._innerHTML.includes("المستخدم:"), "لوحة الوساطة فُتحت للمؤلف");
  });

  await testAsync("M16-UI — no 'إدارة المستخدم' button for staff without reports/view (no accidental exposure)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [STAFF1], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [], error: null },
        forum_reports: { data: [forumReport("2", { status: "pending", created_at: "2026-01-02T00:00:00Z", title: "موضوع", author_id: "author-1" })], error: null },
      },
      rpcResults: { ...LOCK_RPC },
    });
    await authAs(env, STAFF1, []);
    await env.sandbox.loadReports();
    await flush();

    const tr = env.tbody._children.filter((c) => c.tagName === "TR")[0];
    const contentTd = tr._children.find((td) => td.getAttribute("data-label") === "المحتوى المُبلَّغ عنه");
    assert.ok(!contentTd._children.some((c) => c.tagName === "BUTTON"), "لا زر إدارة مستخدم لمن بلا صلاحيات");
    assert.strictEqual(el(env, "moderation-section").hidden, true, "قسم الوساطة مخفي لمن بلا reports/view");
  });

  await testAsync("M16-UI — showModerationSection reveals section only for readers (super_admin)", async () => {
    const env = setupSandbox({
      resultsByTable: {
        profiles: { data: [SA1], error: null },
        user_permissions: { data: [], error: null },
        reports: { data: [], error: null },
        // صف بلاغ واحد حتى يصل loadReports إلى showModerationSection
        // (بدون صفوف يعود مبكرًا قبل استدعاء الإظهار/الإخفاء).
        forum_reports: { data: [forumReport("2", { status: "pending", created_at: "2026-01-02T00:00:00Z", title: "موضوع", author_id: "author-1" })], error: null },
      },
      rpcResults: { ...LOCK_RPC },
    });
    await authAs(env, SA1, []);
    await env.sandbox.loadReports();
    await flush();
    assert.strictEqual(el(env, "moderation-section").hidden, false, "قسم الوساطة ظاهر لـ super_admin");
  });

  await testAsync("M16-UI — showDestructiveConfirm supports confirmLabel + inputPlaceholder (no misleading wording)", async () => {
    const env = setupSandbox({});
    let received = null;
    env.sandbox.showDestructiveConfirm({
      title: "إلغاء الحظر",
      message: "سيُلغى الحظر النشط.",
      confirmLabel: "تأكيد إلغاء الحظر",
      inputPlaceholder: "سبب الإلغاء (اختياري)",
      onConfirm: (v) => { received = v; },
    });
    const ok = el(env, "admin-confirm-ok");
    assert.strictEqual(ok.textContent, "تأكيد إلغاء الحظر", "نص الزر دقيق — ليس تأكيد الحذف");
    const input = el(env, "admin-confirm-input");
    assert.strictEqual(input.hidden, false, "حقل الإدخال ظاهر عند تمرير inputPlaceholder");
    input.value = "  سبب الإلغاء  ";
    ok._listeners.click[0]();
    await flush();
    assert.strictEqual(received, "سبب الإلغاء", "قيمة الحقل تُمرَّر مقصوصة إلى onConfirm");
  });

  await testAsync("M16-UI — default confirm label stays 'تأكيد الحذف' (backward compatible)", async () => {
    const env = setupSandbox({});
    let called = 0;
    env.sandbox.showDestructiveConfirm({ title: "تأكيد الحذف", message: "م", onConfirm: () => { called++; } });
    const ok = el(env, "admin-confirm-ok");
    assert.strictEqual(ok.textContent, "تأكيد الحذف", "الافتراضي لم يتغير");
    const input = el(env, "admin-confirm-input");
    assert.strictEqual(input.hidden, true, "حقل الإدخال مخفي افتراضيًا");
    ok._listeners.click[0]();
    await flush();
    assert.strictEqual(called, 1, "الاستدعاء القديم بلا معاملات ما زال يعمل");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(failures > 0 ? 1 : 0);
})();