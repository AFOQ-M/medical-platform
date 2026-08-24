// ============================================================
// منطق لوحة التحكم: المصادقة + الترخيص الدقيق + عمليات CRUD
// المرحلة 2.5 / الجزء الثاني: يضيف مستوى الكلية (Faculty) فوق
// النظام الحالي (WHO -> WHAT -> WHERE) دون كسر منطق الجامعة/العام.
// RLS يبقى الحَكَم النهائي دائمًا؛ هذا الملف مجرد مرآة للواجهة.
// ============================================================

const RESOURCE_TYPE_LABELS_ADMIN = {
  book: "كتاب", lecture: "محاضرة", slides: "سلايدات",
  summary: "ملخص", questions: "أسئلة", past_exam: "امتحان سابق", notes: "ملاحظات",
};

const ENTITY_LABELS = {
  academic_structure: "الجامعات/الكليات/السنوات/المواد",
  resources: "الموارد",
  reports: "التقارير",
};
const ACTION_LABELS = { view: "عرض", create: "إضافة", edit: "تعديل", delete: "حذف" };

// -------------------- حالة المستخدم الحالي --------------------

let currentProfile = null;       // { id, email, role, active }
let currentPermissions = [];     // صفوف user_permissions الخاصة بالمستخدم الحالي

// -------------------- كاش البيانات الأكاديمية (لتغذية القوائم المتتالية) --------------------

let universitiesById = {};       // id -> { id, name, short_name, logo_url }
let universitiesCache = [];
let facultiesById = {};          // id -> { id, name, code, description, is_active, university_id }
let facultiesCache = [];
let yearsById = {};               // id -> { id, year_number, university_id, faculty_id }
let yearsCache = [];
let subjectsById = {};            // id -> { id, name, code, year_id }
let subjectsCache = [];
let resourcesCache = [];          // آخر نتيجة تحميل لتبويب "الموارد" (لفلترة العنوان/النوع/الحالة محليًا)
let resourcesById = {};           // id -> صف المورد الكامل (لتعبئة نموذج التعديل دون تمرير بيانات غير موثوقة عبر onclick)

// يطابق منطق fn_has_permission(entity_type, university_id, faculty_id, action) في قاعدة
// البيانات (للواجهة فقط — RLS هو الحاكم الفعلي). facultyId اختياري: null يعني "لا يوجد
// نطاق كلية محدد لهذه العملية" (كإنشاء جامعة أو منح صلاحية على مستوى جامعة كاملة).
function hasPerm(entityType, universityId, facultyId, action) {
  if (!currentProfile || !currentProfile.active) return false;
  if (currentProfile.role === "super_admin") return true;
  return currentPermissions.some((p) =>
    p.active && p.entity_type === entityType && p.action === action &&
    (
      p.scope_type === "global" ||
      (p.scope_type === "university" && universityId != null && p.scope_id === universityId) ||
      (p.scope_type === "faculty" && facultyId != null && p.scope_faculty_id === facultyId)
    )
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
    faculties: hasAnyPerm("academic_structure"),
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
  document.getElementById("uni-form").style.display = hasPerm("academic_structure", null, null, "create") ? "" : "none";
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

// تحميل تراكمي بالترتيب: كل مستوى يحتاج الكاش الذي بناه المستوى الذي قبله
// (الجامعات قبل الكليات، الكليات قبل السنوات، السنوات قبل المواد، المواد قبل الموارد)
// حتى تُبنى القوائم المتتالية (Cascading Selects) بشكل صحيح من أول تحميل.
async function loadAllData() {
  loadDashboard();
  await loadUniversities();
  await loadFaculties();
  await loadYears();
  await loadSubjects();
  await loadResources();
  loadReports();
  if (currentProfile.role === "super_admin") loadUsersPanel();
}

// ============================================================
// لوحة المعلومات
// ============================================================

async function loadDashboard() {
  const grid = document.getElementById("dashboard-stats");
  grid.innerHTML = `<div class="state-msg">جارٍ التحميل...</div>`;

  const [uni, fac, yrs, subj, res, rep, admins] = await Promise.all([
    supabaseClient.from("universities").select("*", { count: "exact", head: true }),
    supabaseClient.from("faculties").select("*", { count: "exact", head: true }),
    supabaseClient.from("years").select("*", { count: "exact", head: true }),
    supabaseClient.from("subjects").select("*", { count: "exact", head: true }),
    supabaseClient.from("resources").select("*", { count: "exact", head: true }),
    supabaseClient.from("reports").select("*", { count: "exact", head: true }),
    currentProfile.role === "super_admin"
      ? supabaseClient.from("profiles").select("*", { count: "exact", head: true })
      : Promise.resolve({ count: null }),
  ]);

  const stats = [
    ["الجامعات", uni.count], ["الكليات", fac.count], ["السنوات", yrs.count], ["المواد", subj.count],
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
    const titleSpan = document.createElement("span");
    titleSpan.textContent = r.title;
    const statusSpan = document.createElement("span");
    statusSpan.className = `status-badge ${r.status}`;
    statusSpan.textContent = r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه";
    li.appendChild(titleSpan);
    li.appendChild(statusSpan);
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
  universitiesCache = data || [];

  // تغذية كل قوائم "الجامعة" المنسدلة في النماذج الأخرى بنفس البيانات
  populateSelect("year-university", data, (u) => u.name);
  populateSelect("subj-university", data, (u) => u.name);
  populateSelect("res-university", data, (u) => u.name);

  document.getElementById("uni-form").style.display = hasPerm("academic_structure", null, null, "create") ? "" : "none";

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد جامعات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((u) => {
    const canEdit = hasPerm("academic_structure", u.id, null, "edit");
    const canDelete = hasPerm("academic_structure", u.id, null, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الاسم">${escHtml(u.name)}</td>
      <td data-label="مختصر">${escHtml(u.short_name) || "—"}</td>
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
// الكليات
// ============================================================

async function loadFaculties() {
  const { data, error } = await supabaseClient
    .from("faculties")
    .select("id, name, code, description, is_active, university_id, universities(name)")
    .order("name");
  const tbody = document.querySelector("#fac-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  facultiesById = {};
  (data || []).forEach((f) => { facultiesById[f.id] = f; });
  facultiesCache = data || [];

  // القوائم المتتالية: أعد تغذية قائمة "الكلية" في كل نموذج حسب الجامعة المختارة حاليًا فيه
  populateFacultySelect("year-faculty", currentSelectValue("year-university"), currentSelectValue("year-faculty"));
  populateFacultySelect("subj-faculty", currentSelectValue("subj-university"), currentSelectValue("subj-faculty"));
  populateFacultySelect("res-faculty", currentSelectValue("res-university"), currentSelectValue("res-faculty"));

  refreshFacFormUniversityOptions();

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد كليات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((f) => {
    const canEdit = hasPerm("academic_structure", f.university_id, f.id, "edit");
    const canDelete = hasPerm("academic_structure", f.university_id, f.id, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الجامعة">${escHtml(f.universities?.name) || "—"}</td>
      <td data-label="الكلية">${escHtml(f.name)}</td>
      <td data-label="الرمز">${escHtml(f.code) || "—"}</td>
      <td data-label="الحالة"><span class="status-badge ${f.is_active ? "published" : "hidden"}">${f.is_active ? "مفعّلة" : "معطَّلة"}</span></td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editFaculty('${f.id}')">تعديل</button>` : ""}
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="toggleFacultyActive('${f.id}', ${f.is_active})">${f.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('faculties','${f.id}', loadFaculties)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

function refreshFacFormUniversityOptions() {
  const select = document.getElementById("fac-university");
  if (!select) return;
  const allowed = universitiesCache.filter((u) => hasPerm("academic_structure", u.id, null, "create"));
  const form = document.getElementById("fac-form");
  if (!allowed.length) {
    form.style.display = "none";
    return;
  }
  form.style.display = "";
  populateSelect("fac-university", allowed, (u) => u.name);
}

document.getElementById("fac-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("fac-edit-id").value;
  const payload = {
    university_id: document.getElementById("fac-university").value,
    name: document.getElementById("fac-name").value.trim(),
    code: document.getElementById("fac-code").value.trim() || null,
    description: document.getElementById("fac-description").value.trim() || null,
    is_active: document.getElementById("fac-active").checked,
  };
  const { data, error } = id
    ? await supabaseClient.from("faculties").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("faculties").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك أو من عدم تكرار الاسم)"); console.error(error); return; }
  logActivity(id ? "faculty_updated" : "faculty_created", "faculty", data?.id, payload.name);
  resetFacForm();
  showToast(id ? "تم تعديل الكلية" : "تمت إضافة الكلية");
  loadFaculties();
});

function editFaculty(facultyId) {
  const f = facultiesById[facultyId];
  if (!f) return;
  document.getElementById("fac-edit-id").value = f.id;
  ensureOptionExists("fac-university", f.university_id, f.universities?.name || universitiesById[f.university_id]?.name || "—");
  document.getElementById("fac-university").value = f.university_id;
  document.getElementById("fac-name").value = f.name;
  document.getElementById("fac-code").value = f.code || "";
  document.getElementById("fac-description").value = f.description || "";
  document.getElementById("fac-active").checked = !!f.is_active;
  document.getElementById("fac-form-title").textContent = "تعديل كلية";
  document.getElementById("fac-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("fac-cancel-btn").hidden = false;
}

function resetFacForm() {
  document.getElementById("fac-form").reset();
  document.getElementById("fac-edit-id").value = "";
  document.getElementById("fac-active").checked = true;
  document.getElementById("fac-form-title").textContent = "إضافة كلية";
  document.getElementById("fac-submit-btn").textContent = "إضافة";
  document.getElementById("fac-cancel-btn").hidden = true;
}
document.getElementById("fac-cancel-btn").addEventListener("click", resetFacForm);

async function toggleFacultyActive(facultyId, currentlyActive) {
  const { error } = await supabaseClient.from("faculties").update({ is_active: !currentlyActive }).eq("id", facultyId);
  if (error) { showToast("تعذّر تحديث حالة الكلية"); console.error(error); return; }
  logActivity(currentlyActive ? "faculty_disabled" : "faculty_enabled", "faculty", facultyId, null);
  showToast(currentlyActive ? "تم تعطيل الكلية" : "تم تفعيل الكلية");
  loadFaculties();
}

// ============================================================
// أدوات القوائم المتتالية (Cascading Selects)
// الترتيب دائمًا: الجامعة ← الكلية ← السنة ← المادة
// عند تغيّر مستوى أعلى، تُفرَّغ كل المستويات الأدنى منه دون استثناء.
// ============================================================

function currentSelectValue(id) {
  const el = document.getElementById(id);
  return el && el.value ? el.value : null;
}

function ensureOptionExists(selectId, value, label) {
  const select = document.getElementById(selectId);
  if (!select || !value) return;
  const exists = Array.from(select.options).some((o) => o.value === value);
  if (!exists) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  }
}

/** يملأ قائمة "الكلية" بكليات جامعة معيّنة فقط (نطاق نظيف — لا كليات من جامعة أخرى) */
function populateFacultySelect(selectId, universityId, keepValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = "";
  if (!universityId) {
    select.innerHTML = `<option value="">اختر الجامعة أولاً</option>`;
    return;
  }
  const options = facultiesCache
    .filter((f) => f.university_id === universityId)
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));

  if (!options.length) {
    select.innerHTML = `<option value="">لا توجد كليات لهذه الجامعة بعد</option>`;
    return;
  }
  select.innerHTML = `<option value="">اختر الكلية</option>`;
  options.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = f.name + (f.is_active ? "" : " (معطّلة)");
    select.appendChild(opt);
  });
  if (keepValue && options.some((o) => o.id === keepValue)) select.value = keepValue;
}

/** يملأ قائمة "السنة" بسنوات كلية معيّنة فقط */
function populateYearSelectForFaculty(selectId, facultyId, keepValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = "";
  if (!facultyId) {
    select.innerHTML = `<option value="">اختر الكلية أولاً</option>`;
    return;
  }
  const options = yearsCache
    .filter((y) => y.faculty_id === facultyId)
    .sort((a, b) => a.year_number - b.year_number);

  if (!options.length) {
    select.innerHTML = `<option value="">لا توجد سنوات لهذه الكلية بعد</option>`;
    return;
  }
  select.innerHTML = `<option value="">اختر السنة</option>`;
  options.forEach((y) => {
    const opt = document.createElement("option");
    opt.value = y.id;
    opt.textContent = `سنة ${y.year_number}`;
    select.appendChild(opt);
  });
  if (keepValue && options.some((o) => o.id === keepValue)) select.value = keepValue;
}

/** يملأ قائمة "المادة" بمواد سنة معيّنة فقط */
function populateSubjectSelectForYear(selectId, yearId, keepValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = "";
  if (!yearId) {
    select.innerHTML = `<option value="">اختر السنة أولاً</option>`;
    return;
  }
  const options = subjectsCache
    .filter((s) => s.year_id === yearId)
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));

  if (!options.length) {
    select.innerHTML = `<option value="">لا توجد مواد لهذه السنة بعد</option>`;
    return;
  }
  select.innerHTML = `<option value="">اختر المادة</option>`;
  options.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
  if (keepValue && options.some((o) => o.id === keepValue)) select.value = keepValue;
}

// -------- ربط أحداث التغيير: كل تغيير في مستوى أعلى يفرّغ ما تحته --------

document.getElementById("year-university").addEventListener("change", (e) => {
  populateFacultySelect("year-faculty", e.target.value, null);
});

document.getElementById("subj-university").addEventListener("change", (e) => {
  populateFacultySelect("subj-faculty", e.target.value, null);
  populateYearSelectForFaculty("subj-year", null, null);
});
document.getElementById("subj-faculty").addEventListener("change", (e) => {
  populateYearSelectForFaculty("subj-year", e.target.value, null);
});

document.getElementById("res-university").addEventListener("change", (e) => {
  populateFacultySelect("res-faculty", e.target.value, null);
  populateYearSelectForFaculty("res-year", null, null);
  populateSubjectSelectForYear("res-subject", null, null);
});
document.getElementById("res-faculty").addEventListener("change", (e) => {
  populateYearSelectForFaculty("res-year", e.target.value, null);
  populateSubjectSelectForYear("res-subject", null, null);
});
document.getElementById("res-year").addEventListener("change", (e) => {
  populateSubjectSelectForYear("res-subject", e.target.value, null);
});

// ============================================================
// السنوات
// ============================================================

async function loadYears() {
  const { data, error } = await supabaseClient
    .from("years")
    .select("id, year_number, university_id, faculty_id, universities(name), faculties(name)")
    .order("year_number");
  const tbody = document.querySelector("#year-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="4">تعذّر التحميل</td></tr>`; return; }

  yearsById = {};
  (data || []).forEach((y) => { yearsById[y.id] = y; });
  yearsCache = data || [];

  // القوائم المتتالية التي تعتمد على السنوات: قائمة "السنة" في نموذجي المادة والمورد
  populateYearSelectForFaculty("subj-year", currentSelectValue("subj-faculty"), currentSelectValue("subj-year"));
  populateYearSelectForFaculty("res-year", currentSelectValue("res-faculty"), currentSelectValue("res-year"));

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="4">لا توجد سنوات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((y) => {
    const canEdit = hasPerm("academic_structure", y.university_id, y.faculty_id, "edit");
    const canDelete = hasPerm("academic_structure", y.university_id, y.faculty_id, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الجامعة">${escHtml(y.universities?.name) || "—"}</td>
      <td data-label="الكلية">${escHtml(y.faculties?.name) || "—"}</td>
      <td data-label="السنة">${escHtml(y.year_number)}</td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editYear('${y.id}','${y.university_id}','${y.faculty_id || ""}',${y.year_number})">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('years','${y.id}', loadYears)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("year-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("year-edit-id").value;
  const facultyId = document.getElementById("year-faculty").value;
  if (!facultyId) { showToast("اختر الكلية أولاً"); return; }
  const payload = {
    university_id: document.getElementById("year-university").value,
    faculty_id: facultyId,
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

function editYear(id, universityId, facultyId, yearNumber) {
  document.getElementById("year-edit-id").value = id;
  document.getElementById("year-university").value = universityId;
  populateFacultySelect("year-faculty", universityId, facultyId || null);
  document.getElementById("year-number").value = yearNumber;
  document.getElementById("year-form-title").textContent = "تعديل سنة دراسية";
  document.getElementById("year-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("year-cancel-btn").hidden = false;
}

function resetYearForm() {
  document.getElementById("year-form").reset();
  document.getElementById("year-edit-id").value = "";
  populateFacultySelect("year-faculty", currentSelectValue("year-university"), null);
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
    .select("id, name, code, year_id, years(year_number, university_id, faculty_id, universities(name), faculties(name))")
    .order("name");
  const tbody = document.querySelector("#subj-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  subjectsById = {};
  (data || []).forEach((s) => { subjectsById[s.id] = s; });
  subjectsCache = data || [];

  // القائمة المتتالية التي تعتمد على المواد: قائمة "المادة" في نموذج المورد
  populateSubjectSelectForYear("res-subject", currentSelectValue("res-year"), currentSelectValue("res-subject"));

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد مواد بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((s) => {
    const uniId = s.years?.university_id;
    const facId = s.years?.faculty_id;
    const canEdit = hasPerm("academic_structure", uniId, facId, "edit");
    const canDelete = hasPerm("academic_structure", uniId, facId, "delete");
    const location = `${escHtml(s.years?.universities?.name) || "—"} › ${escHtml(s.years?.faculties?.name) || "—"} › سنة ${escHtml(s.years?.year_number ?? "—")}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="المادة">${escHtml(s.name)}${s.code ? ` (${escHtml(s.code)})` : ""}</td>
      <td data-label="الجامعة / الكلية / السنة">${location}</td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editSubject('${s.id}','${s.year_id}','${uniId || ""}','${facId || ""}','${escAttr(s.name)}','${escAttr(s.code || "")}')">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('subjects','${s.id}', loadSubjects)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("subj-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("subj-edit-id").value;
  const yearId = document.getElementById("subj-year").value;
  if (!yearId) { showToast("اختر السنة الدراسية أولاً"); return; }
  const payload = {
    year_id: yearId,
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

function editSubject(id, yearId, universityId, facultyId, name, code) {
  document.getElementById("subj-edit-id").value = id;
  document.getElementById("subj-university").value = universityId;
  populateFacultySelect("subj-faculty", universityId, facultyId || null);
  populateYearSelectForFaculty("subj-year", facultyId || null, yearId);
  document.getElementById("subj-name").value = name;
  document.getElementById("subj-code").value = code;
  document.getElementById("subj-form-title").textContent = "تعديل مادة";
  document.getElementById("subj-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("subj-cancel-btn").hidden = false;
}

function resetSubjForm() {
  document.getElementById("subj-form").reset();
  document.getElementById("subj-edit-id").value = "";
  populateFacultySelect("subj-faculty", currentSelectValue("subj-university"), null);
  populateYearSelectForFaculty("subj-year", null, null);
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
    .select(`
      id, title, type, language, file_url, storage_provider, source_type, status, keywords, subject_id, verified, view_count,
      subjects(
        id, name, year_id,
        years(id, university_id, faculty_id, year_number, universities(name), faculties(name))
      )
    `)
    .order("created_at", { ascending: false });
  if (error) {
    document.querySelector("#res-table tbody").innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`;
    return;
  }
  resourcesCache = data || [];
  resourcesById = {};
  resourcesCache.forEach((r) => { resourcesById[r.id] = r; });
  renderResourcesTable();
}

/** يفلتر resourcesCache محليًا حسب عناصر تحكم البحث/النوع/الحالة أعلى الجدول ويعيد الرسم — بدون أي طلب شبكة إضافي */
function renderResourcesTable() {
  const tbody = document.querySelector("#res-table tbody");
  const searchText = (document.getElementById("res-filter-search")?.value || "").trim().toLowerCase();
  const typeFilter = document.getElementById("res-filter-type")?.value || "";
  const statusFilter = document.getElementById("res-filter-status")?.value || "";

  if (!resourcesCache.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد موارد بعد (أو لا تملك صلاحية عرضها)</td></tr>`; return; }

  const filtered = resourcesCache.filter((r) => {
    const matchesSearch = !searchText ||
      r.title.toLowerCase().includes(searchText) ||
      (r.keywords || "").toLowerCase().includes(searchText);
    const matchesType = !typeFilter || r.type === typeFilter;
    const matchesStatus = !statusFilter || r.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  if (!filtered.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد نتائج مطابقة للفلاتر الحالية</td></tr>`; return; }

  tbody.innerHTML = "";
  filtered.forEach((r) => {
    const uniId = r.subjects?.years?.university_id;
    const facId = r.subjects?.years?.faculty_id;
    const canEdit = hasPerm("resources", uniId, facId, "edit");
    const canDelete = hasPerm("resources", uniId, facId, "delete");
    const location = `${escHtml(r.subjects?.years?.universities?.name) || "—"} › ${escHtml(r.subjects?.years?.faculties?.name) || "—"} › سنة ${escHtml(r.subjects?.years?.year_number ?? "—")} › ${escHtml(r.subjects?.name) || "—"}`;
    const statusClass = r.status === "published" ? "published" : r.status === "hidden" ? "hidden" : "reported";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="العنوان">${escHtml(r.title)}${r.verified ? ' <span class="tag tag-verified" style="padding:2px 8px; font-size:.7rem;">✓ موثّق</span>' : ""}</td>
      <td data-label="الموقع الأكاديمي">${location}</td>
      <td data-label="النوع">${escHtml(RESOURCE_TYPE_LABELS_ADMIN[r.type] || r.type)}</td>
      <td data-label="الحالة"><span class="status-badge ${statusClass}">${r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه"}</span></td>
      <td>
        ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editResource('${r.id}')">تعديل</button>` : ""}
        ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('resources','${r.id}', loadResources)">حذف</button>` : ""}
        ${!canEdit && !canDelete ? "—" : ""}
      </td>`;
    tbody.appendChild(tr);
  });
}

let resFilterDebounce = null;
document.getElementById("res-filter-search").addEventListener("input", () => {
  clearTimeout(resFilterDebounce);
  resFilterDebounce = setTimeout(renderResourcesTable, 150);
});
document.getElementById("res-filter-type").addEventListener("change", renderResourcesTable);
document.getElementById("res-filter-status").addEventListener("change", renderResourcesTable);

document.getElementById("res-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("res-edit-id").value;
  const subjectId = document.getElementById("res-subject").value;
  if (!subjectId) { showToast("اختر المادة أولاً"); return; }
  const payload = {
    subject_id: subjectId,
    title: document.getElementById("res-title").value.trim(),
    type: document.getElementById("res-type").value,
    language: document.getElementById("res-language").value,
    file_url: document.getElementById("res-file-url").value.trim(),
    storage_provider: document.getElementById("res-storage-provider").value,
    source_type: document.getElementById("res-source-type").value,
    status: document.getElementById("res-status").value,
    keywords: document.getElementById("res-keywords").value.trim() || null,
    verified: document.getElementById("res-verified").checked,
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

function editResource(resourceId) {
  const r = resourcesById[resourceId];
  if (!r) return;
  const uniId = r.subjects?.years?.university_id;
  const facId = r.subjects?.years?.faculty_id;
  const yearId = r.subjects?.year_id;

  document.getElementById("res-edit-id").value = r.id;
  document.getElementById("res-university").value = uniId || "";
  populateFacultySelect("res-faculty", uniId, facId || null);
  populateYearSelectForFaculty("res-year", facId || null, yearId || null);
  populateSubjectSelectForYear("res-subject", yearId || null, r.subject_id);

  document.getElementById("res-title").value = r.title;
  document.getElementById("res-type").value = r.type;
  document.getElementById("res-language").value = r.language || "ar";
  document.getElementById("res-file-url").value = r.file_url;
  document.getElementById("res-storage-provider").value = r.storage_provider || "google_drive";
  document.getElementById("res-source-type").value = r.source_type || "student";
  document.getElementById("res-status").value = r.status;
  document.getElementById("res-keywords").value = r.keywords || "";
  document.getElementById("res-verified").checked = !!r.verified;
  document.getElementById("res-form-title").textContent = "تعديل مورد";
  document.getElementById("res-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("res-cancel-btn").hidden = false;
}

function resetResForm() {
  document.getElementById("res-form").reset();
  document.getElementById("res-edit-id").value = "";
  populateFacultySelect("res-faculty", currentSelectValue("res-university"), null);
  populateYearSelectForFaculty("res-year", null, null);
  populateSubjectSelectForYear("res-subject", null, null);
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
    .select("id, reason, note, created_at, resource_id, resources(id, title, status, subjects(years(university_id, faculty_id)))")
    .order("created_at", { ascending: false });
  const tbody = document.querySelector("#reports-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد بلاغات حاليًا (أو لا تملك صلاحية عرضها)</td></tr>`; return; }
  tbody.innerHTML = "";
  const reasonLabels = { broken_link: "الرابط لا يعمل", wrong_file: "ملف غير صحيح", copyright: "حقوق نشر", other: "أخرى" };
  data.forEach((r) => {
    const resTitle = r.resources?.title || "(مورد محذوف)";
    const isHidden = r.resources?.status === "hidden";
    const uniId = r.resources?.subjects?.years?.university_id;
    const facId = r.resources?.subjects?.years?.faculty_id;
    const canResolve = hasPerm("reports", uniId, facId, "delete");
    const canToggle = hasPerm("resources", uniId, facId, "edit");

    // كل القيم أدناه (عنوان المورد، السبب، ملاحظة المُبلِّغ) قادمة من
    // قاعدة البيانات/من المستخدم ويجب التعامل معها كنص غير موثوق دائمًا؛
    // لذلك تُبنى كل خلية عبر DOM + textContent وليس عبر innerHTML.
    const tr = document.createElement("tr");

    const tdResource = document.createElement("td");
    tdResource.setAttribute("data-label", "المورد");
    tdResource.textContent = resTitle;
    tr.appendChild(tdResource);

    const tdReason = document.createElement("td");
    tdReason.setAttribute("data-label", "السبب");
    tdReason.textContent = reasonLabels[r.reason] || r.reason;
    tr.appendChild(tdReason);

    const tdNote = document.createElement("td");
    tdNote.setAttribute("data-label", "ملاحظة");
    tdNote.textContent = r.note || "—";
    tr.appendChild(tdNote);

    const tdDate = document.createElement("td");
    tdDate.setAttribute("data-label", "التاريخ");
    tdDate.textContent = new Date(r.created_at).toLocaleDateString("ar-EG");
    tr.appendChild(tdDate);

    const tdActions = document.createElement("td");
    tdActions.innerHTML = `
      ${r.resources && canToggle ? `<button class="btn btn-outline btn-sm" onclick="toggleResourceHidden('${r.resources.id}', ${isHidden}, loadReports)">${isHidden ? "إظهار المورد" : "إخفاء المورد"}</button>` : ""}
      ${canResolve ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('reports','${r.id}', loadReports)">حذف البلاغ</button>` : ""}
    `;
    tr.appendChild(tdActions);

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

  const [{ data: profilesData, error: pErr }, { data: permsData }, { data: unis }, { data: facs }] = await Promise.all([
    supabaseClient.from("profiles").select("*").order("created_at"),
    supabaseClient.from("user_permissions").select("*"),
    supabaseClient.from("universities").select("id, name").order("name"),
    supabaseClient.from("faculties").select("id, name, university_id").order("name"),
  ]);

  if (pErr) { container.innerHTML = `<div class="state-msg">تعذّر تحميل المستخدمين</div>`; return; }

  container.innerHTML = "";
  (profilesData || []).forEach((profile) => {
    const userPerms = (permsData || []).filter((p) => p.user_id === profile.id);
    container.appendChild(buildUserPermissionCard(profile, userPerms, unis || [], facs || []));
  });

  if (!profilesData || !profilesData.length) {
    container.innerHTML = `<div class="state-msg">لا يوجد مستخدمون بعد. أنشئهم من Supabase Dashboard &gt; Authentication &gt; Users.</div>`;
  }
}

function buildUserPermissionCard(profile, userPerms, universities, faculties) {
  const card = document.createElement("div");
  card.className = "user-perm-card";
  const isSelf = profile.id === currentProfile.id;
  const isSuper = profile.role === "super_admin";

  const header = document.createElement("div");
  header.className = "user-perm-header";
  header.innerHTML = `
    <div>
      <strong>${escHtml(profile.email) || "(بلا بريد)"}</strong>
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

  // -------- بناء كتلة صلاحيات واحدة (تُستخدم لكل أنواع النطاق: عام/جامعة/كلية) --------
  function buildScopeBlock(scope) {
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
          (p.scope_faculty_id === scope.scope_faculty_id || (p.scope_faculty_id == null && scope.scope_faculty_id == null)) &&
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
    return scopeBlock;
  }

  // مصفوفة صلاحيات: صف "عام (كل الجامعات)" + صف لكل جامعة (سلوك المرحلة 2 كما هو دون تغيير)
  const scopesTable = document.createElement("div");
  scopesTable.className = "perm-scopes";

  const scopeRows = [{ scope_type: "global", scope_id: null, scope_faculty_id: null, label: "عام (كل الجامعات)" }]
    .concat(universities.map((u) => ({ scope_type: "university", scope_id: u.id, scope_faculty_id: null, label: u.name })));

  scopeRows.forEach((scope) => scopesTable.appendChild(buildScopeBlock(scope)));
  card.appendChild(scopesTable);

  // -------- قسم جديد: الصلاحيات على مستوى الكلية --------
  const facSection = document.createElement("div");
  facSection.style.marginTop = "14px";

  const facTitle = document.createElement("div");
  facTitle.className = "perm-scope-title";
  facTitle.textContent = "صلاحيات على مستوى الكلية";
  facSection.appendChild(facTitle);

  const facScopesWrap = document.createElement("div");
  facScopesWrap.className = "perm-scopes";
  facSection.appendChild(facScopesWrap);

  function facultyLabel(facultyId) {
    const f = faculties.find((x) => x.id === facultyId);
    if (!f) return "كلية غير معروفة";
    const uni = universities.find((u) => u.id === f.university_id);
    return `${uni ? uni.name : "—"} › ${f.name}`;
  }

  // الكليات التي للمستخدم فيها صلاحية فعلية بالفعل (مبنية من البيانات الموجودة)
  const existingFacultyIds = Array.from(new Set(
    userPerms.filter((p) => p.scope_type === "faculty" && p.scope_faculty_id).map((p) => p.scope_faculty_id)
  ));

  function addFacultyScopeBlock(facultyId) {
    const faculty = faculties.find((f) => f.id === facultyId);
    if (!faculty) return;
    const scope = { scope_type: "faculty", scope_id: null, scope_faculty_id: facultyId, label: facultyLabel(facultyId) };
    facScopesWrap.appendChild(buildScopeBlock(scope));
  }

  existingFacultyIds.forEach(addFacultyScopeBlock);

  if (!existingFacultyIds.length) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "hint";
    emptyMsg.textContent = "لا توجد صلاحيات على مستوى كلية بعد لهذا المستخدم.";
    emptyMsg.dataset.role = "fac-empty-msg";
    facScopesWrap.appendChild(emptyMsg);
  }

  // -------- نموذج إضافة صلاحية كلية جديدة (متتالي: جامعة ← كلية) --------
  const addRow = document.createElement("div");
  addRow.className = "user-perm-controls";
  addRow.style.marginTop = "10px";

  const addUniSelect = document.createElement("select");
  const uniPlaceholder = document.createElement("option");
  uniPlaceholder.value = "";
  uniPlaceholder.textContent = "اختر الجامعة";
  addUniSelect.appendChild(uniPlaceholder);
  universities.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.id; opt.textContent = u.name;
    addUniSelect.appendChild(opt);
  });

  const addFacSelect = document.createElement("select");
  addFacSelect.innerHTML = `<option value="">اختر الجامعة أولاً</option>`;

  addUniSelect.addEventListener("change", () => {
    const uniId = addUniSelect.value;
    addFacSelect.innerHTML = "";
    if (!uniId) { addFacSelect.innerHTML = `<option value="">اختر الجامعة أولاً</option>`; return; }
    const opts = faculties.filter((f) => f.university_id === uniId);
    if (!opts.length) { addFacSelect.innerHTML = `<option value="">لا توجد كليات لهذه الجامعة</option>`; return; }
    addFacSelect.innerHTML = `<option value="">اختر الكلية</option>`;
    opts.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id; opt.textContent = f.name;
      addFacSelect.appendChild(opt);
    });
  });

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-outline btn-sm";
  addBtn.textContent = "+ إضافة صلاحية كلية";
  addBtn.addEventListener("click", () => {
    const facultyId = addFacSelect.value;
    if (!facultyId) { showToast("اختر الكلية أولاً"); return; }
    if (existingFacultyIds.includes(facultyId)) { showToast("توجد بالفعل كتلة صلاحيات لهذه الكلية بالأسفل"); return; }
    const emptyMsg = facScopesWrap.querySelector('[data-role="fac-empty-msg"]');
    if (emptyMsg) emptyMsg.remove();
    addFacultyScopeBlock(facultyId);
    existingFacultyIds.push(facultyId);
    addUniSelect.value = "";
    addFacSelect.innerHTML = `<option value="">اختر الجامعة أولاً</option>`;
  });

  addRow.appendChild(labeledWrap("الجامعة", addUniSelect));
  addRow.appendChild(labeledWrap("الكلية", addFacSelect));
  addRow.appendChild(addBtn);
  facSection.appendChild(addRow);

  card.appendChild(facSection);

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
        scope_faculty_id: scope.scope_faculty_id || null,
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
  if (error) { showToast("تعذّر الحذف (تحقق من صلاحياتك، أو أن هناك بيانات تابعة لهذا العنصر)"); console.error(error); return; }
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

/**
 * ترميز نص غير موثوق للإدراج داخل قيمة سمة HTML (attribute) تُستخدم كوسيطة
 * JS ضمن onclick (مثال: onclick="fn('${escAttr(x)}')"). يجب ترميز الأحرف
 * الخمسة كاملة — وعلى رأسها "&" — وإلا يمكن لنص خام مثل الحرفين المتتاليين
 * "&quot;" أو "&#39;" (كنص عادي قادم من قاعدة البيانات، وليس ككيان HTML
 * فعلي مقصود) أن يُفكَّه المتصفح إلى علامة اقتباس حقيقية أثناء تحليل قيمة
 * السمة، فتنكسر السلسلة النصية داخل كود onclick ويُصبح حقن JS ممكنًا رغم
 * أن الدالة القديمة كانت "تُرمِّز" علامات الاقتباس الحرفية. لذلك نعيد
 * استخدام نفس منطق escHtml (ترميز كل الأحرف الخمسة في مرور واحد).
 */
function escAttr(str) {
  return escHtml(str);
}

/**
 * ترميز نص غير موثوق (قادم من قاعدة البيانات أو المستخدم) ليكون آمنًا
 * للإدراج داخل محتوى HTML (سياق نص، وليس سياق سمة/attribute).
 * يرمّز كل ميتاكاركترز HTML الخمسة — وليست قائمة سوداء لوسوم بعينها —
 * لذلك تبقى آمنة أيًا كانت القيمة المُدخلة.
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

checkAuthAndInit();
