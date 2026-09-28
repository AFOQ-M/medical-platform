/**
 * test-moderation-foundation.js
 * ------------------------------------------------------------------
 * Phase 3 — Moderation Foundation (M16): user warnings, temporary
 * bans, ban history, repeat-offender visibility.
 *
 * يتحقق من الجانب التطبيقي (Big Pickle scope) دون أي DB mutation:
 *  1) ملف M16 موجود وموثّق APPLIED — LIVE DB وإضافي فقط
 *     (لا DROP table، لا drop policy، لا مساس بسياسات المنتدى القائمة).
 *  2) المخطط: user_warnings ثابت (لا UPDATE/DELETE)، user_bans يحفظ
 *     التاريخ (لا DELETE)، قيدا الاتساق (revoke/time) موجودان.
 *  3) الصلاحيات: كتابة/قراءة = مسند المشرف المعتمد فقط
 *     (fn_is_super_admin OR fn_has_permission('reports', ...))؛
 *     لا anon، لا self-service، لا حذف.
 *  4) الإنفاذ: حظر نشط يمنع إنشاء موضوع/رد جديد عبر BEFORE INSERT
 *     trigger على حدود قاعدة البيانات (SECURITY DEFINER إلزامي).
 *  5) قرارات السياسة المعتمدة: لا Auto-Ban (F1)، لا سلم مدد مفروضة
 *     (F2)، لا تصعيد تلقائي (F3) — غياب أي trigger/منطق تلقائي.
 *  6) Regression: forum.js بلا أي إشارة للجداول الجديدة (العميل
 *     لم يُمس)، M12/M13 سليمان.
 *
 * التشغيل: node test/test-moderation-foundation.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const M16 = path.join(ROOT, "sql", "p1_final_m16_moderation_foundation.sql");
const M12 = path.join(ROOT, "sql", "p1_final_m12_forum_owner_update_guard.sql");
const M13 = path.join(ROOT, "sql", "p1_final_m13_forum_report_integrity.sql");
const PHASE6 = path.join(ROOT, "sql", "phase6_forum_mvp.sql");
const FORUM_JS = path.join(ROOT, "js", "forum.js");

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

const m16 = fs.readFileSync(M16, "utf-8");
const m12 = fs.readFileSync(M12, "utf-8");
const m13 = fs.readFileSync(M13, "utf-8");
const phase6 = fs.readFileSync(PHASE6, "utf-8");
const forumJs = fs.readFileSync(FORUM_JS, "utf-8");

// الجزء التنفيذي فقط (بدون رأس التوثيق وقسم ROLLBACK) — تُفحص عليه
// قواعد "إضافي فقط" وقرارات السياسة حتى لا تتعارض مع التوثيق نفسه.
// ملاحظة: "ROLLBACK:" تظهر أيضًا في رأس الملف (سطر التوثيق) لذا نطابق
// رأس القسم الفعلي "ROLLBACK (documented".
const execPart = m16.slice(
  m16.indexOf("create table public.user_warnings"),
  m16.indexOf("-- ROLLBACK (documented")
);

// استخراج جسم دالة كاملًا (حتى الفاصل الختامي $function$;).
function fnBody(name) {
  const re = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$function\\$;`);
  const m = execPart.match(re);
  return m ? m[0] : "";
}

console.log("AFOQ Phase 3 Moderation Foundation (M16) — Regression Tests\n");

// ============================================================
// 1) File integrity — additive-only, documented status
// ============================================================

test("M16 — file exists, marked APPLIED — LIVE DB, additive-only", () => {
  assert.ok(fs.existsSync(M16), "M16 file must exist");
  assert.ok(/APPLIED — LIVE DB/.test(m16), "M16 must be marked APPLIED — LIVE DB (verified live 2026-09-26)");
  assert.ok(!/drop table\s/i.test(execPart), "executable part must not drop any table");
  assert.ok(!/drop policy/i.test(execPart), "executable part must not drop any existing policy");
  const drops = execPart.match(/drop trigger if exists (\w+)/g) || [];
  assert.ok(drops.length > 0, "idempotent drop trigger if exists must be present (M12/M13 pattern)");
  for (const d of drops) {
    assert.ok(/trg_forum_ban_enforcement|trg_user_bans_guard/.test(d), `only M16's own triggers may be dropped (found: ${d})`);
  }
});

test("M16 — must not redefine or touch M12/M13 guards (no regression)", () => {
  assert.ok(!m16.includes("fn_forum_guard_owner_update"), "M16 must not redefine the M12 owner-update guard");
  assert.ok(!m16.includes("fn_forum_report_write_guard"), "M16 must not redefine the M13 report write guard");
  assert.ok(/APPLIED LIVE/.test(m12), "M12 file must still be marked APPLIED LIVE (reference check)");
  assert.ok(/APPLIED LIVE/.test(m13), "M13 file must still be marked APPLIED LIVE (reference check)");
});

// ============================================================
// 2) Schema — user_warnings (immutable) + user_bans (history)
// ============================================================

test("M16 — user_warnings: RLS enabled, PK, FK to auth.users, reason CHECK", () => {
  assert.ok(m16.includes("create table public.user_warnings"), "user_warnings table must be created");
  assert.ok(m16.includes("id uuid primary key default gen_random_uuid()"), "user_warnings must have a uuid PK");
  assert.ok(m16.includes("user_id uuid not null references auth.users(id) on delete cascade"), "user_warnings.user_id must FK to auth.users");
  assert.ok(m16.includes("issued_by uuid not null references auth.users(id)"), "user_warnings.issued_by must FK to auth.users");
  assert.ok(m16.includes("btrim(reason) <> ''"), "reason must be non-blank");
  assert.ok(m16.includes("char_length(reason) <= 500"), "reason must be length-capped");
  assert.ok(m16.includes("created_at timestamptz not null default now()"), "warnings must keep a timestamp (F4)");
  assert.ok(m16.includes("enable row level security"), "user_warnings must have RLS enabled");
});

test("M16 — user_warnings is immutable: no UPDATE/DELETE policies", () => {
  assert.ok(m16.includes("moderator_insert_user_warnings"), "INSERT policy must exist");
  assert.ok(m16.includes("moderator_read_user_warnings"), "SELECT policy must exist");
  assert.ok(!m16.includes("moderator_update_user_warnings"), "no UPDATE policy must exist");
  assert.ok(!m16.includes("moderator_delete_user_warnings"), "no DELETE policy must exist");
});

test("M16 — user_bans: RLS, PK, FKs, revoke/time consistency constraints", () => {
  assert.ok(m16.includes("create table public.user_bans"), "user_bans table must be created");
  assert.ok(m16.includes("user_bans_revoke_consistency"), "revoke consistency constraint must exist");
  assert.ok(m16.includes("user_bans_time_consistency"), "time consistency constraint must exist");
  assert.ok(m16.includes("expires_at timestamptz"), "expires_at must exist (null = permanent, F2)");
  assert.ok(m16.includes("revoked_at timestamptz"), "revoked_at must exist (F6)");
  assert.ok(m16.includes("revoked_by uuid references auth.users(id)"), "revoked_by must FK to auth.users (F6)");
  assert.ok(m16.includes("enable row level security"), "user_bans must have RLS enabled");
});

test("M16 — user_bans preserves history: no DELETE policy", () => {
  assert.ok(m16.includes("moderator_insert_user_bans"), "INSERT policy must exist");
  assert.ok(m16.includes("moderator_read_user_bans"), "SELECT policy must exist");
  assert.ok(m16.includes("moderator_revoke_user_bans"), "UPDATE (revoke) policy must exist");
  assert.ok(!m16.includes("moderator_delete_user_bans"), "no DELETE policy must exist (history preserved, F5)");
});

// ============================================================
// 3) Authorization — moderator-only, no anon, no self-service
// ============================================================

test("M16 — warning/ban writes use the established moderator predicate (reports/edit)", () => {
  const editPred = "fn_is_super_admin() or fn_has_permission('reports', null, 'edit')";
  assert.ok(m16.includes(editPred), "INSERT/UPDATE policies must use the phase7/M12 moderator predicate");
  assert.ok(phase6.includes("fn_forum_is_real_user()"), "phase6 forum policies must remain intact (reference check)");
});

test("M16 — visibility reads use the phase7 admin-read predicate (reports/view)", () => {
  const viewPred = "fn_has_permission('reports', null, 'view')";
  assert.ok(m16.includes(viewPred), "SELECT policies and visibility functions must use reports/view");
});

test("M16 — no anon grants, no anon policies, no self-service", () => {
  assert.ok(!/user_warnings to anon/.test(m16), "no anon grant on user_warnings");
  assert.ok(!/user_bans to anon/.test(m16), "no anon grant on user_bans");
  assert.ok(!/for anon/.test(m16), "no anon-targeted policy");
  assert.ok(!/auth\.uid\(\)\s*=\s*user_id/.test(m16), "no self-service policy (ordinary users cannot manage their own warnings/bans)");
  assert.ok(!/auth\.uid\(\)\s*=\s*new\.user_id/.test(m16), "no self-service insert path");
});

// ============================================================
// 4) Enforcement — active ban blocks new topics/replies (F8)
// ============================================================

test("M16 — enforcement function is SECURITY DEFINER and raises user_banned on active ban", () => {
  const body = fnBody("fn_forum_ban_enforcement");
  assert.ok(body, "fn_forum_ban_enforcement must be defined");
  assert.ok(/security definer/.test(body), "enforcement must be SECURITY DEFINER (else banned user bypasses via own RLS)");
  assert.ok(/set search_path = public/.test(body), "search_path must be pinned to public");
  assert.ok(body.includes("new.author_id"), "enforcement must key on the row author");
  assert.ok(body.includes("revoked_at is null"), "revoked bans must not block (F6)");
  assert.ok(body.includes("expires_at is null or b.expires_at > now()"), "expired bans must not block (F5)");
  assert.ok(body.includes("raise exception 'user_banned'"), "active ban must raise user_banned");
});

test("M16 — enforcement triggers are BEFORE INSERT on forum_topics and forum_replies", () => {
  const banTriggers = m16.match(/create trigger trg_forum_ban_enforcement\s*\n\s*before insert on public\.(forum_topics|forum_replies)/g);
  assert.ok(banTriggers && banTriggers.length === 2, "exactly two BEFORE INSERT ban triggers must exist (topics + replies)");
});

test("M16 — enforcement scope is creation only (F8): no UPDATE/DELETE triggers on forum content", () => {
  assert.ok(!/create trigger trg_forum_ban_enforcement\s*\n\s*before (update|delete)/.test(m16),
    "no ban trigger on UPDATE/DELETE (editing/deleting own content stays allowed)");
});

test("M16 — ban-row guard prevents mutation of identity/audit columns", () => {
  const body = fnBody("fn_user_bans_guard");
  assert.ok(body, "fn_user_bans_guard must be defined");
  assert.ok(/security definer/.test(body), "guard must be SECURITY DEFINER");
  assert.ok(body.includes("new.user_id") && body.includes("old.user_id"), "user_id must be guarded");
  assert.ok(body.includes("new.issued_by") && body.includes("old.issued_by"), "issued_by must be guarded");
  assert.ok(body.includes("new.created_at") && body.includes("old.created_at"), "created_at must be guarded");
  assert.ok(body.includes("new.starts_at") && body.includes("old.starts_at"), "starts_at must be guarded");
  assert.ok(body.includes("raise exception 'not_authorized'"), "guard must raise not_authorized");
  assert.ok(m16.includes("trg_user_bans_guard"), "guard trigger must be created on user_bans");
});

// ============================================================
// 5) Visibility helpers — moderator-gated, read-only (Phase 4)
// ============================================================

test("M16 — visibility functions are moderator-gated and raise not_authorized", () => {
  const activeBan = fnBody("fn_user_active_ban");
  assert.ok(activeBan, "fn_user_active_ban must be defined");
  assert.ok(/security definer/.test(activeBan), "fn_user_active_ban must be SECURITY DEFINER");
  assert.ok(activeBan.includes("fn_has_permission('reports', null, 'view')"), "fn_user_active_ban must require reports/view");
  assert.ok(activeBan.includes("raise exception 'not_authorized'"), "fn_user_active_ban must deny non-moderators");

  const warnCount = fnBody("fn_user_warning_count");
  assert.ok(warnCount, "fn_user_warning_count must be defined");
  assert.ok(/security definer/.test(warnCount), "fn_user_warning_count must be SECURITY DEFINER");
  assert.ok(warnCount.includes("fn_has_permission('reports', null, 'view')"), "fn_user_warning_count must require reports/view");
  assert.ok(warnCount.includes("raise exception 'not_authorized'"), "fn_user_warning_count must deny non-moderators");
});

test("M16 — visibility helpers are NOT wired to any trigger", () => {
  const triggerFns = [...m16.matchAll(/execute function public\.(fn_\w+)/g)].map((m) => m[1]);
  assert.ok(!triggerFns.includes("fn_user_warning_count"), "warning count must not feed any trigger");
  assert.ok(!triggerFns.includes("fn_user_active_ban"), "active-ban helper must not feed any trigger");
});

// ============================================================
// 6) Approved policy decisions — no auto-ban / no escalation
// ============================================================

test("M16 — F1/F2/F3: no auto-ban, no imposed duration ladder, no auto-escalation", () => {
  assert.ok(!execPart.includes("trg_user_warnings_auto_ban"), "F1: no auto-ban trigger may exist");
  assert.ok(!/auto_ban/i.test(execPart), "F1: no auto-ban logic anywhere in the executable part");
  assert.ok(!/escalat/i.test(execPart), "F3: no escalation logic anywhere in the executable part");
  assert.ok(!/interval/i.test(execPart), "F2: no system-imposed duration math (moderator sets expires_at freely)");
  assert.ok(!/v_count\s*>=/.test(execPart), "F1: no threshold comparison on the warning count");
});

// ============================================================
// 7) Client regression — forum.js untouched by Phase 3
// ============================================================

test("M16 — the web client is untouched: forum.js has no reference to the new tables", () => {
  assert.ok(!forumJs.includes("user_warnings"), "forum.js must not reference user_warnings");
  assert.ok(!forumJs.includes("user_bans"), "forum.js must not reference user_bans");
  assert.ok(!forumJs.includes("fn_user_active_ban"), "forum.js must not call the visibility RPCs");
  assert.ok(!forumJs.includes("fn_user_warning_count"), "forum.js must not call the visibility RPCs");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;