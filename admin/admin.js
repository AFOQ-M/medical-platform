// ============================================================
// منطق لوحة التحكم: تسجيل الدخول + عمليات CRUD الكاملة
// ============================================================

const RESOURCE_TYPE_LABELS_ADMIN = {
  book: "كتاب", lecture: "محاضرة", slides: "سلايدات",
  summary: "ملخص", questions: "أسئلة", past_exam: "امتحان سابق", notes: "ملاحظات",
};

// -------------------- المصادقة --------------------

async function checkAuthAndInit() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    showDashboard(session.user.email);
  } else {
    showLogin();
  }
}

function showLogin() {
  document.getElementById("login-box").hidden = false;
  document.getElementById("dashboard").hidden = true;
  document.getElementById("admin-user-info").textContent = "";
}

function showDashboard(email) {
  document.getElementById("login-box").hidden = true;
  document.getElementById("dashboard").hidden = false;
  document.getElementById("admin-user-info").textContent = email ? `مسجّل دخول: ${email}` : "";
  loadAllData();
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

  showDashboard(data.user.email);
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  showLogin();
});

// -------------------- التبويبات --------------------

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".admin-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add("active");
  });
});

function loadAllData() {
  loadUniversities();
  loadYears();
  loadSubjects();
  loadResources();
  loadReports();
}

// ============================================================
// الجامعات
// ============================================================

async function loadUniversities() {
  const { data, error } = await supabaseClient.from("universities").select("*").order("name");
  const tbody = document.querySelector("#uni-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  populateSelect("year-university", data, (u) => u.name);

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد جامعات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.name}</td>
      <td>${u.short_name || "—"}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editUniversity('${u.id}','${escAttr(u.name)}','${escAttr(u.short_name || "")}','${escAttr(u.logo_url || "")}')">تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRow('universities','${u.id}', loadUniversities)">حذف</button>
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
  const { error } = id
    ? await supabaseClient.from("universities").update(payload).eq("id", id)
    : await supabaseClient.from("universities").insert(payload);

  if (error) { showToast("خطأ: تعذّر الحفظ"); console.error(error); return; }
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${y.universities?.name || "—"}</td>
      <td>${y.year_number}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editYear('${y.id}','${y.university_id}',${y.year_number})">تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRow('years','${y.id}', loadYears)">حذف</button>
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
  const { error } = id
    ? await supabaseClient.from("years").update(payload).eq("id", id)
    : await supabaseClient.from("years").insert(payload);

  if (error) { showToast("خطأ: تعذّر الحفظ"); console.error(error); return; }
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
    .select("id, name, code, year_id, years(year_number, universities(name))")
    .order("name");
  const tbody = document.querySelector("#subj-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="3">تعذّر التحميل</td></tr>`; return; }

  const selectOptions = data.map((s) => ({ id: s.id, label: s.name }));
  populateSelect("res-subject", selectOptions, (o) => o.label, true);

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="3">لا توجد مواد بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((s) => {
    const ctx = s.years ? `${s.years.universities?.name || "—"} / سنة ${s.years.year_number}` : "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.name}</td>
      <td>${ctx}</td>
      <td>
        <button class="btn btn-outline btn-sm" onclick="editSubject('${s.id}','${s.year_id}','${escAttr(s.name)}','${escAttr(s.code || "")}')">تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRow('subjects','${s.id}', loadSubjects)">حذف</button>
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
  const { error } = id
    ? await supabaseClient.from("subjects").update(payload).eq("id", id)
    : await supabaseClient.from("subjects").insert(payload);

  if (error) { showToast("خطأ: تعذّر الحفظ"); console.error(error); return; }
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
    .select("id, title, type, language, file_url, storage_provider, source_type, status, subject_id, subjects(name)")
    .order("created_at", { ascending: false });
  const tbody = document.querySelector("#res-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد موارد بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.title}</td>
      <td>${r.subjects?.name || "—"}</td>
      <td>${RESOURCE_TYPE_LABELS_ADMIN[r.type] || r.type}</td>
      <td><span class="status-badge ${r.status}">${r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه"}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" onclick='editResource(${JSON.stringify(r).replace(/'/g, "&apos;")})'>تعديل</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRow('resources','${r.id}', loadResources)">حذف</button>
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
  };
  const { error } = id
    ? await supabaseClient.from("resources").update(payload).eq("id", id)
    : await supabaseClient.from("resources").insert(payload);

  if (error) { showToast("خطأ: تعذّر الحفظ"); console.error(error); return; }
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
    .select("id, reason, note, created_at, resource_id, resources(id, title, status)")
    .order("created_at", { ascending: false });
  const tbody = document.querySelector("#reports-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد بلاغات حاليًا</td></tr>`; return; }
  tbody.innerHTML = "";
  const reasonLabels = { broken_link: "الرابط لا يعمل", wrong_file: "ملف غير صحيح", copyright: "حقوق نشر", other: "أخرى" };
  data.forEach((r) => {
    const tr = document.createElement("tr");
    const resTitle = r.resources?.title || "(مورد محذوف)";
    const isHidden = r.resources?.status === "hidden";
    tr.innerHTML = `
      <td>${resTitle}</td>
      <td>${reasonLabels[r.reason] || r.reason}</td>
      <td>${r.note || "—"}</td>
      <td>${new Date(r.created_at).toLocaleDateString("ar-EG")}</td>
      <td>
        ${r.resources ? `<button class="btn btn-outline btn-sm" onclick="toggleResourceHidden('${r.resources.id}', ${isHidden}, loadReports)">${isHidden ? "إظهار المورد" : "إخفاء المورد"}</button>` : ""}
        <button class="btn btn-danger btn-sm" onclick="deleteRow('reports','${r.id}', loadReports)">حذف البلاغ</button>
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
  showToast(currentlyHidden ? "تم إظهار المورد" : "تم إخفاء المورد");
  refreshFn();
  loadResources();
}

// ============================================================
// أدوات مساعدة
// ============================================================

async function deleteRow(table, id, refreshFn) {
  if (!confirm("هل أنت متأكد من الحذف؟ لا يمكن التراجع عن هذا الإجراء.")) return;
  const { error } = await supabaseClient.from(table).delete().eq("id", id);
  if (error) { showToast("تعذّر الحذف"); console.error(error); return; }
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
