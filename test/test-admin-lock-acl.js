/**
 * test-admin-lock-acl.js
 * ------------------------------------------------------------------
 * Regression — P1-Final M11 (Admin Session Lock ACL):
 * يتحقق أن تعريف acquire_admin_session_lock() الفعّال لا يمنح القفل
 * بمجرد عضوية الدور (كانت تسمح لأي حساب staff تلقائي بلا أذونات
 * باحتكار قفل الأدمن الوحيد)، بل يتطلب تفويضًا إداريًا حقيقيًا:
 * super_admin، أو وجود سطر user_permissions نشط واحد على الأقل.
 *
 * فحص ثابت (source integrity) على ملفات SQL — لا يوجد محرك plpgsql
 * داخل المستودع، لذا يُفحص التعريف النصي لنفس السبب الذي تفحص به
 * بقية الاختبارات ملفات js/html مصدرًا.
 *
 * التشغيل: node test/test-admin-lock-acl.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const FIRST_SESSION_WINS = path.join(ROOT, "sql", "phase4c_p1_7b_first_session_wins.sql");
const M11 = path.join(ROOT, "sql", "p1_final_m11_admin_session_lock_acl.sql");
const M21 = path.join(ROOT, "sql", "p1_final_m21_admin_user_session_lock.sql");

/*
 * M21 (P-A, Per-Account Lock) — تعديل مقصود لهذا الملف، والسبب مكتوب:
 *
 * كان effectiveAcquireBody() يختار M11 كـ«التعريف الفعّال» لثلاث
 * دوال القفل. بعد M21 أصبح هناك تعريف أحدث (admin_user_session_lock
 * بمفتاح user_id) يسبق M11 في الترتيب اليدوي، فالفحص صار يقرأ نصًا
 * قديماً لا يُنفَّذ على قاعدة حيّة.
 *
 * الحل: اختيار أحدث تعريف موجود حسب أولوية M21 ← M11 ← phase4c.
 * لا يُحذف أي فحص قائم، ولا يُخفَّف أي شرط: M15 كان يضيف بوابة AAL2
 * ولم يكن هذا الملف يفحصها، والبند الجديد (عزل القفل بالحساب) أُضيف
 * كفحوص مستقلة في test-admin-per-account-lock.js.
 */

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

function effectiveAcquireBody() {
  // M21 (P-A) هو الأحدث تعريفًا لـ acquire من بين الملفات الموجودة، ثم
  // M11، ثم phase4c. نقرأ أول ملف موجود حسب هذا الترتيب لأنه يمثّل
  // التعريف الذي سيُطبَّق فعليًا على القاعدة بحسب ترتيب التطبيق اليدوي.
  // (قبل M21 كان الاختيار M11 ← phase4c فقط.)
  const candidate = [M21, M11, FIRST_SESSION_WINS].find((p) => fs.existsSync(p));
  return fs.readFileSync(candidate, "utf-8");
}

const acquire = effectiveAcquireBody();

console.log("AFOQ Admin Session Lock ACL (M11) — Regression Tests\n");

test("source — acquire_admin_session_lock() is present (definition not removed)", () => {
  assert.ok(acquire.includes("create or replace function public.acquire_admin_session_lock()"),
    "the acquire function definition must exist");
});

test("security — the lock does NOT grant by bare role membership", () => {
  assert.ok(!/role not in \('super_admin', 'admin', 'staff'\)/.test(acquire),
    "the old role-only gate must be gone from the effective definition");
  assert.ok(!/v_role in \('super_admin', 'admin', 'staff'\)/.test(acquire),
    "no role-list allowline may remain");
});

test("security — super_admin (active) alone is still sufficient (blanket authority)", () => {
  assert.ok(acquire.includes("v_role <> 'super_admin'"),
    "the ACL must special-case super_admin as blanket authority, matching fn_has_permission");
});

test("security — admin/staff require at least one active user_permissions row", () => {
  assert.ok(acquire.includes("public.user_permissions"),
    "the ACL must reference user_permissions for non-super_admin accounts");
  assert.ok(acquire.includes("up.active = true"),
    "the permission row must be active");
  assert.ok(acquire.includes("up.user_id = v_uid") || acquire.includes("user_id = v_uid"),
    "the permission check must be scoped to the calling user");
});

test("compat — failed ACL check returns the same not_authorized contract", () => {
  assert.ok(acquire.includes("'not_authorized'"),
    "admin.js relies on acquisition=false when unauthorized; contract must remain");
});

test("compat — First Session Wins atomic acquire logic is preserved", () => {
  assert.ok(acquire.includes("expires_at < now()"),
    "first-session-wins (empty or expired only) must survive the M11 redefinition");
  assert.ok(acquire.includes("get diagnostics v_updated = row_count"),
    "the atomic row_count check must survive");
});

test("compat — grants unchanged: execute only to authenticated", () => {
  assert.ok(acquire.includes("revoke all on function public.acquire_admin_session_lock() from public, anon"),
    "revoke from public/anon must remain enforced");
  assert.ok(acquire.includes("grant execute on function public.acquire_admin_session_lock() to authenticated"),
    "execute for authenticated must remain granted");
});

test("scope — M11 changes nothing else (no DROP, no release/refresh redefinition)", () => {
  if (!fs.existsSync(M11)) return; // التعريف الفعّال هو phase4c القديم — لا نطبق هذا الفحص إلا على M11
  const m11 = fs.readFileSync(M11, "utf-8");
  assert.ok(!/drop (table|function|trigger|policy)/i.test(m11),
    "M11 must be fully additive");
  assert.ok(!/refresh_admin_session_lock/.test(m11) && !/release_admin_session_lock/.test(m11),
    "M11 must not redefine the refresh/release functions");
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;