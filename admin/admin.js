// ============================================================
// منطق لوحة التحكم: المصادقة + الترخيص الدقيق + عمليات CRUD
// المرحلة الثانية: authenticated ≠ admin. كل صلاحية تُتحقّق فعليًا
// من جدول user_permissions (و RLS هو الحَكَم النهائي دائمًا).
// ============================================================

const RESOURCE_TYPE_LABELS_ADMIN = {
  book: "كتاب", lecture: "محاضرة", slides: "سلايدات",
  summary: "ملخص", questions: "أسئلة", past_exam: "امتحان سابق", notes: "ملاحظات",
};

const ENTITY_LABELS = {
  academic_structure: "الجامعات/السنوات/المواد",
  resources: "الموارد",
  reports: "التقارير",
};
const ACTION_LABELS = { view: "عرض", create: "إضافة", edit: "تعديل", delete: "حذف" };

// -------------------- حالة المستخدم الحالي --------------------

let currentProfile = null;       // { id, email, role, active }
let currentPermissions = [];     // صفوف user_permissions الخاصة بالمستخدم الحالي
let universitiesById = {};       // كاش: id -> { id, name }

// يطابق منطق fn_has_permission في قاعدة البيانات (للواجهة فقط — RLS هو الحاكم الفعلي)
function hasPerm(entityType, universityId, action) {
  if (!currentProfile || !currentProfile.active) return false;
  if (currentProfile.role === "super_admin") return true;
  return currentPermissions.some((p) =>
    p.active && p.entity_type === entityType && p.action === action &&
    (p.scope_type === "global" || (p.scope_type === "university" && p.scope_id === universityId))
  );
}

function hasAnyPerm(entityType) {
  if (!currentProfile) return false;
  if (currentProfile.role === "super_admin") return true;
  return currentPermissions.some((p) => p.active && p.entity_type === entityType);
}

async function logActivity(action, targetType, targetId, details) {
  if (!currentProfile) return;
  await supabaseClient.from("admin_activity_log").insert({
    actor_user_id: currentProfile.id,
    action, target_type: targetType, target_id: targetId || null, details: details || null,
  });
}

// -------------------- المصادقة --------------------

async function checkAuthAndInit() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await loadCurrentUserAuthorization(session.user);
  } else {
    showLogin();
  }
}

async function loadCurrentUserAuthorization(authUser) {
  const { data: profile, error: profileError } = await supabaseClient
    .from("profiles").select("*").eq("id", authUser.id).maybeSingle();

  if (profileError || !profile) {
    showLogin("تعذّر تحميل صلاحيات الحساب. حاول تسجيل الدخول مجددًا.");
    await supabaseClient.auth.signOut();
    return;
  }

  if (!profile.active) {
    showLogin("هذا الحساب معطَّل حاليًا. تواصل مع المسؤول.");
    await supabaseClient.auth.signOut();
    return;
  }

  currentProfile = profile;

  const { data: perms } = await supabaseClient
    .from("user_permissions").select("*").eq("user_id", authUser.id).eq("active", true);
  currentPermissions = perms || [];

  showDashboard(authUser.email);
}

function showLogin(errorMsg) {
  document.getElementById("login-box").hidden = false;
  document.getElementById("dashboard").hidden = true;
  document.getElementById("admin-user-info").textContent = "";
  const errorEl = document.getElementById("login-error");
  if (errorMsg) { errorEl.textContent = errorMsg; errorEl.style.display = "block"; }
}

function showDashboard(email) {
  document.getElementById("login-box").hidden = true;
  document.getElementById("dashboard").hidden = false;
  const roleLabel = currentProfile.role === "super_admin" ? "سوبر أدمن" : currentProfile.role === "admin" ? "أدمن" : "موظف";
  document.getElementById("admin-user-info").textContent = `${email} (${roleLabel})`;
  applyPermissionVisibility();
  loadAllData();
}

function applyPermissionVisibility() {
  const tabMap = {
    universities: hasAnyPerm("academic_structure"),
    years: hasAnyPerm("academic_structure"),
    subjects: hasAnyPerm("academic_structure"),
    resources: hasAnyPerm("resources"),
    reports: hasAnyPerm("reports"),
    users: currentProfile.role === "super_admin",
    dashboard: true,
  };
  let firstVisible = null;
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    const visible = tabMap[btn.dataset.tab] !== false;
    btn.hidden = !visible;
    if (visible && !firstVisible) firstVisible = btn;
  });
  // إن كان التبويب النشط حاليًا مخفيًا، بدّل لأول تبويب ظاهر
  const activeBtn = document.querySelector(".admin-tab-btn.active");
  if ((!activeBtn || activeBtn.hidden) && firstVisible) {
    document.querySelectorAll(".admin-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
    firstVisible.classList.add("active");
    document.getElementById(`panel-${firstVisible.dataset.tab}`).classList.add("active");
  }

  // إظهار/إخفاء نماذج الإضافة حسب صلاحية create العامة (يُعاد ضبطها بدقة أكبر بعد كل تحميل جدول)
  document.getElementById("uni-form").style.display = hasPerm("academic_structure", null, "create") ? "" : "none";
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errorEl = document.getElementById("login-error");
  errorEl.style.display = "none";

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    errorEl.textContent = "بيانات الدخول غير صحيحة. تأكد من البريد وكلمة المرور.";
    errorEl.style.display = "block";
    return;
  }

  await loadCurrentUserAuthorization(data.user);
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentProfile = null;
  currentPermissions = [];
  showLogin();
});

// -------------------- التبويبات --------------------

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.hidden) return;
    document.querySelectorAll(".admin-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "dashboard") loadDashboard();
    if (btn.dataset.tab === "users") loadUsersPanel();
  });
});

function loadAllData() {
  loadDashboard();
  loadUniversities();
  loadYears();
  loadSubjects();
  loadResources();
  loadReports();
  if (currentProfile.role === "super_admin") loadUsersPanel();
}

// ============================================================
// لوحة المعلومات
// ============================================================

async function loadDashboard() {
  const grid = document.getElementById("dashboard-stats");
  grid.innerHTML = `<div class="state-msg">جارٍ التحميل...</div>`;

  const [uni, yrs, subj, res, rep, admins] = await Promise.all([
    supabaseClient.from("universities").select("*", { count: "exact", head: true }),
    supabaseClient.from("years").select("*", { count: "exact", head: true }),
    supabaseClient.from("subjects").select("*", { count: "exact", head: true }),
    supabaseClient.from("resources").select("*", { count: "exact", head: true }),
    supabaseClient.from("reports").select("*", { count: "exact", head: true }),
    currentProfile.role === "super_admin"
      ? supabaseClient.from("profiles").select("*", { count: "exact", head: true })
      : Promise.resolve({ count: null }),
  ]);

  const stats = [
    ["الجامعات", uni.count], ["السنوات", yrs.count], ["المواد", subj.count],
    ["الموارد", res.count], ["البلاغات", rep.count],
  ];
  if (currentProfile.role === "super_admin") stats.push(["الإداريون", admins.count]);

  grid.innerHTML = "";
  stats.forEach(([label, value]) => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.innerHTML = `<div class="stat-value">${value ?? "—"}</div><div class="stat-label">${label}</div>`;
    grid.appendChild(card);
  });

  // آخر الموارد المضافة
  const recentEl = document.getElementById("dashboard-recent");
  const { data: recentResources } = await supabaseClient
    .from("resources").select("id, title, created_at, status").order("created_at", { ascending: false }).limit(6);
  recentEl.innerHTML = "";
  (recentResources || []).forEach((r) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${r.title}</span><span class="status-badge ${r.status}">${r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه"}</span>`;
    recentEl.appendChild(li);
  });
  if (!recentResources || !recentResources.length) {
    recentEl.innerHTML = `<li>لا توجد موارد بعد</li>`;
  }
}

// ============================================================
// الجامعات
// ============================================================

async function loadUniversities() {
  const { data, error } = await supabaseClient.from("universities").select("*").order("name");
  const tbody = document.querySelector("#uni-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  universitiesById = {};
  (data || []).forEach((u) => { universitiesById[u.id] = u; });

  populateSelect("year-university", data, (u) => u.name);
  document.getElementById("uni-form").style.display = hasPerm("academic_structure", null, "create") ? "" : "none";

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد جامعات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((u) => {
    const canEdit = hasPerm("academic_structure", u.id, "edit");
    const canDelete = hasPerm("academic_structure", u.id, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الاسم">${u.name}</td>
      <td data-label="مختصر">${u.short_name || "—"}</td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editUniversity('${u.id}','${escAttr(u.name)}','${escAttr(u.short_name || "")}','${escAttr(u.logo_url || "")}')">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('universities','${u.id}', loadUniversities)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("uni-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("uni-edit-id").value;
  const payload = {
    name: document.getElementById("uni-name").value.trim(),
    short_name: document.getElementById("uni-short-name").value.trim() || null,
    logo_url: document.getElementById("uni-logo-url").value.trim() || null,
  };
  const { data, error } = id
    ? await supabaseClient.from("universities").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("universities").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "university_updated" : "university_created", "university", data?.id, payload.name);
  resetUniForm();
  showToast(id ? "تم تعديل الجامعة" : "تمت إضافة الجامعة");
  loadUniversities();
});

function editUniversity(id, name, shortName, logoUrl) {
  document.getElementById("uni-edit-id").value = id;
  document.getElementById("uni-name").value = name;
  document.getElementById("uni-short-name").value = shortName;
  document.getElementById("uni-logo-url").value = logoUrl;
  document.getElementById("uni-form-title").textContent = "تعديل جامعة";
  document.getElementById("uni-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("uni-cancel-btn").hidden = false;
}

function resetUniForm() {
  document.getElementById("uni-form").reset();
  document.getElementById("uni-edit-id").value = "";
  document.getElementById("uni-form-title").textContent = "إضافة جامعة";
  document.getElementById("uni-submit-btn").textContent = "إضافة";
  document.getElementById("uni-cancel-btn").hidden = true;
}
document.getElementById("uni-cancel-btn").addEventListener("click", resetUniForm);

// ============================================================
// السنوات
// ============================================================

async function loadYears() {
  const { data, error } = await supabaseClient
    .from("years")
    .select("id, year_number, university_id, universities(name)")
    .order("year_number");
  const tbody = document.querySelector("#year-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  const selectOptions = data.map((y) => ({ id: y.id, label: `${y.universities?.name || "—"} — سنة ${y.year_number}` }));
  populateSelect("subj-year", selectOptions, (o) => o.label, true);

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد سنوات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((y) => {
    const canEdit = hasPerm("academic_structure", y.university_id, "edit");
    const canDelete = hasPerm("academic_structure", y.university_id, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الجامعة">${y.universities?.name || "—"}</td>
      <td data-label="السنة">${y.year_number}</td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editYear('${y.id}','${y.university_id}',${y.year_number})">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('years','${y.id}', loadYears)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("year-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("year-edit-id").value;
  const payload = {
    university_id: document.getElementById("year-university").value,
    year_number: parseInt(document.getElementById("year-number").value, 10),
  };
  const { data, error } = id
    ? await supabaseClient.from("years").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("years").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "year_updated" : "year_created", "year", data?.id, `سنة ${payload.year_number}`);
  resetYearForm();
  showToast(id ? "تم تعديل السنة" : "تمت إضافة السنة");
  loadYears();
});

function editYear(id, universityId, yearNumber) {
  document.getElementById("year-edit-id").value = id;
  document.getElementById("year-university").value = universityId;
  document.getElementById("year-number").value = yearNumber;
  document.getElementById("year-form-title").textContent = "تعديل سنة دراسية";
  document.getElementById("year-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("year-cancel-btn").hidden = false;
}

function resetYearForm() {
  document.getElementById("year-form").reset();
  document.getElementById("year-edit-id").value = "";
  document.getElementById("year-form-title").textContent = "إضافة سنة دراسية";
  document.getElementById("year-submit-btn").textContent = "إضافة";
  document.getElementById("year-cancel-btn").hidden = true;
}
document.getElementById("year-cancel-btn").addEventListener("click", resetYearForm);

// ============================================================
// المواد
// ============================================================

async function loadSubjects() {
  const { data, error } = await supabaseClient
    .from("subjects")
    .select("id, name, code, year_id, years(year_number, university_id, universities(name))")
    .order("name");
  const tbody = document.querySelector("#subj-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  populateSelect("res-subject", data.map((s) => ({ id: s.id, label: s.name })), (o) => o.label, true);

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد مواد بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((s) => {
    const uniId = s.years?.university_id;
    const canEdit = hasPerm("academic_structure", uniId, "edit");
    const canDelete = hasPerm("academic_structure", uniId, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="المادة">${s.name}${s.code ? ` (${s.code})` : ""}</td>
      <td data-label="السنة/الجامعة">${s.years?.universities?.name || "—"} — سنة ${s.years?.year_number ?? "—"}</td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editSubject('${s.id}','${s.year_id}','${escAttr(s.name)}','${escAttr(s.code || "")}')">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('subjects','${s.id}', loadSubjects)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("subj-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("subj-edit-id").value;
  const payload = {
    year_id: document.getElementById("subj-year").value,
    name: document.getElementById("subj-name").value.trim(),
    code: document.getElementById("subj-code").value.trim() || null,
  };
  const { data, error } = id
    ? await supabaseClient.from("subjects").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("subjects").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "subject_updated" : "subject_created", "subject", data?.id, payload.name);
  resetSubjForm();
  showToast(id ? "تم تعديل المادة" : "تمت إضافة المادة");
  loadSubjects();
});

function editSubject(id, yearId, name, code) {
  document.getElementById("subj-edit-id").value = id;
  document.getElementById("subj-year").value = yearId;
  document.getElementById("subj-name").value = name;
  document.getElementById("subj-code").value = code;
  document.getElementById("subj-form-title").textContent = "تعديل مادة";
  document.getElementById("subj-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("subj-cancel-btn").hidden = false;
}

function resetSubjForm() {
  document.getElementById("subj-form").reset();
  document.getElementById("subj-edit-id").value = "";
  document.getElementById("subj-form-title").textContent = "إضافة مادة";
  document.getElementById("subj-submit-btn").textContent = "إضافة";
  document.getElementById("subj-cancel-btn").hidden = true;
}
document.getElementById("subj-cancel-btn").addEventListener("click", resetSubjForm);

// ============================================================
// الموارد
// ============================================================

async function loadResources() {
  const { data, error } = await supabaseClient
    .from("resources")
    .select("id, title, type, language, file_url, storage_provider, source_type, status, keywords, subject_id, subjects(name, years(university_id))")
    .order("created_at", { ascending: false });
  const tbody = document.querySelector("#res-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد موارد بعد (أو لا تملك صلاحية عرضها)</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((r) => {
    const uniId = r.subjects?.years?.university_id;
    const canEdit = hasPerm("resources", uniId, "edit");
    const canDelete = hasPerm("resources", uniId, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="العنوان">${r.title}</td>
      <td data-label="المادة">${r.subjects?.name || "—"}</td>
      <td data-label="النوع">${RESOURCE_TYPE_LABELS_ADMIN[r.type] || r.type}</td>
      <td data-label="الحالة"><span class="status-badge ${r.status}">${r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه"}</span></td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick='editResource(${JSON.stringify(r).replace(/'/g, "&apos;")})'>تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('resources','${r.id}', loadResources)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("res-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("res-edit-id").value;
  const payload = {
    subject_id: document.getElementById("res-subject").value,
    title: document.getElementById("res-title").value.trim(),
    type: document.getElementById("res-type").value,
    language: document.getElementById("res-language").value,
    file_url: document.getElementById("res-file-url").value.trim(),
    storage_provider: document.getElementById("res-storage-provider").value,
    source_type: document.getElementById("res-source-type").value,
    status: document.getElementById("res-status").value,
    keywords: document.getElementById("res-keywords").value.trim() || null,
  };
  const { data, error } = id
    ? await supabaseClient.from("resources").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("resources").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "resource_updated" : "resource_created", "resource", data?.id, payload.title);
  resetResForm();
  showToast(id ? "تم تعديل المورد" : "تمت إضافة المورد");
  loadResources();
});

function editResource(r) {
  document.getElementById("res-edit-id").value = r.id;
  document.getElementById("res-subject").value = r.subject_id;
  document.getElementById("res-title").value = r.title;
  document.getElementById("res-type").value = r.type;
  document.getElementById("res-language").value = r.language || "ar";
  document.getElementById("res-file-url").value = r.file_url;
  document.getElementById("res-storage-provider").value = r.storage_provider || "google_drive";
  document.getElementById("res-source-type").value = r.source_type || "student";
  document.getElementById("res-status").value = r.status;
  document.getElementById("res-keywords").value = r.keywords || "";
  document.getElementById("res-form-title").textContent = "تعديل مورد";
  document.getElementById("res-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("res-cancel-btn").hidden = false;
}

function resetResForm() {
  document.getElementById("res-form").reset();
  document.getElementById("res-edit-id").value = "";
  document.getElementById("res-form-title").textContent = "إضافة مورد";
  document.getElementById("res-submit-btn").textContent = "إضافة";
  document.getElementById("res-cancel-btn").hidden = true;
}
document.getElementById("res-cancel-btn").addEventListener("click", resetResForm);

// ============================================================
// التقارير
// ============================================================

async function loadReports() {
  const { data, error } = await supabaseClient
    .from("reports")
    .select("id, reason, note, created_at, resource_id, resources(id, title, status, subjects(years(university_id)))")
    .order("created_at", { ascending: false });
  const tbody = document.querySelector("#reports-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد بلاغات حاليًا (أو لا تملك صلاحية عرضها)</td></tr>`; return; }
  tbody.innerHTML = "";
  const reasonLabels = { broken_link: "الرابط لا يعمل", wrong_file: "ملف غير صحيح", copyright: "حقوق نشر", other: "أخرى" };
  data.forEach((r) => {
    const tr = document.createElement("tr");
    const resTitle = r.resources?.title || "(مورد محذوف)";
    const isHidden = r.resources?.status === "hidden";
    const uniId = r.resources?.subjects?.years?.university_id;
    const canResolve = hasPerm("reports", uniId, "delete");
    const canToggle = hasPerm("resources", uniId, "edit");
    tr.innerHTML = `
      <td data-label="المورد">${resTitle}</td>
      <td data-label="السبب">${reasonLabels[r.reason] || r.reason}</td>
      <td data-label="ملاحظة">${r.note || "—"}</td>
      <td data-label="التاريخ">${new Date(r.created_at).toLocaleDateString("ar-EG")}</td>
      <td>
        ${r.resources && canToggle ? `<button class="btn btn-outline btn-sm" onclick="toggleResourceHidden('${r.resources.id}', ${isHidden}, loadReports)">${isHidden ? "إظهار المورد" : "إخفاء المورد"}</button>` : ""}
        ${canResolve ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('reports','${r.id}', loadReports)">حذف البلاغ</button>` : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

async function toggleResourceHidden(resourceId, currentlyHidden, refreshFn) {
  const { error } = await supabaseClient
    .from("resources")
    .update({ status: currentlyHidden ? "published" : "hidden" })
    .eq("id", resourceId);
  if (error) { showToast("تعذّر تحديث حالة المورد"); console.error(error); return; }
  logActivity(currentlyHidden ? "resource_restored" : "resource_hidden", "resource", resourceId, null);
  showToast(currentlyHidden ? "تم إظهار المورد" : "تم إخفاء المورد");
  refreshFn();
  loadResources();
}

// ============================================================
// المستخدمون والصلاحيات (Super Admin فقط)
// ============================================================

async function loadUsersPanel() {
  if (currentProfile.role !== "super_admin") return;
  const container = document.getElementById("users-list");
  container.innerHTML = `<div class="state-msg">جارٍ التحميل...</div>`;

  const [{ data: profilesData, error: pErr }, { data: permsData }, { data: unis }] = await Promise.all([
    supabaseClient.from("profiles").select("*").order("created_at"),
    supabaseClient.from("user_permissions").select("*"),
    supabaseClient.from("universities").select("id, name").order("name"),
  ]);

  if (pErr) { container.innerHTML = `<div class="state-msg">تعذّر تحميل المستخدمين</div>`; return; }

  container.innerHTML = "";
  (profilesData || []).forEach((profile) => {
    const userPerms = (permsData || []).filter((p) => p.user_id === profile.id);
    container.appendChild(buildUserPermissionCard(profile, userPerms, unis || []));
  });

  if (!profilesData || !profilesData.length) {
    container.innerHTML = `<div class="state-msg">لا يوجد مستخدمون بعد. أنشئهم من Supabase Dashboard &gt; Authentication &gt; Users.</div>`;
  }
}

function buildUserPermissionCard(profile, userPerms, universities) {
  const card = document.createElement("div");
  card.className = "user-perm-card";
  const isSelf = profile.id === currentProfile.id;
  const isSuper = profile.role === "super_admin";

  const header = document.createElement("div");
  header.className = "user-perm-header";
  header.innerHTML = `
    <div>
      <strong>${profile.email || "(بلا بريد)"}</strong>
      <span class="status-badge ${profile.active ? "published" : "hidden"}">${profile.active ? "مفعّل" : "معطَّل"}</span>
      ${isSelf ? '<span class="hint">(أنت)</span>' : ""}
    </div>
  `;

  const controls = document.createElement("div");
  controls.className = "user-perm-controls";

  const roleSelect = document.createElement("select");
  ["staff", "admin", "super_admin"].forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r; opt.textContent = r === "super_admin" ? "سوبر أدمن" : r === "admin" ? "أدمن" : "موظف";
    if (r === profile.role) opt.selected = true;
    roleSelect.appendChild(opt);
  });
  roleSelect.disabled = isSelf;
  roleSelect.addEventListener("change", async () => {
    const { error } = await supabaseClient.from("profiles").update({ role: roleSelect.value }).eq("id", profile.id);
    if (error) { showToast("تعذّر تحديث الدور"); console.error(error); return; }
    logActivity("role_changed", "profile", profile.id, roleSelect.value);
    showToast("تم تحديث الدور");
    loadUsersPanel();
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "btn btn-outline btn-sm";
  toggleBtn.textContent = profile.active ? "تعطيل الحساب" : "تفعيل الحساب";
  toggleBtn.disabled = isSelf;
  toggleBtn.addEventListener("click", async () => {
    const { error } = await supabaseClient.from("profiles").update({ active: !profile.active }).eq("id", profile.id);
    if (error) { showToast("تعذّر تحديث الحالة"); console.error(error); return; }
    logActivity(profile.active ? "user_disabled" : "user_enabled", "profile", profile.id, null);
    showToast(profile.active ? "تم تعطيل الحساب" : "تم تفعيل الحساب");
    loadUsersPanel();
  });

  controls.appendChild(labeledWrap("الدور", roleSelect));
  controls.appendChild(toggleBtn);
  header.appendChild(controls);
  card.appendChild(header);

  if (isSuper) {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "السوبر أدمن يملك كل الصلاحيات تلقائيًا في كل مكان — لا حاجة لتحديد صلاحيات مخصّصة.";
    card.appendChild(note);
    return card;
  }

  // مصفوفة صلاحيات: صف "عام (كل الجامعات)" + صف لكل جامعة
  const scopesTable = document.createElement("div");
  scopesTable.className = "perm-scopes";

  const scopeRows = [{ scope_type: "global", scope_id: null, label: "عام (كل الجامعات)" }]
    .concat(universities.map((u) => ({ scope_type: "university", scope_id: u.id, label: u.name })));

  scopeRows.forEach((scope) => {
    const scopeBlock = document.createElement("div");
    scopeBlock.className = "perm-scope-block";
    const title = document.createElement("div");
    title.className = "perm-scope-title";
    title.textContent = scope.label;
    scopeBlock.appendChild(title);

    Object.keys(ENTITY_LABELS).forEach((entityType) => {
      const row = document.createElement("div");
      row.className = "perm-entity-row";
      const rowLabel = document.createElement("span");
      rowLabel.className = "perm-entity-label";
      rowLabel.textContent = ENTITY_LABELS[entityType];
      row.appendChild(rowLabel);

      Object.keys(ACTION_LABELS).forEach((action) => {
        const existing = userPerms.find((p) =>
          p.scope_type === scope.scope_type &&
          (p.scope_id === scope.scope_id || (p.scope_id == null && scope.scope_id == null)) &&
          p.entity_type === entityType && p.action === action
        );
        const wrap = document.createElement("label");
        wrap.className = "perm-checkbox";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!(existing && existing.active);
        checkbox.addEventListener("change", () =>
          togglePermission(profile.id, scope, entityType, action, existing, checkbox.checked)
        );
        wrap.appendChild(checkbox);
        wrap.appendChild(document.createTextNode(ACTION_LABELS[action]));
        row.appendChild(wrap);
      });
      scopeBlock.appendChild(row);
    });
    scopesTable.appendChild(scopeBlock);
  });

  card.appendChild(scopesTable);
  return card;
}

async function togglePermission(userId, scope, entityType, action, existingRow, checked) {
  if (checked) {
    if (existingRow) {
      // صف موجود مسبقًا (غالبًا كان active=false) — نفعّله بدل الإضافة
      const { error } = await supabaseClient.from("user_permissions")
        .update({ active: true }).eq("id", existingRow.id);
      if (error) { showToast("تعذّر منح الصلاحية"); console.error(error); return; }
    } else {
      const { error } = await supabaseClient.from("user_permissions").insert({
        user_id: userId, scope_type: scope.scope_type, scope_id: scope.scope_id,
        entity_type: entityType, action, active: true,
      });
      if (error) { showToast("تعذّر منح الصلاحية"); console.error(error); return; }
    }
    logActivity("permission_granted", "user_permissions", userId, `${scope.label} / ${ENTITY_LABELS[entityType]} / ${ACTION_LABELS[action]}`);
  } else if (existingRow) {
    const { error } = await supabaseClient.from("user_permissions").delete().eq("id", existingRow.id);
    if (error) { showToast("تعذّر إزالة الصلاحية"); console.error(error); return; }
    logActivity("permission_revoked", "user_permissions", userId, `${scope.label} / ${ENTITY_LABELS[entityType]} / ${ACTION_LABELS[action]}`);
  }
  showToast("تم تحديث الصلاحيات");
  // إعادة تحميل صلاحيات المستخدم الحالي إن كان هو نفسه المعدَّل عليه (نادر)
  if (currentProfile && userId === currentProfile.id) {
    const { data: perms } = await supabaseClient.from("user_permissions").select("*").eq("user_id", userId).eq("active", true);
    currentPermissions = perms || [];
    applyPermissionVisibility();
  }
  loadUsersPanel();
}

function labeledWrap(label, el) {
  const wrap = document.createElement("label");
  wrap.className = "inline-label";
  wrap.appendChild(document.createTextNode(label + " "));
  wrap.appendChild(el);
  return wrap;
}

// ============================================================
// أدوات مساعدة
// ============================================================

async function deleteRow(table, id, refreshFn) {
  if (!confirm("هل أنت متأكد من الحذف؟ لا يمكن التراجع عن هذا الإجراء.")) return;
  const { error } = await supabaseClient.from(table).delete().eq("id", id);
  if (error) { showToast("تعذّر الحذف (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(`${table}_deleted`, table, id, null);
  showToast("تم الحذف");
  refreshFn();
}

function populateSelect(selectId, items, labelFn, useIdField) {
  const select = document.getElementById(selectId);
  const currentValue = select.value;
  select.innerHTML = "";
  items.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = useIdField ? item.id : item.id;
    opt.textContent = labelFn(item);
    select.appendChild(opt);
  });
  if (currentValue) select.value = currentValue;
}

function escAttr(str) {
  return String(str).replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

checkAuthAndInit();
