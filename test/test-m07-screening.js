/**
 * test-m07-screening.js
 * ------------------------------------------------------------------
 * M-07 — Automated Content Screening (Group B — M17).
 *
 * يتحقق من الجانب التطبيقي (Big Pickle scope) دون أي DB mutation:
 *  1) ملف M17 موجود وموثّق NOT APPLIED — PARITY REFERENCE (B4):
 *     إضافي فقط (لا DROP table، لا drop policy، لا مساس بسياسات
 *     المنتدى القائمة)؛ لا إعادة تعريف لـ submit_public_report (G6).
 *  2) المخطط: content_version على المواضيع/الردود، m07_screening_events
 *     ثابت (لا UPDATE/DELETE)، m07_moderation_cases بقيد الاتساق،
 *     m07_moderator_recipients، m07_backlog_state.
 *  3) الصلاحيات: قراءة = مسند المشرف (reports/view)؛ كل الكتابة عبر
 *     دوال SECURITY DEFINER (reports/edit / super_admin)؛ لا anon،
 *     لا self-service، لا حذف.
 *  4) الإنفاذ: FAILURE/FLAGGED → is_hidden=true (hold-hidden) بلا raise
 *     (الحدث يبقى محفوظًا)؛ الأدمن مستثنى (G4)؛ الفحص مرتبط بالإصدار
 *     (ثابتة B)؛ FLAGGED يُنشئ حالة وساطة (ثابتة E).
 *  5) قرارات السياسة المعتمدة: ثابتة A (لا نشر بلا فحص — fail-closed)،
 *     G5 (البلاغات لا تُحجب أبدًا)، G7 (قائمة الانتظار لا تغيّر رؤية
 *     المحتوى المنشور سابقًا — مسار إعادة المحاولة فقط للمحتوى المحجوز).
 *  6) تكامل العميل: m07.js fail-closed افتراضيًا؛ forum.js يستدعي الحدود
 *     قبل الكتابة؛ app.js يستدعي الحدود قبل إرسال بلاغ المورد؛ وسوم
 *     <script> على الصفحات الست؛ mock test-forum.js يدعم .or().
 *  7) Regression: M12/M13/M16 سليمة (مرجعية).
 *
 * التشغيل: node test/test-m07-screening.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const M17 = path.join(ROOT, "sql", "p1_final_m17_m07_screening.sql");
const M12 = path.join(ROOT, "sql", "p1_final_m12_forum_owner_update_guard.sql");
const M13 = path.join(ROOT, "sql", "p1_final_m13_forum_report_integrity.sql");
const M16 = path.join(ROOT, "sql", "p1_final_m16_moderation_foundation.sql");
const M07_JS = path.join(ROOT, "js", "m07.js");
const FORUM_JS = path.join(ROOT, "js", "forum.js");
const APP_JS = path.join(ROOT, "js", "app.js");
const TEST_FORUM = path.join(ROOT, "test", "test-forum.js");
const PAGES = ["forum.html", "forum-topic.html", "favorites.html", "platform.html", "search.html", "subject.html"];

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

const m17 = fs.readFileSync(M17, "utf-8");
const m12 = fs.readFileSync(M12, "utf-8");
const m13 = fs.readFileSync(M13, "utf-8");
const m16 = fs.readFileSync(M16, "utf-8");
const m07Js = fs.readFileSync(M07_JS, "utf-8");
const forumJs = fs.readFileSync(FORUM_JS, "utf-8");
const appJs = fs.readFileSync(APP_JS, "utf-8");
const testForum = fs.readFileSync(TEST_FORUM, "utf-8");

// الجزء التنفيذي فقط (بدون رأس التوثيق وقسم ROLLBACK) — تُفحص عليه
// قواعد "إضافي فقط" وقرارات السياسة حتى لا تتعارض مع التوثيق نفسه.
const execPart = m17.slice(
  m17.indexOf("alter table public.forum_topics add column"),
  m17.indexOf("-- ROLLBACK (documented")
);

// استخراج جسم دالة كاملًا (حتى الفاصل الختامي $function$;).
function fnBody(name) {
  const re = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`);
  const m = execPart.match(re);
  return m ? m[0] : "";
}

console.log("AFOQ M-07 Automated Content Screening (M17) — Regression Tests\n");

// ============================================================
// 1) File integrity — additive-only, documented status
// ============================================================

test("M17 — file exists, marked NOT APPLIED — PARITY REFERENCE, additive-only", () => {
  assert.ok(fs.existsSync(M17), "M17 file must exist");
  assert.ok(/NOT APPLIED — PARITY REFERENCE/.test(m17), "M17 must be marked NOT APPLIED — PARITY REFERENCE (B4)");
  assert.ok(!/drop table\s/i.test(execPart), "executable part must not drop any table");
  assert.ok(!/drop policy/i.test(execPart), "executable part must not drop any existing policy");
  const drops = execPart.match(/drop trigger if exists (\w+)/g) || [];
  assert.ok(drops.length > 0, "idempotent drop trigger if exists must be present (M12/M16 pattern)");
  for (const d of drops) {
    assert.ok(/trg_m07_/.test(d), `only M-07's own triggers may be dropped (found: ${d})`);
  }
});

test("M17 — must not redefine M12/M13/M16 guards or submit_public_report (no regression)", () => {
  assert.ok(!m17.includes("fn_forum_guard_owner_update"), "M17 must not redefine the M12 owner-update guard");
  assert.ok(!m17.includes("fn_forum_report_write_guard"), "M17 must not redefine the M13 report write guard");
  assert.ok(!m17.includes("fn_forum_ban_enforcement"), "M17 must not redefine the M16 ban enforcement");
  assert.ok(!/create or replace function public\.submit_public_report/.test(execPart), "M17 must not redefine submit_public_report (G6 — M13 parity)");
  assert.ok(/APPLIED LIVE/.test(m12), "M12 file must still be marked APPLIED LIVE (reference check)");
  assert.ok(/APPLIED LIVE/.test(m13), "M13 file must still be marked APPLIED LIVE (reference check)");
  assert.ok(/APPLIED — LIVE DB/.test(m16), "M16 file must still be marked APPLIED — LIVE DB (reference check)");
});

// ============================================================
// 2) Schema — content_version + four M-07 tables
// ============================================================

test("M17 — content_version columns added to forum_topics and forum_replies", () => {
  assert.ok(m17.includes("alter table public.forum_topics add column if not exists content_version integer not null default 1"), "forum_topics.content_version must be added");
  assert.ok(m17.includes("alter table public.forum_replies add column if not exists content_version integer not null default 1"), "forum_replies.content_version must be added");
});

test("M17 — m07_screening_events: RLS, PK, surface/result CHECK, append-only", () => {
  assert.ok(m17.includes("create table public.m07_screening_events"), "m07_screening_events must be created");
  assert.ok(m17.includes("id uuid primary key default gen_random_uuid()"), "events must have a uuid PK");
  assert.ok(m17.includes("surface in ('forum_topic', 'forum_reply', 'forum_report', 'resource_report')"), "surface CHECK must cover all four surfaces");
  assert.ok(m17.includes("result in ('normal', 'flagged', 'failure')"), "result CHECK must be normal/flagged/failure");
  assert.ok(m17.includes("enable row level security"), "events must have RLS enabled");
  assert.ok(!m17.includes("moderator_update_m07_events"), "no UPDATE policy on events (append-only)");
  assert.ok(!m17.includes("moderator_delete_m07_events"), "no DELETE policy on events (append-only)");
});

test("M17 — m07_moderation_cases: RLS, FK to event, open/resolved consistency constraint", () => {
  assert.ok(m17.includes("create table public.m07_moderation_cases"), "m07_moderation_cases must be created");
  assert.ok(m17.includes("screening_event_id uuid not null references public.m07_screening_events(id)"), "case must FK to its screening event");
  assert.ok(m17.includes("m07_cases_consistency"), "open/resolved consistency constraint must exist");
  assert.ok(m17.includes("status in ('open', 'resolved')"), "status CHECK must be open/resolved");
  assert.ok(m17.includes("decision in ('keep', 'hide')"), "decision CHECK must be keep/hide");
  assert.ok(m17.includes("enable row level security"), "cases must have RLS enabled");
});

test("M17 — m07_moderator_recipients and m07_backlog_state exist with RLS", () => {
  assert.ok(m17.includes("create table public.m07_moderator_recipients"), "recipients table must be created");
  assert.ok(m17.includes("user_id uuid primary key references auth.users(id) on delete cascade"), "recipients.user_id must FK to auth.users");
  assert.ok(m17.includes("create table public.m07_backlog_state"), "backlog state table must be created");
  assert.ok(m17.includes("primary key (surface, content_id, content_version)"), "backlog state PK must be (surface, content_id, content_version)");
  assert.ok(m17.includes("last_result in ('normal', 'flagged', 'failure')"), "backlog last_result CHECK must exist");
  assert.ok(m17.includes("enable row level security"), "both tables must have RLS enabled");
});

// ============================================================
// 3) Authorization — moderator-only, no anon, no self-service
// ============================================================

test("M17 — reads use the phase7 admin-read predicate (reports/view)", () => {
  const viewPred = "fn_is_super_admin() or fn_has_permission('reports', null, 'view')";
  assert.ok(m17.includes(viewPred), "SELECT policies must use reports/view");
  assert.ok(m17.includes("moderator_read_m07_events"), "events read policy must exist");
  assert.ok(m17.includes("moderator_read_m07_cases"), "cases read policy must exist");
  assert.ok(m17.includes("moderator_read_m07_recipients"), "recipients read policy must exist");
});

test("M17 — writes are SECURITY DEFINER functions gated by reports/edit or super_admin", () => {
  const decide = fnBody("fn_m07_decide_case");
  assert.ok(decide, "fn_m07_decide_case must be defined");
  assert.ok(/security definer/.test(decide), "decide_case must be SECURITY DEFINER");
  assert.ok(decide.includes("fn_has_permission('reports', null, 'edit')"), "decide_case must require reports/edit");
  assert.ok(decide.includes("raise exception 'not_authorized'"), "decide_case must deny non-moderators");

  const addRec = fnBody("fn_m07_add_recipient");
  const rmRec = fnBody("fn_m07_remove_recipient");
  assert.ok(addRec && rmRec, "recipient functions must be defined");
  assert.ok(addRec.includes("fn_is_super_admin()"), "add_recipient must require super_admin");
  assert.ok(rmRec.includes("fn_is_super_admin()"), "remove_recipient must require super_admin");

  const backlog = fnBody("fn_m07_process_backlog");
  assert.ok(backlog, "fn_m07_process_backlog must be defined");
  assert.ok(/security definer/.test(backlog), "backlog processor must be SECURITY DEFINER");
  assert.ok(backlog.includes("fn_has_permission('reports', null, 'edit')"), "backlog processor must require reports/edit (F1 — M12 consistency)");
});

test("M17 — no anon grants, no anon policies, no self-service", () => {
  assert.ok(!/ to anon/.test(execPart), "no anon grants in the executable part");
  assert.ok(!/for anon/.test(execPart), "no anon-targeted policy");
  assert.ok(!/auth\.uid\(\)\s*=\s*content_id/.test(execPart), "no self-service policy on screening data");
  assert.ok(!/auth\.uid\(\)\s*=\s*new\.author_id/.test(execPart), "no self-service insert path");
});

// ============================================================
// 4) Enforcement — hold-hidden, admin-exempt, version-specific
// ============================================================

test("M17 — enforcement is SECURITY DEFINER, admin-exempt, hold-hidden with NO raise", () => {
  const body = fnBody("fn_m07_screening_enforcement");
  assert.ok(body, "fn_m07_screening_enforcement must be defined");
  assert.ok(/security definer/.test(body), "enforcement must be SECURITY DEFINER (else author bypasses via own RLS)");
  assert.ok(/set search_path = public/.test(body), "search_path must be pinned to public");
  assert.ok(body.includes("fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit')"), "admin content must be exempt (G4)");
  assert.ok(body.includes("new.is_hidden := true"), "FAILURE/FLAGGED must hold content hidden");
  assert.ok(!/raise exception/.test(body), "enforcement must NEVER raise (failure event survives — G2)");
  assert.ok(body.includes("insert into public.m07_moderation_cases"), "FLAGGED must create a moderation case (invariant E)");
});

test("M17 — screening is version-specific: triggers fire only on content-changing UPDATE", () => {
  assert.ok(m17.includes("before update of title, content on public.forum_topics"), "topic screening trigger must fire on title/content change only (invariant B)");
  assert.ok(m17.includes("before update of content on public.forum_replies"), "reply screening trigger must fire on content change only (invariant B)");
  assert.ok(m17.includes("before insert or update of title, content on public.forum_topics"), "topic enforcement trigger must cover INSERT + content UPDATE");
  assert.ok(m17.includes("before insert or update of content on public.forum_replies"), "reply enforcement trigger must cover INSERT + content UPDATE");
  const versionFn = fnBody("fn_m07_content_version");
  assert.ok(versionFn, "fn_m07_content_version must be defined");
  assert.ok(versionFn.includes("new.content_version := old.content_version + 1"), "content_version must increment on edit");
});

test("M17 — reports are never blocked: forum report trigger records events only (G5)", () => {
  const body = fnBody("fn_m07_report_screening");
  assert.ok(body, "fn_m07_report_screening must be defined");
  assert.ok(body.includes("fn_m07_screen('forum_report'"), "forum report screening must record an event");
  assert.ok(!/is_hidden/.test(body), "report screening must not touch visibility (reports are internal)");
  assert.ok(!/raise exception/.test(body), "report screening must never raise");
});

// ============================================================
// 5) Approved policy decisions — invariant A, G7 forward-looking
// ============================================================

test("M17 — invariant A: pluggable boundary is fail-closed (no provider → failure)", () => {
  const screen = fnBody("fn_m07_screen");
  assert.ok(screen, "fn_m07_screen must be defined");
  assert.ok(/security definer/.test(screen), "fn_m07_screen must be SECURITY DEFINER");
  assert.ok(screen.includes("'failure'") && screen.includes("'no_provider_configured'"), "no provider must record failure/no_provider_configured");
  assert.ok(!/normal/.test(screen), "the boundary must never return normal without a provider");
});

test("M17 — G7: backlog never changes visibility of previously published content", () => {
  const backlog = fnBody("fn_m07_process_backlog");
  assert.ok(backlog, "fn_m07_process_backlog must be defined");
  assert.ok(backlog.includes("v_row.is_hidden"), "publish path must be gated on the row being currently hidden");
  assert.ok(backlog.includes("update public.forum_topics set is_hidden = false"), "retry path publishes held topics");
  assert.ok(backlog.includes("update public.forum_replies set is_hidden = false"), "retry path publishes held replies");
  assert.ok(backlog.includes("c.status = 'open'"), "open-case check must gate both FLAGGED and publish paths");
  assert.ok(backlog.includes("m07_backlog_state"), "backlog processor must update retry bookkeeping");
});

// ============================================================
// 6) Client integration — fail-closed boundary + defensive calls
// ============================================================

test("m07.js — client boundary module exists and is fail-closed by default", () => {
  assert.ok(fs.existsSync(M07_JS), "js/m07.js must exist");
  assert.ok(m07Js.includes("var M07_PROVIDER = null;"), "M07_PROVIDER must default to null (no provider configured)");
  assert.ok(m07Js.includes("no_provider_configured"), "fail-closed reason must be no_provider_configured");
  assert.ok(m07Js.includes("async function m07ScreenContent"), "m07ScreenContent must be defined");
  assert.ok(m07Js.includes("function m07HandleResult"), "m07HandleResult must be defined");
  assert.ok(m07Js.includes("async function m07RecordScreeningFailure"), "m07RecordScreeningFailure must be defined");
  assert.ok(m07Js.includes("fn_m07_record_screening_failure"), "failure recording must call the RPC");
});

test("forum.js — boundary is called before topic write, with defensive typeof check", () => {
  const callIdx = forumJs.indexOf('m07ScreenContent("forum_topic", null, 1, content');
  const insertIdx = forumJs.indexOf('.from("forum_topics")\n    .insert({');
  assert.ok(callIdx > -1, "forum.js must call the boundary for topics");
  assert.ok(insertIdx > -1, "forum.js must still insert topics");
  assert.ok(callIdx < insertIdx, "boundary call must come BEFORE the topic insert");
  assert.ok(forumJs.includes('typeof m07ScreenContent === "function"'), "boundary call must be defensive (sandbox-safe)");
});

test("forum.js — boundary is called before reply write, with screening-aware toast", () => {
  const callIdx = forumJs.indexOf('m07ScreenContent("forum_reply", null, 1, content');
  const insertIdx = forumJs.indexOf('.from("forum_replies").insert({');
  assert.ok(callIdx > -1, "forum.js must call the boundary for replies");
  assert.ok(insertIdx > -1, "forum.js must still insert replies");
  assert.ok(callIdx < insertIdx, "boundary call must come BEFORE the reply insert");
  assert.ok(forumJs.includes('typeof m07HandleResult === "function"'), "toast must be defensive");
  assert.ok(forumJs.includes("تم استلام المحتوى") || forumJs.includes("m07Message"), "screening-aware toast must be wired");
});

test("forum.js — own held content is visible to its author via .or() filters + markers", () => {
  assert.ok(forumJs.includes(".or(`is_hidden.eq.false,author_id.eq."), "replies query must include own-content .or() filter");
  assert.ok(forumJs.includes("forum-screening-tag"), "held content must carry a 'قيد الفحص' marker");
  assert.ok(forumJs.includes("forum-screening-banner"), "topic detail must show the held-content banner");
  assert.ok(forumJs.includes("هذا الموضوع قيد الفحص الآلي وسيظهر للآخرين بعد اكتماله."), "banner text must be present");
});

test("app.js — resource report boundary call + failure recording before submit_public_report", () => {
  const callIdx = appJs.indexOf('m07ScreenContent("resource_report"');
  const rpcIdx = appJs.indexOf('.rpc("submit_public_report"');
  assert.ok(callIdx > -1, "app.js must call the boundary for resource reports");
  assert.ok(rpcIdx > -1, "app.js must still call submit_public_report");
  assert.ok(callIdx < rpcIdx, "boundary call must come BEFORE the report RPC");
  assert.ok(appJs.includes('m07RecordScreeningFailure("resource_report"'), "FAILURE must record a screening event");
});

test("m07.js script tag is present on all six report/forum pages", () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, page), "utf-8");
    assert.ok(html.includes('<script defer src="js/m07.js"></script>'), `${page} must load js/m07.js`);
  }
});

test("test-forum.js — mock builder supports .or() (additive, sandbox parity)", () => {
  assert.ok(testForum.includes("or(expr)"), "mock builder must implement .or()");
  assert.ok(testForum.includes('state.filters.or = expr'), "mock .or() must record the filter");
});

// ============================================================
// 7) Client regression — no direct writes to M-07 tables
// ============================================================

test("Client never writes M-07 tables directly (all writes via RPC/triggers)", () => {
  assert.ok(!forumJs.includes('from("m07_screening_events")'), "forum.js must not write screening events directly");
  assert.ok(!forumJs.includes('from("m07_moderation_cases")'), "forum.js must not write cases directly");
  assert.ok(!appJs.includes('from("m07_screening_events")'), "app.js must not write screening events directly");
  assert.ok(!appJs.includes('from("m07_moderation_cases")'), "app.js must not write cases directly");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;