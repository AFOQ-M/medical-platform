// ============================================================
// دوال مشتركة تُستخدم في كل صفحات الموقع العامة
// ============================================================

const RESOURCE_TYPE_LABELS = {
  book: "كتاب",
  lecture: "محاضرة",
  slides: "سلايدات",
  summary: "ملخص",
  questions: "أسئلة",
  past_exam: "امتحان سابق",
  notes: "ملاحظات",
};

// رموز بصرية سريعة لكل نوع مورد (Phase 3.1) — تُستخدم في البطاقات وتبويبات الفلترة
const RESOURCE_TYPE_ICONS = {
  book: "📘",
  lecture: "🎥",
  slides: "🖥️",
  summary: "📝",
  questions: "❓",
  past_exam: "🗂️",
  notes: "🗒️",
};

// ترتيب ثابت لعرض الأنواع (تبويبات صفحة المادة، إلخ) بدل الاعتماد على ترتيب قاعدة البيانات
const RESOURCE_TYPE_ORDER = ["lecture", "slides", "book", "summary", "notes", "questions", "past_exam"];

// Phase 4B: الفصل الدراسي للمادة (subjects.semester) — عمود اختياري،
// NULL يعني "غير محدد" (مواد قديمة قبل هذا الحقل، أو لا يُفرَّق فيها
// بين الفصول). يُستخدم في تبويبات فلترة المواد بصفحة year.html.
const SUBJECT_SEMESTER_LABELS = {
  first: "الفصل الأول",
  second: "الفصل الثاني",
  summer: "الفصل الصيفي",
};

const SUBJECT_SEMESTER_ORDER = ["first", "second", "summer"];

// ------------------------------------------------------------
// المفضلة + "آخر ما شوهد" (Phase 3.4) — تُخزَّن محليًا فقط (localStorage)
// لكل متصفّح، دون أي حساب مستخدم أو جدول قاعدة بيانات جديد.
// ------------------------------------------------------------

const FAVORITES_KEY = "mrp_favorites";
const RECENTLY_VIEWED_KEY = "mrp_recently_viewed";
const RECENTLY_VIEWED_LIMIT = 12;

function readLocalList(key) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function writeLocalList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch (e) {
    // مساحة تخزين ممتلئة أو غير متاحة (وضع تصفّح خاص متشدد مثلاً) — نتجاهل بصمت
    console.warn("تعذّر الحفظ محليًا:", e);
  }
}

/** يحتفظ فقط بالحقول اللازمة لإعادة عرض بطاقة المورد لاحقًا دون طلب من قاعدة البيانات */
function pickResourceFields(resource) {
  return {
    id: resource.id,
    title: resource.title,
    type: resource.type,
    language: resource.language || null,
    file_url: resource.file_url,
    source_type: resource.source_type || null,
    subject_id: resource.subject_id || null,
    subject_name: resource.subject_name || null,
    faculty_name: resource.faculty_name || null,
    university_name: resource.university_name || null,
    verified: !!resource.verified,
  };
}

function isFavorite(resourceId) {
  return readLocalList(FAVORITES_KEY).some((r) => r.id === resourceId);
}

/** يبدّل حالة المفضلة لمورد ويعيد الحالة الجديدة (true = أصبح مفضّلاً) */
function toggleFavorite(resource) {
  const list = readLocalList(FAVORITES_KEY);
  const idx = list.findIndex((r) => r.id === resource.id);
  if (idx >= 0) {
    list.splice(idx, 1);
    writeLocalList(FAVORITES_KEY, list);
    return false;
  }
  list.unshift(pickResourceFields(resource));
  writeLocalList(FAVORITES_KEY, list);
  return true;
}

/** يسجّل مورداً في "آخر ما شوهد" (الأحدث أولاً)، بحد أقصى RECENTLY_VIEWED_LIMIT عنصرًا */
function recordRecentlyViewed(resource) {
  let list = readLocalList(RECENTLY_VIEWED_KEY);
  list = list.filter((r) => r.id !== resource.id);
  list.unshift(pickResourceFields(resource));
  if (list.length > RECENTLY_VIEWED_LIMIT) list = list.slice(0, RECENTLY_VIEWED_LIMIT);
  writeLocalList(RECENTLY_VIEWED_KEY, list);
}

const LANGUAGE_LABELS = { ar: "عربي", en: "إنجليزي" };

const SOURCE_TYPE_LABELS = {
  official: "مصدر رسمي",
  student: "رفع طلابي",
  open_license: "رخصة مفتوحة",
  external_link: "رابط خارجي",
};

/**
 * يتحقق أن رابط المورد يستخدم مخطّط URL آمنًا (http/https فقط) قبل
 * استخدامه كقيمة href — يمنع حقن روابط javascript: أو data: أو غيرها
 * من المخططات القابلة للتنفيذ، لأن file_url نص حر غير مُقيَّد في قاعدة
 * البيانات ويُدخله الأدمن يدويًا.
 */
function safeResourceUrl(url) {
  // P1-6: فحص مبكر للفراغ/whitespace — بدونه، تمرير سلسلة فارغة إلى
  // new URL() أدناه قد تُحلّها كمرجع نسبي فارغ. لا تغيير على أي حالة
  // أخرى (javascript:/data:/رابط صالح/رابط غير قابل للتحليل) — تسلك
  // جميعها نفس مسار try/catch أدناه كما كانت تمامًا.
  if (typeof url !== "string" || url.trim() === "") {
    return "#";
  }
  try {
    // P1-Final M5: لا نمرّر base (window.location.href) عمدًا. تمريره
    // كان يجعل new URL() تُحلّل أي نص غير مفهوم كمخطط (مثل "not-a-url")
    // كمسار *نسبي* صالح على نفس الموقع، فتُعيد رابطًا http(s) "صالحًا"
    // لكنه يشير خطأً إلى صفحة داخلية غير مقصودة بدل "#" المتوقَّع لقيمة
    // غير صالحة. بدون base، new URL() تتطلب رابطًا مطلقًا فعليًا —
    // النصوص غير المفهومة/الفارغة تفشل بـ Invalid URL وتسقط إلى catch
    // أدناه بشكل صحيح، بينما روابط http(s):// المطلقة الحقيقية (حتى مع
    // مسافات بادئة/لاحقة، التي يزيلها محلّل WHATWG تلقائيًا) لا تتأثر.
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "#";
  } catch {
    return "#";
  }
}

/** يبني عنصر DOM لبطاقة مورد واحد */
function buildResourceCard(resource) {
  const card = document.createElement("div");
  card.className = "resource-card";
  card.dataset.type = resource.type;

  const favBtn = document.createElement("button");
  favBtn.type = "button";
  favBtn.className = "favorite-btn" + (isFavorite(resource.id) ? " active" : "");
  favBtn.textContent = isFavorite(resource.id) ? "★" : "☆";
  favBtn.setAttribute("aria-label", isFavorite(resource.id) ? "إزالة من المفضلة" : "إضافة للمفضلة");
  favBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const nowFavorite = toggleFavorite(resource);
    favBtn.textContent = nowFavorite ? "★" : "☆";
    favBtn.classList.toggle("active", nowFavorite);
    favBtn.setAttribute("aria-label", nowFavorite ? "إزالة من المفضلة" : "إضافة للمفضلة");
  });
  card.appendChild(favBtn);

  const title = document.createElement("div");
  title.className = "resource-title";
  const iconSpan = document.createElement("span");
  iconSpan.className = "resource-type-icon";
  iconSpan.setAttribute("aria-hidden", "true");
  iconSpan.textContent = RESOURCE_TYPE_ICONS[resource.type] || "📄";
  title.appendChild(iconSpan);
  title.appendChild(document.createTextNode(resource.title));
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "resource-meta";

  const typeTag = document.createElement("span");
  typeTag.className = "tag";
  typeTag.dataset.type = resource.type;
  typeTag.textContent = RESOURCE_TYPE_LABELS[resource.type] || resource.type;
  meta.appendChild(typeTag);

  if (resource.language) {
    const langTag = document.createElement("span");
    langTag.className = "tag tag-lang";
    langTag.textContent = LANGUAGE_LABELS[resource.language] || resource.language;
    meta.appendChild(langTag);
  }

  if (resource.verified) {
    const verifiedTag = document.createElement("span");
    verifiedTag.className = "tag tag-verified";
    verifiedTag.textContent = "✓ موثّق";
    meta.appendChild(verifiedTag);
  }

  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "resource-actions";

  const openBtn = document.createElement("a");
  openBtn.className = "btn btn-primary btn-sm";
  openBtn.target = "_blank";
  openBtn.rel = "noopener noreferrer";
  openBtn.href = safeResourceUrl(resource.file_url);

  if (resource.source_type === "external_link") {
    openBtn.textContent = "الذهاب إلى المصدر الرسمي ↗";
  } else {
    openBtn.textContent = "فتح / تحميل";
  }
  openBtn.addEventListener("click", async () => {
    recordRecentlyViewed(resource);
    // عدّاد مشاهدات عام (Phase 3.5) — عبر دالة ضيقة النطاق تتجاوز RLS
    // فقط لزيادة رقم واحد؛ لا نعطّل فتح الرابط إن فشل الاستدعاء.
    // (جعل المعالِج async + await هنا لا يعطّل فتح الرابط: الزر <a> بلا
    // preventDefault، فالتنقّل الافتراضي يحدث فورًا بغضّ النظر عن هذا الاستدعاء)
    const { error } = await supabaseClient.rpc("increment_resource_view", { p_resource_id: resource.id });
    if (error) console.error(error);
  });
  actions.appendChild(openBtn);

  const reportBtn = document.createElement("button");
  reportBtn.className = "report-btn";
  reportBtn.type = "button";
  reportBtn.textContent = "⚠️ إبلاغ عن مشكلة";
  reportBtn.addEventListener("click", () => openReportModal(resource.id, resource.title));
  actions.appendChild(reportBtn);

  card.appendChild(actions);
  return card;
}

/**
 * ترميز نص غير موثوق (قادم من قاعدة البيانات أو المستخدم) ليكون آمنًا
 * للإدراج داخل محتوى HTML (سياق نص، وليس سياق سمة/attribute).
 * يرمّز كل ميتاكاركترز HTML الخمسة — وليست قائمة سوداء لوسوم بعينها —
 * لذلك تبقى آمنة أيًا كانت القيمة المُدخلة. يُستخدم في الصفحات
 * العامة حيث تُبنى بطاقات (روابط) عبر innerHTML لأسباب تصميمية.
 */
function escHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

/** يعرض رسالة حالة (تحميل / فارغ / خطأ) داخل حاوية */
function renderState(container, message) {
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "state-msg";
  div.textContent = message;
  container.appendChild(div);
}

/** يبني مسار التنقّل (Breadcrumb) من قائمة عقد {label, href} */
function renderBreadcrumb(container, crumbs) {
  container.innerHTML = "";
  crumbs.forEach((crumb, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      container.appendChild(sep);
    }
    if (crumb.href) {
      const a = document.createElement("a");
      a.href = crumb.href;
      a.textContent = crumb.label;
      container.appendChild(a);
    } else {
      const span = document.createElement("span");
      span.className = "current";
      span.textContent = crumb.label;
      container.appendChild(span);
    }
  });
}

/** يقرأ قيمة من الرابط ?key=value */
function getQueryParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

// ------------------------------------------------------------
// نافذة "الإبلاغ عن مشكلة" — مشتركة بين كل الصفحات التي تعرض موارد
// ------------------------------------------------------------

let currentReportResourceId = null;

function openReportModal(resourceId, resourceTitle) {
  currentReportResourceId = resourceId;
  const overlay = document.getElementById("report-modal");
  if (!overlay) return;
  document.getElementById("report-resource-name").textContent = resourceTitle;
  document.getElementById("report-reason").value = "broken_link";
  document.getElementById("report-note").value = "";
  overlay.hidden = false;
}

function closeReportModal() {
  const overlay = document.getElementById("report-modal");
  if (overlay) overlay.hidden = true;
  currentReportResourceId = null;
}

function wireReportModal() {
  const overlay = document.getElementById("report-modal");
  if (!overlay) return;

  document.getElementById("report-cancel-btn").addEventListener("click", closeReportModal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeReportModal();
  });

  document.getElementById("report-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentReportResourceId) return;

    const reason = document.getElementById("report-reason").value;
    const note = document.getElementById("report-note").value.trim();
    const submitBtn = document.getElementById("report-submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "جارٍ الإرسال...";

    // P0-4: الإدراج المباشر على reports لم يعد متاحًا للعميل (تم حذف
    // سياسة public_insert_reports). كل بلاغ يمر الآن عبر الدالة
    // المحمية submit_public_report(...) التي تفرض حد 5 بلاغات كل
    // 10 دقائق لكل مصدر قبل تنفيذ الإدراج الفعلي من طرف الخادم.
    const { error } = await supabaseClient.rpc("submit_public_report", {
      p_resource_id: currentReportResourceId,
      p_reason: reason,
      p_note: note || null,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "إرسال البلاغ";

    if (error) {
      if ((error.message || "").includes("rate_limit_exceeded")) {
        showToast("لقد أرسلت عدة بلاغات مؤخرًا، فضلاً حاول مرة أخرى بعد قليل");
      } else {
        showToast("تعذّر إرسال البلاغ، حاول مرة أخرى");
        console.error(error);
      }
      return;
    }

    closeReportModal();
    showToast("تم إرسال البلاغ، شكرًا لمساعدتك 🙏");
  });
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
}

// ------------------------------------------------------------
// البحث الشامل من الهيدر (Phase 3.2) — نافذة عائمة + اقتراحات فورية
// تُبنى بالكامل عبر JS وتُضاف لكل صفحة فيها زر #global-search-trigger
// (بدون تكرار أي HTML في كل صفحة عامة على حدة).
// ------------------------------------------------------------

function buildGlobalSearchOverlay() {
  if (document.getElementById("global-search-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay global-search-overlay";
  overlay.id = "global-search-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-box global-search-box">
      <form id="global-search-form">
        <input type="search" id="global-search-input" class="search-input"
               placeholder="ابحث عن مادة أو محاضرة أو كتاب أو جامعة أو كلية..." autocomplete="off">
      </form>
      <div id="global-search-results" class="global-search-results"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#global-search-input");
  const resultsEl = overlay.querySelector("#global-search-results");
  const form = overlay.querySelector("#global-search-form");

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGlobalSearchOverlay(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeGlobalSearchOverlay();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    goToFullSearch(input.value.trim());
  });

  let debounceTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) {
      resultsEl.innerHTML = `<div class="state-msg">اكتب حرفين على الأقل، مثل اسم المادة أو الجامعة</div>`;
      return;
    }
    resultsEl.innerHTML = `<div class="state-msg">جارٍ البحث...</div>`;
    debounceTimer = setTimeout(() => runGlobalSearchSuggestions(q), 250);
  });
}

async function runGlobalSearchSuggestions(query) {
  const input = document.getElementById("global-search-input");
  const resultsEl = document.getElementById("global-search-results");
  if (!input || !resultsEl) return;

  // نرسل كل المعاملات صراحةً (حتى المُهملة منها كـ null) بدل الاعتماد على
  // القيم الافتراضية فقط — هذا يحمي من تكرار مشكلة تعارض النسخ المتعددة
  // (Overload) لو أُعيد تعريف الدالة يومًا بمعاملات إضافية أخرى.
  const { data, error } = await supabaseClient.rpc("search_resources", {
    p_query: query,
    p_type: null,
    p_university_id: null,
    p_faculty_id: null,
    p_year_number: null,
    p_subject_id: null,
    p_language: null,
  });

  // تجاهل نتيجة بحث وصلت متأخرة بعد أن غيّر المستخدم كلمة البحث بالفعل
  if (input.value.trim() !== query) return;

  if (error) {
    resultsEl.innerHTML = `<div class="state-msg">تعذّر البحث الآن، حاول مرة أخرى.</div>`;
    console.error(error);
    return;
  }

  const suggestions = (data || []).slice(0, 6);
  resultsEl.innerHTML = "";

  const viewAllBtn = document.createElement("button");
  viewAllBtn.type = "button";
  viewAllBtn.className = "global-search-viewall";
  viewAllBtn.textContent = `عرض كل النتائج لـ «${query}» ←`;
  viewAllBtn.addEventListener("click", () => goToFullSearch(query));
  resultsEl.appendChild(viewAllBtn);

  if (suggestions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "state-msg";
    empty.textContent = "لا توجد نتائج مطابقة.";
    resultsEl.appendChild(empty);
    return;
  }

  suggestions.forEach((r) => {
    const item = document.createElement("a");
    item.className = "global-search-item";
    item.href = `subject.html?id=${r.subject_id}`;

    const iconSpan = document.createElement("span");
    iconSpan.className = "resource-type-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = RESOURCE_TYPE_ICONS[r.type] || "📄";
    item.appendChild(iconSpan);

    const textWrap = document.createElement("span");
    textWrap.className = "global-search-item-text";

    const titleEl = document.createElement("span");
    titleEl.className = "global-search-item-title";
    titleEl.textContent = r.title;
    textWrap.appendChild(titleEl);

    const metaEl = document.createElement("span");
    metaEl.className = "global-search-item-meta";
    metaEl.textContent = [r.subject_name, r.faculty_name, r.university_name].filter(Boolean).join(" · ");
    textWrap.appendChild(metaEl);

    item.appendChild(textWrap);
    resultsEl.appendChild(item);
  });
}

function goToFullSearch(query) {
  window.location.href = `search.html?q=${encodeURIComponent(query)}`;
}

function openGlobalSearchOverlay() {
  const overlay = document.getElementById("global-search-overlay");
  if (!overlay) return;
  overlay.hidden = false;
  const input = document.getElementById("global-search-input");
  input.value = "";
  document.getElementById("global-search-results").innerHTML =
    `<div class="state-msg">اكتب حرفين على الأقل، مثل اسم المادة أو الجامعة</div>`;
  setTimeout(() => input.focus(), 30);
}

function closeGlobalSearchOverlay() {
  const overlay = document.getElementById("global-search-overlay");
  if (overlay) overlay.hidden = true;
}

function initGlobalSearch() {
  const trigger = document.getElementById("global-search-trigger");
  if (!trigger) return; // الصفحة لا تحتوي زر بحث شامل (مثال: لوحة التحكم)
  buildGlobalSearchOverlay();
  trigger.addEventListener("click", openGlobalSearchOverlay);
}

document.addEventListener("DOMContentLoaded", () => {
  wireReportModal();
  initGlobalSearch();
});
