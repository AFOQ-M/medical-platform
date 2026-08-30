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

// Phase 4B: تسميات الفصل الدراسي — تُستخدم فقط لعرض القيمة في جدول
// المواد بلوحة التحكم؛ القيم المخزَّنة فعليًا في subjects.semester تبقى
// first/second/summer (أو NULL) كما هي.
// ملاحظة: SUBJECT_SEMESTER_LABELS مُعرَّفة في js/app.js الذي يُحمَّل قبل
// هذا الملف مباشرة في admin/index.html، لذا لا تُعاد هنا (كانت تسبب
// SyntaxError: Identifier already declared يوقف admin.js بالكامل عن
// العمل، بما في ذلك ربط نموذج تسجيل الدخول).

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

// P1-7A: حالة التحقق بخطوتين (MFA) للجلسة الحالية فقط — لا تُخزَّن في
// أي storage دائم (لا localStorage ولا sessionStorage)، مجرد متغيرات
// وحدة الذاكرة (module-level) تُعاد قراءتها من Supabase عند كل تحميل/
// تسجيل دخول. هذا الفحص للواجهة فقط (متى نعرض شاشة "تحقق" بدل
// الداشبورد مباشرة) — RLS عبر fn_has_permission() يبقى الحَكَم الفعلي،
// تمامًا كما مع hasPerm()/hasAnyPerm() أعلاه.
let currentMfaState = { hasVerifiedFactor: false, currentLevel: "aal1", factorId: null };
let currentAuthEmail = null;

// -------------------- Single-Admin Session Lock --------------------
// (سُمّيت "P1-7B" في تعليمات التنفيذ الحالية؛ نفس الاسم مستخدم أعلاه
// لميزة MFA — راجع ملاحظة التسمية في رأس sql/phase4b_p1_7b_admin_session_lock.sql).
//
// يمنع أكثر من جلسة أدمن واحدة فعّالة في لوحة التحكم في آن واحد. الفرض
// الحقيقي من جهة القاعدة عبر acquire/refresh/release_admin_session_lock()
// (SECURITY DEFINER RPCs، الجدول نفسه deny-all عبر RLS بلا أي policy).
// هذا الكود هنا مجرد "مرآة" للواجهة — تمامًا كمنطق hasPerm() أعلاه —
// وليس مصدر الحماية الفعلي.
//
// currentLockToken يعيش في متغير module-level (يُفقد تلقائيًا عند
// إغلاق التبويب — هذا مقصود: إغلاق المتصفح لا يُعتبر تحريرًا مضمونًا
// للقفل، والضامن الحقيقي هو TTL (90 ثانية) في القاعدة + heartbeat دوري
// من هنا)، **و**أيضًا في sessionStorage (خاص بهذا التبويب فقط — لا
// localStorage، لأن localStorage يُشارَك بين كل تبويبات نفس الأصل
// فيسمح لتبويب ثانٍ فعلي لنفس الحساب باستعادة/سرقة قفل تبويب أول، بينما
// sessionStorage معزول لكل تبويب على حدة). الغرض الوحيد من هذا التخزين
// هو تمكين استعادة نفس القفل بعد F5 لنفس التبويب (راجع restoreAdminLock
// أدناه) دون المساس بقاعدة "First Session Wins" — القيمة المخزَّنة هنا
// مجرد نسخة محلية من session_token نفسه؛ التحقق الفعلي من ملكية القفل
// يبقى بالكامل من جهة القاعدة عبر refresh_admin_session_lock().
let currentLockToken = null;
let lockHeartbeatTimer = null;
const LOCK_HEARTBEAT_MS = 25000; // TTL في القاعدة = 90 ثانية؛ ~3 محاولات heartbeat قبل الانتهاء
const LOCK_TOKEN_STORAGE_KEY = "p17b_admin_session_lock_token"; // sessionStorage فقط — راجع الشرح أعلاه

function stopLockHeartbeat() {
  if (lockHeartbeatTimer) {
    clearInterval(lockHeartbeatTimer);
    lockHeartbeatTimer = null;
  }
}

function startLockHeartbeat() {
  stopLockHeartbeat();
  lockHeartbeatTimer = setInterval(async () => {
    if (!currentLockToken) return;
    try {
      const { data, error } = await supabaseClient.rpc("refresh_admin_session_lock", {
        p_session_token: currentLockToken,
      });
      if (error || !data || data.ok !== true) {
        await forceLockLogout("تم إنهاء جلستك الحالية (جلسة أدمن أخرى بدأت، أو انتهت صلاحية جلستك). سجّل الدخول مجددًا.");
      }
    } catch (e) {
      // فشل شبكة عابر لا يُنهي الجلسة فورًا من طرف الواجهة — الـ TTL في
      // القاعدة هو الضامن النهائي؛ محاولة heartbeat التالية قد تنجح.
      console.error("تعذّر إرسال heartbeat لقفل الأدمن:", e);
    }
  }, LOCK_HEARTBEAT_MS);
}

// محاولة الحصول على قفل الأدمن الوحيد. لا تُعرض الداشبورد أبدًا قبل
// نجاح هذه الدالة — الفرض فعلي من القاعدة، وليس مجرد ستارة واجهة.
async function acquireAdminLock() {
  const { data, error } = await supabaseClient.rpc("acquire_admin_session_lock");
  if (error || !data || data.acquired !== true) {
    return false;
  }
  currentLockToken = data.session_token;
  try { sessionStorage.setItem(LOCK_TOKEN_STORAGE_KEY, currentLockToken); } catch (e) {
    // sessionStorage غير متاح (وضع خاص صارم مثلاً) — لا يمنع القفل نفسه
    // من العمل، فقط يعني أن استعادته بعد F5 لن تكون ممكنة لهذا التبويب.
  }
  startLockHeartbeat();
  return true;
}

// محاولة استعادة قفل يملكه هذا التبويب بالفعل، بعد إعادة تحميل الصفحة
// (F5) وقبل أي محاولة acquire جديدة — هذا هو إصلاح مشكلة F5 بالكامل.
//
// تعتمد فقط على session_token المخزَّن في sessionStorage (معزول لهذا
// التبويب وحده)، وليس على تطابق auth.uid() وحده: تبويب/متصفح ثانٍ فعلي
// لنفس الحساب لن يملك هذه القيمة في sessionStorage الخاصة به إطلاقًا
// (sessionStorage غير مشترك بين التبويبات)، فلا يستطيع استعادة/سرقة قفل
// تبويب أول عبر هذا المسار مهما كان auth.uid() متطابقًا.
//
// تستدعي refresh_admin_session_lock() نفسها — الدالة الموجودة أصلًا
// للـ heartbeat، بلا أي تعديل عليها — التي تتحقق من auth.uid() *و*
// تطابق session_token *و* عدم انتهاء الصلاحية معًا قبل أي نجاح. عند
// النجاح: لا تُنشأ أي جلسة/توكن جديد، فقط تمديد expires_at كما يفعل أي
// heartbeat عادي — القفل يبقى نفسه تمامًا كما كان قبل F5. عند الفشل
// (توكن غير صالح/منتهٍ/لم يعد ملكنا): نُنظّف sessionStorage ونعود false
// كي يكمل enterDashboardWithLock() بمسار acquire العادي دون أي تغيير.
async function restoreAdminLock() {
  let savedToken;
  try {
    savedToken = sessionStorage.getItem(LOCK_TOKEN_STORAGE_KEY);
  } catch (e) {
    savedToken = null;
  }
  if (!savedToken) return false;

  const { data, error } = await supabaseClient.rpc("refresh_admin_session_lock", {
    p_session_token: savedToken,
  });
  if (error || !data || data.ok !== true) {
    try { sessionStorage.removeItem(LOCK_TOKEN_STORAGE_KEY); } catch (e) {
      // تجاهل — سيُعاد تجاهله لاحقًا عند أي محاولة تالية بلا أثر عملي
    }
    return false;
  }

  currentLockToken = savedToken;
  startLockHeartbeat();
  return true;
}

// إنهاء قسري للجلسة (heartbeat فشل أو القفل لم يعد ملكنا). لا نحاول
// release هنا (غالبًا لم نعد نملك القفل أصلاً)، فقط تنظيف + signOut.
async function forceLockLogout(message) {
  stopLockHeartbeat();
  currentLockToken = null;
  try { sessionStorage.removeItem(LOCK_TOKEN_STORAGE_KEY); } catch (e) {
    // تجاهل — لا تأثير عملي إن فشل هذا فقط
  }
  currentProfile = null;
  currentPermissions = [];
  currentMfaState = { hasVerifiedFactor: false, currentLevel: "aal1", factorId: null };
  currentAuthEmail = null;
  try {
    await supabaseClient.auth.signOut();
  } catch (e) {
    // نظّف واجهة تسجيل الدخول حتى لو فشل signOut نفسه (مثلاً لا اتصال)
  }
  showLogin(message);
}

// تحرير طوعي للقفل عند تسجيل الخروج. best-effort: فشل الشبكة هنا لا
// يمنع logout من إتمامه — الـ TTL في القاعدة يحرر القفل خلال 90 ثانية
// كحد أقصى حتى لو فشل release تمامًا.
async function releaseAdminLock() {
  stopLockHeartbeat();
  if (!currentLockToken) return;
  const token = currentLockToken;
  currentLockToken = null;
  try { sessionStorage.removeItem(LOCK_TOKEN_STORAGE_KEY); } catch (e) {
    // تجاهل — لا تأثير عملي إن فشل هذا فقط
  }
  try {
    await supabaseClient.rpc("release_admin_session_lock", { p_session_token: token });
  } catch (e) {
    console.error("تعذّر تحرير قفل الأدمن (سيُحرَّر تلقائيًا خلال 90 ثانية عبر TTL):", e);
  }
}

// نقطة الدخول الموحّدة للداشبورد — من تسجيل الدخول المباشر (لا MFA) أو
// بعد نجاح التحقق بخطوتين. القفل شرط إلزامي قبل أي عرض للداشبورد.
async function enterDashboardWithLock(email) {
  // أولًا: هل هذا التبويب يملك قفلًا بالفعل من قبل إعادة التحميل؟ إن
  // نجحت الاستعادة، لا حاجة لأي acquire جديد — نفس القفل/التوكن يستمر.
  const restored = await restoreAdminLock();
  const acquired = restored || (await acquireAdminLock());
  if (!acquired) {
    currentProfile = null;
    currentPermissions = [];
    currentMfaState = { hasVerifiedFactor: false, currentLevel: "aal1", factorId: null };
    currentAuthEmail = null;
    try {
      await supabaseClient.auth.signOut();
    } catch (e) {
      // نظّف واجهة تسجيل الدخول حتى لو فشل signOut نفسه
    }
    showLogin("يوجد مسؤول آخر يستخدم لوحة التحكم حاليًا. حاول لاحقًا.");
    return;
  }
  showDashboard(email);
}

async function refreshMfaState() {
  const { data: factorsData, error: factorsError } = await supabaseClient.auth.mfa.listFactors();
  const verifiedTotp = !factorsError && factorsData
    ? (factorsData.totp || []).find((f) => f.status === "verified")
    : null;

  const { data: aalData } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();

  currentMfaState = {
    hasVerifiedFactor: !!verifiedTotp,
    currentLevel: aalData ? aalData.currentLevel : "aal1",
    factorId: verifiedTotp ? verifiedTotp.id : null,
  };
  return currentMfaState;
}

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
  currentAuthEmail = authUser.email;

  const { data: perms } = await supabaseClient
    .from("user_permissions").select("*").eq("user_id", authUser.id).eq("active", true);
  currentPermissions = perms || [];

  await refreshMfaState();

  // P1-7A — قرار العمل المعتمد:
  // - super_admin: لا يُطلب منه إكمال MFA إطلاقًا مهما كانت حالته (حتى
  //   لو لديه factor verified ولم يُكمل aal2) — دخول مباشر دائمًا.
  // - غيره: إن لم يملك أي factor verified، دخول مباشر (MFA اختياري،
  //   لا يُفرض تلقائيًا). إن ملك factor verified ولم يصل بعد لـ aal2،
  //   تُعرض شاشة التحقق بخطوتين قبل الداشبورد.
  const isSuperAdmin = currentProfile.role === "super_admin";
  if (!isSuperAdmin && currentMfaState.hasVerifiedFactor && currentMfaState.currentLevel !== "aal2") {
    showMfaVerify();
    return;
  }

  await enterDashboardWithLock(authUser.email);
}

function showLogin(errorMsg) {
  document.getElementById("login-box").hidden = false;
  document.getElementById("mfa-verify-box").hidden = true;
  document.getElementById("dashboard").hidden = true;
  document.getElementById("admin-user-info").textContent = "";
  const errorEl = document.getElementById("login-error");
  if (errorMsg) { errorEl.textContent = errorMsg; errorEl.style.display = "block"; }
}

function showMfaVerify() {
  document.getElementById("login-box").hidden = true;
  document.getElementById("dashboard").hidden = true;
  document.getElementById("mfa-verify-box").hidden = false;
  document.getElementById("mfa-verify-code").value = "";
  document.getElementById("mfa-verify-error").style.display = "none";
}

function showDashboard(email) {
  document.getElementById("login-box").hidden = true;
  document.getElementById("mfa-verify-box").hidden = true;
  document.getElementById("dashboard").hidden = false;
  const roleLabel = currentProfile.role === "super_admin" ? "سوبر أدمن" : currentProfile.role === "admin" ? "أدمن" : "موظف";
  document.getElementById("admin-user-info").textContent = `${email} (${roleLabel})`;
  applyPermissionVisibility();
  updateMfaEnrollVisibility();
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

// P1-7A: زر تفعيل التحقق بخطوتين يظهر فقط لحساب غير super_admin لم
// يُسجّل بعد أي factor بحالة verified — enrollment اختياري بالكامل،
// لا يُفرض على أحد، ويختفي تلقائيًا بعد إتمام التسجيل بنجاح.
//
// (لاحقًا) نفس الدالة تتحكم أيضًا بظهور حالة "مفعّل" وزر التعطيل —
// enrollBtn و disableBtn دائمًا متبادلان (mutually exclusive): الأول
// يظهر فقط بغياب factor verified، والثاني فقط بوجوده. هذا لا يغيّر أي
// شيء في enforcement (تسجيل الدخول/aal2) ولا في استثناء super_admin
// الموجود أصلًا — فقط يعكس نفس currentMfaState.hasVerifiedFactor في
// عنصرين إضافيين من الواجهة.
function updateMfaEnrollVisibility() {
  const enrollBtn = document.getElementById("mfa-enroll-btn");
  const disableBtn = document.getElementById("mfa-disable-btn");
  const statusEl = document.getElementById("mfa-status-enabled");
  const isSuperAdmin = currentProfile && currentProfile.role === "super_admin";

  if (enrollBtn) enrollBtn.hidden = isSuperAdmin || currentMfaState.hasVerifiedFactor;
  if (disableBtn) disableBtn.hidden = isSuperAdmin || !currentMfaState.hasVerifiedFactor;
  if (statusEl) statusEl.hidden = isSuperAdmin || !currentMfaState.hasVerifiedFactor;
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

// P1-7A: شاشة التحقق بخطوتين — تظهر فقط لحساب غير super_admin لديه
// factor verified ولم يصل بعد لـ aal2 (راجع loadCurrentUserAuthorization).
document.getElementById("mfa-verify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("mfa-verify-code").value.trim();
  const errorEl = document.getElementById("mfa-verify-error");
  errorEl.style.display = "none";

  if (!currentMfaState.factorId) {
    errorEl.textContent = "تعذّر العثور على وسيلة التحقق. حاول تسجيل الدخول مجددًا.";
    errorEl.style.display = "block";
    return;
  }

  const { data: challengeData, error: challengeError } = await supabaseClient.auth.mfa.challenge({
    factorId: currentMfaState.factorId,
  });
  if (challengeError) {
    errorEl.textContent = "تعذّر بدء التحقق الآن. حاول مجددًا.";
    errorEl.style.display = "block";
    return;
  }

  const { error: verifyError } = await supabaseClient.auth.mfa.verify({
    factorId: currentMfaState.factorId,
    challengeId: challengeData.id,
    code,
  });
  if (verifyError) {
    errorEl.textContent = "رمز التحقق غير صحيح.";
    errorEl.style.display = "block";
    return;
  }

  await refreshMfaState();
  if (currentMfaState.currentLevel !== "aal2") {
    errorEl.textContent = "تعذّر إكمال التحقق. حاول مجددًا.";
    errorEl.style.display = "block";
    return;
  }

  await enterDashboardWithLock(currentAuthEmail);
});

document.getElementById("logout-btn").addEventListener("click", async () => {
  await releaseAdminLock();
  await supabaseClient.auth.signOut();
  currentProfile = null;
  currentPermissions = [];
  currentMfaState = { hasVerifiedFactor: false, currentLevel: "aal1", factorId: null };
  currentAuthEmail = null;
  showLogin();
});

// ⚠️ ملاحظة إزالة (جزء من إصلاح F5 — راجع sql/... وتقرير F5 المرفق):
// كان هنا سابقًا معالج "pagehide" يحاول تحرير القفل (best-effort) عند
// أي تفريغ للصفحة — بما في ذلك إعادة التحميل (F5) نفسها، لأن pagehide
// يُطلَق أيضًا عند reload وليس فقط عند إغلاق التبويب فعليًا. كان هذا
// يسبق طلب restoreAdminLock() الجديد بسباق شبكة (race) غير محدد النتيجة:
// أحيانًا يصل طلب التحرير قبل أن تُحمَّل الصفحة الجديدة فتفشل استعادة
// القفل فتُضطر لعمل acquire جديد بتوكن جديد رغم أنها مجرد F5 — ما يخالف
// المطلوب صراحة (F5 يجب ألا يمنح قفلًا جديدًا). أُزيل هذا المعالج كليًا
// كجزء ضروري من إصلاح F5، وليس تحسينًا جانبيًا. لا فقدان ضمان حقيقي هنا:
// التعليق الأصلي على هذا الكود وعلى releaseAdminLock() نفسه كان يوضّح
// أصلًا أن هذه المحاولة "غير مضمونة" وأن الضامن الحقيقي يبقى TTL/heartbeat
// (90 ثانية) — وهذا لم يتغيّر. إغلاق تبويب/متصفح فعلي الآن يتحرر عبر TTL
// خلال ≤90 ثانية كحد أقصى (كما كان دائمًا الضمان الفعلي)، بدل محاولة
// إضافية غير موثوقة أصبحت الآن متعارضة مع استعادة F5.

// -------------------- P1-7A: تسجيل عامل MFA (TOTP) اختياري --------------------
// نقطة دخول اختيارية لغير super_admin فقط (راجع updateMfaEnrollVisibility).
// لا إجبار على enrollment عند تسجيل الدخول في هذه المرحلة.

let mfaEnrollPendingFactorId = null;

function openMfaEnrollOverlay() {
  document.getElementById("mfa-enroll-overlay").hidden = false;
  document.getElementById("mfa-enroll-step-start").hidden = false;
  document.getElementById("mfa-enroll-step-verify").hidden = true;
  document.getElementById("mfa-enroll-step-success").hidden = true;
  document.getElementById("mfa-enroll-error").style.display = "none";
}

async function closeMfaEnrollOverlay() {
  // P1-Final (مشكلة 2): كان الإغلاق/الإلغاء يمسح mfaEnrollPendingFactorId
  // محليًا فقط دون إلغاء تسجيل factor غير المُتحقَّق منه على الخادم — هذا
  // هو السبب الجذري المؤكَّد لتراكم unverified factors متروكة (تحقّقنا
  // حيًا: factor واحد متروك بالضبط لهذا الحساب في auth.mfa_factors).
  // الآن: إن كان هناك factor قيد الانتظار، نُلغي تسجيله فعليًا أولًا حتى
  // لا يتعارض مع أي محاولة تسجيل لاحقة (تعارض friendly_name/الوصول لحد
  // عدد factors المسموح). فشل unenroll هنا (مثلاً بسبب انقطاع شبكة) لا
  // يمنع إغلاق الشاشة — لا نريد حبس المستخدم داخل overlay بسبب هذا التنظيف.
  //
  // ملاحظة (إصلاح لاحق): معالج نجاح mfa-enroll-verify-form يُصفّر
  // mfaEnrollPendingFactorId إلى null فور نجاح challengeAndVerify()، قبل
  // عرض شاشة النجاح — لذلك عند الضغط على "تم" يكون هذا المتغيّر دائمًا
  // null والشرط أدناه لا يتحقق، فلا يُحذف الـfactor الذي أصبح verified.
  // unenroll() هنا يبقى يعمل فقط لتنظيف factor ما زال unverified فعلًا
  // (المستخدم أغلق النافذة أو ضغط إلغاء قبل إكمال التحقق).
  if (mfaEnrollPendingFactorId) {
    try {
      await supabaseClient.auth.mfa.unenroll({ factorId: mfaEnrollPendingFactorId });
    } catch { /* تنظيف بأفضل جهد فقط — لا نمنع الإغلاق بسبب فشله */ }
  }
  document.getElementById("mfa-enroll-overlay").hidden = true;
  document.getElementById("mfa-enroll-qr").innerHTML = "";
  document.getElementById("mfa-enroll-secret").textContent = "";
  document.getElementById("mfa-enroll-code").value = "";
  mfaEnrollPendingFactorId = null;
}

document.getElementById("mfa-enroll-btn").addEventListener("click", () => {
  openMfaEnrollOverlay();
});

document.getElementById("mfa-enroll-overlay").addEventListener("click", async (e) => {
  if (e.target.id === "mfa-enroll-overlay") await closeMfaEnrollOverlay();
});

document.getElementById("mfa-enroll-cancel-btn").addEventListener("click", async () => {
  await closeMfaEnrollOverlay();
});

document.getElementById("mfa-enroll-cancel-btn-2").addEventListener("click", async () => {
  await closeMfaEnrollOverlay();
});

document.getElementById("mfa-enroll-start-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("mfa-enroll-error");
  const startBtn = document.getElementById("mfa-enroll-start-btn");
  errorEl.style.display = "none";

  // حارس ضد النقر المزدوج/السريع: كان النقر مرتين قبل استجابة أول
  // enroll() يُطلق طلبين POST /auth/v1/factors متزامنين — وهذا سبب
  // مؤكَّد شائع لتعارض 422/403 على GoTrue (راجع تقرير الإصلاح). تعطيل
  // الزر فورًا يمنع هذا السباق بالكامل.
  if (startBtn.disabled) return;
  startBtn.disabled = true;

  try {
    // نقرأ حالة الـfactors مباشرة من الخادم في بداية كل محاولة enrollment —
    // وليس من currentMfaState المخزَّن مسبقًا — حتى لا يعتمد القرار على
    // حالة واجهة قديمة (المعالج قد يُستدعى من console أو بعد تحديث لم
    // يصل بعد لعناصر الواجهة).
    const { data: existing } = await supabaseClient.auth.mfa.listFactors();

    // حارس دفاعي: لا تستدعِ enroll() إطلاقًا إذا كان هناك factor TOTP بحالة
    // verified موجود بالفعل (راجع تقرير التحقيق — هذا هو سبب 422 "friendly
    // name already exists": enroll() كان يُستدعى رغم وجود factor verified
    // سليم). لا يُحذف أو يُعدَّل هذا الـfactor بأي شكل هنا — نكتفي بإبلاغ
    // المستخدم وإعادة مزامنة الواجهة. هذا الفحص مستقل عن إخفاء الزر HTML
    // ويعمل حتى لو استُدعي المعالج بأي طريقة أخرى.
    const alreadyVerified = (existing?.totp || []).find((f) => f.status === "verified");
    if (alreadyVerified) {
      errorEl.textContent = "التحقق بخطوتين مفعّل بالفعل لهذا الحساب.";
      errorEl.style.display = "block";
      await refreshMfaState();
      updateMfaEnrollVisibility();
      return;
    }

    // تنظيف استباقي: إن كان هناك factor غير مُتحقَّق منه متروك من محاولة
    // سابقة (قبل هذا الإصلاح، أو بسبب تحديث الصفحة أثناء enrollment سابق)
    // نُلغي تسجيله أولًا — تركه يتعارض مع محاولة enroll() الجديدة (هذا هو
    // السبب الجذري المؤكَّد حيًا لخطأ 422/403: factor واحد غير مُتحقَّق
    // منه وُجد بالفعل متروكًا في auth.mfa_factors لحساب الاختبار). هذا
    // التنظيف يستهدف unverified فقط — لا علاقة له بالحارس أعلاه.
    const staleUnverified = (existing?.totp || []).find((f) => f.status === "unverified");
    if (staleUnverified) {
      await supabaseClient.auth.mfa.unenroll({ factorId: staleUnverified.id });
    }

    const { data, error } = await supabaseClient.auth.mfa.enroll({ factorType: "totp" });
    if (error || !data) {
      errorEl.textContent = "تعذّر بدء تسجيل التحقق بخطوتين الآن."
        + (error?.message ? ` (${error.message})` : "");
      errorEl.style.display = "block";
      return;
    }

    mfaEnrollPendingFactorId = data.id;
    // لا نطبع data.totp.secret في console ولا نخزّنه في أي storage دائم —
    // يُعرض فقط داخل DOM هذه الشاشة، ويُمسح عند إغلاقها (closeMfaEnrollOverlay).
    document.getElementById("mfa-enroll-qr").innerHTML =
      `<img src="${data.totp.qr_code}" alt="QR" width="180" height="180">`;
    document.getElementById("mfa-enroll-secret").textContent = data.totp.secret;

    document.getElementById("mfa-enroll-step-start").hidden = true;
    document.getElementById("mfa-enroll-step-verify").hidden = false;
  } finally {
    startBtn.disabled = false;
  }
});

document.getElementById("mfa-enroll-verify-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("mfa-enroll-error");
  errorEl.style.display = "none";

  // حارس ضد الإرسال المتكرر: نفس نمط الحارس على mfa-enroll-start-btn.
  // بدون هذا، نقر/submit مزدوج قبل استجابة أول challengeAndVerify() يُطلق
  // أكثر من نداء challenge/verify متزامن لنفس الرمز (مؤكَّد حيًا في سجلات
  // GoTrue ضمن تقرير التحقيق). تعطيل زر التأكيد فورًا يمنع هذا السباق.
  const submitBtn = e.target.querySelector('button[type="submit"]');
  if (submitBtn && submitBtn.disabled) return;
  if (submitBtn) submitBtn.disabled = true;

  try {
    const code = document.getElementById("mfa-enroll-code").value.trim();
    if (!mfaEnrollPendingFactorId) {
      errorEl.textContent = "انتهت صلاحية هذه الخطوة. أعد المحاولة.";
      errorEl.style.display = "block";
      return;
    }

    const { error } = await supabaseClient.auth.mfa.challengeAndVerify({
      factorId: mfaEnrollPendingFactorId,
      code,
    });
    if (error) {
      errorEl.textContent = "رمز التحقق غير صحيح.";
      errorEl.style.display = "block";
      return;
    }

    // نجاح: هذا الـfactor أصبح verified الآن على الخادم. نُصفّر
    // mfaEnrollPendingFactorId فورًا وقبل عرض شاشة النجاح، حتى لا يستدعي
    // الضغط على "تم" لاحقًا unenroll() لهذا الـfactor داخل
    // closeMfaEnrollOverlay() (راجع تقرير التحقيق — هذا هو السبب الجذري
    // لاختفاء الـfactor فور نجاح التسجيل).
    mfaEnrollPendingFactorId = null;

    await refreshMfaState();
    updateMfaEnrollVisibility();

    document.getElementById("mfa-enroll-step-verify").hidden = true;
    document.getElementById("mfa-enroll-step-success").hidden = false;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
});

document.getElementById("mfa-enroll-done-btn").addEventListener("click", () => {
  closeMfaEnrollOverlay();
});

// -------------------- تعطيل التحقق بخطوتين (Disable MFA) --------------------
// مسار مستقل تمامًا عن closeMfaEnrollOverlay() أعلاه. الفرق:
//   closeMfaEnrollOverlay()  → تنظيف factor بحالة unverified فقط، يُستدعى
//                              تلقائيًا عند إلغاء/إغلاق نافذة enrollment.
//                              لا يجوز ولا يُستدعى أبدًا على factor verified.
//   disableMfa() (هنا)       → فعل صريح من المستخدم عبر زر مستقل، يعمل
//                              فقط على factor verified، ويشترط أن تكون
//                              الجلسة الحالية aal2 فعلًا قبل أي unenroll.
// هذا هو المسار الوحيد في الكود الذي يجوز له حذف factor verified.
async function disableMfa() {
  const errorEl = document.getElementById("mfa-disable-error");
  errorEl.style.display = "none";

  const confirmed = confirm(
    "تعطيل التحقق بخطوتين سيزيل وسيلة التحقق الحالية ويعيد الحساب لتسجيل الدخول بدون التحقق بخطوتين. هل تريد المتابعة؟"
  );
  if (!confirmed) return; // إلغاء المستخدم — لا شيء يتغيّر، لا أي طلب شبكة.

  // نقرأ الـfactor الحالي من الخادم مباشرة عند التنفيذ (وليس factor ID
  // ثابت أو currentMfaState مخزَّن مسبقًا) — نفس مبدأ حارس enrollment أعلاه.
  const { data: existing, error: listError } = await supabaseClient.auth.mfa.listFactors();
  if (listError) {
    errorEl.textContent = "تعذّر التحقق من حالة التحقق بخطوتين الآن."
      + (listError.message ? ` (${listError.message})` : "");
    errorEl.style.display = "block";
    return;
  }

  const verifiedFactor = (existing?.totp || []).find((f) => f.status === "verified");
  if (!verifiedFactor) {
    // لا يوجد factor verified فعليًا على الخادم رغم ظهور الزر — نُزامن
    // الواجهة فقط، لا حاجة لأي unenroll.
    await refreshMfaState();
    updateMfaEnrollVisibility();
    return;
  }

  // حارس أمان إلزامي: لا unenroll على factor verified إلا من جلسة وصلت
  // فعليًا لـ aal2 (تحقّق كامل بخطوتين لهذه الجلسة نفسها)، وليس فقط لأن
  // الحساب يملك factor verified في القاعدة. هذا يمنع تعطيل MFA اعتمادًا
  // فقط على كلمة المرور دون إتمام الخطوة الثانية لهذه الجلسة.
  const { data: aalData, error: aalError } = await supabaseClient.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aalError || !aalData || aalData.currentLevel !== "aal2") {
    errorEl.textContent = "أكمل التحقق بخطوتين أولًا قبل تعطيله.";
    errorEl.style.display = "block";
    return;
  }

  const { error: unenrollError } = await supabaseClient.auth.mfa.unenroll({ factorId: verifiedFactor.id });
  if (unenrollError) {
    errorEl.textContent = "تعذّر تعطيل التحقق بخطوتين الآن."
      + (unenrollError.message ? ` (${unenrollError.message})` : "");
    errorEl.style.display = "block";
    return;
  }

  // بعد unenroll ناجح على الخادم: نحدّث توكن الجلسة المحلي كي ينعكس
  // مستوى aal الجديد فورًا. فشل هذا لا يمنع اعتبار التعطيل نفسه ناجحًا —
  // الفعل الأساسي (unenroll) تم بالفعل على الخادم.
  try {
    await supabaseClient.auth.refreshSession();
  } catch (e) {
    console.error("تعذّر تحديث الجلسة بعد تعطيل MFA (التعطيل نفسه تم بنجاح):", e);
  }

  await refreshMfaState();
  updateMfaEnrollVisibility();
}

document.getElementById("mfa-disable-btn").addEventListener("click", async () => {
  const btn = document.getElementById("mfa-disable-btn");
  // حارس ضد الإرسال المتكرر/المتزامن — نفس نمط أزرار enrollment أعلاه:
  // يمنع إرسال طلبَي unenroll متزامنين لو ضغط المستخدم مرتين بسرعة.
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await disableMfa();
  } finally {
    btn.disabled = false;
  }
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
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editUniversity('${u.id}')">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('universities','${u.id}', loadUniversities)">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
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

function editUniversity(id) {
  // الأمان: id فقط يصل عبر onclick (UUID، لا يحتاج ترميز ولا يمكنه كسر
  // السياق) — بيانات الجامعة الفعلية (name/short_name/logo_url، وهي نصوص
  // حرة قد يدخلها أي حساب لديه صلاحية "إضافة/تعديل" على أي جامعة) تُقرأ من
  // universitiesById، المصدر الآمن الذي عبّأته loadUniversities() مسبقًا،
  // بدل تمريرها كنص خام داخل onclick حيث كانت عرضة لكسر سياق JavaScript.
  const u = universitiesById[id];
  if (!u) return;
  document.getElementById("uni-edit-id").value = u.id;
  document.getElementById("uni-name").value = u.name;
  document.getElementById("uni-short-name").value = u.short_name || "";
  document.getElementById("uni-logo-url").value = u.logo_url || "";
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
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editFaculty('${f.id}')">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${f.is_active ? "btn-state-off" : "btn-state-on"}" onclick="toggleFacultyActive('${f.id}', ${f.is_active})">${f.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('faculties','${f.id}', loadFaculties)">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
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
    opt.textContent = `سنة ${y.year_number}` + (y.is_active ? "" : " (معطّلة)");
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
    opt.textContent = s.name + (s.is_active ? "" : " (معطّلة)");
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
    .select("id, year_number, university_id, faculty_id, is_active, universities(name), faculties(name)")
    .order("year_number");
  const tbody = document.querySelector("#year-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  yearsById = {};
  (data || []).forEach((y) => { yearsById[y.id] = y; });
  yearsCache = data || [];

  // القوائم المتتالية التي تعتمد على السنوات: قائمة "السنة" في نموذجي المادة والمورد
  populateYearSelectForFaculty("subj-year", currentSelectValue("subj-faculty"), currentSelectValue("subj-year"));
  populateYearSelectForFaculty("res-year", currentSelectValue("res-faculty"), currentSelectValue("res-year"));

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد سنوات بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((y) => {
    const canEdit = hasPerm("academic_structure", y.university_id, y.faculty_id, "edit");
    const canDelete = hasPerm("academic_structure", y.university_id, y.faculty_id, "delete");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الجامعة">${escHtml(y.universities?.name) || "—"}</td>
      <td data-label="الكلية">${escHtml(y.faculties?.name) || "—"}</td>
      <td data-label="السنة">${escHtml(y.year_number)}</td>
      <td data-label="الحالة"><span class="status-badge ${y.is_active ? "published" : "hidden"}">${y.is_active ? "مفعّلة" : "معطَّلة"}</span></td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editYear('${y.id}','${y.university_id}','${y.faculty_id || ""}',${y.year_number},${y.is_active})">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${y.is_active ? "btn-state-off" : "btn-state-on"}" onclick="toggleYearActive('${y.id}', ${y.is_active})">${y.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('years','${y.id}', loadYears)">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
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
    is_active: document.getElementById("year-active").checked,
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

function editYear(id, universityId, facultyId, yearNumber, isActive) {
  document.getElementById("year-edit-id").value = id;
  document.getElementById("year-university").value = universityId;
  populateFacultySelect("year-faculty", universityId, facultyId || null);
  document.getElementById("year-number").value = yearNumber;
  document.getElementById("year-active").checked = !!isActive;
  document.getElementById("year-form-title").textContent = "تعديل سنة دراسية";
  document.getElementById("year-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("year-cancel-btn").hidden = false;
}

function resetYearForm() {
  document.getElementById("year-form").reset();
  document.getElementById("year-edit-id").value = "";
  document.getElementById("year-active").checked = true;
  populateFacultySelect("year-faculty", currentSelectValue("year-university"), null);
  document.getElementById("year-form-title").textContent = "إضافة سنة دراسية";
  document.getElementById("year-submit-btn").textContent = "إضافة";
  document.getElementById("year-cancel-btn").hidden = true;
}
document.getElementById("year-cancel-btn").addEventListener("click", resetYearForm);

async function toggleYearActive(yearId, currentlyActive) {
  const { error } = await supabaseClient.from("years").update({ is_active: !currentlyActive }).eq("id", yearId);
  if (error) { showToast("تعذّر تحديث حالة السنة"); console.error(error); return; }
  logActivity(currentlyActive ? "year_disabled" : "year_enabled", "year", yearId, null);
  showToast(currentlyActive ? "تم تعطيل السنة" : "تم تفعيل السنة");
  loadYears();
}

// ============================================================
// المواد
// ============================================================

async function loadSubjects() {
  const { data, error } = await supabaseClient
    .from("subjects")
    .select("id, name, code, semester, year_id, is_active, years(year_number, university_id, faculty_id, universities(name), faculties(name))")
    .order("name");
  const tbody = document.querySelector("#subj-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="4">تعذّر التحميل</td></tr>`; return; }

  subjectsById = {};
  (data || []).forEach((s) => { subjectsById[s.id] = s; });
  subjectsCache = data || [];

  // القائمة المتتالية التي تعتمد على المواد: قائمة "المادة" في نموذج المورد
  populateSubjectSelectForYear("res-subject", currentSelectValue("res-year"), currentSelectValue("res-subject"));

  if (!data.length) { tbody.innerHTML = `<tr><td colspan="4">لا توجد مواد بعد</td></tr>`; return; }
  tbody.innerHTML = "";
  data.forEach((s) => {
    const uniId = s.years?.university_id;
    const facId = s.years?.faculty_id;
    const canEdit = hasPerm("academic_structure", uniId, facId, "edit");
    const canDelete = hasPerm("academic_structure", uniId, facId, "delete");
    const semesterLabel = s.semester ? (SUBJECT_SEMESTER_LABELS[s.semester] || s.semester) : "غير محدد";
    const location = `${escHtml(s.years?.universities?.name) || "—"} › ${escHtml(s.years?.faculties?.name) || "—"} › سنة ${escHtml(s.years?.year_number ?? "—")} › ${escHtml(semesterLabel)}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="المادة">${escHtml(s.name)}${s.code ? ` (${escHtml(s.code)})` : ""}</td>
      <td data-label="الجامعة / الكلية / السنة">${location}</td>
      <td data-label="الحالة"><span class="status-badge ${s.is_active ? "published" : "hidden"}">${s.is_active ? "مفعّلة" : "معطَّلة"}</span></td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editSubject('${s.id}')">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${s.is_active ? "btn-state-off" : "btn-state-on"}" onclick="toggleSubjectActive('${s.id}', ${s.is_active})">${s.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('subjects','${s.id}', loadSubjects)">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("subj-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("subj-edit-id").value;
  const yearId = document.getElementById("subj-year").value;
  if (!yearId) { showToast("اختر السنة الدراسية أولاً"); return; }
  const semesterValue = document.getElementById("subj-semester").value || null;
  // عند إضافة مادة جديدة (لا id بعد)، الفصل الدراسي إلزامي من الآن فصاعدًا.
  // لا يشمل هذا تعديل مادة قديمة موجودة أصلاً بـ semester = NULL — تعديلها
  // يبقى ممكنًا دون إجبار اختيار فصل، حفاظًا على قرار عدم لمس بيانات قديمة.
  if (!id && !semesterValue) {
    showToast("الرجاء اختيار الفصل الدراسي");
    return;
  }
  const payload = {
    year_id: yearId,
    name: document.getElementById("subj-name").value.trim(),
    code: document.getElementById("subj-code").value.trim() || null,
    semester: semesterValue,
    is_active: document.getElementById("subj-active").checked,
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

function editSubject(id) {
  // نفس مبدأ editUniversity: id فقط (UUID) يصل عبر onclick، وكل الحقول
  // النصية الحرة (name/code/semester) وكل معرّفات السياق (yearId/universityId/
  // facultyId) تُقرأ من subjectsById الآمن بدل تمريرها كنص خام داخل onclick.
  const s = subjectsById[id];
  if (!s) return;
  const yearId = s.year_id;
  const universityId = s.years?.university_id;
  const facultyId = s.years?.faculty_id;
  document.getElementById("subj-edit-id").value = s.id;
  document.getElementById("subj-university").value = universityId || "";
  populateFacultySelect("subj-faculty", universityId, facultyId || null);
  populateYearSelectForFaculty("subj-year", facultyId || null, yearId);
  document.getElementById("subj-name").value = s.name;
  document.getElementById("subj-code").value = s.code || "";
  document.getElementById("subj-semester").value = s.semester || "";
  document.getElementById("subj-active").checked = !!s.is_active;
  document.getElementById("subj-form-title").textContent = "تعديل مادة";
  document.getElementById("subj-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("subj-cancel-btn").hidden = false;
}

function resetSubjForm() {
  document.getElementById("subj-form").reset();
  document.getElementById("subj-edit-id").value = "";
  document.getElementById("subj-active").checked = true;
  populateFacultySelect("subj-faculty", currentSelectValue("subj-university"), null);
  populateYearSelectForFaculty("subj-year", null, null);
  document.getElementById("subj-form-title").textContent = "إضافة مادة";
  document.getElementById("subj-submit-btn").textContent = "إضافة";
  document.getElementById("subj-cancel-btn").hidden = true;
}
document.getElementById("subj-cancel-btn").addEventListener("click", resetSubjForm);

async function toggleSubjectActive(subjectId, currentlyActive) {
  const { error } = await supabaseClient.from("subjects").update({ is_active: !currentlyActive }).eq("id", subjectId);
  if (error) { showToast("تعذّر تحديث حالة المادة"); console.error(error); return; }
  logActivity(currentlyActive ? "subject_disabled" : "subject_enabled", "subject", subjectId, null);
  showToast(currentlyActive ? "تم تعطيل المادة" : "تم تفعيل المادة");
  loadSubjects();
}

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
    .order("created_at", { ascending: false })
    // P1-2: explicit fetch cap for the Admin Dashboard resources query.
    // 1000 matches the project's current Data API "Max rows" default, which was
    // already the implicit ceiling on this query (no .limit()/.range() was set
    // before). Making it explicit avoids relying on an invisible platform
    // setting and the silent, unsignaled truncation that setting causes if
    // exceeded. This does not change current behavior; see phase4_p1_2 notes.
    .limit(1000);
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

  if (!resourcesCache.length) { tbody.innerHTML = `<tr><td colspan="6">لا توجد موارد بعد (أو لا تملك صلاحية عرضها)</td></tr>`; return; }

  const filtered = resourcesCache.filter((r) => {
    const matchesSearch = !searchText ||
      r.title.toLowerCase().includes(searchText) ||
      (r.keywords || "").toLowerCase().includes(searchText);
    const matchesType = !typeFilter || r.type === typeFilter;
    const matchesStatus = !statusFilter || r.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  if (!filtered.length) { tbody.innerHTML = `<tr><td colspan="6">لا توجد نتائج مطابقة للفلاتر الحالية</td></tr>`; return; }

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
      <td data-label="المشاهدات">${escHtml(r.view_count ?? 0)}</td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-sm ${r.status === "hidden" ? "btn-state-on" : "btn-state-off"}" onclick="toggleResourceHidden('${r.id}', ${r.status === "hidden"}, function(){})">${r.status === "hidden" ? "نشر" : "إخفاء"}</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${r.verified ? "btn-state-off" : "btn-state-on"}" onclick="toggleResourceVerified('${r.id}', ${!!r.verified}, loadResources)">${r.verified ? "إلغاء التوثيق" : "توثيق"}</button>` : ""}
          ${canEdit ? `<button class="btn btn-outline btn-sm" onclick="editResource('${r.id}')">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('resources','${r.id}', loadResources)">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
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

// P1-6: يتحقق أن رابط الملف عنوان URL مطلق بمخطّط http/https فقط —
// نفس سياسة المخطّطات المسموحة المطبَّقة فعليًا في safeResourceUrl()
// (js/app.js) عند بناء رابط العرض العام للزوار. الفرق المتعمَّد هنا:
// تلك الدالة تُمرِّر window.location.href كـ base عند الفحص لأنها
// تعرض رابطًا مخزَّنًا سلفًا ويجب ألا تكسر الصفحة إن فشل التحليل،
// بينما هنا نتحقق من رابط جديد يكتبه الأدمن للتو — تمرير base كان
// سيجعل رابطًا ناقصًا مثل "example.com/file.pdf" يُقبل خطأً بعد حلّه
// نسبيًا لعنوان لوحة التحكم نفسها بدل رفضه كما يجب. لا علاقة لهذا
// بـ storage_provider أو source_type: كلاهما بيانات وصفية فقط ولا
// يُغيّران صيغة الرابط المتوقَّعة (تحقّق ذلك في تدقيق P1-6).
function isValidResourceUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

document.getElementById("res-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("res-edit-id").value;
  const subjectId = document.getElementById("res-subject").value;
  if (!subjectId) { showToast("اختر المادة أولاً"); return; }
  const fileUrl = document.getElementById("res-file-url").value.trim();
  if (!fileUrl || !isValidResourceUrl(fileUrl)) {
    showToast("رابط الملف غير صالح — أدخل رابطًا كاملاً يبدأ بـ http:// أو https://");
    return;
  }
  const payload = {
    subject_id: subjectId,
    title: document.getElementById("res-title").value.trim(),
    type: document.getElementById("res-type").value,
    language: document.getElementById("res-language").value,
    file_url: fileUrl,
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
      <div class="row-actions">
        ${r.resources && canToggle ? `<button class="btn btn-sm ${isHidden ? "btn-state-on" : "btn-state-off"}" onclick="toggleResourceHidden('${r.resources.id}', ${isHidden}, loadReports)">${isHidden ? "إظهار المورد" : "إخفاء المورد"}</button>` : ""}
        ${canResolve ? `<button class="btn btn-danger btn-sm" onclick="deleteRow('reports','${r.id}', loadReports)">حذف البلاغ</button>` : ""}
      </div>
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

// P1-5: تبديل سريع لعلامة "موثّق" من صف المورد مباشرة في تبويب الموارد
// بلوحة التحكم، دون فتح نموذج التعديل الكامل. نفس اتفاقية توثيق النشاط
// وإشعارات الخطأ المستخدمة في toggleResourceHidden أعلاه. يمر عبر نفس
// سياسة auth_update_resources (صلاحية resources/edit) — لا حاجة لأي
// سياسة RLS جديدة أو عمود إضافي، تمامًا كحالة verified في نموذج التعديل
// الكامل الحالي.
async function toggleResourceVerified(resourceId, currentlyVerified, refreshFn) {
  const { error } = await supabaseClient
    .from("resources")
    .update({ verified: !currentlyVerified })
    .eq("id", resourceId);
  if (error) { showToast("تعذّر تحديث حالة التوثيق"); console.error(error); return; }
  logActivity(currentlyVerified ? "resource_unverified" : "resource_verified", "resource", resourceId, null);
  showToast(currentlyVerified ? "تم إلغاء توثيق المورد" : "تم توثيق المورد");
  refreshFn();
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
  toggleBtn.className = `btn btn-sm ${profile.active ? "btn-state-off" : "btn-state-on"}`;
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
