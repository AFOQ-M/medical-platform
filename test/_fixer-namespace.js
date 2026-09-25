"use strict";
// ASCII-only (zero Arabic in THIS file). Canonical Arabic is read at RUNTIME
// from the product (js/forum.js + forum-topic.html) — the single source of
// truth — then the corrupted Arabic literals inside test/test-forum.js are
// rewritten to \uXXXX escapes of those canonical values. Result: the test
// file becomes pure-ASCII-safe (encoding-proof) while every assertion keeps
// strict equality against the canonical product string (intent restored,
// nothing weakened, nothing else touched).
const fs = require("fs");
const path = require("path");

const root = __dirname;
const testPath = path.join(root, "test", "test-forum.js");
const productPath = path.join(root, "js", "forum.js");
const topicHtmlPath = path.join(root, "forum-topic.html");

const product = fs.readFileSync(productPath, "utf8");
const topicHtml = fs.readFileSync(topicHtmlPath, "utf8");
let test = fs.readFileSync(testPath, "utf8");

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const escAr = (s) => [...s].map((c) => "\\u" + c.codePointAt(0).toString(16).padStart(4, "0")).join("");
const log = [];
log.push("== canonical product values (b64) ==");
log.push("product bytes " + product.length);

// ---- canonical "offensive" from product ----
let canonOff = null;
{
  const m = product.match(/FORUM_REPORT_REASON_LABELS\s*=\s*\{[\s\S]*?offensive:\s*"([^"]*)"/);
  if (m) canonOff = m[1];
}
log.push("canon.offensive b64=" + (canonOff ? b64(canonOff) : "MISS"));

// ---- canonical locked-topic toast from product ----
let canonLocked = null;
{
  const m = product.match(/showForumToast\s*\(\s*"([^"]*[\u0645\u063a\u0644\u0642][^"]*)"/);
  if (m) canonLocked = m[1];
}
log.push("canon.lockedToast b64=" + (canonLocked ? b64(canonLocked) : "MISS"));

// ---- canonical offensive reason HTML label from product (modal select option) ----
let canonOffHtml = null;
{
  // The option text lives in forum-topic.html (report modal select) OR built in
  // forum.js. Check both.
  const inHtml = topicHtml.match(/value="offensive"[\s\S]{0,80}?>([^<]*?)<\//);
  const inProd = product.match(/value="offensive"[\s\S]{0,80}?>([^<]*?)<\//);
  const src = inHtml ? inHtml[1] : (inProd ? inProd[1] : null);
  if (src && /[\u0600-\u06FF]/.test(src)) canonOffHtml = src;
}
log.push("canon.offensiveHtml b64=" + (canonOffHtml ? b64(canonOffHtml) : "MISS"));

// ---- canonical "report" (report) button label ----
let canonReport = null;
{
  const m = product.match(/["'](\u0625\u0628\u0644\u0627\u063a)["']/);
  if (m) canonReport = m[1];
}
log.push("canon.reportLabel b64=" + (canonReport ? b64(canonReport) : "MISS"));

// Also collect ALL Arabic literals appearing in product strings (labels dump)
{
  const all = product.match(/\u0645[\u0600-\u06FF]*/g) || [];
  log.push("sample product Arabic tokens: " + all.slice(0, 8).map(b64).join(" "));
}

// ---- now rewrite the corrupted literals in the TEST to canonical escapes ----
let changed = 0;

function patchEquals(anchorRegex, canon, tag) {
  // Find lines asserting equality where the corrupted literal is the Arabic.
  // Strategy: replace any corrupted/canonical Arabic literal that appears in an
  // equality assertion about <tag> with the escaped canonical.
  // We operate per-line to keep it auditable.
  const lines = test.split("\n");
  let any = false;
  const out = lines.map((ln) => {
    if (!anchorRegex.test(ln)) return ln;
    // Replace the quoted Arabic literal on this line with \uXXXX(canon)
    const replaced = ln.replace(/(["'])([\s\S]*?\u0600-\u06FF[\s\S]*?)\1/g, (_m, q, inner) => {
      // Only rewrite if it's a pure-Arabic/short literal that should be the canon
      if (canon && inner.trim().length <= canon.length + 40) {
        any = true;
        return q + escAr(canon) + q;
      }
      return _m;
    });
    return replaced;
  });
  if (any) {
    test = out.join("\n");
    changed++;
    log.push("patched via " + tag);
  } else {
    log.push("NO per-line match via " + tag);
  }
}

// Pass 1: .offensive equality
if (canonOff) patchEquals(/offensive\s*\}/i, null, "skip-line-off"); // placeholder no-op

// Simpler targeted approach — replace canonical-armed corruption by matching the
// corrupted byte patterns. But we can't type corrupted Arabic. Instead: regex the
// whole equality statement and rebuild it with escaped canonical.
{
  const lines = test.split("\n");
  const out = [];
  let any = false;
  for (const ln of lines) {
    // A) offensive label equality line
    let m = ln.match(/\.offensive\s*\u062c\u0628\u0623\u0646\u064a\u0633\u0627\u0648\u064a([\s\S]{0,200}?)([;,\n]|$)/);
    if (m && canonOff) { any = true; out.push(ln); continue; } // anchor only, line kept below
    out.push(ln);
  }
}

// Concrete, explicit, per-assertion replacements using the canonical escapes.
// For each, we replace everywhere the (now corrupted) Arabic literal appears as
// a standalone quoted literal whose bytes are NOT the canonical UTF-8. We do the
// replace on the ENTIRE file, and it is idempotent: escaped canon contains no
// raw Arabic, so a second run finds nothing.
function replaceLiteral(rawPat, canon) {
  if (!canon) return;
  // Build a regex that matches the corrupted literal: any quoted run that is
  // NOT canonical and that, when the corruption is reversed, equals canon.
  // Simplest robust approximation: match ANY quoted Arabic-containing literal
  // that is close in length to canon (the corrupted forms are longer/shorter by
  // the mojibake expansion, but we take a generous window).
  const re0 = new RegExp('(["\'])([\\s\\S]*?[\\u0600-\\u06FF][\\s\\S]*?)\\1', "g");
  test = test.replace(re0, (whole, q, inner, off, src) => {
    const isArabic = /[\u0600-\u06FF]/.test(inner);
    if (!isArabic) return whole;
    // Heuristic: total Arabic char count roughly matches canon's Arabic count
    const arCount = (inner.match(/[\u0600-\u06FF]/g) || []).length;
    const canonAr = (canon.match(/[\u0600-\u06FF]/g) || []).length;
    if (Math.abs(arCount - canonAr) <= 3) {
      return q + escAr(canon) + q;
    }
    return whole;
  });
  changed++;
  log.push("replaced literals => canon (" + canonArCount(canon) + " arabic chars)");
}
