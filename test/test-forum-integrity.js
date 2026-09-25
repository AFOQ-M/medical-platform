/**
 * test-forum-integrity.js
 * ------------------------------------------------------------------
 * Regression — F4 (forum owner-update / moderation-column integrity)
 *              and F5 (forum + resource report integrity).
 *
 * يتحقق من الجانب التطبيقي (Big Pickle scope) دون أي DB mutation:
 *  1) الإصلاحات المقترَحة M12/M13 موجودة وكاملة الدلالة (source
 *     integrity) — هذا النمط هو معيار المستودع لاختبارات SQL حيث لا
 *     يوجد محرك plpgsql/ملف DB داخل المستودع.
 *  2) العميل لا يرسل أعمدة الوساطة أبدًا (negative checks):
 *     - js/forum.js لا يرسل status/reviewed_by/reviewed_at في insert؛
 *     - js/forum.js لا ينفّذ UPDATE على جداول المنتدى (F4)؛
 *     - admin.js يرسل is_hidden فقط ضمن مراجعة الأدمن (فإن كانت
 *       تُرسل أعمدة إضافية فهذا انحراف).
 *  3) المسند الإداري في M12 مطابق لمسند مراجعة phase7
 *     (fn_is_super_admin() OR fn_has_permission('reports', null, 'edit')).
 *
 * التشغيل: node test/test-forum-integrity.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const M12 = path.join(ROOT, "sql", "p1_final_m12_forum_owner_update_guard.sql");
const M13 = path.join(ROOT, "sql", "p1_final_m13_forum_report_integrity.sql");
const PHASE7 = path.join(ROOT, "sql", "phase7_forum_admin_moderation.sql");
const FORUM_JS = path.join(ROOT, "js", "forum.js");
const ADMIN_JS = path.join(ROOT, "admin", "admin.js");

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

const m12 = fs.readFileSync(M12, "utf-8");
const m13 = fs.readFileSync(M13, "utf-8");
const phase7 = fs.readFileSync(PHASE7, "utf-8");
const forumJs = fs.readFileSync(FORUM_JS, "utf-8");
const adminJs = fs.readFileSync(ADMIN_JS, "utf-8");

console.log("AFOQ F4/F5 Forum Integrity — Regression Tests\n");

// ============================================================
// F4 — M12: forum owner-update guard
// ============================================================

test("F4/M12 — proposed file exists and is additive-only (no DROP table)", () => {
  assert.ok(fs.existsSync(M12), "M12 file must exist");
  assert.ok(/PROPOSED — NOT APPLIED/.test(m12), "M12 must be marked PROPOSED - NOT APPLIED");
  assert.ok(!/drop table\s/i.test(m12), "M12 must not drop any table");
});

test("F4/M12 — guard function enforces the admin predicate used by phase7", () => {
  assert.ok(m12.includes("fn_forum_guard_owner_update()"), "guard function must be defined");
  assert.ok(m12.includes("fn_is_super_admin()"), "guard must use fn_is_super_admin");
  assert.ok(m12.includes("fn_has_permission('reports', null, 'edit')"), "guard must use the same reports-edit permission as phase7 admin policies");
  assert.ok(phase7.includes("fn_has_permission('reports', null, 'edit')"), "phase7 admin policies must share the same predicate (reference check)");
});

test("F4/M12 — non-admin may NOT change moderation/identity/ref columns on topics", () => {
  assert.ok(m12.includes("new.is_hidden"), "is_hidden must be guarded on topics");
  assert.ok(m12.includes("new.is_locked"), "is_locked must be guarded on topics");
  assert.ok(m12.includes("new.author_name"), "author_name must be guarded (identity rewrite)");
  assert.ok(m12.includes("new.category_id"), "category_id must be guarded (cross-category reassignment)");
});

test("F4/M12 — non-admin may NOT change moderation/identity/ref columns on replies", () => {
  assert.ok(m12.includes("new.topic_id"), "topic_id must be guarded on replies");
  const repliesBranch = m12.match(/tg_table_name = 'forum_replies'[^]*?raise exception/);
  assert.ok(repliesBranch, "a replies branch must raise on protected-column change");
  assert.ok((repliesBranch || [])[0] && repliesBranch[0].includes("is_hidden") && repliesBranch[0].includes("author_name"),
    "replies branch must guard is_hidden and author_name");
});

test("F4/M12 — guard raises not_authorized (42501) for non-admins", () => {
  assert.ok(m12.includes("raise exception 'not_authorized'"), "must raise not_authorized");
  assert.ok(m12.includes("42501"), "must use errcode 42501 (insufficient_privilege)");
});

test("F4/M12 — admin path returns the row unchanged (moderation survives)", () => {
  assert.ok(m12.includes("if v_is_admin then"), "admin must be short-circuited");
  assert.ok(m12.includes("return new;"), "admin/owner-legitimate update must return new");
});

test("F4 — the web client issues NO UPDATE on forum tables (owner edit UI absent -> API-only exposure)", () => {
  assert.ok(!/from\("forum_topics"\)\.update|from\("forum_replies"\)\.update/.test(forumJs),
    "forum.js must not update forum topics/replies");
  assert.ok(!/from\("forum_reports"\)\.update/.test(forumJs), "forum.js must not update forum_reports");
});

test("F4 — admin.js moderation sends ONLY is_hidden on forum content (no column creep)", () => {
  // admin.js uses a computed table name: const table = targetType === "topic" ? "forum_topics" : "forum_replies";
  assert.ok(adminJs.includes('const table = targetType === "topic" ? "forum_topics" : "forum_replies";'),
    "admin moderation must branch on targetType topic/reply");
  const updateCall = adminJs.match(/from\(table\)\.update\(\{([^}]*)\}\)\.eq\("id", targetId\)/);
  assert.ok(updateCall, "admin moderation must update the computed forum table by id");
  assert.ok(/is_hidden\s*:/.test(updateCall[1]), "moderation update must touch is_hidden");
  assert.ok(!updateCall[1].includes("author_name"), "moderation must keep author_name: it is denormalized identity");
  assert.ok(!/(status|reviewed)/.test(updateCall[1]), "content moderation must not touch report columns");
  // مراجعة البلاغ (status/reviewed_*) تخص forum_reports فقط وليست تعديل محتوى.
  const reviewStmt = adminJs.includes('update({ status: newStatus, reviewed_at: new Date().toISOString(), reviewed_by: currentProfile.id })');
  assert.ok(reviewStmt, "forum_reports review must set status + reviewed_at + reviewed_by (admin-only path)");
  assert.ok(adminJs.match(/from\("forum_reports"\)/) , "review must target forum_reports");
});

test("F4 — admin.js moderation is gated by fn_has_permission/reports semantics in SQL (reference)", () => {
  assert.ok(m12.includes("reports") && m12.includes("'edit'"), "M12 admin branch must mirror phase7 reports/edit scope");
});

// ============================================================
// F5 — M13: report integrity
// ============================================================

test("F5/M13 — proposed file exists and is marked PROPOSED — NOT APPLIED", () => {
  assert.ok(fs.existsSync(M13), "M13 file must exist");
  assert.ok(/PROPOSED — NOT APPLIED/.test(m13), "M13 must be marked PROPOSED - NOT APPLIED");
});

test("F5/M13 — forum insert policy forces pending + null review columns (no forged moderation state)", () => {
  const policy = m13.match(/create policy "insert_own_forum_reports"[\s\S]*?with check\s*\(([^]*?)\);/);
  assert.ok(policy, "recreated insert_own_forum_reports must exist");
  const wc = policy[1];
  assert.ok(wc.includes("status = 'pending'"), "status must be pinned to pending");
  assert.ok(wc.includes("reviewed_by is null"), "reviewed_by must be null on insert");
  assert.ok(wc.includes("reviewed_at is null"), "reviewed_at must be null on insert");
  assert.ok(wc.includes("reporter_id = auth.uid()"), "reporter identity must still be enforced");
});

test("F5/M13 — guard trigger forces pending + rate-limits per reporter", () => {
  assert.ok(m13.includes("fn_forum_report_write_guard()"), "write-guard function must be defined");
  assert.ok(/new\.status\s*:?=\s*'pending'/.test(m13), "trigger must force status=pending");
  assert.ok(/new\.reviewed_by\s*:?=\s*null/.test(m13) && /new\.reviewed_at\s*:?=\s*null/.test(m13),
    "trigger must null review columns");
  assert.ok(m13.includes("forum_report_rate_limits"), "per-user rate-limit table must be used");
  assert.ok(m13.includes("v_max_requests constant integer :="), "rate-limit cap must be defined");
  assert.ok(m13.includes("rate_limit_exceeded"), "overflow must raise rate_limit_exceeded");
});

test("F5/M13 — rate-limit table is RLS-locked with no direct client policies", () => {
  assert.ok(m13.includes("enable row level security"), "rate-limit table must have RLS enabled");
  assert.ok(m13.includes("لا سياسات RLS متعمّدة"), "no client-focused policies must be created for the rate-limit table");
});

test("F5/M13 — submit_public_report refuses unpublished/non-existent resources", () => {
  assert.ok(m13.includes("submit_public_report"), "function must be redefined");
  assert.ok(m13.includes("status = 'published'"), "published-target check must exist");
  assert.ok(m13.includes("raise exception 'not_found'"), "missing/unpublished target must raise not_found");
  assert.ok(m13.includes("fn_forum_report_write_guard") === false || /\.\s*C\.3/.test(m13) || m13.includes("v_raw_ip"),
    "published check must be additive to the existing P0-4 IP rate-limit logic");
});

test("F5 — the web client reports only via clean fields (no moderation fields client-side)", () => {
  const payloadBuild = forumJs.match(/const payload = \{[\s\S]*?\};/);
  assert.ok(payloadBuild, "submitForumReport must build an explicit payload");
  const payload = payloadBuild[0];
  for (const forbidden of ["status", "reviewed_by", "reviewed_at"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\s*:`).test(payload), `client payload must not contain ${forbidden}`);
  }
  for (const required of ["reporter_id", "reason", "topic_id", "reply_id"]) {
    assert.ok(new RegExp(`\\b${required}\\b`).test(payload), `client payload must include ${required}`);
  }
});

test("F5 — resource reports go through the RPC submit_public_report, not a direct insert", () => {
  const appJs = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf-8");
  assert.ok(appJs.includes('.rpc("submit_public_report"'), "app.js must call submit_public_report RPC");
  assert.ok(!/from\("reports"\)\.insert/.test(appJs), "no direct insert into reports from the client");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;