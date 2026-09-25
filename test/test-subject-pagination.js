/**
 * test-subject-pagination.js
 * ------------------------------------------------------------------
 * اختبارات NEW-04 — جلب موارد المادة على دفعات range() داخل subject.html
 * (loadSubjectPage): بدل استعلام واحد بلا limit، تُجمَع الموارد المنشورة
 * عبر range(offset, offset+99) حتى يتوقف أو يكتمل، بنفس select/filters/order،
 * مع بقاء الفلترة المحلية كما هي — دون أي تغيير في markup الصفحة.
 *
 * شروط القبول من الـspec:
 *   - .range() تُستدعى بالتسلسل بالحدود الصحيحة (0..99 ثم 100..199 …)؛
 *   - القائمة المجمَّعة كاملة (تجربة 250 موردًا تُرجَع كلها بلا سقف)؛
 *   - الترتيب created_at desc محفوظ لكل دفعة وفي المجموع؛
 *   - بنفس select/eq(subject_id)/eq(status)/order عبر كل الدفعات؛
 *   - لا أي .limit() في سحب الموارد؛
 *   - حالة فارغة تُعالَج كما كانت ("لا توجد موارد …")؛
 *   - خطأ في الاستعلام يُعرض كما كان ("تعذّر تحميل الموارد").
 *
 * التشغيل: node test/test-subject-pagination.js
 * ------------------------------------------------------------------
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const SUBJECT_HTML_PATH = path.join(__dirname, "..", "subject.html");
const subjectHtml = fs.readFileSync(SUBJECT_HTML_PATH, "utf-8");

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

/* استخراج سكربت subject.html المضمَّن (آخر <script> بدون src). */
function extractInlineScript(html) {
  const srcScripts = (html.match(/<script[^>]*src=[^>]*>/g) || []).length;
  const opens = [];
  const re = /<script(?![^>]*src=)[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) opens.push(m.index);
  assert.ok(opens.length === 1, "subject.html يجب أن يحوي كتلة سكربت واحدة مضمَّنة");
  const start = html.indexOf(">", opens[0]) + 1;
  const end = html.indexOf("</script>", start);
  let code = html.slice(start, end);
  // ننزع الاستدعاء التلقائي في الأسفل لنستدعي loadSubjectPage بأنفسنا
  code = code.replace(/\n\s*loadSubjectPage\(\);\s*$/, "\n");
  return code;
}

/* عنصر DOM مختصر يكفي لـ loadSubjectPage (لا يُبنى أي بطاقة هنا). */
function makeElement() {
  return {
    textContent: "", innerHTML: "", hidden: false, value: "",
    style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, insertBefore() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, scrollIntoView() {},
  };
}

/* Supabase وهمي: subjects يرجع عنصرًا واحدًا، resources تُقطّع pool حسب range. */
function makeSubjectSupabase({ resourceCount = 0, orderDesc = true } = {}) {
  const calls = [];
  const pool = Array.from({ length: resourceCount }, (_, i) => ({
    id: "res-" + i,
    title: "مورد رقم " + i,
    type: "book",
    language: "ar",
    file_url: "https://x.test/r" + i,
    source_type: "official",
    status: "published",
    keywords: "مرجع",
    subject_id: "subj-1",
    verified: true,
    created_at: new Date(2026, 0, 1, 0, 0, (orderDesc ? resourceCount - i : i)).toISOString(),
  }));
  if (!orderDesc) pool.reverse();

  const subject = {
    id: "subj-1", name: "مادة الاختبار", year_id: "y1", semester: "first",
    years: { id: "y1", year_number: 1, is_active: true, university_id: "u1", faculty_id: "f1",
      universities: { id: "u1", name: "جامعة الاختبار" }, faculties: { id: "f1", name: "كلية الاختبار" } },
  };

  function builder(table) {
    const state = { table, filters: {}, order: null, range: null, single: false };
    const chain = {
      select(cols) { state.cols = cols; calls.push({ table, phase: "select", cols }); return chain; },
      eq(col, val) { state.filters[col] = val; calls.push({ table, phase: "eq", col, val }); return chain; },
      order(col, opts) { state.order = { col, opts }; calls.push({ table, phase: "order", col, opts }); return chain; },
      range(f, t) { state.range = [f, t]; return chain; },
      limit(n) { calls.push({ table, phase: "limit", n }); return chain; },
      maybeSingle() { return chain; },
      single() { state.single = true; return chain; },
      then(resolve) {
        if (table === "subjects") { resolve({ data: subject, error: null }); return; }
        if (table === "resources") {
          if (state.range === null) { resolve({ data: [], error: null }); return; }
          calls.push({ table, phase: "range", from: state.range[0], to: state.range[1], filters: { ...state.filters }, order: state.order });
          const slice = pool.slice(state.range[0], state.range[1] + 1);
          resolve({ data: slice.slice(), error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return chain;
  }
  return { supabase: { from: builder }, calls, pool };
}

/* مُنشئ ساندبوكس واحد لكل اختبار: يركّب السكربت ويستدعي loadSubjectPage داخل
 * نفس السياق. تُحصى الموارد المرسومة عبر buildResourceCard الوهمية (بديل
 * الذي تعرّفه الدالة المحلية renderFilteredResources وتستخدمه). */
function loadSubjectPageIn(supabase, captured, rendered) {
  const doc = {
    getElementById() { return makeElement(); },
    createElement() { return makeElement(); },
    createTextNode() { return {}; },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const sandbox = vm.createContext({
    console: { log: () => {}, error: (...a) => { rendered.consoleErrors = rendered.consoleErrors || []; rendered.consoleErrors.push(a.join(" ")); }, warn: () => {} },
    document: doc,
    URL, URLSearchParams,
    getQueryParam: (k) => (k === "id" ? "subj-1" : null),
    renderState: (el, msg) => { rendered.state = msg; },
    renderBreadcrumb: () => {},
    // globals من js/app.js يحتاجها setupResourceToolbar/renderFilteredResources
    RESOURCE_TYPE_ORDER: ["book", "video", "past_exams", "slides", "summary"],
    RESOURCE_TYPE_LABELS: { book: "كتاب", video: "فيديو", past_exams: "أسئلة سابقة", slides: "سلايدات", summary: "ملخص" },
    resourceTypeIcon: () => makeElement(),
    initTablist() {},
    buildResourceCard: (r) => { (captured.drawn = captured.drawn || []).push(r); return makeElement(); },
    supabaseClient: supabase,
  });
  vm.runInContext(extractInlineScript(subjectHtml), sandbox, { filename: "subject.html" });
  return vm.runInContext("loadSubjectPage()", sandbox);
}

(async () => {
  console.log("AFOQ Subject Pagination (NEW-04) Tests\n");

  await testAsync("250 موردًا — تُجمَع كاملة عبر دفعات range() بالتسلسل", async () => {
    const { supabase, calls, pool } = makeSubjectSupabase({ resourceCount: 250 });
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    assert.ok(captured.drawn, "القائمة المجمَّعة الكاملة رُسمت عبر buildResourceCard");
    assert.strictEqual(captured.drawn.length, 250, "القائمة الكاملة مطلوبة بلا سقف");
    const ranges = calls.filter((c) => c.phase === "range");
    assert.deepStrictEqual(ranges.map((c) => [c.from, c.to]), [[0, 99], [100, 199], [200, 299]], "الدفعات التسلسلية الصحيحة");
    assert.strictEqual(captured.drawn.map((r) => r.id).join("|"), pool.map((r) => r.id).join("|"), "لا فقدان ولا إعادة ترتيب عبر الدفعات");
  });

  await testAsync("الترتيب created_at desc محفوظ عبر الدفعات", async () => {
    const { supabase, calls } = makeSubjectSupabase({ resourceCount: 250 });
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    const desc = captured.drawn.every((r, i) => i === 0 || new Date(captured.drawn[i - 1].created_at) >= new Date(r.created_at));
    assert.ok(desc, "created_at تنازليًا في المجموع");
    const orderCalls = calls.filter((c) => c.phase === "order");
    assert.ok(orderCalls.length >= 3 && orderCalls.every((c) => c.col === "created_at" && c.opts.ascending === false), "كل دفعة طُلبت بنفس الفرز desc");
  });

  await testAsync("بنفس select/eq عبر الدفعات وبدون أي limit", async () => {
    const { supabase, calls } = makeSubjectSupabase({ resourceCount: 120 });
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    const ranges = calls.filter((c) => c.phase === "range");
    assert.strictEqual(ranges.length, 2, "120 موردًا => دفعتان (0..99 ثم 100..119)");
    ranges.forEach((c) => {
      assert.strictEqual(c.filters.subject_id, "subj-1", "نفس eq subject_id لكل دفعة");
      assert.strictEqual(c.filters.status, "published", "نفس eq status لكل دفعة");
      assert.ok(c.order && c.order.col === "created_at", "نفس order لكل دفعة");
    });
    const selectCols = calls.filter((c) => c.phase === "select" && c.table === "resources").map((c) => c.cols);
    assert.ok(selectCols.length > 0 && selectCols.every((s) => s === selectCols[0]), "نفس columns في كل الدفعات");
    assert.strictEqual(calls.some((c) => c.phase === "limit"), false, "لا أي .limit() في سحب الموارد");
  });

  await testAsync("دفعة واحدة تامة (100 بالضبط) + دفعة فارغة ثانية توقف الحلقة", async () => {
    const { supabase, calls } = makeSubjectSupabase({ resourceCount: 100 });
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    const ranges = calls.filter((c) => c.phase === "range");
    assert.deepStrictEqual(ranges.map((c) => [c.from, c.to]), [[0, 99], [100, 199]], "دفعة تامة ثم دفعة فارغة تُنهي الجمع");
    assert.strictEqual(ranges.length, 2);
    assert.strictEqual(captured.drawn.length, 100, "كل المئة مورد مضمومة");
  });

  await testAsync("لا موارد منشورة — رسالة «لا توجد موارد» كما كانت (بلا أي استدعاء رسم)", async () => {
    const { supabase } = makeSubjectSupabase({ resourceCount: 0 });
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    assert.strictEqual(rendered.state, "لا توجد موارد منشورة لهذه المادة بعد.", "رسالة الفارغة بلا تغيير");
    assert.strictEqual(captured.drawn, undefined, "لا يُرسم أي شيء عند الفارغة");
  });

  await testAsync("خطأ استعلام — رسالة «تعذّر تحميل الموارد» مع console.error كما كانت", async () => {
    const { supabase, calls } = makeSubjectSupabase({ resourceCount: 5 });
    // نُكسِر الدفعة الأولى بعد مرحلة select
    const { from } = supabase;
    supabase.from = (table) => {
      const chain = from(table);
      if (table === "resources") {
        const origThen = chain.then;
        chain.then = (resolve) => {
          const record = calls.find((c) => c.table === "resources" && c.phase === "select");
          if (record && !record._brokeOnce) {
            record._brokeOnce = true;
            resolve({ data: null, error: { message: "boom" } });
          } else {
            origThen(resolve);
          }
        };
      }
      return chain;
    };
    const captured = {}; const rendered = {};
    await loadSubjectPageIn(supabase, captured, rendered);
    assert.strictEqual(rendered.state, "تعذّر تحميل الموارد.", "رسالة الخطأ بلا تغيير");
    assert.ok(rendered.consoleErrors && rendered.consoleErrors.length, "console.error سُجِّل");
  });

  await testAsync("source integrity — لا pagination UI جديدة ولا change في markup الصفحة", async () => {
    assert.ok(!subjectHtml.includes('id="pagination"') && !subjectHtml.includes('class="pagination"'), "لا markup ترقيم جديد");
    const lastScript = subjectHtml.slice(subjectHtml.lastIndexOf("<script")).slice(0, 60);
    assert.ok(!/pagination|data-page/.test(lastScript), "لا مؤشرات واجهة ترقيم في سكربت الصفحة");
    assert.ok(subjectHtml.includes(".range("), "loadSubjectPage يستخدم .range() في الجلب");
  });

  console.log(`\n${passed} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
})();