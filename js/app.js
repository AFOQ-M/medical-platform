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

const LANGUAGE_LABELS = { ar: "عربي", en: "إنجليزي" };

const SOURCE_TYPE_LABELS = {
  official: "مصدر رسمي",
  student: "رفع طلابي",
  open_license: "رخصة مفتوحة",
  external_link: "رابط خارجي",
};

/** يبني عنصر DOM لبطاقة مورد واحد */
function buildResourceCard(resource) {
  const card = document.createElement("div");
  card.className = "resource-card";
  card.dataset.type = resource.type;

  const title = document.createElement("div");
  title.className = "resource-title";
  title.textContent = resource.title;
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

  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "resource-actions";

  const openBtn = document.createElement("a");
  openBtn.className = "btn btn-primary btn-sm";
  openBtn.target = "_blank";
  openBtn.rel = "noopener noreferrer";
  openBtn.href = resource.file_url;

  if (resource.source_type === "external_link") {
    openBtn.textContent = "الذهاب إلى المصدر الرسمي ↗";
  } else {
    openBtn.textContent = "فتح / تحميل";
  }
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

    const { error } = await supabaseClient.from("reports").insert({
      resource_id: currentReportResourceId,
      reason,
      note: note || null,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = "إرسال البلاغ";

    if (error) {
      showToast("تعذّر إرسال البلاغ، حاول مرة أخرى");
      console.error(error);
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

document.addEventListener("DOMContentLoaded", wireReportModal);
