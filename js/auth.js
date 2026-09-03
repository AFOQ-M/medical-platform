// ============================================================
// Phase 4B / Google Identity Enablement — أساس المصادقة العامة
// (Guest / Google / Apple)
// ============================================================
//
// هذا الملف مسؤول فقط عن "أساس الهوية" على الموقع العام:
//   - ضمان وجود جلسة (Supabase Anonymous Auth) لكل زائر تلقائيًا،
//     دون أي اسم/بريد/كلمة مرور — هذا ما يجعل الموقع قابلاً للاستخدام
//     فورًا كضيف.
//   - نافذة بسيطة (Google / Apple / متابعة كضيف). Google مفعَّل فعليًا
//     (Manual Linking عبر linkIdentity، مع fallback signInWithOAuth).
//     Apple يبقى "قريبًا" — لم يُفعَّل في هذه المهمة.
//   - ترقية الجلسة المجهولة إلى Google عبر آلية Supabase الرسمية
//     (linkIdentity) بدل إنشاء هوية تطبيق مستقلة ثانية.
//   - لا ميزة فعلية تعتمد على وجود هوية Google مرتبطة بعد (تمهيد فقط
//     لملتقى أفق المستقبلي) — isAnonymousUser()/hasLinkedGoogleIdentity()
//     مُصدَّرتان كدالتين عامتين لإعادة الاستخدام لاحقًا هناك.
//
// لا علاقة لهذا الملف بمصادقة لوحة التحكم (admin/admin.js) — تلك تبقى
// دخول بريد/كلمة مرور فقط، ولا يُحمَّل هذا الملف في admin/index.html.
//
// يُحمَّل مرة واحدة فقط بعد js/supabase-client.js في كل صفحة عامة،
// لتفادي تكرار منطق التهيئة في كل صفحة على حدة.
// ============================================================

const AUTH_PENDING_PROVIDER_KEY = "mrp_auth_pending_provider";

let authBootstrapPromise = null;
let currentAuthUser = null;

/** true إن كان المستخدم الحالي جلسة ضيف (Anonymous Auth)، لا حساب حقيقي مربوط بعد */
function isGuestUser(user) {
  return !!user && user.is_anonymous === true;
}

/**
 * نفس isGuestUser لكن على currentAuthUser مباشرة، بدون تمرير وسيط —
 * الاسم العام المُعاد استخدامه من أي ميزة مستقبلية (مثل ملتقى أفق) تحتاج
 * التحقق السريع من حالة الهوية الحالية دون التعامل مع currentAuthUser
 * مباشرة كمتغيّر داخلي لهذا الملف.
 */
function isAnonymousUser() {
  return isGuestUser(currentAuthUser);
}

/**
 * true إن كان للمستخدم (الحالي افتراضيًا) هوية Google مرتبطة فعليًا —
 * سواء عبر linkIdentity (ترقية جلسة ضيف) أو signInWithOAuth مباشرة.
 * تُستخدم لمنع محاولة ربط مكرر (Test C) ولأي ميزة مستقبلية تحتاج التحقق
 * من وجود هوية ثابتة قبل السماح بإجراء يتطلبها (مثل ملتقى أفق).
 */
function hasLinkedGoogleIdentity(user) {
  const target = user || currentAuthUser;
  return !!(target && Array.isArray(target.identities) &&
    target.identities.some((identity) => identity.provider === "google"));
}

/**
 * يضمن وجود جلسة عند تحميل أي صفحة عامة:
 *  - جلسة موجودة (ضيف أو حساب مرتبط) → لا شيء يُفعل.
 *  - لا جلسة إطلاقًا → إنشاء جلسة ضيف (Anonymous Auth) بصمت.
 * محمي من التكرار (نفس الـ Promise يُعاد استخدامه إن استُدعيت الدالة
 * أكثر من مرة أثناء تحميل نفس الصفحة).
 */
function ensureAuthSession() {
  if (authBootstrapPromise) return authBootstrapPromise;

  authBootstrapPromise = (async () => {
    const { data: { session }, error: getError } = await supabaseClient.auth.getSession();
    if (getError) {
      console.error("تعذّر قراءة جلسة المصادقة:", getError);
    }

    if (session) {
      currentAuthUser = session.user;
      return session.user;
    }

    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) {
      // لا نكسر تصفّح الموقع إن فشل إنشاء جلسة الضيف (مثلاً Anonymous
      // Auth غير مفعّلة بعد من لوحة تحكم Supabase) — الموقع يبقى يعمل
      // بصفحاته العامة (RLS يسمح بالقراءة العامة بمعزل عن هذه الجلسة).
      console.error("تعذّر إنشاء جلسة ضيف:", error);
      return null;
    }

    currentAuthUser = data.session ? data.session.user : null;
    return currentAuthUser;
  })();

  return authBootstrapPromise;
}

/**
 * Google عبر Supabase OAuth الرسمي (لا منطق OAuth مخصّص، لا أسرار في
 * الكود). إن كانت الجلسة الحالية جلسة ضيف، نحاول أولاً ترقيتها بنفس
 * الهوية (linkIdentity) بدل فتح حساب تطبيق ثانٍ منفصل. إن تعذّر ذلك
 * (مثلاً Manual Linking غير مفعّلة من لوحة التحكم بعد، أو الحساب
 * مرتبط فعليًا بمستخدم آخر لدى Supabase)، نرجع لتسجيل دخول عادي بنفس
 * المزوّد بدل تعليق الزائر بلا أي مسار متاح.
 */
async function continueWithProvider(provider) {
  // ربط مكرر: هوية Google مرتبطة أصلًا بهذه الجلسة — لا داعٍ لأي طلب
  // شبكة جديد (Test C: لا نحاول linking مكرر).
  if (provider === "google" && hasLinkedGoogleIdentity()) {
    return { data: null, error: null, alreadyLinked: true };
  }

  try {
    sessionStorage.setItem(AUTH_PENDING_PROVIDER_KEY, provider);
  } catch (e) {
    // تخزين مؤقت غير متاح (وضع خاص متشدد) — لا يمنع المتابعة
  }

  const user = currentAuthUser || (await ensureAuthSession());
  const redirectTo = window.location.href;

  if (isGuestUser(user)) {
    const { data, error } = await supabaseClient.auth.linkIdentity({ provider, options: { redirectTo } });
    if (!error) return { data, error: null };

    // "Manual linking is disabled"، أو الحساب المُعاد من Google مرتبط
    // فعليًا بمستخدم آخر لدى Supabase أصلاً ("identity already exists") →
    // في كلتا الحالتين نرجع لتسجيل دخول عادي بدل تعليق الزائر. هذا يعني
    // عمليًا أن الزائر سينتقل لحساب Google ذاك (لا يبقى ضيفًا)، بدل ربط
    // فاشل بصمت — سلوك معقول ولا يكسر شيئًا.
    console.warn("تعذّرت ترقية جلسة الضيف مباشرةً، جارٍ تسجيل دخول عادي.");
  }

  return supabaseClient.auth.signInWithOAuth({ provider, options: { redirectTo } });
}

/**
 * رسالة عربية عامة وآمنة لأي خطأ OAuth — لا نعرض أبدًا نص/كود الخطأ
 * الخام القادم من Supabase أو من المزوّد (قد يحتوي تفاصيل تقنية داخلية).
 */
function friendlyAuthErrorMessage(providerLabel) {
  return `تعذّر إتمام تسجيل الدخول عبر ${providerLabel} الآن. حاول مرة أخرى لاحقًا.`;
}

function continueWithGoogle() {
  return continueWithProvider("google");
}

function continueWithApple() {
  return continueWithProvider("apple");
}

// ------------------------------------------------------------
// نافذة "كيف تريد المتابعة؟" — تُبنى مرة واحدة عبر JS (بلا تكرار HTML في
// كل صفحة)، على نفس نمط نافذة البحث الشامل في app.js. غير مربوطة بأي
// ميزة تتطلب حسابًا بعد؛ هذه فقط الواجهة الدنيا اللازمة لتجربة Google/
// Apple والتأكد من عمل الأساس.
// ------------------------------------------------------------

function buildAuthOverlay() {
  if (document.getElementById("auth-overlay")) return;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "auth-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal-box auth-box">
      <h3>كيف تريد المتابعة؟</h3>
      <p class="hint" id="auth-status-line">تصفّح المنصة الآن كضيف.</p>
      <div class="modal-actions" style="flex-direction: column; align-items: stretch;">
        <button type="button" class="btn btn-outline" id="auth-google-btn">المتابعة عبر Google</button>
        <button type="button" class="btn btn-outline" id="auth-apple-btn">المتابعة عبر Apple <span class="badge-soon">قريبًا</span></button>
        <button type="button" class="btn btn-primary" id="auth-guest-btn">متابعة كضيف — بدون حساب</button>
      </div>
      <p class="hint" style="margin-top:14px; margin-bottom:0;">
        متابعة كضيف: تصفّح المنصة دون إنشاء حساب.
      </p>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeAuthOverlay(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeAuthOverlay();
  });

  overlay.querySelector("#auth-google-btn").addEventListener("click", async () => {
    const { error, alreadyLinked } = await continueWithGoogle();
    if (alreadyLinked) {
      showToast("حسابك مرتبط بالفعل عبر Google.");
      closeAuthOverlay();
      return;
    }
    if (error) {
      // لا نطبع تفاصيل الخطأ الخام في console (قد تحتوي معلومات من
      // المزوّد) — رسالة عامة فقط للمستخدم.
      showToast(friendlyAuthErrorMessage("Google"));
    }
    // نجاح linkIdentity/signInWithOAuth هنا يعني بدء تحويل (redirect) إلى
    // Google بالفعل — لا شيء إضافي يُفعل في هذه اللحظة من التنفيذ.
  });

  overlay.querySelector("#auth-apple-btn").addEventListener("click", async () => {
    const { error } = await continueWithApple();
    if (error) {
      console.error(error);
      showToast("تعذّر بدء تسجيل الدخول عبر Apple الآن");
    }
  });

  overlay.querySelector("#auth-guest-btn").addEventListener("click", () => {
    closeAuthOverlay();
  });
}

function updateAuthStatusLine() {
  const line = document.getElementById("auth-status-line");
  if (!line) return;
  line.textContent = (!isGuestUser(currentAuthUser) && currentAuthUser != null)
    ? "تم ربط حسابك بهذا المتصفح."
    : "تصفّح المنصة الآن كضيف.";
}

/**
 * فحص أمان أساسي لأي رابط صورة قادم من Google user_metadata قبل استخدامه
 * كـimg.src — يقبل http/https فقط (نفس روح isValidResourceUrl في
 * admin.js). كل ملف عام في هذا المشروع يحتفظ بفحصه الخاص بلا وحدة
 * مشتركة (لا أدوات بناء/bundler هنا)، فهذا تكرار متعمَّد ومتّسق مع
 * النمط القائم، لا اختراع نظام تحقق جديد.
 */
function isSafeHttpUrl(url) {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

/**
 * أفضل رابط صورة متاح من Google user_metadata، بترتيب منطقي. Google
 * OAuth عبر Supabase قد يضع الصورة في avatar_url أو picture حسب النسخة/
 * السياق — لا نفترض وجود أي منهما. null إن لم يوجد رابط آمن.
 */
function bestAvatarUrl(user) {
  const meta = (user && user.user_metadata) || {};
  if (isSafeHttpUrl(meta.avatar_url)) return meta.avatar_url;
  if (isSafeHttpUrl(meta.picture)) return meta.picture;
  return null;
}

/**
 * أفضل اسم عرض متاح، بترتيب منطقي. لا نعرض البريد الإلكتروني كاملاً
 * أبدًا — فقط الجزء قبل @ كحل قبل أخير، ثم نص عام ثابت كحل أخير نهائي.
 */
function bestDisplayName(user) {
  const meta = (user && user.user_metadata) || {};
  if (typeof meta.full_name === "string" && meta.full_name.trim()) return meta.full_name.trim();
  if (typeof meta.name === "string" && meta.name.trim()) return meta.name.trim();
  if (user && typeof user.email === "string" && user.email.includes("@")) {
    const localPart = user.email.split("@")[0];
    if (localPart) return localPart;
  }
  return "حساب Google";
}

/**
 * العنصر الوحيد المرئي دائمًا خارج نافذة "كيف تريد المتابعة؟" (المغلقة
 * افتراضيًا) هو زر الحساب في الهيدر (#account-trigger). في حالة الضيف
 * يبقى بشكله الأصلي تمامًا (أيقونة 👤 + aria-label "الحساب"، بلا أي اسم
 * أو صورة). في حالة ربط Google فعليًا، يُعاد بناء محتواه (عبر DOM APIs
 * فقط — لا innerHTML، لا خطر XSS حتى لو احتوى الاسم القادم من Google
 * نصًا يشبه HTML) ليعرض صورة الحساب (إن وُجدت وكانت http/https آمنة) +
 * اسم العرض، مع fallback آمن لكل منهما إن لم يتوفر.
 */
function updateAccountTriggerUI() {
  const trigger = document.getElementById("account-trigger");
  if (!trigger) return;

  const linked = !isGuestUser(currentAuthUser) && currentAuthUser != null;
  trigger.textContent = ""; // إفراغ كامل قبل إعادة البناء، بلا استثناء
  trigger.classList.toggle("account-linked", linked);

  if (!linked) {
    trigger.textContent = "👤";
    trigger.setAttribute("aria-label", "الحساب");
    return;
  }

  const name = bestDisplayName(currentAuthUser);
  const avatarUrl = bestAvatarUrl(currentAuthUser);

  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "account-avatar";
    img.alt = ""; // زخرفية فقط — الاسم النصي المجاور يحمل المعنى الفعلي لقارئ الشاشة
    img.referrerPolicy = "no-referrer"; // لا نُسرّب مرجع الصفحة الحالية لخوادم صور Google
    // fallback آمن: إن فشل تحميل الصورة (رابط منتهي/محجوب/غير صالح فعليًا
    // رغم اجتيازه فحص المخطّط)، نستبدلها بالأيقونة الافتراضية بدل ترك
    // أيقونة صورة مكسورة في الهيدر.
    img.onerror = () => { img.replaceWith(document.createTextNode("👤")); };
    img.src = avatarUrl;
    trigger.appendChild(img);
  } else {
    trigger.appendChild(document.createTextNode("👤"));
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "account-name";
  nameSpan.textContent = name; // textContent فقط — لا خطر XSS مهما كان محتوى الاسم
  trigger.appendChild(nameSpan);

  trigger.setAttribute("aria-label", `الحساب — ${name}`);
}

/** يُستدعى من كل نقطة قد تتغيّر فيها حالة المصادقة — يبقي كل عناصر
 *  الواجهة المرتبطة بها متزامنة معًا بدل تكرار نفس زوج الاستدعاءات. */
function refreshAuthUI() {
  updateAuthStatusLine();
  updateAccountTriggerUI();
}

function openAuthOverlay() {
  buildAuthOverlay();
  refreshAuthUI();
  document.getElementById("auth-overlay").hidden = false;
}

function closeAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.hidden = true;
}

function initAuthUI() {
  const trigger = document.getElementById("account-trigger");
  if (!trigger) return; // الصفحة لا تحتوي زر حساب (مثال: لوحة التحكم لا تحمّل هذا الملف أصلاً)
  trigger.addEventListener("click", openAuthOverlay);
}

/**
 * بعد تحويل (redirect) فاشل من Google (إلغاء المستخدم، أو خطأ من
 * المزوّد)، يعيد Supabase توجيه المتصفح إلى نفس الصفحة مع معامل ?error=
 * (وأحيانًا error_description/error_code) في الرابط، دون أن ينكسر أي
 * شيء في الجلسة الحالية (تبقى جلسة الضيف كما هي). هذه الدالة تلتقط ذلك
 * مرة واحدة عند تحميل الصفحة، تعرض رسالة عامة فقط (لا نص الخطأ الخام)،
 * ثم تنظّف معاملات الخطأ فقط من الرابط — دون المساس بأي معامل آخر مثل
 * ?id= في course.html أو ?q= في search.html.
 */
function consumeOAuthRedirectError() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (!error) return;

  showToast(error === "access_denied"
    ? "تم إلغاء تسجيل الدخول."
    : friendlyAuthErrorMessage("Google"));

  params.delete("error");
  params.delete("error_description");
  params.delete("error_code");
  const cleanQuery = params.toString();
  const cleanUrl = window.location.pathname + (cleanQuery ? "?" + cleanQuery : "");
  window.history.replaceState({}, document.title, cleanUrl);
}

document.addEventListener("DOMContentLoaded", async () => {
  initAuthUI();
  consumeOAuthRedirectError();

  // نُسجّل المستمع قبل استدعاء ensureAuthSession() لا بعده — لضمان عدم
  // تفويت أي حدث مصادقة قد يُطلقه العميل أثناء استعادة/استبدال الجلسة
  // (مثلاً استعادة جلسة Google فور العودة من التحويل)، بدل تسجيله بعد
  // اكتمال ensureAuthSession() كما كان سابقًا.
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentAuthUser = session ? session.user : null;
    refreshAuthUI();
  });

  await ensureAuthSession();
  // استدعاء صريح إضافي هنا (بمعزل عن onAuthStateChange أعلاه): يضمن
  // ظهور الحالة الصحيحة فورًا في كل الأحوال، حتى لو لم يُطلِق العميل أي
  // حدث تغيير حالة لجلسة كانت موجودة ومُستعادة أصلًا من التخزين قبل
  // تحميل هذه الصفحة (لا اعتماد فقط على توقيت/إطلاق onAuthStateChange).
  refreshAuthUI();
});
