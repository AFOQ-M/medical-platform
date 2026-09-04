// ============================================================
// Phase 6 — Forum MVP (ملتقى أفق)
// ============================================================
//
// يعيد استخدام بالكامل: ensureAuthSession/currentAuthUser/isAnonymousUser/
// isLinkedAccountUser/openAuthOverlay/bestDisplayName (من js/auth.js)
// وshowToast/escHtml/renderState/renderBreadcrumb/getQueryParam (من
// js/app.js) — لا منطق مصادقة أو Helpers جديدة مكرّرة هنا.
//
// كل محتوى مستخدم (عناوين/محتوى مواضيع/ردود) يُعرض حصريًا عبر
// textContent/createElement — لا innerHTML لأي نص قادم من المستخدم في
// أي مكان بهذا الملف.
// ============================================================

const FORUM_TOPICS_PAGE_SIZE = 20;
const FORUM_REPLIES_PAGE_SIZE = 20;

const FORUM_CATEGORY_ICONS = {
  "subjects-study": "📚",
  "exams-review": "📝",
  "questions": "💡",
  "experiences-tips": "🤝",
  "announcements": "📢",
};

const FORUM_REPORT_REASON_LABELS = {
  offensive: "ألفاظ بذيئة أو إساءة",
  harassment: "تنمر أو مضايقة",
  inappropriate: "محتوى غير مناسب",
  misinformation: "معلومات مضللة أو مزعجة",
  other: "أخرى",
};

/** تنسيق تاريخ/وقت مختصر بالعربية — لا اعتماد على أي مكتبة خارجية جديدة. */
function forumFormatDate(isoString) {
  try {
    return new Date(isoString).toLocaleDateString("ar-EG", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch (e) {
    return "";
  }
}

/** يبني عنصر نص بسيط (span/div...) بمحتوى نصي آمن (textContent فقط). */
function forumEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

// ------------------------------------------------------------
// حماية الكتابة: يجب مستخدم حقيقي (غير ضيف). إن كان ضيفًا، تُفتح نافذة
// المصادقة الحالية بدل السماح بالإجراء — بلا أي نظام Auth جديد.
// ------------------------------------------------------------
function forumRequireRealUser() {
  if (typeof isAnonymousUser !== "function") return false;
  if (isAnonymousUser() || !currentAuthUser) {
    openAuthOverlay();
    return false;
  }
  return true;
}

// ============================================================
// صفحة forum.html
// ============================================================

let forumCategoriesCache = [];
let forumTopicsOffset = 0;
let forumActiveCategorySlug = null;

async function initForumHomePage() {
  await ensureAuthSession();
  refreshAuthUI();

  forumActiveCategorySlug = getQueryParam("category");

  renderBreadcrumb(document.getElementById("breadcrumb"), [
    { label: "الرئيسية", href: "index.html" },
    { label: "ملتقى أفق" },
  ]);

  document.getElementById("forum-new-topic-btn").addEventListener("click", openForumNewTopicModal);
  document.getElementById("forum-new-topic-cancel-btn").addEventListener("click", closeForumNewTopicModal);
  document.getElementById("forum-new-topic-modal").addEventListener("click", (e) => {
    if (e.target.id === "forum-new-topic-modal") closeForumNewTopicModal();
  });
  document.getElementById("forum-new-topic-form").addEventListener("submit", submitForumNewTopic);
  document.getElementById("forum-load-more-btn").addEventListener("click", () => loadForumTopics(false));

  updateForumToolbarStatus();

  await loadForumCategories();
  await loadForumTopics(true);
}

function updateForumToolbarStatus() {
  const statusEl = document.getElementById("forum-toolbar-status");
  if (!statusEl) return;
  statusEl.textContent = "";
  if (forumActiveCategorySlug) {
    const cat = forumCategoriesCache.find((c) => c.slug === forumActiveCategorySlug);
    if (cat) {
      const label = forumEl("span", null, `القسم: ${cat.name}`);
      statusEl.appendChild(label);
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "forum-clear-filter-btn";
      clearBtn.textContent = "عرض كل الأقسام ✕";
      clearBtn.addEventListener("click", () => {
        forumActiveCategorySlug = null;
        window.history.replaceState({}, document.title, "forum.html");
        updateForumToolbarStatus();
        loadForumTopics(true);
      });
      statusEl.appendChild(clearBtn);
    }
  }
}

async function loadForumCategories() {
  const grid = document.getElementById("forum-categories-grid");
  const { data, error } = await supabaseClient
    .from("forum_categories")
    .select("id, name, slug, description")
    .order("sort_order", { ascending: true });

  if (error) {
    console.error(error);
    renderState(grid, "تعذّر تحميل الأقسام.");
    return;
  }

  forumCategoriesCache = data || [];
  updateForumToolbarStatus();

  grid.innerHTML = "";
  if (forumCategoriesCache.length === 0) {
    renderState(grid, "لا توجد أقسام حاليًا.");
    return;
  }

  forumCategoriesCache.forEach((cat) => {
    const a = document.createElement("a");
    a.className = "card forum-category-card";
    a.href = `forum.html?category=${encodeURIComponent(cat.slug)}`;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      forumActiveCategorySlug = cat.slug;
      window.history.replaceState({}, document.title, `forum.html?category=${encodeURIComponent(cat.slug)}`);
      updateForumToolbarStatus();
      loadForumTopics(true);
      document.getElementById("forum-topics-heading").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const icon = forumEl("div", "card-icon", FORUM_CATEGORY_ICONS[cat.slug] || "💬");
    a.appendChild(icon);
    a.appendChild(forumEl("h3", null, cat.name));
    if (cat.description) a.appendChild(forumEl("div", "card-sub", cat.description));

    grid.appendChild(a);
  });

  // نموذج "موضوع جديد": تعبئة قائمة الأقسام
  const select = document.getElementById("forum-new-topic-category");
  select.innerHTML = "";
  forumCategoriesCache.forEach((cat) => {
    const opt = document.createElement("option");
    opt.value = cat.id;
    opt.textContent = cat.name;
    select.appendChild(opt);
  });
}

async function loadForumTopics(reset) {
  const list = document.getElementById("forum-topics-list");
  const loadMoreBtn = document.getElementById("forum-load-more-btn");

  if (reset) {
    forumTopicsOffset = 0;
    list.innerHTML = `<div class="state-msg">جارٍ التحميل...</div>`;
  }

  let query = supabaseClient
    .from("forum_topics")
    .select("id, title, content, author_name, created_at, is_locked, category_id, forum_categories(name, slug)")
    .eq("is_hidden", false)
    .order("created_at", { ascending: false })
    .range(forumTopicsOffset, forumTopicsOffset + FORUM_TOPICS_PAGE_SIZE - 1);

  if (forumActiveCategorySlug) {
    const cat = forumCategoriesCache.find((c) => c.slug === forumActiveCategorySlug);
    if (cat) query = query.eq("category_id", cat.id);
  }

  const { data, error } = await query;

  if (error) {
    console.error(error);
    renderState(list, "تعذّر تحميل المواضيع.");
    loadMoreBtn.hidden = true;
    return;
  }

  if (reset) list.innerHTML = "";

  if (reset && (!data || data.length === 0)) {
    renderState(list, "لا توجد مواضيع بعد. كن أول من يبدأ نقاشًا!");
    loadMoreBtn.hidden = true;
    return;
  }

  (data || []).forEach((topic) => list.appendChild(buildForumTopicCard(topic)));

  forumTopicsOffset += (data || []).length;
  loadMoreBtn.hidden = !data || data.length < FORUM_TOPICS_PAGE_SIZE;
}

function buildForumTopicCard(topic) {
  const a = document.createElement("a");
  a.className = "card forum-topic-card";
  a.href = `forum-topic.html?id=${topic.id}`;

  const head = forumEl("div", "forum-topic-card-head");
  if (topic.forum_categories) {
    const tag = forumEl("span", "tag", `${FORUM_CATEGORY_ICONS[topic.forum_categories.slug] || "💬"} ${topic.forum_categories.name}`);
    head.appendChild(tag);
  }
  if (topic.is_locked) head.appendChild(forumEl("span", "tag forum-locked-tag", "مغلق 🔒"));
  a.appendChild(head);

  a.appendChild(forumEl("h3", null, topic.title));

  const excerpt = (topic.content || "").slice(0, 140);
  a.appendChild(forumEl("div", "card-sub", excerpt + (topic.content && topic.content.length > 140 ? "…" : "")));

  const meta = forumEl("div", "forum-topic-card-meta");
  meta.appendChild(forumEl("span", null, topic.author_name));
  meta.appendChild(forumEl("span", null, forumFormatDate(topic.created_at)));
  a.appendChild(meta);

  return a;
}

function openForumNewTopicModal() {
  if (!forumRequireRealUser()) return;
  document.getElementById("forum-new-topic-form").reset();
  if (forumActiveCategorySlug) {
    const cat = forumCategoriesCache.find((c) => c.slug === forumActiveCategorySlug);
    if (cat) document.getElementById("forum-new-topic-category").value = cat.id;
  }
  document.getElementById("forum-new-topic-modal").hidden = false;
}

function closeForumNewTopicModal() {
  document.getElementById("forum-new-topic-modal").hidden = true;
}

async function submitForumNewTopic(e) {
  e.preventDefault();
  if (!forumRequireRealUser()) return;

  const categoryId = document.getElementById("forum-new-topic-category").value;
  const title = document.getElementById("forum-new-topic-title").value.trim();
  const content = document.getElementById("forum-new-topic-content").value.trim();

  if (!categoryId || !title || !content) {
    showToast("فضلاً أكمل كل الحقول المطلوبة");
    return;
  }
  if (title.length < 3) {
    showToast("عنوان الموضوع قصير جدًا");
    return;
  }

  const submitBtn = document.getElementById("forum-new-topic-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "جارٍ النشر...";

  const authorName = bestDisplayName(currentAuthUser);

  const { data, error } = await supabaseClient
    .from("forum_topics")
    .insert({
      category_id: categoryId,
      author_id: currentAuthUser.id,
      author_name: authorName,
      title,
      content,
    })
    .select("id")
    .single();

  submitBtn.disabled = false;
  submitBtn.textContent = "نشر";

  if (error) {
    console.error(error);
    showToast("تعذّر نشر الموضوع، حاول مرة أخرى");
    return;
  }

  closeForumNewTopicModal();
  window.location.href = `forum-topic.html?id=${data.id}`;
}

// ============================================================
// صفحة forum-topic.html
// ============================================================

let forumCurrentTopicId = null;
let forumCurrentTopic = null;
let forumRepliesOffset = 0;
let forumReportTargetType = null; // "topic" | "reply"
let forumReportTargetId = null;

async function initForumTopicPage() {
  await ensureAuthSession();
  refreshAuthUI();

  forumCurrentTopicId = getQueryParam("id");
  const container = document.getElementById("forum-topic-container");

  if (!forumCurrentTopicId) {
    renderState(container, "لم يتم تحديد موضوع.");
    return;
  }

  document.getElementById("forum-report-cancel-btn").addEventListener("click", closeForumReportModal);
  document.getElementById("forum-report-modal").addEventListener("click", (e) => {
    if (e.target.id === "forum-report-modal") closeForumReportModal();
  });
  document.getElementById("forum-report-form").addEventListener("submit", submitForumReport);
  document.getElementById("forum-replies-load-more-btn").addEventListener("click", () => loadForumReplies(false));
  document.getElementById("forum-reply-form").addEventListener("submit", submitForumReply);

  await loadForumTopicDetail();
}

async function loadForumTopicDetail() {
  const container = document.getElementById("forum-topic-container");

  const { data: topic, error } = await supabaseClient
    .from("forum_topics")
    .select("id, title, content, author_id, author_name, created_at, is_locked, is_hidden, category_id, forum_categories(name, slug)")
    .eq("id", forumCurrentTopicId)
    .maybeSingle();

  if (error) {
    console.error(error);
    renderState(container, "تعذّر تحميل الموضوع.");
    return;
  }
  if (!topic) {
    renderState(container, "هذا الموضوع غير موجود أو تم حذفه.");
    return;
  }

  forumCurrentTopic = topic;

  renderBreadcrumb(document.getElementById("breadcrumb"), [
    { label: "الرئيسية", href: "index.html" },
    { label: "ملتقى أفق", href: "forum.html" },
    { label: topic.forum_categories ? topic.forum_categories.name : "", href: topic.forum_categories ? `forum.html?category=${topic.forum_categories.slug}` : undefined },
    { label: topic.title },
  ].filter((c) => c.label));

  document.title = `${topic.title} — ملتقى أفق`;

  renderForumTopicDetail(topic);

  document.getElementById("forum-replies-section").hidden = false;
  await loadForumReplies(true);
  setupForumReplyForm(topic);
}

function renderForumTopicDetail(topic) {
  const container = document.getElementById("forum-topic-container");
  container.innerHTML = "";

  const box = forumEl("div", "forum-topic-detail");

  const head = forumEl("div", "forum-topic-card-head");
  if (topic.forum_categories) {
    head.appendChild(forumEl("span", "tag", `${FORUM_CATEGORY_ICONS[topic.forum_categories.slug] || "💬"} ${topic.forum_categories.name}`));
  }
  if (topic.is_locked) head.appendChild(forumEl("span", "tag forum-locked-tag", "مغلق 🔒"));
  box.appendChild(head);

  box.appendChild(forumEl("h1", "forum-topic-title", topic.title));

  const meta = forumEl("div", "forum-topic-card-meta");
  meta.appendChild(forumEl("span", null, topic.author_name));
  meta.appendChild(forumEl("span", null, forumFormatDate(topic.created_at)));
  box.appendChild(meta);

  const contentEl = forumEl("div", "forum-content-text", topic.content);
  box.appendChild(contentEl);

  const actions = forumEl("div", "forum-item-actions");
  const isOwner = currentAuthUser && topic.author_id === currentAuthUser.id;

  if (isOwner) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-outline btn-sm";
    editBtn.textContent = "تعديل";
    editBtn.addEventListener("click", () => startForumTopicEdit(box, topic));
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-outline btn-sm forum-danger-btn";
    delBtn.textContent = "حذف";
    delBtn.addEventListener("click", () => deleteForumTopic(topic.id));
    actions.appendChild(delBtn);
  }

  const reportBtn = document.createElement("button");
  reportBtn.type = "button";
  reportBtn.className = "btn btn-outline btn-sm";
  reportBtn.textContent = "🚩 إبلاغ";
  reportBtn.addEventListener("click", () => openForumReportModal("topic", topic.id));
  actions.appendChild(reportBtn);

  box.appendChild(actions);

  if (topic.is_locked) {
    box.appendChild(forumEl("div", "state-msg forum-locked-banner", "هذا الموضوع مغلق — لا يمكن إضافة ردود جديدة عليه."));
  }

  container.appendChild(box);
}

function startForumTopicEdit(box, topic) {
  const contentEl = box.querySelector(".forum-content-text");
  const titleEl = box.querySelector(".forum-topic-title");
  if (!contentEl || !titleEl) return;

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "forum-edit-title-input";
  titleInput.maxLength = 200;
  titleInput.value = topic.title;
  titleEl.replaceWith(titleInput);

  const textarea = document.createElement("textarea");
  textarea.className = "forum-edit-textarea";
  textarea.maxLength = 10000;
  textarea.value = topic.content;
  contentEl.replaceWith(textarea);

  const actionsEl = box.querySelector(".forum-item-actions");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "حفظ";
  saveBtn.addEventListener("click", async () => {
    const newTitle = titleInput.value.trim();
    const newContent = textarea.value.trim();
    if (newTitle.length < 3 || !newContent) {
      showToast("تأكد من عنوان ومحتوى صالحين");
      return;
    }
    const { error } = await supabaseClient
      .from("forum_topics")
      .update({ title: newTitle, content: newContent })
      .eq("id", topic.id);
    if (error) {
      console.error(error);
      showToast("تعذّر حفظ التعديل");
      return;
    }
    showToast("تم حفظ التعديل");
    loadForumTopicDetail();
  });
  actionsEl.prepend(saveBtn);
}

async function deleteForumTopic(topicId) {
  if (!window.confirm("هل تريد حذف هذا الموضوع نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.")) return;
  const { error } = await supabaseClient.from("forum_topics").delete().eq("id", topicId);
  if (error) {
    console.error(error);
    showToast("تعذّر حذف الموضوع");
    return;
  }
  showToast("تم حذف الموضوع");
  window.location.href = "forum.html";
}

async function loadForumReplies(reset) {
  const list = document.getElementById("forum-replies-list");
  const loadMoreBtn = document.getElementById("forum-replies-load-more-btn");

  if (reset) {
    forumRepliesOffset = 0;
    list.innerHTML = `<div class="state-msg">جارٍ تحميل الردود...</div>`;
  }

  const { data, error } = await supabaseClient
    .from("forum_replies")
    .select("id, content, author_id, author_name, created_at")
    .eq("topic_id", forumCurrentTopicId)
    .eq("is_hidden", false)
    .order("created_at", { ascending: true })
    .range(forumRepliesOffset, forumRepliesOffset + FORUM_REPLIES_PAGE_SIZE - 1);

  if (error) {
    console.error(error);
    renderState(list, "تعذّر تحميل الردود.");
    loadMoreBtn.hidden = true;
    return;
  }

  if (reset) list.innerHTML = "";

  if (reset && (!data || data.length === 0)) {
    renderState(list, "لا توجد ردود بعد. كن أول من يرد!");
    loadMoreBtn.hidden = true;
    return;
  }

  (data || []).forEach((reply) => list.appendChild(buildForumReplyCard(reply)));

  forumRepliesOffset += (data || []).length;
  loadMoreBtn.hidden = !data || data.length < FORUM_REPLIES_PAGE_SIZE;
}

function buildForumReplyCard(reply) {
  const box = forumEl("div", "card forum-reply-card");

  const meta = forumEl("div", "forum-topic-card-meta");
  meta.appendChild(forumEl("span", null, reply.author_name));
  meta.appendChild(forumEl("span", null, forumFormatDate(reply.created_at)));
  box.appendChild(meta);

  const contentEl = forumEl("div", "forum-content-text", reply.content);
  box.appendChild(contentEl);

  const actions = forumEl("div", "forum-item-actions");
  const isOwner = currentAuthUser && reply.author_id === currentAuthUser.id;

  if (isOwner) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-outline btn-sm";
    editBtn.textContent = "تعديل";
    editBtn.addEventListener("click", () => startForumReplyEdit(box, reply));
    actions.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-outline btn-sm forum-danger-btn";
    delBtn.textContent = "حذف";
    delBtn.addEventListener("click", () => deleteForumReply(reply.id, box));
    actions.appendChild(delBtn);
  }

  const reportBtn = document.createElement("button");
  reportBtn.type = "button";
  reportBtn.className = "btn btn-outline btn-sm";
  reportBtn.textContent = "🚩 إبلاغ";
  reportBtn.addEventListener("click", () => openForumReportModal("reply", reply.id));
  actions.appendChild(reportBtn);

  box.appendChild(actions);
  return box;
}

function startForumReplyEdit(box, reply) {
  const contentEl = box.querySelector(".forum-content-text");
  if (!contentEl) return;

  const textarea = document.createElement("textarea");
  textarea.className = "forum-edit-textarea";
  textarea.maxLength = 5000;
  textarea.value = reply.content;
  contentEl.replaceWith(textarea);

  const actionsEl = box.querySelector(".forum-item-actions");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "حفظ";
  saveBtn.addEventListener("click", async () => {
    const newContent = textarea.value.trim();
    if (!newContent) {
      showToast("لا يمكن أن يكون الرد فارغًا");
      return;
    }
    const { error } = await supabaseClient
      .from("forum_replies")
      .update({ content: newContent })
      .eq("id", reply.id);
    if (error) {
      console.error(error);
      showToast("تعذّر حفظ التعديل");
      return;
    }
    showToast("تم حفظ التعديل");
    loadForumReplies(true);
  });
  actionsEl.prepend(saveBtn);
}

async function deleteForumReply(replyId) {
  if (!window.confirm("هل تريد حذف هذا الرد نهائيًا؟")) return;
  const { error } = await supabaseClient.from("forum_replies").delete().eq("id", replyId);
  if (error) {
    console.error(error);
    showToast("تعذّر حذف الرد");
    return;
  }
  showToast("تم حذف الرد");
  loadForumReplies(true);
}

function setupForumReplyForm(topic) {
  const wrap = document.getElementById("forum-reply-form-wrap");
  const textarea = document.getElementById("forum-reply-content");
  const submitBtn = document.getElementById("forum-reply-submit-btn");

  if (topic.is_locked) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  if (typeof isAnonymousUser === "function" && isAnonymousUser()) {
    textarea.disabled = true;
    textarea.placeholder = "سجّل الدخول لإضافة رد";
    submitBtn.textContent = "سجّل الدخول للرد";
  } else {
    textarea.disabled = false;
    textarea.placeholder = "اكتب ردك هنا...";
    submitBtn.textContent = "إضافة رد";
  }
}

async function submitForumReply(e) {
  e.preventDefault();
  if (!forumRequireRealUser()) return;
  if (forumCurrentTopic && forumCurrentTopic.is_locked) {
    showToast("هذا الموضوع مغلق، لا يمكن إضافة ردود جديدة");
    return;
  }

  const textarea = document.getElementById("forum-reply-content");
  const content = textarea.value.trim();
  if (!content) {
    showToast("لا يمكن إرسال رد فارغ");
    return;
  }

  const submitBtn = document.getElementById("forum-reply-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "جارٍ الإرسال...";

  const { error } = await supabaseClient.from("forum_replies").insert({
    topic_id: forumCurrentTopicId,
    author_id: currentAuthUser.id,
    author_name: bestDisplayName(currentAuthUser),
    content,
  });

  submitBtn.disabled = false;
  submitBtn.textContent = "إضافة رد";

  if (error) {
    console.error(error);
    showToast("تعذّر إرسال الرد، حاول مرة أخرى");
    return;
  }

  textarea.value = "";
  showToast("تم إضافة ردك");
  await loadForumReplies(true);
}

// ------------------------------------------------------------
// نافذة الإبلاغ — مشتركة بين الموضوع وأي رد
// ------------------------------------------------------------

function openForumReportModal(targetType, targetId) {
  if (!forumRequireRealUser()) return;
  forumReportTargetType = targetType;
  forumReportTargetId = targetId;
  document.getElementById("forum-report-form").reset();
  document.getElementById("forum-report-modal").hidden = false;
}

function closeForumReportModal() {
  document.getElementById("forum-report-modal").hidden = true;
  forumReportTargetType = null;
  forumReportTargetId = null;
}

async function submitForumReport(e) {
  e.preventDefault();
  if (!forumRequireRealUser()) return;
  if (!forumReportTargetType || !forumReportTargetId) return;

  const reason = document.getElementById("forum-report-reason").value;
  const details = document.getElementById("forum-report-details").value.trim();

  const payload = {
    reporter_id: currentAuthUser.id,
    reason,
    details: details || null,
    topic_id: forumReportTargetType === "topic" ? forumReportTargetId : null,
    reply_id: forumReportTargetType === "reply" ? forumReportTargetId : null,
  };

  const submitBtn = document.getElementById("forum-report-submit-btn");
  submitBtn.disabled = true;
  submitBtn.textContent = "جارٍ الإرسال...";

  const { error } = await supabaseClient.from("forum_reports").insert(payload);

  submitBtn.disabled = false;
  submitBtn.textContent = "إرسال البلاغ";

  if (error) {
    console.error(error);
    showToast("تعذّر إرسال البلاغ، حاول مرة أخرى");
    return;
  }

  closeForumReportModal();
  showToast("تم إرسال البلاغ، سيراجعه فريق أفق");
}
