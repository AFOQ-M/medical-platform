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

// أيقونات SVG stroke (تنسيق lucide، سماكة 1.8) لقائمة الحساب — بديل
// الإيموجي الذي يوفر مظهرًا متسقًا مع بقية أيقونات الموقع (فيتحول اللون
// تلقائيًا عبر currentColor). بنية الإدخال: { d: "path d" } لمس، أو
// { tag, attrs } لأي عنصر مرن (مثل الدائرة في أيقونة المستخدم).
const AUTH_ICONS = {
  user: [
    { tag: "circle", attrs: { cx: "12", cy: "8", r: "3.8" } },
    { d: "M4.6 20c.9-3.4 4-5.4 7.4-5.4s6.5 2 7.4 5.4" },
  ],
  home: [
    { d: "m3 10 9-7 9 7" },
    { d: "M5 9v11h14V9" },
  ],
  resources: [
    { d: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20" },
    { d: "M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" },
  ],
  courses: [
    { d: "M22 10 12 5 2 10l10 5 10-5z" },
    { d: "M6 12v5c3 3 9 3 12 0v-5" },
    { d: "M22 10v6" },
  ],
  forum: [
    { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
  ],
  favorites: [
    { d: "m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" },
  ],
  signout: [
    { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" },
    { d: "m16 17 5-5-5-5" },
    { d: "M21 12H9" },
  ],
  check: [
    { d: "M20 6 9 17l-5-5" },
  ],
};

/** يبني عنصر SVG جاهز عبر DOM APIs — يُستخدم في الأماكن التي تُبنى
 *  محتوياتها برمجيًا (زر الحساب وصورته الاحتياطية) ليبقى بعيدًا عن
 *  innerHTML مع أي بيانات قادمة من المستخدم. */
function authSvgIcon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className || "auth-svg-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  (AUTH_ICONS[name] || {}).forEach((item) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", item.d ? "path" : item.tag);
    if (item.d) node.setAttribute("d", item.d);
    else Object.keys(item.attrs).forEach((k) => node.setAttribute(k, item.attrs[k]));
    svg.appendChild(node);
  });
  return svg;
}

/** نسخة نصية للقوالب الثابتة الآمنة فقط (أيقونات القائمة الجانبية —
 *  لا تمر عليها أي بيانات مستخدم أبدًا). */
function authSvgMarkup(name, className) {
  const body = (AUTH_ICONS[name] || [])
    .map((item) =>
      item.d
        ? `<path d="${item.d}"/>`
        : `<${item.tag} ${Object.keys(item.attrs).map((k) => `${k}="${item.attrs[k]}"`).join(" ")}/>`
    )
    .join("");
  return `<svg class="${className || "auth-svg-icon"}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

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
 * true إن كان لدى المستخدم (الحالي افتراضيًا) حساب حقيقي مرتبط فعليًا —
 * أي ليس ضيفًا (Anonymous) وليس null (جلسة لم تُحمَّل بعد). تُستخدم لتحديد
 * أي واجهة تظهر عند الضغط على زر الحساب: نافذة تسجيل الدخول (ضيف) أو
 * القائمة الجانبية للحساب (مستخدم حقيقي) — بدل تكرار نفس الشرط في كل مكان.
 */
function isLinkedAccountUser(user) {
  const target = user !== undefined ? user : currentAuthUser;
  return !isGuestUser(target) && target != null;
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
 *
 * معالجة "Anonymous sign-ins are disabled" (ردّ 422 من لوحة تحكم
 * Supabase عندما تكون Anonymous Auth معطّلة إعدادًا، لا عطلًا في الكود):
 * يُسجَّل زمن أول رفض محليًا (localStorage) فتتوقف إعادة المحاولة في كل
 * صفحة/تبويب (المصدر السابق لضوضاء console في كل تحميل)، وتُعاد المحاولة
 * تلقائيًا بعد GUEST_SIGNIN_RETRY_MS في حال أُعيد تفعيلها — بلا أي تأثير
 * على تصفّح الصفحات العامة (RLS يسمح بالقراءة العامة بمعزل عن الجلسة).
 */
const GUEST_SIGNIN_DISABLED_KEY = "afoq_guest_signin_disabled_at";
const GUEST_SIGNIN_RETRY_MS = 24 * 60 * 60 * 1000;

/** هل نجرّب إنشاء جلسة الضيف الآن؟ false إن كان آخر رفض حديثًا (ضمن
 *  GUEST_SIGNIN_RETRY_MS) — تقلّل الطلبات الفاشلة إلى أقصى محاولة واحدة
 *  لكل نافذة زمنية بدل محاولة في كل صفحة. أي خطأ تخزين → نحاول (آمن). */
function guestSignInShouldAttempt() {
  try {
    const raw = localStorage.getItem(GUEST_SIGNIN_DISABLED_KEY);
    if (!raw) return true;
    const disabledAt = Number(raw);
    if (!Number.isFinite(disabledAt)) return true;
    return Date.now() - disabledAt > GUEST_SIGNIN_RETRY_MS;
  } catch (e) {
    return true;
  }
}

/** تسجيل زمن آخر رفض معروف لدور الضيف — يُستدعى مرة واحدة يوميًا تقريبًا
 *  عند اكتشاف الرفض (وليس في كل صفحة). */
function recordGuestSignInDisabled() {
  try {
    localStorage.setItem(GUEST_SIGNIN_DISABLED_KEY, String(Date.now()));
  } catch (e) {
    // تخزين غير متاح (وضع خاص متشدد) — المحاولة ستتكرر في هذه الصفحات فقط، غير مؤذية
  }
}

/** مسح علامة التعطيل عند نجاح جلسة ضيف — يضمن عودة فورية للمحاولة إن
 *  أُعيد تفعيل Anonymous Auth لاحقًا دون انتظار GUEST_SIGNIN_RETRY_MS. */
function clearGuestSignInDisabled() {
  try {
    localStorage.removeItem(GUEST_SIGNIN_DISABLED_KEY);
  } catch (e) {
    // لا حاجة لأي شيء — غياب الطريقة مجرد بيئة تخزين غير متاحة
  }
}

/** هل خطأ Supabase هو تحديدًا "Anonymous sign-ins are disabled" (موقف
 *  معروف/متوقَّع) وليس عطلًا حقيقيًا؟ الرقم 422 هو status الرد الفعلي؛
 *  وفحص الرسالة سقف أمان إضافي لو جاء status مختلفًا في نسخة أخرى. */
function isGuestSignInDisabledError(error) {
  return !!(error && (
    error.status === 422 ||
    (typeof error.message === "string" && error.message.includes("Anonymous sign-ins are disabled"))
  ));
}

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

    // تعليق مؤقت وارد: رفض سابق حديث (مثلاً Anonymous Auth معطّلة) →
    // نتجاوز المحاولة الآن حتى يتغير الإعداد أو تنقضي النافذة الزمنية.
    if (!guestSignInShouldAttempt()) {
      return null;
    }

    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) {
      if (isGuestSignInDisabledError(error)) {
        // حالة إعداد معروفة (Anonymous Auth غير مفعّلة من لوحة Supabase) —
        // نُسجّل تاريخها ونعرض تحذيرًا واحدًا واضحًا بدل error متكرر في كل
        // صفحة/تبويب. لا نكسر تصفّح الموقع: الصفحات العامة تبقى تعمل لأن
        // RLS يسمح بالقراءة العامة بمعزل عن هذه الجلسة.
        recordGuestSignInDisabled();
        console.warn("Anonymous Auth معطَّل في هذا المشروع — الموقع يستمر بالتصفح العام دون جلسة ضيف.");
      } else {
        console.error("تعذّر إنشاء جلسة ضيف:", error);
      }
      return null;
    }

    // نجاح جلسة ضيف — نمسح أي علامة تعطيل سابقة (لو أُعيد تفعيلها).
    clearGuestSignInDisabled();
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
// NEW-01: طبقات auth (نافذة "كيف تريد المتابعة؟" + القائمة الجانبية)
// تعتمد مصيدة تركيز موحّدة مطابقة لنمط wireDialogOverlay في js/app.js.
// معرّفة هنا محليًا لأن auth.js يعمل مستقلاً في اختباراته (لا يحمّل
// app.js)، ولأن المحاكاة البسيطة في الاختبارات قد لا توفر كل قدرات DOM
// (querySelectorAll/contains...). كل مواضع الاستخدام محميّة بـ typeof،
// فإن غابت قدرة ما تُتجاهل بأمان ولا يكسر أي اختبار قائم.
// _authOpenLayers: overlay -> العنصر الذي فتح الطبقة (لاستعادة التركيز).
// ------------------------------------------------------------
const _authOpenLayers = new Map();

function _authLayerFocusables(overlay) {
  if (!overlay || typeof overlay.querySelectorAll !== "function") return [];
  return Array.from(overlay.querySelectorAll(
    'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )).filter((el) => el && typeof el.getAttribute === "function" ? el.getAttribute("type") !== "hidden" : true);
}

function _trapAuthLayerFocus(overlay, event) {
  if (!overlay || overlay.hidden) return;
  const items = _authLayerFocusables(overlay);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document && typeof document.activeElement === "object" && document.activeElement ? document.activeElement : null;
  if (event.shiftKey) {
    if (!active || active === first || active === overlay) {
      event.preventDefault();
      if (typeof last.focus === "function") last.focus();
    }
  } else if (!active || active === last) {
    event.preventDefault();
    if (typeof first.focus === "function") first.focus();
  }
}

function _wireAuthLayerTrap(overlay, onClose) {
  if (!overlay || typeof overlay.addEventListener !== "function") return;
  if (overlay._authTrapWired) return;
  overlay._authTrapWired = true;
  overlay.addEventListener("keydown", (event) => {
    if (!event || !event.key) return;
    if (event.key === "Escape") {
      if (typeof onClose === "function") onClose();
      return;
    }
    if (event.key === "Tab") _trapAuthLayerFocus(overlay, event);
  });
}

function _restoreAuthLayerFocus(overlay) {
  if (!overlay) return;
  const opener = _authOpenLayers.get(overlay);
  _authOpenLayers.delete(overlay);
  if (opener && typeof opener.focus === "function"
    && document && typeof document.contains === "function" && document.contains(opener)) {
    opener.focus();
  }
}

document.addEventListener("focusin", (e) => {
  _authOpenLayers.forEach((_opener, layer) => {
    if (!layer || layer.hidden) return;
    if (typeof layer.contains !== "function" || layer.contains(e.target)) return;
    const first = _authLayerFocusables(layer)[0];
    if (first && typeof first.focus === "function") first.focus();
  });
});

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
 * يبقى بشكله الأصلي تمامًا (أيقونة المستخدم SVG + aria-label "الحساب"، بلا أي اسم
 * أو صورة). في حالة ربط Google فعليًا، يُعاد بناء محتواه (عبر DOM APIs
 * فقط — لا innerHTML، لا خطر XSS حتى لو احتوى الاسم القادم من Google
 * نصًا يشبه HTML) ليعرض صورة الحساب (إن وُجدت وكانت http/https آمنة) +
 * اسم العرض، مع fallback آمن لكل منهما إن لم يتوفر.
 */
function updateAccountTriggerUI() {
  const trigger = document.getElementById("account-trigger");
  if (!trigger) return;

  const linked = isLinkedAccountUser();
  trigger.textContent = ""; // إفراغ كامل قبل إعادة البناء، بلا استثناء
  trigger.classList.toggle("account-linked", linked);

  if (!linked) {
    trigger.appendChild(authSvgIcon("user", "icon account-trigger-icon"));
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
    img.onerror = () => { img.replaceWith(authSvgIcon("user", "icon account-trigger-icon")); };
    img.src = avatarUrl;
    trigger.appendChild(img);
  } else {
    trigger.appendChild(authSvgIcon("user", "icon account-trigger-icon"));
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "account-name";
  nameSpan.textContent = name; // textContent فقط — لا خطر XSS مهما كان محتوى الاسم
  trigger.appendChild(nameSpan);

  trigger.setAttribute("aria-label", `الحساب — ${name}`);
}

/**
 * يحدّث نص زرّي "دخول / تسجيل" في صفحة الهبوط (#hero-auth-trigger في
 * قسم Hero، و#final-auth-trigger في الشريط الختامي) ليعكسا حالة الدخول
 * الفعلية، بنفس منطق updateAccountTriggerUI أعلاه (isLinkedAccountUser +
 * bestDisplayName) بدل بقائهما ثابتين على "دخول / تسجيل" دائمًا.
 * هذان العنصران موجودان فقط في index.html — أي صفحة أخرى لا تحتويهما
 * تتجاهل هذه الدالة تلقائيًا (لا تأثير خارج صفحة الهبوط).
 */
function updateHeroAuthButtonsUI() {
  // كلا الزرّين قبل تسجيل الدخول (ضيف): "دخول / تسجيل" — كما كانا دائمًا.
  // بعد تسجيل الدخول: hero-auth-trigger (العلوي) يعرض "القائمة" (الضغط
  // عليه يفتح القائمة الجانبية عبر نفس مستمع الحدث الحالي، بلا أي تغيير
  // في السلوك). final-auth-trigger (السفلي) يبقى "حسابي — [الاسم]" تمامًا
  // كما كان قبل أي من هذه التعديلات.
  const guestLabel = "دخول / تسجيل";
  const linkedLabels = {
    "hero-auth-trigger": "القائمة",
    "final-auth-trigger": `حسابي — ${bestDisplayName(currentAuthUser)}`,
  };

  const linked = isLinkedAccountUser();

  Object.keys(linkedLabels).forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = linked ? linkedLabels[id] : guestLabel; // نص فقط، لا innerHTML — نفس معيار الأمان المتّبع في الملف
  });
}

/** يُستدعى من كل نقطة قد تتغيّر فيها حالة المصادقة — يبقي كل عناصر
 *  الواجهة المرتبطة بها متزامنة معًا بدل تكرار نفس زوج الاستدعاءات. */
function refreshAuthUI() {
  updateAuthStatusLine();
  updateAccountTriggerUI();
  updateHeroAuthButtonsUI();
}

/**
 * نقطة الدخول الوحيدة لكل أزرار "الحساب / دخول" في الموقع العام
 * (#account-trigger في الهيدر، وأزرار "دخول / تسجيل" في صفحة الهبوط).
 * لمستخدم حقيقي مرتبط فعليًا (لا ضيف) تُفتح القائمة الجانبية للحساب مباشرة
 * بدل نافذة "كيف تريد المتابعة؟" — حتى لا تظهر رسالة "تم ربط حسابك بهذا
 * المتصفح" لمستخدم مسجَّل بالفعل من أي زر يستدعي هذه الدالة.
 */
function openAuthOverlay() {
  if (isLinkedAccountUser()) {
    openAccountSidebar();
    return;
  }
  buildAuthOverlay();
  refreshAuthUI();
  const overlay = document.getElementById("auth-overlay");
  if (!overlay) return;
  _authOpenLayers.set(overlay, document.activeElement);
  _wireAuthLayerTrap(overlay, closeAuthOverlay);
  overlay.hidden = false;
  const first = _authLayerFocusables(overlay)[0];
  if (first && typeof first.focus === "function") first.focus();
}

function closeAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.hidden = true;
  _restoreAuthLayerFocus(overlay);
}

function initAuthUI() {
  const trigger = document.getElementById("account-trigger");
  if (!trigger) return; // الصفحة لا تحتوي زر حساب (مثال: لوحة التحكم لا تحمّل هذا الملف أصلاً)
  trigger.addEventListener("click", openAuthOverlay);
}

// ------------------------------------------------------------
// القائمة الجانبية للحساب (Account Sidebar) — تظهر فقط لمستخدم حقيقي
// مرتبط (isLinkedAccountUser)، من جهة اليمين فعليًا. تُبنى مرة واحدة عبر
// JS بنفس نمط buildAuthOverlay/buildGlobalSearchOverlay (بلا تكرار HTML
// في كل صفحة). "الموارد" هنا رابط مباشر إلى platform.html — المدخل
// الفعلي الحالي للهيكل الأكاديمي (جامعة ← كلية ← سنة ← فصل ← مادة) — دون
// إنشاء أي قائمة أو رحلة مستقلة جديدة له.
// ------------------------------------------------------------

let accountSidebarPreviousFocus = null;

function buildAccountSidebar() {
  if (document.getElementById("account-sidebar")) return;

  const overlay = document.createElement("div");
  overlay.className = "account-sidebar-overlay";
  overlay.id = "account-sidebar-overlay";
  overlay.hidden = true;

  const sidebar = document.createElement("aside");
  sidebar.className = "account-sidebar";
  sidebar.id = "account-sidebar";
  sidebar.hidden = true;
  sidebar.setAttribute("role", "dialog");
  sidebar.setAttribute("aria-modal", "true");
  sidebar.setAttribute("aria-label", "قائمة الحساب");

  // كل النصوص هنا ثابتة من تأليفنا (لا بيانات مستخدم) — استخدام innerHTML
  // لهيكل القائمة الساكن هنا آمن ومتّسق مع buildAuthOverlay. الاسم/الصورة
  // الفعليان (بيانات من Google) يُملآن لاحقًا عبر DOM APIs/textContent فقط
  // في updateAccountSidebarProfile، وليس هنا.
  sidebar.innerHTML = `
    <div class="account-sidebar-header">
      <button type="button" class="icon-btn account-sidebar-close" id="account-sidebar-close" aria-label="إغلاق قائمة الحساب">✕</button>
    </div>
    <div class="account-sidebar-profile">
      <div class="account-sidebar-avatar-wrap" id="account-sidebar-avatar-wrap"></div>
      <p class="account-sidebar-name" id="account-sidebar-name"></p>
      <p class="account-sidebar-status">حساب Google مرتبط <span class="account-sidebar-status-check" aria-hidden="true">${authSvgMarkup("check", "auth-svg-icon")}</span></p>
    </div>
    <nav class="account-sidebar-nav" aria-label="روابط الحساب">
      <a href="index.html" class="account-sidebar-link">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("home")}</span><span>الرئيسية</span>
      </a>
      <a href="platform.html" class="account-sidebar-link">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("resources")}</span><span>الموارد</span>
      </a>
      <a href="courses.html" class="account-sidebar-link">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("courses")}</span><span>الدورات</span>
      </a>
      <a href="forum.html" class="account-sidebar-link" id="account-sidebar-forum">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("forum")}</span><span>ملتقى أفق</span>
      </a>
      <a href="favorites.html" class="account-sidebar-link">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("favorites")}</span><span>المفضلة</span>
      </a>
    </nav>
    <div class="account-sidebar-footer">
      <button type="button" class="account-sidebar-link account-sidebar-signout" id="account-sidebar-signout">
        <span class="account-sidebar-icon" aria-hidden="true">${authSvgMarkup("signout")}</span><span>تسجيل الخروج</span>
      </button>
    </div>
  `;

  document.body.appendChild(overlay);
  document.body.appendChild(sidebar);

  overlay.addEventListener("click", closeAccountSidebar);
  sidebar.querySelector("#account-sidebar-close").addEventListener("click", closeAccountSidebar);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sidebar.hidden) closeAccountSidebar();
  });

  // ملتقى أفق: forum.html أصبح موجودًا (Phase 6) — رابط عادي فقط
  // (لا مستمع خاص هنا)، بنفس نمط بقية روابط القائمة أعلاه.

  sidebar.querySelector("#account-sidebar-signout").addEventListener("click", handleAccountSignOut);
}

/** يملأ صورة/اسم القائمة الجانبية من currentAuthUser الحالي، بنفس دوال
 *  bestAvatarUrl/bestDisplayName المستخدمة أصلاً لزر الحساب في الهيدر —
 *  عبر DOM APIs/textContent فقط، لا innerHTML مع بيانات المستخدم. */
function updateAccountSidebarProfile() {
  const nameEl = document.getElementById("account-sidebar-name");
  const avatarWrap = document.getElementById("account-sidebar-avatar-wrap");
  if (!nameEl || !avatarWrap) return;

  nameEl.textContent = bestDisplayName(currentAuthUser);

  const avatarUrl = bestAvatarUrl(currentAuthUser);
  avatarWrap.textContent = "";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.className = "account-sidebar-avatar";
    img.alt = ""; // زخرفية — الاسم النصي المجاور يحمل المعنى لقارئ الشاشة
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { img.replaceWith(authSvgIcon("user", "account-sidebar-avatar-placeholder")); };
    img.src = avatarUrl;
    avatarWrap.appendChild(img);
  } else {
    avatarWrap.appendChild(authSvgIcon("user", "account-sidebar-avatar-placeholder"));
  }
}

function openAccountSidebar() {
  buildAccountSidebar();
  updateAccountSidebarProfile();
  accountSidebarPreviousFocus = document.activeElement;
  const accountTrigger = document.getElementById("account-trigger");
  if (accountTrigger) accountTrigger.setAttribute("aria-expanded", "true");
  const overlay = document.getElementById("account-sidebar-overlay");
  if (overlay) overlay.hidden = false;
  const sidebar = document.getElementById("account-sidebar");
  if (sidebar) {
    // NEW-01: فخ التركيز على اللوحة نفسها (الزر/الروابط داخلها فعليًا) —
    // ليس على خلفية overlay لأن اللوحة أُضيفت كأخٍ لـ header/body وليست
    // طفلاً داخل الخلفية، فلا يعثر querySelectorAll على العناصر داخلها.
    _authOpenLayers.set(sidebar, accountSidebarPreviousFocus);
    _wireAuthLayerTrap(sidebar, closeAccountSidebar);
    sidebar.hidden = false;
  }
  const closeBtn = document.getElementById("account-sidebar-close");
  if (closeBtn) closeBtn.focus();
}

function closeAccountSidebar() {
  const overlay = document.getElementById("account-sidebar-overlay");
  const sidebar = document.getElementById("account-sidebar");
  if (overlay) overlay.hidden = true;
  if (sidebar) sidebar.hidden = true;
  const accountTrigger = document.getElementById("account-trigger");
  if (accountTrigger) accountTrigger.setAttribute("aria-expanded", "false");
  // إعادة التركيز إلى العنصر الذي فتح القائمة (غالبًا #account-trigger) —
  // بلا ذلك يُفقَد موضع لوحة المفاتيح بعد الإغلاق.
  if (accountSidebarPreviousFocus && typeof accountSidebarPreviousFocus.focus === "function") {
    accountSidebarPreviousFocus.focus();
  }
  if (sidebar) _restoreAuthLayerFocus(sidebar);
  accountSidebarPreviousFocus = null;
}

/**
 * تسجيل الخروج الفعلي عبر Supabase signOut() الرسمية فقط — لا حذف يدوي
 * لأي tokens أو localStorage/sessionStorage، ولا لمس لبيانات Favorites أو
 * إعدادات Admin، ولا إنشاء أي جلسة ضيف يدويًا من هذه الدالة. عند النجاح
 * نُحدِّث currentAuthUser والواجهة صراحةً هنا (بدل الانتظار فقط لحدث
 * onAuthStateChange غير المتزامن أدناه، الذي يبقى مسجَّلاً ويعمل بلا
 * تعارض — تحديثان متطابقان غير ضارّين معًا) لضمان عودة فورية وحتمية
 * لحالة الضيف فور نجاح signOut().
 */
async function handleAccountSignOut() {
  const { error } = await supabaseClient.auth.signOut();
  if (error) {
    // رسالة عامة فقط للمستخدم؛ لا نطبع كائن الخطأ/الجلسة كاملاً في
    // console (قد يحتوي تفاصيل حساسة) — فقط نص الرسالة إن وُجد.
    console.error("تعذّر تسجيل الخروج:", error.message || "خطأ غير معروف");
    showToast("تعذّر تسجيل الخروج الآن، حاول مرة أخرى.");
    return;
  }
  // نحدّث currentAuthUI/الواجهة صراحةً هنا بدل الاعتماد فقط على حدث
  // onAuthStateChange غير المتزامن (المُسجَّل أصلاً في DOMContentLoaded،
  // ويبقى يعمل بلا تعارض — هذا التحديث المباشر متطابق معه وغير ضار حتى
  // لو نُفِّذ الاثنان معًا) — لضمان عودة فورية وحتمية لحالة الضيف فور
  // نجاح signOut()، دون إنشاء أي جلسة ضيف جديدة يدويًا هنا.
  currentAuthUser = null;
  refreshAuthUI();
  closeAccountSidebar();
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
