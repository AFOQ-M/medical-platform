/**
 * test-admin-per-account-lock.js
 * ------------------------------------------------------------------
 * Regression — M21 (P-A): Per-Account Admin Session Lock.
 *
 * المشكلة التي يعالجها هذا الملف:
 *   public.admin_session_lock صف مفرد مقيد بـ CHECK (id = true)، وكل
 *   استدعاء acquire يستهدف `where id = true`. النتيجة: دخول أدمن A
 *   يمنع أدمن B مع أن الحسابين مختلفان تمامًا.
 *
 * المطلوب: العزل على مستوى الحساب. صف لكل user_id. أدمن A لا يمنع
 *   أدمن B؛ التبويب الثاني لنفس الحساب وحده هو المرفوض.
 *
 * أنواع الفحوص هنا:
 *   1) source — فحوص ثابتة على نص M21: مفتاح الجدول، shape المخطط،
 *      بقاء TTL و AAL2 و SECURITY DEFINER و search_path، عدم وجود
 *      أي DROP أو كتابة على الجدول القديم.
 *   2) behavior — نحاكي دلالات الـ upsert الحقيقية في JS على同样的
 *      منطق `ON CONFLICT (user_id) DO UPDATE ... WHERE expires_at < now()`
 *      لإثبات: حسابان يدخلان معًا، ونفس الحساب مرفوض، و TTL، و release.
 *      المحاكاة ليست بديلًا عن الفحص الحي بعد التطبيق، بل دليل أن
 *      المنطق المطلوب مكتوب في الملف نفسه.
 *
 * التشغيل: node test/test-admin-per-account-lock.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const SQL_DIR = path.join(ROOT, "sql");
const M21 = path.join(SQL_DIR, "p1_final_m21_admin_user_session_lock.sql");
const M21_ROLLBACK = path.join(SQL_DIR, "p1_final_m21_rollback_admin_user_session_lock.sql");
const M11 = path.join(SQL_DIR, "p1_final_m11_admin_session_lock_acl.sql");
const M15 = path.join(SQL_DIR, "p1_final_m15_lock_rpc_aal2.sql");

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

console.log("AFOQ Per-Account Admin Session Lock (M21 / P-A) — Regression Tests\n");

// ------------------------------------------------------------ presence
test("source — M21 migration file exists", () => {
  assert.ok(fs.existsSync(M21), "sql/p1_final_m21_admin_user_session_lock.sql must exist");
});

test("source — M21 rollback file exists", () => {
  assert.ok(fs.existsSync(M21_ROLLBACK), "a written rollback must ship with the migration");
});

const sql = fs.existsSync(M21) ? fs.readFileSync(M21, "utf-8") : "";
const rb = fs.existsSync(M21_ROLLBACK) ? fs.readFileSync(M21_ROLLBACK, "utf-8") : "";

/** Executable SQL only: strip full-line `--` comments. */
const exec = (text) =>
  text
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
const sqlExec = exec(sql);
const rbExec = exec(rb);

// ------------------------------------------------------------ table shape
test("table — the new table is keyed by user_id, not by a boolean id", () => {
  assert.ok(/user_id\s+uuid\s+primary\s+key/i.test(sqlExec),
    "user_id must be the primary key — that is what scopes the lock to one account");
  assert.ok(!/id\s+boolean\s+primary\s+key/i.test(sqlExec),
    "the singleton `id boolean primary key` shape must not be reproduced");
});

test("table — the singleton CHECK (id = true) is not carried over", () => {
  assert.ok(!/check\s*\(\s*id\s*=\s*true\s*\)/i.test(sqlExec),
    "CHECK (id = true) is exactly what made the lock global; it must not exist here");
  assert.ok(!/admin_session_lock_singleton_row/i.test(sqlExec),
    "the singleton constraint name must not reappear");
});

test("table — the lock table is admin_user_session_lock", () => {
  assert.ok(/create\s+table\s+(if\s+not\s+exists\s+)?public\.admin_user_session_lock/i.test(sqlExec),
    "the per-account table must be public.admin_user_session_lock");
});

test("table — FK to auth.users is ON DELETE CASCADE", () => {
  assert.ok(/references\s+auth\.users\(id\)\s+on\s+delete\s+cascade/i.test(sqlExec),
    "removing an account must drop its lock row atomically (the old table had a SET NULL + trigger dance)");
});

test("table — payload columns are NOT NULL, so a half-written lock is impossible", () => {
  for (const col of ["session_token", "acquired_at", "last_seen_at", "expires_at"]) {
    const re = new RegExp(`${col}\\s+timestamptz\\s+not\\s+null|${col}\\s+uuid\\s+not\\s+null`, "i");
    assert.ok(re.test(sqlExec), `${col} must be NOT NULL`);
  }
});

test("security — RLS enabled on the new table", () => {
  assert.ok(/alter\s+table\s+public\.admin_user_session_lock\s+enable\s+row\s+level\s+security/i.test(sqlExec),
    "RLS must be on, mirroring admin_session_lock");
});

test("security — no privilege for anon / authenticated / public on the new table", () => {
  assert.ok(/revoke\s+all\s+on\s+public\.admin_user_session_lock\s+from\s+anon,\s*authenticated,\s*public/i.test(sqlExec),
    "the new table must be revoked from anon/authenticated/public like the old one");
  assert.ok(/grant\s+all\s+on\s+public\.admin_user_session_lock\s+to\s+service_role/i.test(sqlExec),
    "service_role keeps owner-level access");
});

test("security — the migration creates no RLS policy (table is RPC-only)", () => {
  assert.ok(!/create\s+policy/i.test(sqlExec),
    "zero policies is the intended posture: access only via SECURITY DEFINER RPCs");
});

// -------------------------------------------------------- additive-only
test("additive — the old admin_session_lock is neither altered nor dropped", () => {
  assert.ok(!/alter\s+table\s+(public\.)?admin_session_lock\b/i.test(sqlExec),
    "the old table is the rollback path and must stay byte-identical");
  assert.ok(!/drop\s+table/i.test(sqlExec), "no DROP TABLE anywhere in the migration");
  assert.ok(!/drop\s+column/i.test(sqlExec), "no DROP COLUMN anywhere in the migration");
});

test("additive — no write statement targets the old singleton table", () => {
  assert.ok(!/(insert\s+into|update|delete\s+from)\s+(public\.)?admin_session_lock\b/i.test(sqlExec),
    "M21 must only ever write admin_user_session_lock");
});

test("additive — the migration never uses the global `where id = true` predicate", () => {
  assert.ok(!/where\s+id\s*=\s*true/i.test(sqlExec),
    "`where id = true` is the global predicate being eliminated");
});

test("additive — every lock statement is keyed on user_id", () => {
  const keyings = (sqlExec.match(/where\s+user_id\s*=\s*v_uid/gi) || []).length;
  assert.ok(keyings >= 2,
    "refresh and release must both scope on `user_id = v_uid` (expected >= 2, found " + keyings + ")");
});

// ------------------------------------------------- preserved guarantees
test("compat — TTL stays at 90 seconds wherever a TTL is needed", () => {
  // acquire and refresh declare the window; release does not extend
  // anything, so two declarations is the correct count, not three.
  const count = (sqlExec.match(/interval\s+'90 seconds'/gi) || []).length;
  assert.strictEqual(count, 2,
    "acquire + refresh must both declare the 90s TTL (release must not)");
});

test("compat — the MFA/AAL2 gate survives in all three RPCs", () => {
  const count = (sqlExec.match(/fn_mfa_aal2_ok\(\)/g) || []).length;
  assert.strictEqual(count, 3, "M15's aal2 gate must be called in acquire, refresh and release");
  assert.ok(fs.existsSync(M15), "M15 is the file that introduced the gate");
  assert.ok(/fn_mfa_aal2_ok\(\)/.test(fs.readFileSync(M15, "utf-8")),
    "M15 must still be present and unchanged");
});

test("compat — MFA gate runs before any role/ACL logic (M15 ordering)", () => {
  const gate = sqlExec.indexOf("fn_mfa_aal2_ok()");
  const roleCheck = sqlExec.indexOf("from public.profiles");
  assert.ok(gate > -1 && roleCheck > -1, "both must be present in acquire");
  assert.ok(gate < roleCheck, "the aal2 gate must precede the profile/role lookup");
});

test("compat — real authorization is preserved (not bare role membership)", () => {
  assert.ok(/v_role\s*<>\s*'super_admin'/.test(sqlExec),
    "the super_admin special case must survive");
  assert.ok(/public\.user_permissions/.test(sqlExec) && /up\.active\s*=\s*true/.test(sqlExec),
    "non-super_admin still needs an active user_permissions row");
});

test("compat — SECURITY DEFINER and search_path hardening on all three RPCs", () => {
  assert.strictEqual((sqlExec.match(/security\s+definer/gi) || []).length, 3);
  assert.strictEqual((sqlExec.match(/set\s+search_path\s+to\s+'public'/gi) || []).length, 3);
});

test("compat — grants unchanged: execute only to authenticated", () => {
  for (const fn of ["acquire_admin_session_lock()", "refresh_admin_session_lock(uuid)", "release_admin_session_lock(uuid)"]) {
    assert.ok(new RegExp(`revoke all on function public\\.${fn.replace(/[()]/g, "\\$&")} from public, anon`).test(sqlExec),
      `revoke from public/anon must remain for ${fn}`);
    assert.ok(new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, "\\$&")} to authenticated`).test(sqlExec),
      `execute for authenticated must remain for ${fn}`);
  }
});

test("compat — every reason value the client can receive is preserved", () => {
  for (const reason of ["unauthenticated", "mfa_aal2_required", "not_authorized", "locked", "not_owner_or_expired"]) {
    assert.ok(sqlExec.includes(`'${reason}'`), `reason '${reason}' must still be emitted`);
  }
});

test("compat — acquire still returns the same JSON contract", () => {
  assert.ok(/jsonb_build_object\(\s*'acquired',\s*true/.test(sqlExec), "acquired/session_token/expires_at/ttl_seconds shape");
  assert.ok(/'ttl_seconds'/.test(sqlExec), "ttl_seconds must still be reported to the client");
});

test("compat — First Session Wins survives, now per account", () => {
  assert.ok(/on\s+conflict\s*\(user_id\)\s+do\s+update/i.test(sqlExec),
    "acquire must upsert on user_id, which is the per-account form of First Session Wins");
  assert.ok(/where\s+l\.expires_at\s*<\s*now\(\)/i.test(sqlExec),
    "the upsert must only fire when the account's own row is expired");
  assert.ok(/get\s+diagnostics\s+v_updated\s*=\s*row_count/.test(sqlExec),
    "the atomic row_count check must survive");
});

test("compat — acquire/refresh/release signatures are unchanged (no client change needed)", () => {
  assert.ok(/create\s+or\s+replace\s+function\s+public\.acquire_admin_session_lock\(\)/i.test(sqlExec));
  assert.ok(/create\s+or\s+replace\s+function\s+public\.refresh_admin_session_lock\(p_session_token\s+uuid\)/i.test(sqlExec));
  assert.ok(/create\s+or\s+replace\s+function\s+public\.release_admin_session_lock\(p_session_token\s+uuid\)/i.test(sqlExec));
});

test("compat — no information leak about another account's lock", () => {
  assert.ok(!/select[^;]*from\s+public\.admin_user_session_lock\s+where\s+user_id\s*<>/i.test(sqlExec),
    "nothing may read a row belonging to a different account");
});

// -------------------------------------------------------------- rollback
test("rollback — restores the singleton definitions and drops nothing", () => {
  assert.ok(/where\s+id\s*=\s*true/i.test(rbExec),
    "rollback must restore `where id = true` in acquire/refresh/release");
  assert.ok(!/drop\s+(table|column|function)/i.test(rbExec),
    "rollback must not execute any DROP — additive-only rule");
  assert.ok(!/admin_user_session_lock/i.test(rbExec),
    "rollback's executable SQL must not mention the new table at all");
});

test("rollback — keeps the same signatures, SECURITY DEFINER and search_path", () => {
  assert.ok(/create\s+or\s+replace\s+function\s+public\.acquire_admin_session_lock\(\)/i.test(rbExec));
  assert.strictEqual((rbExec.match(/security\s+definer/gi) || []).length, 3);
  assert.strictEqual((rbExec.match(/set\s+search_path\s+to\s+'public'/gi) || []).length, 3);
});

test("rollback — keeps the MFA gate and the real-authorization check", () => {
  assert.strictEqual((rbExec.match(/fn_mfa_aal2_ok\(\)/g) || []).length, 3);
  assert.ok(/public\.user_permissions/.test(rbExec));
});

// ------------------------------------------------------------- behavior
/**
 * Faithful JS transcription of the upsert in M21's acquire():
 *   insert ... on conflict (user_id) do update set ... where l.expires_at < now()
 * Returns the number of affected rows, exactly like get diagnostics.
 */
function simulateAcquire(rows, uid, now) {
  const row = rows.find((r) => r.user_id === uid);
  if (!row) {
    rows.push({ user_id: uid, token: "t-" + uid, expires_at: now + 90_000, live: true });
    return 1; // insert path
  }
  if (row.expires_at < now) {
    row.token = "t-" + uid;
    row.expires_at = now + 90_000;
    return 1; // update path, guarded by WHERE expires_at < now()
  }
  return 0; // the WHERE excludes a live row -> 'locked'
}

function simulateRefresh(rows, uid, token, now) {
  const row = rows.find((r) => r.user_id === uid && r.token === token);
  if (!row || row.expires_at < now) return 0;
  row.expires_at = now + 90_000;
  return 1;
}

function simulateRelease(rows, uid, token) {
  const i = rows.findIndex((r) => r.user_id === uid && r.token === token);
  if (i < 0) return 0;
  rows.splice(i, 1);
  return 1;
}

test("behavior — two DIFFERENT accounts hold their own lock simultaneously", () => {
  const rows = [];
  assert.strictEqual(simulateAcquire(rows, "admin-A", 1_000_000), 1, "A acquires");
  assert.strictEqual(simulateAcquire(rows, "admin-B", 1_000_000), 1,
    "B must acquire while A's lock is live — this is the whole point of P-A");
  assert.strictEqual(rows.length, 2, "each account owns a row");
});

test("behavior — the SAME account is refused on a second acquire ('locked')", () => {
  const rows = [];
  simulateAcquire(rows, "admin-A", 1_000_000);
  assert.strictEqual(simulateAcquire(rows, "admin-A", 1_000_000), 0,
    "second tab of the same account must be refused");
  assert.strictEqual(rows.length, 1, "the first lock must be left untouched by the refusal");
});

test("behavior — a refusal by one account does not disturb another account's token", () => {
  const rows = [];
  simulateAcquire(rows, "admin-A", 1_000_000);
  const tokenA = rows[0].token;
  simulateAcquire(rows, "admin-A", 1_000_000); // refused
  simulateAcquire(rows, "admin-B", 1_000_000);
  assert.strictEqual(rows[0].token, tokenA, "A's session_token must be unchanged");
});

test("behavior — TTL: the lock frees itself after 90 seconds", () => {
  const rows = [];
  const t0 = 1_000_000;
  simulateAcquire(rows, "admin-A", t0);
  assert.strictEqual(simulateAcquire(rows, "admin-A", t0 + 89_000), 0, "still locked at +89s");
  assert.strictEqual(simulateAcquire(rows, "admin-A", t0 + 90_001), 1, "re-acquirable after expiry");
});

test("behavior — refresh only extends the caller's own live lock", () => {
  const rows = [];
  simulateAcquire(rows, "admin-A", 1_000_000);
  const tokenA = rows[0].token;
  assert.strictEqual(simulateRefresh(rows, "admin-A", tokenA, 1_000_000), 1, "owner refreshes");
  assert.strictEqual(simulateRefresh(rows, "admin-A", "wrong-token", 1_000_000), 0, "wrong token refused");
  assert.strictEqual(simulateRefresh(rows, "admin-B", tokenA, 1_000_000), 0,
    "another account cannot refresh someone else's lock");
  assert.strictEqual(simulateRefresh(rows, "admin-A", tokenA, 1_000_000 + 200_000), 0,
    "an expired lock cannot be resurrected by heartbeat");
});

test("behavior — release only frees the caller's own lock, and only with the token", () => {
  const rows = [];
  simulateAcquire(rows, "admin-A", 1_000_000);
  simulateAcquire(rows, "admin-B", 1_000_000);
  assert.strictEqual(simulateRelease(rows, "admin-A", "t-admin-A"), 1, "A releases its own lock");
  assert.strictEqual(rows.length, 1, "B's lock survives A's logout");
  assert.strictEqual(simulateRelease(rows, "admin-B", "t-admin-A"), 0, "A's stale token cannot release B");
});

test("behavior — release then re-acquire works immediately (no 90s wait)", () => {
  const rows = [];
  simulateAcquire(rows, "admin-A", 1_000_000);
  simulateRelease(rows, "admin-A", "t-admin-A");
  assert.strictEqual(simulateAcquire(rows, "admin-A", 1_000_000), 1, "re-acquire after logout");
});

test("behavior — three accounts can each hold a lock; only self-conflicts fail", () => {
  const rows = [];
  for (const uid of ["A", "B", "C"]) assert.strictEqual(simulateAcquire(rows, uid, 1_000_000), 1, uid + " acquires");
  for (const uid of ["A", "B", "C"]) assert.strictEqual(simulateAcquire(rows, uid, 1_000_000), 0, uid + " is refused");
  assert.strictEqual(rows.length, 3);
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;
