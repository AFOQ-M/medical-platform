// ============================================================
// Phase 4B — أساس المصادقة العامة (Guest / Google / Apple)
// ============================================================
//
// هذا الملف مسؤول فقط عن "أساس الهوية" على الموقع العام:
//   - ضمان وجود جلسة (Supabase Anonymous Auth) لكل زائر تلقائيًا،
//     دون أي اسم/بريد/كلمة مرور — هذا ما يجعل الموقع قابلاً للاستخدام
//     فورًا كضيف.
//   - نافذة بسيطة (Google / Apple / متابعة كضيف) تُستخدم لاحقًا من أي
//     ميزة تتطلب حسابًا فعليًا (مثل المفضلة السحابية مستقبلاً) — لا شيء
//     يعتمد عليها بعد في هذه الخطوة.
//   - ترقية الجلسة المجهولة إلى Google/Apple عبر آلية Supabase الرسمية
//     (linkIdentity) بدل إنشاء هوية تطبيق مستقلة ثانية.
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
 * Google/Apple عبر Supabase OAuth الرسمي (لا منطق OAuth مخصّص، لا أسرار
 * في الكود). إن كانت الجلسة الحالية جلسة ضيف، نحاول أولاً ترقيتها بنفس
 * الهوية (linkIdentity) بدل فتح حساب تطبيق ثانٍ منفصل. إن تعذّر ذلك
 * (مثلاً Manual Linking غير مفعّلة من لوحة التحكم بعد)، نرجع لتسجيل
 * دخول عادي بنفس المزوّد.
 */
async function continueWithProvider(provider) {
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

    // "Manual linking is disabled" أو ما شابه → لوحة تحكم Supabase تحتاج
    // تفعيل Manual Linking لهذا المشروع؛ نرجع لتسجيل دخول عادي بدل تعليق
    // الزائر بلا أي مسار متاح.
    console.warn("تعذّرت ترقية جلسة الضيف مباشرةً، جارٍ تسجيل دخول عادي:", error);
  }

  return supabaseClient.auth.signInWithOAuth({ provider, options: { redirectTo } });
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
        <button type="button" class="btn btn-outline" id="auth-google-btn">المتابعة عبر Google <span class="badge-soon">قريبًا</span></button>
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
    const { error } = await continueWithGoogle();
    if (error) {
      console.error(error);
      showToast("تعذّر بدء تسجيل الدخول عبر Google الآن");
    }
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
  line.textContent = isGuestUser(currentAuthUser)
    ? "تصفّح المنصة الآن كضيف."
    : "تم ربط حسابك بهذا المتصفح.";
}

function openAuthOverlay() {
  buildAuthOverlay();
  updateAuthStatusLine();
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

document.addEventListener("DOMContentLoaded", async () => {
  initAuthUI();
  await ensureAuthSession();

  // Phase 4B — أساس فقط: لا نغيّر أي عنصر واجهة آخر بناءً على حالة
  // الحساب بعد (لا Favorites ولا Premium)، فقط نبقي الحالة متاحة
  // لأي كود لاحق عبر currentAuthUser / isGuestUser().
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentAuthUser = session ? session.user : null;
    updateAuthStatusLine();
  });
});
