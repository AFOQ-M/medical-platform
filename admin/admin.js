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
  // Phase 5 P1 — Courses MVP: أُضيفت هنا فقط (أصغر تغيير ممكن)، بعد
  // التحقق (C-0) أن buildScopeBlock في هذا الملف تشتق أنواع الكيانات
  // من Object.keys(ENTITY_LABELS) بشكل عام — لا حاجة لأي تعديل آخر في
  // واجهة منح الصلاحيات حتى تعمل مع الدورات.
  courses: "الدورات",
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

// Phase 5 P1 — Courses MVP: نفس نمط الكاش أعلاه، لكن الدورات مستقلة
// تمامًا عن الهرم الأكاديمي (لا university_id/faculty_id/year_id).
let coursesCache = [];
let coursesById = {};             // id -> صف الدورة الكامل (لتعبئة نموذج التعديل)
let courseLessonsCache = [];      // آخر دروس مُحمَّلة (لدورة واحدة مختارة في lesson-course-select)
let courseLessonsById = {};

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

  // P1-7A / محدَّث بعد m8 — القرار الحالي المطابق لإنفاذ قاعدة البيانات:
  // - أي حساب (بما فيه super_admin) يملك MFA factor موثّق (verified) ولم
  //   يصل بعد لـ aal2 في الجلسة الحالية: تُعرض شاشة التحقق بخطوتين قبل
  //   الداشبورد. هذا يطابق فعليًا ما تفرضه fn_has_permission()/
  //   fn_is_super_admin() على مستوى القاعدة منذ m8 (لم يعد super_admin
  //   مستثنى من AAL2 هناك)، وقد كان هذا الشرط هنا (!isSuperAdmin) هو آخر
  //   نقطة في الواجهة لا تزال تطبّق الاستثناء القديم قبل m8.
  // - أي حساب بلا factor verified: دخول مباشر (MFA اختياري، لا يُفرض
  //   تلقائيًا) — لم يتغيّر.
  if (currentMfaState.hasVerifiedFactor && currentMfaState.currentLevel !== "aal2") {
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
    courses: hasAnyPerm("courses"),
    reports: hasAnyPerm("reports"),
    forum: hasAnyPerm("reports"),
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
  // (عبر switchAdminTab لتبقى الحالة البصرية = aria-selected = tabindex = إظهار اللوحة)
  const activeBtn = document.querySelector(".admin-tab-btn.active");
  if ((!activeBtn || activeBtn.hidden) && firstVisible) {
    switchAdminTab(firstVisible.dataset.tab);
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
let mfaEnrollTriggerEl = null; // A11Y-03: عنصر التركيز قبل فتح النافذة، ليُستعاد التركيز إليه عند الإغلاق

function openMfaEnrollOverlay() {
  if (document.activeElement && document.activeElement.id !== "mfa-enroll-overlay") {
    mfaEnrollTriggerEl = document.activeElement;
  }
  document.getElementById("mfa-enroll-overlay").hidden = false;
  document.getElementById("mfa-enroll-step-start").hidden = false;
  document.getElementById("mfa-enroll-step-verify").hidden = true;
  document.getElementById("mfa-enroll-step-success").hidden = true;
  document.getElementById("mfa-enroll-error").style.display = "none";
  // A11Y-03: انقل التركيز داخل النافذة إلى أول عنصر تفاعلي ظاهر (تأكيديًا زر البدء)
  const firstControl = document.querySelector('#mfa-enroll-overlay [autofocus], #mfa-enroll-overlay button:not([hidden])');
  if (firstControl && typeof firstControl.focus === "function") firstControl.focus();
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
  // A11Y-03: استعادة التركيز إلى العنصر الذي فتح النافذة (إن كان ما يزال ظاهرًا)
  if (mfaEnrollTriggerEl && typeof mfaEnrollTriggerEl.focus === "function" && !mfaEnrollTriggerEl.hidden) {
    mfaEnrollTriggerEl.focus();
  }
  mfaEnrollTriggerEl = null;
}

document.getElementById("mfa-enroll-btn").addEventListener("click", () => {
  openMfaEnrollOverlay();
});

document.getElementById("mfa-enroll-overlay").addEventListener("click", async (e) => {
  if (e.target.id === "mfa-enroll-overlay") await closeMfaEnrollOverlay();
});

// A11Y-03: إغلاق النافذة بمفتاح Escape مع إعادة التركيز لنفس مسار الإغلاق العادي
// (مُرفق على الـoverlay نفسه — التركيز يكون داخلها أثناء فتحها بفضل إدارة
// التركيز في openMfaEnrollOverlay، كما تتحقق الاستعادة في closeMfaEnrollOverlay)
document.getElementById("mfa-enroll-overlay").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    closeMfaEnrollOverlay();
  }
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

  // NEW-02: بديل window.confirm — نافذة تأكيد داخل الصفحة؛ علىConfirm يُنفَّذ
  // فقط عند قبول المستخدم (زر "تأكيد الحذف")، والإلغاء/الخلفية/Escape = لا شيء.
  showDestructiveConfirm({
    title: "تعطيل التحقق بخطوتين",
    message: "تعطيل التحقق بخطوتين سيزيل وسيلة التحقق الحالية ويعيد الحساب لتسجيل الدخول بدون التحقق بخطوتين. هل تريد المتابعة؟",
    onConfirm: () => performDisableMfa(),
  });
}

async function performDisableMfa() {
  const errorEl = document.getElementById("mfa-disable-error");

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
// UX-01 + A11Y-01: التنقّل عبر التبويبات من لوحة المفاتيح بنموذج التفعيل
// اليدوي (Manual Activation): الأسهم (وHome/End) تنقّل التركيز فقط عبر
// roving tabindex دون فتح اللوحة، والتبديل الفعلي يحدث بالنقر أو Enter/Space
// على التبويب المُرَكَّز عليه. الحالة الاتساقية بين التمييز البصري (class active)
// و aria-selected و tabindex وإظهار اللوحة تُدار عبر دالة مركزية واحدة.
// اتجاه الأسهم يتبع "الترتيب المنطقي" لاتجاه القراءة: في واجهة RTL هذه
// (read from right to left على بنية flex الناتجة) السهم لليسار هو "التالي"
// والسهم لليمين هو "السابق" — وليس مجرد عكس أزرار.

let currentAdminTab = "dashboard";

function getVisibleTabBtns() {
  return Array.from(document.querySelectorAll(".admin-tab-btn")).filter((b) => !b.hidden);
}

function switchAdminTab(tabName) {
  const btn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  if (!btn || btn.hidden) return false;
  currentAdminTab = tabName;
  document.querySelectorAll(".admin-tab-btn").forEach((b) => {
    const isActive = b.dataset.tab === tabName;
    b.classList.toggle("active", isActive);
    b.setAttribute("aria-selected", isActive ? "true" : "false");
    b.tabIndex = isActive ? 0 : -1;
  });
  document.querySelectorAll(".admin-panel").forEach((p) => p.classList.remove("active"));
  const panel = document.getElementById(`panel-${tabName}`);
  if (panel) panel.classList.add("active");
  return true;
}

// Manual Activation: تحريك التركيز بين التبويبات لا يغيّر aria-selected ولا
// tabindex (يبقى 0 على التبويب المحدد فعليًا) ولا يفتح اللوحة — فقط ينقل
// التركيز إلى التبويب التالي (focus() يعمل على tabindex=-1 أيضًا).
function moveTabFocus(btn) {
  btn.focus();
}

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.hidden) return;
    const switched = switchAdminTab(btn.dataset.tab);
    if (switched) {
      // نعيد سلوك التحديث عند النقر على اللوحتَين الحييتَين (كما كان أصلًا)
      if (btn.dataset.tab === "dashboard") loadDashboard();
      if (btn.dataset.tab === "users") loadUsersPanel();
    }
  });
  btn.addEventListener("keydown", (e) => {
    if (btn.hidden) return;
    const tabs = getVisibleTabBtns();
    const idx = tabs.indexOf(btn);
    if (idx === -1) return;
    const rtl = (getComputedStyle(document.body).direction || "ltr") === "rtl";
    let nextIdx = null;
    if (e.key === "ArrowRight") nextIdx = rtl ? idx - 1 : idx + 1;
    else if (e.key === "ArrowLeft") nextIdx = rtl ? idx + 1 : idx - 1;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = tabs.length - 1;
    if (nextIdx === null) return; // Enter / Space: التفعيل عبر النقر الأصلي على الزر
    e.preventDefault();
    moveTabFocus(tabs[(nextIdx + tabs.length) % tabs.length]);
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
  await loadCourses();
  loadReports();
  if (currentProfile.role === "super_admin") loadUsersPanel();
}

// ============================================================
// لوحة المعلومات
// ============================================================

async function loadDashboard() {
  const grid = document.getElementById("dashboard-stats");
  if (grid && typeof grid.setAttribute === "function") {
    // A11Y-04: aria-busy أثناء التحميل — قارئات الشاشة تحجم الإعلانات حتى نزع
    // الخاصية، فتُعلن البطاقات النهائية مرة واحدة بدل "جارٍ التحميل..." ثم
    // الإحصائيات (ولا تكرار بلا داعٍ).
    grid.setAttribute("aria-busy", "true");
  }
  grid.innerHTML = `<div class="state-msg">جارٍ التحميل...</div>`;

  // F-06: عدّ كل جدول بمعالجة أخطاء معزولة — فشل أي استعلام يُسجَّل
  // للمطوّر فقط (console.error) ويُظهر "—" في بطاقته، ولا يُسقط بقية
  // البطاقات. شكل العرض الحالي ("—" عند الفشل) لم يتغيّر.
  const countQuery = async (table) => {
    try {
      const { count, error } = await supabaseClient.from(table).select("*", { count: "exact", head: true });
      if (error) { console.error(`loadDashboard: تعذّر عدّ ${table}`, error); return null; }
      return count;
    } catch (err) {
      console.error(`loadDashboard: تعذّر عدّ ${table}`, err);
      return null;
    }
  };

  // F-01: استعلام count إضافي لـ forum_reports (بلاغات المنتدى) بنفس نمط
  // الاستعلامات الأخرى. القراءة مسموحة عبر RLS الموجودة فعلًا
  // (admin_read_all_forum_reports في phase7_forum_admin_moderation.sql:
  // fn_is_super_admin() OR fn_has_permission('reports', null, 'view')) —
  // لمن لا يملك الصلاحية تُعيد RLS صفرًا وليس خطأً، فلا حاجة لأي RLS جديدة.
  const [uni, fac, yrs, subj, res, courses, rep, forumRep, admins] = await Promise.all([
    countQuery("universities"),
    countQuery("faculties"),
    countQuery("years"),
    countQuery("subjects"),
    countQuery("resources"),
    countQuery("courses"),
    countQuery("reports"),
    countQuery("forum_reports"),
    currentProfile.role === "super_admin" ? countQuery("profiles") : Promise.resolve(null),
  ]);

  const stats = [
    ["الجامعات", uni], ["الكليات", fac], ["السنوات", yrs], ["المواد", subj],
    ["الموارد", res], ["الدورات", courses], ["البلاغات", rep], ["بلاغات المنتدى", forumRep],
  ];
  if (currentProfile.role === "super_admin") stats.push(["الإداريون", admins]);

  if (grid && typeof grid.removeAttribute === "function") grid.removeAttribute("aria-busy");
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

  // إجراء عاجل: بلاغات معلّقة (منتدى) وآخر بلاغات (موارد) — من المصادر الحالية فقط
  loadUrgentQueue();
}

// ============================================================
// إجراء عاجل — G-12: بلاغات معلّقة وآخر بلاغات الموارد على الداشبورد
// من المصادر الحالية فقط (forum_reports + reports)، لا backend جديد.
// G-19: `.admin-action-row.pending` يستخدم var(--warning) لحالة
// البلاغ المعلّق فعليًا (forum_reports.status = 'pending').
// ============================================================

async function loadUrgentQueue() {
  const queueEl = document.getElementById("urgent-queue");
  queueEl.innerHTML = "";

  // G-12 Permission gating: لا نعرض أي بيانات reports إذا لم تكن الصلاحية متوفرة.
  // لا نعتمد على إخفاء CSS — البيانات لا تُجلب أبدًا.
  if (!hasAnyPerm("reports")) {
    queueEl.innerHTML = `<li class="state-msg">ليس لديك صلاحية عرض التقارير.</li>`;
    return;
  }

  queueEl.innerHTML = `<li class="state-msg">جارٍ التحميل...</li>`;

  const FORUM_REASON_LABELS = {
    offensive: "ألفاظ بذيئة أو إساءة", harassment: "تنمر أو مضايقة",
    inappropriate: "محتوى غير مناسب", misinformation: "معلومات مضللة أو مزعجة", other: "أخرى",
  };
  const REPORT_REASON_LABELS = {
    broken_link: "الرابط لا يعمل", wrong_file: "ملف غير صحيح", copyright: "حقوق نشر", other: "أخرى",
  };

  // استعلامان مستقلان لا يُسقطان بعضهما (F-06 pattern): بلاغات منتدى معلّقة + بلاغات موارد
  const forumPromise = supabaseClient
    .from("forum_reports")
    .select("id, reason, details, status, created_at, topic_id, reply_id, forum_topics(id, title, author_name, is_hidden), forum_replies(id, content, author_name, is_hidden, topic_id)")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(5);

  const reportsPromise = supabaseClient
    .from("reports")
    .select("id, reason, note, created_at, resource_id, resources(id, title, status, subjects(years(university_id, faculty_id)))")
    .order("created_at", { ascending: false })
    .limit(5);

  const [forumResult, reportsResult] = await Promise.allSettled([forumPromise, reportsPromise]);

  let pendingForumReports = [];
  let recentReports = [];

  if (forumResult.status === "fulfilled" && !forumResult.value.error) {
    pendingForumReports = forumResult.value.data || [];
  } else {
    console.error("loadUrgentQueue: تعذّر تحميل بلاغات المنتدى", forumResult.reason || forumResult.value?.error);
  }

  if (reportsResult.status === "fulfilled" && !reportsResult.value.error) {
    recentReports = reportsResult.value.data || [];
  } else {
    console.error("loadUrgentQueue: تعذّر تحميل بلاغات الموارد", reportsResult.reason || reportsResult.value?.error);
  }

  const queue = [];

  pendingForumReports.forEach((r) => {
    const isTopic = !!r.topic_id;
    const target = isTopic ? r.forum_topics : r.forum_replies;
    const targetLabel = isTopic ? "موضوع" : "رد";
    const targetText = isTopic ? (target?.title || "(موضوع محذوف)") : (target?.content || "(رد محذوف)");
    queue.push({
      date: r.created_at,
      isPending: true,
      type: `بلاغ منتدى — ${targetLabel}`,
      title: targetText.length > 60 ? targetText.slice(0, 60) + "…" : targetText,
      reason: FORUM_REASON_LABELS[r.reason] || r.reason,
      tab: "reports",
    });
  });

  recentReports.forEach((r) => {
    queue.push({
      date: r.created_at,
      isPending: false,
      type: "بلاغ مورد",
      title: r.resources?.title || "(مورد محذوف)",
      reason: REPORT_REASON_LABELS[r.reason] || r.reason,
      tab: "reports",
    });
  });

  // ترتيب مشترك حسب التاريخ (الأحدث أولًا)
  queue.sort((a, b) => new Date(b.date) - new Date(a.date));

  const visibleItems = queue.slice(0, 8);
  queueEl.innerHTML = "";

  if (!visibleItems.length) {
    queueEl.innerHTML = `<li class="state-msg">لا توجد إجراءات عاجلة حاليًا.</li>`;
    return;
  }

  visibleItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "admin-action-row" + (item.isPending ? " pending" : "");

    const typeSpan = document.createElement("span");
    typeSpan.className = "queue-type";
    typeSpan.textContent = item.type;

    const reasonSpan = document.createElement("span");
    reasonSpan.className = "queue-reason";
    reasonSpan.textContent = item.reason;

    const titleSpan = document.createElement("span");
    titleSpan.className = "queue-title";
    titleSpan.textContent = item.title;

    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "btn btn-outline btn-sm";
    actionBtn.textContent = "عرض التفاصيل";
    actionBtn.addEventListener("click", () => switchAdminTab(item.tab));

    if (item.isPending) {
      const statusChip = document.createElement("span");
      statusChip.className = "queue-status-chip";
      statusChip.textContent = "قيد المراجعة";
      li.append(typeSpan, statusChip, reasonSpan, titleSpan, actionBtn);
    } else {
      li.append(typeSpan, reasonSpan, titleSpan, actionBtn);
    }
    queueEl.appendChild(li);
  });

  if (queue.length > visibleItems.length) {
    const moreLi = document.createElement("li");
    moreLi.className = "admin-action-row queue-more";
    const moreBtn = document.createElement("button");
    moreBtn.type = "button";
    moreBtn.className = "btn btn-sm btn-outline";
    moreBtn.textContent = "عرض جميع التقارير";
    moreBtn.addEventListener("click", () => switchAdminTab("reports"));
    moreLi.appendChild(moreBtn);
    queueEl.appendChild(moreLi);
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
  const uniFormToggle = document.getElementById("uni-form-toggle");
  if (uniFormToggle) uniFormToggle.hidden = !hasPerm("academic_structure", null, null, "create");

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
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="universities" data-id="${u.id}">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="universities" data-id="${u.id}">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

// UX-02: وضع إرسال آمن على نماذج الإضافة/التعديل — حارس ضد الإرسال المزدوج
// (double submit) مع إظهار حالة تحميل واضحة على زر الإرسال ("جارٍ الحفظ...").
// يغنّف معالج الحفظ الحالي فقط (يُستدعى قبله) ولا يغيّر أي منطق حفظ/تحقق/payload.
async function runFormMutation(form, handler) {
  const btn = form.querySelector('button[type="submit"]');
  if (btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    if (!btn.dataset.loadingText) btn.dataset.loadingText = btn.textContent;
    btn.textContent = "جارٍ الحفظ...";
  }
  try {
    await handler();
  } finally {
    if (btn) {
      btn.disabled = false;
      // لا نستعيد النص إن غيّره resetForm إلى نصه الصحيح بعد النجاح
      if (btn.textContent === "جارٍ الحفظ...") btn.textContent = btn.dataset.loadingText;
      delete btn.dataset.loadingText;
    }
  }
}

document.getElementById("uni-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFormMutation(e.currentTarget, async () => {
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
});

// F-08: عند التعديل، اطوِ النموذج open ودخوله للعرض — النماذج أصبحت مطوية
// افتراضيًا داخل <details class="admin-form-toggle"> لتفادي ظهورها مفتوحة
// دائمًا فوق الجدول على الشاشات الضيقة.
// G-14: عمليات سحب النماذج الطويلة (Drawer) — تُستخدم للنموذجين الطويلين
// (المورد والدورة). كل منطقها داخل admin.js لتعمل داخل sandbox الاختبارات
// الذي يسترجع admin.js وحده دون app.js. النماذج البسيطة (جامعة/كلية/سنة/
// مادة/درس) بقيت داخل <details class="admin-form-toggle">.
function getAdminDrawer(id) {
  return document.getElementById(id);
}

function adminDrawerFocusables(drawerId) {
  const overlay = getAdminDrawer(drawerId);
  if (!overlay || typeof overlay.querySelectorAll !== "function") return [];
  return Array.from(overlay.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el && typeof el.getAttribute === "function" ? el.getAttribute("type") !== "hidden" : true);
}

function trapAdminDrawerFocus(drawerId, event) {
  const focusables = adminDrawerFocusables(drawerId);
  if (focusables.length < 1) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = typeof document.activeElement === "object" && document.activeElement ? document.activeElement : null;
  if (event.shiftKey) {
    if (!active || active === first || active === document.body) {
      event.preventDefault();
      if (typeof last.focus === "function") last.focus();
    }
  } else if (!active || active === last) {
    event.preventDefault();
    if (typeof first.focus === "function") first.focus();
  }
}

function keydownAdminDrawer(event) {
  const overlay = event.currentTarget;
  if (!overlay || !overlay.dataset) return;
  const drawerId = overlay.dataset.drawerId || overlay.id;
  if (event.key === "Escape") {
    event.preventDefault();
    closeAdminDrawer(drawerId);
  } else if (event.key === "Tab") {
    trapAdminDrawerFocus(drawerId, event);
  }
}

function openAdminDrawer(drawerId) {
  const overlay = getAdminDrawer(drawerId);
  if (!overlay || typeof overlay.addEventListener !== "function") return;
  const drawer = overlay.querySelector("aside.admin-drawer");
  overlay.setAttribute("aria-hidden", "false");
  if (typeof overlay.classList === "object" && overlay.classList) overlay.classList.add("open");
  overlay.hidden = false;
  overlay.open = true;
  if (overlay.dataset) overlay.dataset.drawerId = drawerId;
  overlay.addEventListener("keydown", keydownAdminDrawer);
  const focusTarget = drawer && typeof drawer.querySelector === "function"
    ? drawer.querySelector("button, input, select, textarea, a[href]")
    : null;
  if (focusTarget && typeof focusTarget.focus === "function") focusTarget.focus();
}

function closeAdminDrawer(drawerId) {
  const overlay = getAdminDrawer(drawerId);
  if (!overlay) return;
  if (overlay.classList && typeof overlay.classList.remove === "function") overlay.classList.remove("open");
  overlay.hidden = true;
  overlay.open = false;
  if (overlay.dataset) overlay.dataset.drawerId = "";
  const trigger = document.querySelector('[data-drawer-open="' + drawerId + '"]');
  if (trigger && typeof trigger.focus === "function") trigger.focus();
}

function openAdminAddForm(detailsId) {
  const el = document.getElementById(detailsId);
  if (!el) return;
  // G-14: إذا كان المحفّز يستهدف نافذة منزلقة، افتح الـ drawer بدل details.
  if (el.dataset && el.dataset.drawerOpen) {
    openAdminDrawer(el.dataset.drawerOpen);
    return;
  }
  el.open = true;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// G-14: ربط محفّزات فتح النماذج الطويلة وأزرار/خلفية الإغلاق ونماذجها.
// آمن ضمن sandbox الاختبارات لأن querySelectorAll تعود [] افتراضيًا.
(function wireAdminDrawers() {
  document.querySelectorAll("[data-drawer-open]").forEach((trigger) => {
    if (typeof trigger.addEventListener !== "function") return;
    trigger.addEventListener("click", () => {
      if (!trigger.dataset) return;
      openAdminDrawer(trigger.dataset.drawerOpen);
    });
  });
  document.querySelectorAll("[data-drawer-close]").forEach((closer) => {
    if (typeof closer.addEventListener !== "function") return;
    closer.addEventListener("click", () => {
      if (!closer.dataset) return;
      closeAdminDrawer(closer.dataset.drawerClose);
    });
  });
})();


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
  openAdminAddForm("uni-form-toggle");
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
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="faculties" data-id="${f.id}">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${f.is_active ? "btn-state-off" : "btn-state-on"}" data-action="toggle-active" data-table="faculties" data-id="${f.id}" data-active="${f.is_active}">${f.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="faculties" data-id="${f.id}">حذف</button>` : ""}
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
  const formToggle = document.getElementById("fac-form-toggle");
  if (!allowed.length) {
    form.style.display = "none";
    if (formToggle) formToggle.hidden = true;
    return;
  }
  form.style.display = "";
  if (formToggle) formToggle.hidden = false;
  populateSelect("fac-university", allowed, (u) => u.name);
}

document.getElementById("fac-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFormMutation(e.currentTarget, async () => {
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
  openAdminAddForm("fac-form-toggle");
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
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="years" data-id="${y.id}" data-university-id="${y.university_id}" data-faculty-id="${y.faculty_id || ""}" data-year-number="${y.year_number}" data-active="${y.is_active}">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${y.is_active ? "btn-state-off" : "btn-state-on"}" data-action="toggle-active" data-table="years" data-id="${y.id}" data-active="${y.is_active}">${y.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="years" data-id="${y.id}">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("year-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFormMutation(e.currentTarget, async () => {
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
  openAdminAddForm("year-form-toggle");
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

// NEW-06: بديل السقف الصامت عند الجلب الكبير — جلب كامل عبر range() بدفعات
// (100 صف) حتى يتوقف أو يكتمل، دون أي UI ترقيم جديد. الفلاتر (بحث/نوع/حالة)
// تبقى محلية على cache المجمَّعة. كل استدعاء يبني استعلام select/order نفسه
// مع range(fromRow, toRow) — الترتيب يبقى محفوظًا عبر الضم المتسلسل.
const ADMIN_TABLE_CHUNK_SIZE = 100;
async function loadAdminTableChunked(buildQuery) {
  let all = [];
  let firstError = null;
  let offset = 0;
  for (;;) {
    const { data, error } = await buildQuery(offset, offset + ADMIN_TABLE_CHUNK_SIZE - 1);
    if (error) { firstError = error; break; }
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < ADMIN_TABLE_CHUNK_SIZE) break;
    offset += ADMIN_TABLE_CHUNK_SIZE;
  }
  return { data: all, error: firstError };
}

async function loadSubjects() {
  const { data, error } = await loadAdminTableChunked((fromRow, toRow) =>
    supabaseClient
      .from("subjects")
      .select("id, name, code, semester, year_id, is_active, years(year_number, university_id, faculty_id, universities(name), faculties(name))")
      .order("name")
      .range(fromRow, toRow)
  );
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
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="subjects" data-id="${s.id}">تعديل</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${s.is_active ? "btn-state-off" : "btn-state-on"}" data-action="toggle-active" data-table="subjects" data-id="${s.id}" data-active="${s.is_active}">${s.is_active ? "تعطيل" : "تفعيل"}</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="subjects" data-id="${s.id}">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("subj-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFormMutation(e.currentTarget, async () => {
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
  openAdminAddForm("subj-form-toggle");
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
  const { data, error } = await loadAdminTableChunked((fromRow, toRow) =>
    supabaseClient
      .from("resources")
      .select(`
      id, title, type, language, file_url, storage_provider, source_type, status, keywords, subject_id, verified, view_count,
      subjects(
        id, name, year_id,
        years(id, university_id, faculty_id, year_number, universities(name), faculties(name))
      )
    `)
      .order("created_at", { ascending: false })
      .range(fromRow, toRow)
  );
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
      <td data-label="العنوان">${escHtml(r.title)}${r.verified ? ' <span class="tag tag-verified" style="padding:2px 8px; font-size:.7rem;"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-inline-end:3px" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>موثّق</span>' : ""}</td>
      <td data-label="الموقع الأكاديمي">${location}</td>
      <td data-label="النوع">${escHtml(RESOURCE_TYPE_LABELS_ADMIN[r.type] || r.type)}</td>
      <td data-label="الحالة"><span class="status-badge ${statusClass}">${r.status === "published" ? "منشور" : r.status === "hidden" ? "مخفي" : "مُبلَّغ عنه"}</span></td>
      <td data-label="المشاهدات">${escHtml(r.view_count ?? 0)}</td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-sm ${r.status === "hidden" ? "btn-state-on" : "btn-state-off"}" data-action="toggle-resource-hidden" data-table="resources" data-id="${r.id}" data-hidden="${r.status === "hidden"}">${r.status === "hidden" ? "نشر" : "إخفاء"}</button>` : ""}
          ${canEdit ? `<button class="btn btn-sm ${r.verified ? "btn-state-off" : "btn-state-on"}" data-action="toggle-resource-verified" data-table="resources" data-id="${r.id}" data-verified="${!!r.verified}">${r.verified ? "إلغاء التوثيق" : "توثيق"}</button>` : ""}
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="resources" data-id="${r.id}">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="resources" data-id="${r.id}">حذف</button>` : ""}
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

// نسخة مطابقة لمنطق js/app.js (resolveResourceUrl) — الملفان سكربتان
// مستقلان بلا أي تجميع/استيراد مشترك في هذا المشروع، فالتكرار هنا
// أقل تدخلًا من إنشاء ملف utils.js جديد يُحمَّل في كل صفحات HTML.
// الاستخدام هنا مختلف عن app.js: هذا التحقق وقت الحفظ في نموذج
// الأدمن (رفض رابط غير صالح قبل التخزين)، بينما app.js يستخدم نفس
// الاستخراج وقت العرض العام لبناء رابط التحميل المباشر. file_url
// المخزَّن يبقى رابط المشاركة الأصلي كما ألصقه الأدمن دون أي تعديل.
function parseGoogleDriveUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { isFolder: false, fileId: null };
  }
  if (parsed.hostname !== "drive.google.com") {
    return { isFolder: false, fileId: null };
  }
  if (parsed.pathname.startsWith("/drive/folders/")) {
    return { isFolder: true, fileId: null };
  }
  const fileMatch = parsed.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch) {
    return { isFolder: false, fileId: fileMatch[1] };
  }
  const idParam = parsed.searchParams.get("id");
  if (idParam && /^[a-zA-Z0-9_-]+$/.test(idParam)) {
    return { isFolder: false, fileId: idParam };
  }
  return { isFolder: false, fileId: null };
}

// NEW-03 — التحقق الخفيف من حقول النماذج (client-side فقط؛ لا شبكة عند الخطأ).
// الحفظ الفعلي الحالي عند البيانات الصحيحة يبقى كما هو بلا أي اعتراض.
function isAcceptableResourceFormUrl(raw) {
  if (isValidResourceUrl(raw)) return true;
  return /^\/[^\s]*$/.test(raw || "");
}
function setNewFieldError(inputEl, message) {
  if (!inputEl || typeof inputEl.id !== "string") return;
  const errId = inputEl.id + "-error";
  let errEl = document.getElementById(errId);
  if (message) {
    if (!errEl && typeof document.createElement === "function") {
      errEl = document.createElement("small");
      errEl.id = errId;
      errEl.className = "field-error";
      const parent = (typeof inputEl.closest === "function" && inputEl.closest(".field"))
        || inputEl.parentElement || null;
      if (parent && typeof parent.appendChild === "function") parent.appendChild(errEl);
    }
  }
  if (errEl) { errEl.textContent = message || ""; errEl.hidden = !message; }
  if (typeof inputEl.setCustomValidity === "function") inputEl.setCustomValidity(message || "");
  if (typeof inputEl.setAttribute === "function") {
    if (message) { inputEl.setAttribute("aria-invalid", "true"); inputEl.setAttribute("aria-describedby", errId); }
    else if (typeof inputEl.removeAttribute === "function") { inputEl.removeAttribute("aria-invalid"); inputEl.removeAttribute("aria-describedby"); }
  }
}
function validateResourceForm() {
  const title = document.getElementById("res-title");
  const titleOk = Boolean(title && String(title.value || "").trim().length > 0);
  setNewFieldError(title, titleOk ? "" : "أدخل عنوان المورد");
  const srcTypeEl = document.getElementById("res-source-type");
  const sourceType = srcTypeEl ? String(srcTypeEl.value || "") : "";
  const fileUrlEl = document.getElementById("res-file-url");
  const rawUrlVal = fileUrlEl ? String(fileUrlEl.value || "").trim() : "";
  const urlOk = sourceType === "link" || (rawUrlVal.length > 0 && isAcceptableResourceFormUrl(rawUrlVal));
  setNewFieldError(fileUrlEl, urlOk ? "" : "أدخل رابط الملف (http(s):// أو مسار نسبي يبدأ بـ /)");
  return titleOk && urlOk;
}
function validateCourseForm() {
  const title = document.getElementById("course-title");
  const titleOk = Boolean(title && String(title.value || "").trim().length > 0);
  setNewFieldError(title, titleOk ? "" : "أدخل عنوان الدورة");
  return titleOk;
}
["res-title", "res-file-url"].forEach((id) => {
  const el = document.getElementById(id);
  if (el && typeof el.addEventListener === "function") {
    el.addEventListener("blur", validateResourceForm);
    el.addEventListener("input", validateResourceForm);
  }
});
const resSrcSel = document.getElementById("res-source-type");
if (resSrcSel && typeof resSrcSel.addEventListener === "function") {
  resSrcSel.addEventListener("change", validateResourceForm);
}
const courseTitleEl = document.getElementById("course-title");
if (courseTitleEl && typeof courseTitleEl.addEventListener === "function") {
  courseTitleEl.addEventListener("blur", validateCourseForm);
  courseTitleEl.addEventListener("input", validateCourseForm);
}

document.getElementById("res-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validateResourceForm()) return; // NEW-03: يُمنع الإرسال عند خطأ ولا يُرسل شبكة
  runFormMutation(e.currentTarget, async () => {
  const id = document.getElementById("res-edit-id").value;
  const subjectId = document.getElementById("res-subject").value;
  if (!subjectId) { showToast("اختر المادة أولاً"); return; }
  const fileUrl = document.getElementById("res-file-url").value.trim();
  if (!fileUrl || !isValidResourceUrl(fileUrl)) {
    showToast("رابط الملف غير صالح — أدخل رابطًا كاملاً يبدأ بـ http:// أو https://");
    return;
  }
  const storageProvider = document.getElementById("res-storage-provider").value;
  if (storageProvider === "google_drive") {
    const gdrive = parseGoogleDriveUrl(fileUrl);
    if (gdrive.isFolder) {
      showToast("هذا رابط مجلد Google Drive وليس ملفًا — الصق رابط الملف نفسه، لا رابط المجلد");
      return;
    }
    if (!gdrive.fileId) {
      showToast("تعذّر التعرّف على معرّف الملف من رابط Google Drive — تأكد من نسخ رابط مشاركة الملف كاملاً");
      return;
    }
  }
  const payload = {
    subject_id: subjectId,
    title: document.getElementById("res-title").value.trim(),
    type: document.getElementById("res-type").value,
    language: document.getElementById("res-language").value,
    file_url: fileUrl,
    storage_provider: storageProvider,
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
  closeAdminDrawer("res-form-drawer");
   loadResources();
  });
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
  openAdminAddForm("res-form-toggle");
}

function resetResForm() {
  closeAdminDrawer("res-form-drawer");
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
// التقارير — قائمة موحّدة (G-13 / Z.17)
// ============================================================
// تجمع هذه الشاشة بلاغات الموارد (reports) وبلاغات المنتدى
// (forum_reports) في Queue واحدة لوساطة موحَّدة. لا تتغير أي دلالة
// عمل (workflow) — نفس الإجراءات، نفس الجداول، نفس الصلاحيات — فقط
// العرض/القائمة أصبح واحدًا على تبويب واحد.

const FORUM_REPORT_REASON_LABELS_ADMIN = {
  offensive: "ألفاظ بذيئة أو إساءة",
  harassment: "تنمر أو مضايقة",
  inappropriate: "محتوى غير مناسب",
  misinformation: "معلومات مضللة أو مزعجة",
  other: "أخرى",
};
const FORUM_REPORT_STATUS_LABELS_ADMIN = { pending: "قيد المراجعة", reviewed: "تمت المراجعة", dismissed: "مرفوض" };

async function loadReports() {
  const tbody = document.querySelector("#reports-table tbody");
  const updateBadge = (count) => {
    const badge = document.getElementById("reports-tab-badge");
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.hidden = false; }
    else { badge.textContent = ""; badge.hidden = true; }
  };

  tbody.innerHTML = `<tr><td colspan="7">جارٍ التحميل...</td></tr>`;

  // استعلامان مستقلان لا يُسقط أحدهما الآخر (F-06 pattern) — فشل أي
  // استعلام يُسجَّل للمطوِّر فقط ولا يمنع عرض المحتوى الآخر.
  const [reportsResult, forumResult] = await Promise.allSettled([
    supabaseClient
      .from("reports")
      .select("id, reason, note, created_at, resource_id, resources(id, title, status, subjects(years(university_id, faculty_id)))")
      .order("created_at", { ascending: false }),
    supabaseClient
      .from("forum_reports")
      .select(`
        id, reason, details, status, created_at,
        topic_id, reply_id,
        forum_topics(id, title, author_name, is_hidden),
        forum_replies(id, content, author_name, is_hidden, topic_id)
      `)
      .order("created_at", { ascending: false }),
  ]);

  const resourceReasonLabels = { broken_link: "الرابط لا يعمل", wrong_file: "ملف غير صحيح", copyright: "حقوق نشر", other: "أخرى" };
  const rows = [];
  let pendingCount = 0;

  // بلاغات الموارد — تُدمج في القائمة الموحدة بنفس بنية الأعمدة.
  if (reportsResult.status === "fulfilled" && !reportsResult.value.error) {
    (reportsResult.value.data || []).forEach((r) => {
      const resTitle = r.resources?.title || "(مورد محذوف)";
      const isHidden = r.resources?.status === "hidden";
      const uniId = r.resources?.subjects?.years?.university_id;
      const facId = r.resources?.subjects?.years?.faculty_id;
      rows.push({
        kind: "report",
        id: r.id,
        source: "مورد",
        content: resTitle,
        details: r.note || "—",
        reason: resourceReasonLabels[r.reason] || r.reason,
        statusLabel: "—",
        date: r.created_at,
        resource: r.resources,
        isHidden,
        canResolve: hasPerm("reports", uniId, facId, "delete"),
        canToggle: hasPerm("resources", uniId, facId, "edit"),
      });
    });
  } else {
    console.error("loadReports: تعذّر تحميل بلاغات الموارد", reportsResult.reason || reportsResult.value?.error);
  }

  // بلاغات المنتدى — نفس الدمج، مع الحالة المعلّقة/المُراجَعة/المرفوضة.
  if (forumResult.status === "fulfilled" && !forumResult.value.error) {
    const canModerate = hasAnyPerm("reports") && (currentProfile.role === "super_admin" || hasPerm("reports", null, null, "edit"));
    (forumResult.value.data || []).forEach((r) => {
      const isTopic = !!r.topic_id;
      const target = isTopic ? r.forum_topics : r.forum_replies;
      const content = isTopic ? (target?.title || "(موضوع محذوف)") : (target?.content || "(رد محذوف)");
      if (r.status === "pending") pendingCount++;
      rows.push({
        kind: "forum",
        id: r.id,
        source: isTopic ? "موضوع" : "رد",
        content,
        details: r.details ? `ملاحظة: ${r.details}` : "—",
        reason: FORUM_REPORT_REASON_LABELS_ADMIN[r.reason] || r.reason,
        statusLabel: FORUM_REPORT_STATUS_LABELS_ADMIN[r.status] || r.status,
        date: r.created_at,
        isTopic,
        target,
        isHidden: target?.is_hidden === true,
        canModerate,
      });
    });
  } else {
    console.error("loadReports: تعذّر تحميل بلاغات المنتدى", forumResult.reason || forumResult.value?.error);
  }

  updateBadge(pendingCount);

  // ترتيب مشترك حسب التاريخ (الأحدث أولًا) ثم الحالة (المعلّقة أولًا).
  rows.sort((a, b) => {
    const aPending = a.kind === "forum" && a.statusLabel === FORUM_REPORT_STATUS_LABELS_ADMIN.pending ? 0 : 1;
    const bPending = b.kind === "forum" && b.statusLabel === FORUM_REPORT_STATUS_LABELS_ADMIN.pending ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return new Date(b.date) - new Date(a.date);
  });

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7">لا توجد بلاغات حاليًا (أو لا تملك صلاحية عرضها)</td></tr>`;
    return;
  }
  tbody.innerHTML = "";

  // كل القيم أدناه (عنوان المورد/الموضوع، الرد، السبب، ملاحظة المُبلِّغ)
  // قادمة من قاعدة البيانات/من المستخدم ويجب التعامل معها كنص غير موثوق
  // دائمًا؛ لذلك تُبنى كل خلية عبر DOM + textContent وليس عبر innerHTML.
  rows.forEach((row) => {
    const tr = document.createElement("tr");

    const tdSource = document.createElement("td");
    tdSource.setAttribute("data-label", "المصدر");
    tdSource.textContent = row.source;
    tr.appendChild(tdSource);

    const tdContent = document.createElement("td");
    tdContent.setAttribute("data-label", "المحتوى المُبلَّغ عنه");
    tdContent.textContent = row.content.length > 80 ? row.content.slice(0, 80) + "…" : row.content;
    tr.appendChild(tdContent);

    const tdDetails = document.createElement("td");
    tdDetails.setAttribute("data-label", "التفاصيل");
    tdDetails.textContent = row.details.length > 80 ? row.details.slice(0, 80) + "…" : row.details;
    tr.appendChild(tdDetails);

    const tdReason = document.createElement("td");
    tdReason.setAttribute("data-label", "السبب");
    tdReason.textContent = row.reason;
    tr.appendChild(tdReason);

    const tdStatus = document.createElement("td");
    tdStatus.setAttribute("data-label", "الحالة");
    tdStatus.textContent = row.statusLabel;
    tr.appendChild(tdStatus);

    const tdDate = document.createElement("td");
    tdDate.setAttribute("data-label", "التاريخ");
    tdDate.textContent = new Date(row.date).toLocaleDateString("ar-EG");
    tr.appendChild(tdDate);

    const tdActions = document.createElement("td");
    const actionsWrap = document.createElement("div");
    actionsWrap.className = "row-actions";

    if (row.kind === "report") {
      if (row.resource && row.canToggle) {
        const hideBtn = document.createElement("button");
        hideBtn.type = "button";
        hideBtn.className = `btn btn-sm ${row.isHidden ? "btn-state-on" : "btn-state-off"}`;
        hideBtn.textContent = row.isHidden ? "إظهار المورد" : "إخفاء المورد";
        hideBtn.dataset.action = "toggle-resource-hidden";
        hideBtn.dataset.table = "reports";
        hideBtn.dataset.id = row.resource.id;
        hideBtn.dataset.hidden = row.isHidden;
        actionsWrap.appendChild(hideBtn);
      }
      if (row.canResolve) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "btn btn-danger btn-sm";
        delBtn.textContent = "حذف البلاغ";
        delBtn.dataset.action = "delete";
        delBtn.dataset.table = "reports";
        delBtn.dataset.id = row.id;
        actionsWrap.appendChild(delBtn);
      }
    } else if (row.kind === "forum" && row.canModerate && row.target) {
      const hideBtn = document.createElement("button");
      hideBtn.type = "button";
      hideBtn.className = `btn btn-sm ${row.isHidden ? "btn-state-on" : "btn-state-off"}`;
      hideBtn.textContent = row.isHidden ? (row.isTopic ? "إظهار الموضوع" : "إظهار الرد") : (row.isTopic ? "إخفاء الموضوع" : "إخفاء الرد");
      hideBtn.addEventListener("click", () => toggleForumTargetHidden(row.isTopic ? "topic" : "reply", row.target.id, row.isHidden, loadReports));
      actionsWrap.appendChild(hideBtn);

      const dismissBtn = document.createElement("button");
      dismissBtn.type = "button";
      dismissBtn.className = "btn btn-sm btn-outline";
      dismissBtn.textContent = "رفض البلاغ";
      dismissBtn.disabled = row.statusLabel !== FORUM_REPORT_STATUS_LABELS_ADMIN.pending;
      dismissBtn.addEventListener("click", () => updateForumReportStatus(row.id, "dismissed", loadReports));
      actionsWrap.appendChild(dismissBtn);

      const reviewBtn = document.createElement("button");
      reviewBtn.type = "button";
      reviewBtn.className = "btn btn-sm btn-primary";
      reviewBtn.textContent = "تحديد كمُراجَع";
      reviewBtn.disabled = row.statusLabel !== FORUM_REPORT_STATUS_LABELS_ADMIN.pending;
      reviewBtn.addEventListener("click", () => updateForumReportStatus(row.id, "reviewed", loadReports));
      actionsWrap.appendChild(reviewBtn);
    }

    if (actionsWrap.children.length) tdActions.appendChild(actionsWrap);
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });
}

// توافق خلفي: بعض الاستدعاءات القديمة (refreshFn في إجراءات المنتدى،
// loadAllData قبل هذا الدمج) كانت تشير إلى loadForumReports — تُترك
// ككيل لـ loadReports حتى تبقى كل الاستدعاءات تعمل مع القائمة الموحدة.
async function loadForumReports() {
  return loadReports();
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

async function toggleForumTargetHidden(targetType, targetId, currentlyHidden, refreshFn) {
  const table = targetType === "topic" ? "forum_topics" : "forum_replies";
  const { error } = await supabaseClient.from(table).update({ is_hidden: !currentlyHidden }).eq("id", targetId);
  if (error) { showToast("تعذّر تحديث حالة المحتوى"); console.error(error); return; }
  logActivity(currentlyHidden ? "forum_content_restored" : "forum_content_hidden", targetType, targetId, null);
  showToast(currentlyHidden ? "تم إظهار المحتوى" : "تم إخفاء المحتوى");
  refreshFn();
}

async function updateForumReportStatus(reportId, newStatus, refreshFn) {
  const { error } = await supabaseClient
    .from("forum_reports")
    .update({ status: newStatus, reviewed_at: new Date().toISOString(), reviewed_by: currentProfile.id })
    .eq("id", reportId);
  if (error) { showToast("تعذّر تحديث حالة البلاغ"); console.error(error); return; }
  logActivity("forum_report_" + newStatus, "forum_report", reportId, null);
  showToast(newStatus === "reviewed" ? "تم تحديد البلاغ كمُراجَع" : "تم رفض البلاغ");
  refreshFn();
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
// الدورات (Courses MVP — Phase 5 P1)
// ============================================================
// نمط مطابق لقسم "المواد"/"الموارد" أعلاه: load*/edit*/reset*Form + جدول
// + نموذج. الفرق الوحيد: لا قوائم متتالية (cascading selects) هنا لأن
// الدورات مستقلة تمامًا عن الهرم الأكاديمي (university/faculty/year/
// subject) — هذا مقصود (انظر تدقيق الدورات، القسم 8، الخيار A).
// كل صلاحيات CRUD هنا تستخدم النطاق العام فقط: hasPerm("courses", null,
// null, action) — يطابق fn_has_permission('courses', null, null, action)
// في RLS تمامًا (لا نطاق جامعة/كلية للدورات في MVP).

const COURSE_STATUS_LABELS = { draft: "مسودة", published: "منشورة", hidden: "مخفية" };
const LESSON_CONTENT_TYPE_LABELS = { video_url: "رابط فيديو", external_link: "رابط خارجي", text: "نص" };

async function loadCourses() {
  const { data, error } = await supabaseClient
    .from("courses")
    .select("id, title, short_description, description, cover_image_url, instructor_name, language, status, sort_order")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false });

  const tbody = document.querySelector("#course-table tbody");
  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  coursesCache = data || [];
  coursesById = {};
  coursesCache.forEach((c) => { coursesById[c.id] = c; });

  // تغذية قائمة "اختر دورة لإدارة دروسها" — نفس مبدأ populateSelect المستخدم
  // للقوائم المتتالية الأخرى، لكن بلا اعتماد على مستوى أعلى (الدورات مستوى جذر).
  populateSelect("lesson-course-select", coursesCache, (c) => c.title, true);
  // إعادة إدراج خيار placeholder بعد إعادة بناء القائمة (populateSelect يبني من items فقط)
  const lessonCourseSelect = document.getElementById("lesson-course-select");
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = coursesCache.length ? "اختر دورة" : "لا توجد دورات بعد";
  lessonCourseSelect.insertBefore(placeholder, lessonCourseSelect.firstChild);
  if (!lessonCourseSelect.value) lessonCourseSelect.value = "";

  if (!coursesCache.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد دورات بعد</td></tr>`; return; }

  const canEdit = hasPerm("courses", null, null, "edit");
  const canDelete = hasPerm("courses", null, null, "delete");

  tbody.innerHTML = "";
  coursesCache.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الدورة">${escHtml(c.title)}</td>
      <td data-label="المدرّب / اللغة">${escHtml(c.instructor_name) || "—"}${c.language ? ` (${LANGUAGE_LABELS[c.language] || escHtml(c.language)})` : ""}</td>
      <td data-label="الحالة"><span class="status-badge ${c.status}">${escHtml(COURSE_STATUS_LABELS[c.status] || c.status)}</span></td>
      <td data-label="الترتيب">${escHtml(c.sort_order ?? 0)}</td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="courses" data-id="${c.id}">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="courses" data-id="${c.id}">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("course-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!validateCourseForm()) return; // NEW-03: يُمنع الإرسال عند خطأ ولا يُرسل شبكة
  runFormMutation(e.currentTarget, async () => {
  const id = document.getElementById("course-edit-id").value;
  const coverUrl = document.getElementById("course-cover-url").value.trim();
  if (coverUrl && !isValidResourceUrl(coverUrl)) {
    showToast("رابط صورة الغلاف غير صالح — أدخل رابطًا يبدأ بـ http:// أو https://، أو اتركه فارغًا");
    return;
  }
  const payload = {
    title: document.getElementById("course-title").value.trim(),
    instructor_name: document.getElementById("course-instructor").value.trim() || null,
    language: document.getElementById("course-language").value || null,
    status: document.getElementById("course-status").value,
    sort_order: parseInt(document.getElementById("course-sort-order").value, 10) || 0,
    cover_image_url: coverUrl || null,
    short_description: document.getElementById("course-short-desc").value.trim() || null,
    description: document.getElementById("course-description").value.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = id
    ? await supabaseClient.from("courses").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("courses").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "course_updated" : "course_created", "course", data?.id, payload.title);
  resetCourseForm();
  closeAdminDrawer("course-form-drawer");
  showToast(id ? "تم تعديل الدورة" : "تمت إضافة الدورة");
  loadCourses();
  });
});

function editCourse(id) {
  const c = coursesById[id];
  if (!c) return;
  document.getElementById("course-edit-id").value = c.id;
  document.getElementById("course-title").value = c.title;
  document.getElementById("course-instructor").value = c.instructor_name || "";
  document.getElementById("course-language").value = c.language || "";
  document.getElementById("course-status").value = c.status;
  document.getElementById("course-sort-order").value = c.sort_order ?? 0;
  document.getElementById("course-cover-url").value = c.cover_image_url || "";
  document.getElementById("course-short-desc").value = c.short_description || "";
  document.getElementById("course-description").value = c.description || "";
  document.getElementById("course-form-title").textContent = "تعديل دورة";
  document.getElementById("course-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("course-cancel-btn").hidden = false;
  openAdminAddForm("course-form-toggle");
}

function resetCourseForm() {
  resetCourseFormImpl();
  closeAdminDrawer("course-form-drawer");
}
function resetCourseFormImpl() {
  document.getElementById("course-form").reset();
  document.getElementById("course-edit-id").value = "";
  document.getElementById("course-status").value = "draft";
  document.getElementById("course-sort-order").value = 0;
  document.getElementById("course-form-title").textContent = "إضافة دورة";
  document.getElementById("course-submit-btn").textContent = "إضافة";
  document.getElementById("course-cancel-btn").hidden = true;
}
document.getElementById("course-cancel-btn").addEventListener("click", resetCourseForm);

// -------------------- دروس الدورة --------------------
// مقيّدة دائمًا بدورة واحدة مختارة (lesson-course-select) — لا جدول عام
// لكل الدروس، لتفادي تحميل دروس دورات أخرى غير ذات صلة دفعة واحدة.

document.getElementById("lesson-course-select").addEventListener("change", () => {
  const courseId = document.getElementById("lesson-course-select").value;
  const manager = document.getElementById("lesson-manager");
  if (!courseId) { manager.hidden = true; return; }
  manager.hidden = false;
  resetLessonForm();
  loadCourseLessons(courseId);
});

async function loadCourseLessons(courseId) {
  const tbody = document.querySelector("#lesson-table tbody");
  tbody.innerHTML = `<tr><td colspan="5">جارٍ التحميل...</td></tr>`;

  const { data, error } = await supabaseClient
    .from("course_lessons")
    .select("id, course_id, title, content_type, content_url, content_text, duration_minutes, sort_order, status")
    .eq("course_id", courseId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) { tbody.innerHTML = `<tr><td colspan="5">تعذّر التحميل</td></tr>`; return; }

  courseLessonsCache = data || [];
  courseLessonsById = {};
  courseLessonsCache.forEach((l) => { courseLessonsById[l.id] = l; });

  if (!courseLessonsCache.length) { tbody.innerHTML = `<tr><td colspan="5">لا توجد دروس بعد لهذه الدورة</td></tr>`; return; }

  const canEdit = hasPerm("courses", null, null, "edit");
  const canDelete = hasPerm("courses", null, null, "delete");

  tbody.innerHTML = "";
  courseLessonsCache.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td data-label="الدرس">${escHtml(l.title)}</td>
      <td data-label="النوع">${escHtml(LESSON_CONTENT_TYPE_LABELS[l.content_type] || l.content_type)}</td>
      <td data-label="الحالة"><span class="status-badge ${l.status}">${escHtml(COURSE_STATUS_LABELS[l.status] || l.status)}</span></td>
      <td data-label="الترتيب">${escHtml(l.sort_order ?? 0)}</td>
      <td>
        <div class="row-actions">
          ${canEdit ? `<button class="btn btn-outline btn-sm" data-action="edit" data-table="course_lessons" data-id="${l.id}">تعديل</button>` : ""}
          ${canDelete ? `<button class="btn btn-danger btn-sm" data-action="delete" data-table="course_lessons" data-id="${l.id}" data-course-id="${courseId}">حذف</button>` : ""}
          ${!canEdit && !canDelete ? "—" : ""}
        </div>
      </td>`;
    tbody.appendChild(tr);
  });
}

// إظهار/إخفاء حقل الرابط مقابل حقل النص حسب نوع المحتوى — نفس مبدأ
// إظهار/إخفاء الحقول الشرطية الموجود أصلاً في نماذج أخرى بالمشروع
// (مثال: نموذج التقرير العام في subject.html/... يُظهر/يُخفي حقولاً بالمثل).
function updateLessonContentFieldVisibility() {
  const type = document.getElementById("lesson-content-type").value;
  document.getElementById("lesson-content-url-field").hidden = type === "text";
  document.getElementById("lesson-content-text-field").hidden = type !== "text";
}
document.getElementById("lesson-content-type").addEventListener("change", updateLessonContentFieldVisibility);

document.getElementById("lesson-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runFormMutation(e.currentTarget, async () => {
  const courseId = document.getElementById("lesson-course-select").value;
  if (!courseId) { showToast("اختر دورة أولاً"); return; }
  const id = document.getElementById("lesson-edit-id").value;
  const contentType = document.getElementById("lesson-content-type").value;
  const contentUrl = document.getElementById("lesson-content-url").value.trim();
  const contentText = document.getElementById("lesson-content-text").value.trim();

  if (contentType !== "text") {
    if (!contentUrl || !isValidResourceUrl(contentUrl)) {
      showToast("رابط المحتوى غير صالح — أدخل رابطًا كاملاً يبدأ بـ http:// أو https://");
      return;
    }
  } else if (!contentText) {
    showToast("أدخل نص الدرس");
    return;
  }

  const durationRaw = document.getElementById("lesson-duration").value;
  const payload = {
    course_id: courseId,
    title: document.getElementById("lesson-title").value.trim(),
    content_type: contentType,
    content_url: contentType !== "text" ? contentUrl : null,
    content_text: contentType === "text" ? contentText : null,
    duration_minutes: durationRaw === "" ? null : parseInt(durationRaw, 10),
    sort_order: parseInt(document.getElementById("lesson-sort-order").value, 10) || 0,
    status: document.getElementById("lesson-status").value,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = id
    ? await supabaseClient.from("course_lessons").update(payload).eq("id", id).select().maybeSingle()
    : await supabaseClient.from("course_lessons").insert(payload).select().maybeSingle();

  if (error) { showToast("خطأ: تعذّر الحفظ (تحقق من صلاحياتك)"); console.error(error); return; }
  logActivity(id ? "course_lesson_updated" : "course_lesson_created", "course_lesson", data?.id, payload.title);
  resetLessonForm();
  showToast(id ? "تم تعديل الدرس" : "تمت إضافة الدرس");
  loadCourseLessons(courseId);
  });
});

function editLesson(id) {
  const l = courseLessonsById[id];
  if (!l) return;
  document.getElementById("lesson-edit-id").value = l.id;
  document.getElementById("lesson-title").value = l.title;
  document.getElementById("lesson-content-type").value = l.content_type;
  document.getElementById("lesson-content-url").value = l.content_url || "";
  document.getElementById("lesson-content-text").value = l.content_text || "";
  document.getElementById("lesson-duration").value = l.duration_minutes ?? "";
  document.getElementById("lesson-sort-order").value = l.sort_order ?? 0;
  document.getElementById("lesson-status").value = l.status;
  updateLessonContentFieldVisibility();
  document.getElementById("lesson-form-title").textContent = "تعديل درس";
  document.getElementById("lesson-submit-btn").textContent = "حفظ التعديل";
  document.getElementById("lesson-cancel-btn").hidden = false;
  openAdminAddForm("lesson-form-toggle");
}

function resetLessonForm() {
  document.getElementById("lesson-form").reset();
  document.getElementById("lesson-edit-id").value = "";
  document.getElementById("lesson-content-type").value = "video_url";
  document.getElementById("lesson-status").value = "draft";
  document.getElementById("lesson-sort-order").value = 0;
  updateLessonContentFieldVisibility();
  document.getElementById("lesson-form-title").textContent = "إضافة درس";
  document.getElementById("lesson-submit-btn").textContent = "إضافة";
  document.getElementById("lesson-cancel-btn").hidden = true;
}
document.getElementById("lesson-cancel-btn").addEventListener("click", resetLessonForm);

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

// NEW-02 — تأكيد الإجراءات المدمرة (Destructive Confirm)
// بديل window.confirm المدمج بنافذة تأكيد داخل الصفحة (inline) بنفس
// نمط الـmodal الموجود (role="dialog" aria-modal="true" aria-labelledby)،
// تُبنى بالكامل عبر DOM APIs و textContent (لا innerHTML لأي بيانات صح،
// ولا سلسلة confirm block للنصوص) — لا يغيّر أي استعلام Supabase ولا
// ترتيب العمليات: التأكيد واجهة فقط. تعمل في المتصفح وفي sandbox
// الاختبارات (لا تعتمد على document.body ولا على querySelector).
let _destructiveConfirmCallback = null;
let _destructiveConfirmOpener = null;

function showDestructiveConfirm({ title, message, onConfirm }) {
  const overlay = _buildDestructiveConfirmOverlay();

  const titleEl = document.getElementById("admin-confirm-title");
  if (titleEl) titleEl.textContent = title || "تأكيد";
  const msgEl = document.getElementById("admin-confirm-message");
  if (msgEl) msgEl.textContent = message || "";

  _destructiveConfirmCallback = typeof onConfirm === "function" ? onConfirm : null;
  _destructiveConfirmOpener = (typeof document.activeElement === "object" && document.activeElement)
    ? document.activeElement : null;

  overlay.hidden = false;
  const cancelBtn = document.getElementById("admin-confirm-cancel");
  if (cancelBtn && typeof cancelBtn.focus === "function") cancelBtn.focus();
}

function _getOrCreate(id, tagName) {
  let el = document.getElementById(id);
  if (el) return el;
  el = document.createElement(tagName || "DIV");
  el.id = id;
  return el;
}

function _buildDestructiveConfirmOverlay() {
  let overlay = document.getElementById("admin-confirm-overlay");
  if (overlay && overlay._built) return overlay;
  overlay = overlay || document.createElement("div");
  overlay.id = "admin-confirm-overlay";
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "admin-confirm-title");

  const box = _getOrCreate("admin-confirm-box");
  box.className = "modal-box";

  const titleEl = _getOrCreate("admin-confirm-title", "H3");
  const msgEl = _getOrCreate("admin-confirm-message", "P");
  const actions = _getOrCreate("admin-confirm-actions");
  actions.className = "modal-actions";

  const cancelBtn = _getOrCreate("admin-confirm-cancel", "BUTTON");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-outline";
  cancelBtn.textContent = "إلغاء";

  const okBtn = _getOrCreate("admin-confirm-ok", "BUTTON");
  okBtn.type = "button";
  okBtn.className = "btn btn-danger";
  okBtn.textContent = "تأكيد الحذف";

  // نبني الهيكل فقط عند أول استخدام (محمي بعلامة _built) — بعدها نكتفي
  // بتحديث النصوص وإظهار النافذة. في sandbox الاختبارات قد يعيد
  // getElementById عناصر مختلقة تلقائيًا، فالربط يُحفظ على العناصر نفسها.
  if (!overlay._built) {
    overlay._built = true;
    overlay.appendChild(box);
    box.appendChild(titleEl);
    box.appendChild(msgEl);
    box.appendChild(actions);
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    okBtn.addEventListener("click", () => _confirmDestructive(true));
    cancelBtn.addEventListener("click", () => _confirmDestructive(false));
    overlay.addEventListener("click", (e) => { if (e && e.target === overlay) _confirmDestructive(false); });
    overlay.addEventListener("keydown", (e) => { if (e && e.key === "Escape") _confirmDestructive(false); });

    const body = typeof document.body === "object" && document.body ? document.body : null;
    if (body && typeof body.appendChild === "function") body.appendChild(overlay);
  }

  return overlay;
}

function _confirmDestructive(confirmed) {
  const overlay = document.getElementById("admin-confirm-overlay");
  if (overlay) overlay.hidden = true;

  const cb = _destructiveConfirmCallback;
  _destructiveConfirmCallback = null;
  const opener = _destructiveConfirmOpener;
  _destructiveConfirmOpener = null;

  if (opener && typeof opener.focus === "function" && typeof document.contains === "function"
    && document.contains(opener)) opener.focus();

  if (confirmed && cb) {
    try { cb(); } catch (err) {
      if (typeof console !== "undefined" && console.error) console.error(err);
    }
  }
}

// F-11: أزرار صفوف الجداول تُبنى عبر data-action/data-id (لا onclick داخل
// سلاسل القوالب — لا حقن JS عبر القيم القادمة من قاعدة البيانات). الاستدعاء
// يتم عبر تفويض أحداث (event delegation) على كل tbody مرة واحدة وقت التحميل.
// نفس الأزرار، نفس النتائج، نفس الصلاحيات المعروضة — سلوك مطابق 100%.
const ADMIN_ROW_REFRESHERS = {
  universities: loadUniversities,
  faculties: loadFaculties,
  years: loadYears,
  subjects: loadSubjects,
  resources: loadResources,
  reports: loadReports,
  courses: loadCourses,
};

function handleAdminRowAction(btn) {
  const { table, action, id } = btn.dataset;
  if (action === "delete") {
    const refresher = table === "course_lessons"
      ? (btn.dataset.courseId ? () => loadCourseLessons(btn.dataset.courseId) : () => {})
      : (ADMIN_ROW_REFRESHERS[table] || (() => {}));
    return deleteRow(table, id, refresher);
  }
  if (action === "toggle-active") {
    const currentlyActive = btn.dataset.active === "true";
    if (table === "faculties") toggleFacultyActive(id, currentlyActive);
    else if (table === "years") toggleYearActive(id, currentlyActive);
    else if (table === "subjects") toggleSubjectActive(id, currentlyActive);
    return;
  }
  if (action === "toggle-resource-hidden") {
    const refresher = table === "resources" ? () => {} : (ADMIN_ROW_REFRESHERS[table] || (() => {}));
    toggleResourceHidden(id, btn.dataset.hidden === "true", refresher);
    return;
  }
  if (action === "toggle-resource-verified") {
    toggleResourceVerified(id, btn.dataset.verified === "true", ADMIN_ROW_REFRESHERS[table] || (() => {}));
    return;
  }
  if (action === "edit") {
    switch (table) {
      case "universities": editUniversity(id); break;
      case "faculties": editFaculty(id); break;
      case "years":
        editYear(id, btn.dataset.universityId, btn.dataset.facultyId || null, parseInt(btn.dataset.yearNumber, 10), btn.dataset.active === "true");
        break;
      case "subjects": editSubject(id); break;
      case "resources": editResource(id); break;
      case "courses": editCourse(id); break;
      case "course_lessons": editLesson(id); break;
    }
    return;
  }
}

document.querySelectorAll(".admin-table tbody").forEach((tbody) => {
  tbody.addEventListener("click", (event) => {
    const btn = event.target.closest && event.target.closest("button[data-action]");
    if (!btn) return;
    handleAdminRowAction(btn);
  });
});

function deleteRow(table, id, refreshFn) {
  showDestructiveConfirm({
    title: "تأكيد الحذف",
    message: "هل أنت متأكد من الحذف؟ لا يمكن التراجع عن هذا الإجراء.",
    onConfirm: () => performDeleteRow(table, id, refreshFn),
  });
}

async function performDeleteRow(table, id, refreshFn) {
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
