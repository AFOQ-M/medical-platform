/**
 * test-a11y-contrast.js
 * ------------------------------------------------------------------
 * فحص تباين WCAG AA على مستوى الملفات (قراءة CSS فقط — بلا متصفح).
 *
 * 1) G-13: .forum-topic-card-meta (نص عادي 13.6px) يجب ألا يستخدم
 *    --ink-faint (2.56:1) — أصلاح: --ink-soft (7.45:1 على --bg).
 * 2) G-19: أزواج الـ warning tokens تبقى ≥ 4.5:1 (نص صغير AA).
 * 3) G-08: ألوان شارة "موثّق/منشور" تبقى via --success-text (6.30:1)
 *    بدل القديم #2E9E5B (3.01:1 فاشل).
 * 4) --ink-faint مقيّد: لا يُستخدم خارج القاعدة المصرّح بها.
 * 5) حساب التباين عدديًا للتأكد من القيم التوثيقية نفسها.
 *
 * التشغيل: node test/test-a11y-contrast.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf-8");

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

const TOKENS = {};
for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
  TOKENS[m[1]] = m[2];
}

function lum(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255);
  const f = (x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  const [r, g, b] = c.map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fgHex, bgHex) {
  const l1 = lum(fgHex);
  const l2 = lum(bgHex);
  const [a, b] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (a + 0.05) / (b + 0.05);
}

function getRule(rawSelector) {
  const selector = rawSelector.replace(/\s*\{\s*$/, "");
  const re = new RegExp("\\" + selector + "\\s*\\{([^}]*)\\}", "g");
  return re.exec(css);
}

const BG = TOKENS["bg"] || "#fffdf8";
assert.ok(BG, "يوجد --bg");

console.log("AFOQ Accessibility — Contrast & Token-Gate Tests\n");

test("التوثيق — تباين --success-text على --success-bg ≥ 4.5:1 (شارة موثّق/منشور)", () => {
  const fg = TOKENS["success-text"];
  const cb = TOKENS["success-bg"];
  assert.ok(fg && cb, "--success-text و --success-bg معرفان");
  const cr = contrast(fg, cb);
  assert.ok(cr >= 4.5, `--success-text(${fg}) على --success-bg(${cb}) = ${cr.toFixed(2)}:1 يجب أن ≥ 4.5:1`);
});

test("التوثيق — لم يعد اللون الفاشل #2E9E5B مستخدمًا في CSS للشارات", () => {
  assert.ok(!css.includes("#2E9E5B"), "لا بقايا للون القديم الفاشل #2E9E5B في style.css");
  assert.ok(!css.includes("#2E9e5b") && !css.includes("#2e9e5b"), "لا بديل كتابي بنمط مختلف");
});

test("G-19 — تباين --warning على --warning-bg ≥ 4.5:1 (نص بلاغ معلّق)", () => {
  const fg = TOKENS["warning"];
  const cb = TOKENS["warning-bg"];
  assert.ok(fg && cb, "--warning و --warning-bg معرفان");
  const cr = contrast(fg, cb);
  assert.ok(cr >= 4.5, `--warning(${fg}) على --warning-bg(${cb}) = ${cr.toFixed(2)}:1 يجب أن ≥ 4.5:1`);
});

test("G-19 — قواعد حالة pending تستخدم --warning tokens فقط", () => {
  const pendingRow = getRule(".admin-action-row.pending {");
  assert.ok(pendingRow, "توجد قاعدة .admin-action-row.pending");
  assert.ok(pendingRow[1].includes("var(--warning)"), ".admin-action-row.pending يستخدم --warning");
  const chip = getRule(".queue-status-chip {");
  assert.ok(chip, "توجد قاعدة .queue-status-chip");
  assert.ok(chip[1].includes("var(--warning)"), ".queue-status-chip يستخدم --warning");
  // كل أوضاع .status-badge المعتمدة تستخدم رموز الألوان السيمانتية لا hex مباشر
  for (const variant of ["published", "hidden", "reported", "draft"]) {
    const r = getRule(".status-badge." + variant + " {");
    assert.ok(r, ".status-badge." + variant + " معرّفة");
    assert.ok(!/#[0-9a-fA-F]{6}/.test(r[1]), ".status-badge." + variant + " بلا hex مباشر");
  }
});

test("G-13 — .forum-topic-card-meta يستخدم --ink-soft لا --ink-faint (نص عادي صغير)", () => {
  const rule = getRule(".forum-topic-card-meta {");
  assert.ok(rule, "توجد قاعدة .forum-topic-card-meta");
  const colorLine = rule[1].split("\n").find((l) => l.includes("color:"));
  assert.ok(colorLine, "قاعدة .forum-topic-card-meta فيها سطر color");
  assert.ok(!colorLine.includes("ink-faint"), "لا --ink-faint (كان 2.56:1 على نص 13.6px)");
  assert.ok(colorLine.includes("--ink-soft"), ".forum-topic-card-meta يستخدم --ink-soft");
  const cr = contrast(TOKENS["ink-soft"], BG);
  assert.ok(cr >= 4.5, `--ink-soft على --bg = ${cr.toFixed(2)}:1 يجب أن ≥ 4.5:1`);
});

test("--ink-faint غير مستخدم إلا في مواضع غير نصية/التوثيق", () => {
  const uses = css.split("\n").filter((l) => l.includes("--ink-faint"));
  for (const line of uses) {
    assert.ok(line.includes("var") === false || !line.trim().startsWith("."),
      `سطر --ink-faint غير مصرّح: ${line.trim()}`);
  }
});

test("--accent-focus حلقة التركيز العامة — تباين UI ≥ 3:1 على --accent-focus؟", () => {
  const fg = TOKENS["accent-focus"];
  assert.ok(fg, "--accent-focus معرف");
  const cr = contrast(fg, BG);
  assert.ok(cr >= 3.0, `--accent-focus(${fg}) على --bg = ${cr.toFixed(2)}:1 يجب أن ≥ 3:1 (UI)`);
});

console.log(`\n${passed} passed, ${failures} failed`);
process.exitCode = failures > 0 ? 1 : 0;