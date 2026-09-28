/**
 * m07.js — M-07 Automated Content Screening — client boundary module.
 * ------------------------------------------------------------------
 * حدود الفحص الآلي على جانب العميل (Group B). محايدة للمزوّد وfail-closed:
 *   - M07_PROVIDER = null افتراضيًا (لا مزوّد مُهيّأ) → كل الفحوص تعود
 *     FAILURE/no_provider_configured (ثابتة A: لا نشر بلا فحص).
 *   - m07ScreenContent(...)  : استدعاء الحدود قبل أي كتابة محتوى.
 *   - m07HandleResult(...)   : الرسالة العربية المناسبة لنتيجة الفحص.
 *   - m07RecordScreeningFailure(...): تسجيل فشل فحص عبر RPC (بلاغات الموارد).
 *
 * الإنفاذ الفعلي على حدود قاعدة البيانات (M17 — fn_m07_screening_enforcement):
 * هذا الملف للرسائل/التسجيل فقط؛ لا يُنشر أي محتوى بلا فحص حتى لو تعطّل
 * هذا الملف (الدفاع في العمق — قاعدة البيانات هي المصدر الموثوق).
 *
 * التحميل: <script defer src="js/m07.js"> قبل js/forum.js و js/app.js.
 * ------------------------------------------------------------------
 */

// سجل المزوّدات (pluggable). null = لا مزوّد مُهيّأ — السلوك الافتراضي
// fail-closed. عند تهيئة مزوّد مستقبلًا: window.M07_PROVIDER = { screen: async (ctx) => ({ result: "NORMAL"|"FLAGGED", reason? }) }
var M07_PROVIDER = null;

const M07_SURFACES = ["forum_topic", "forum_reply", "forum_report", "resource_report"];

/**
 * استدعاء حدود الفحص قبل كتابة المحتوى.
 * @returns {Promise<{result: "NORMAL"|"FLAGGED"|"FAILURE", reason?: string|null}>}
 */
async function m07ScreenContent(surface, contentId, contentVersion, content, authorId) {
  // fail-closed: لا مزوّد → FAILURE (لا نشر بلا فحص — ثابتة A).
  if (!M07_PROVIDER || typeof M07_PROVIDER.screen !== "function") {
    return { result: "FAILURE", reason: "no_provider_configured" };
  }
  try {
    const verdict = await M07_PROVIDER.screen({ surface, contentId, contentVersion, content, authorId });
    const result = String((verdict && verdict.result) || "").toUpperCase();
    if (result === "NORMAL") return { result: "NORMAL" };
    if (result === "FLAGGED") return { result: "FLAGGED", reason: (verdict && verdict.reason) || null };
    // نتيجة غير صالحة من المزوّد = فشل (لا ننشر أبدًا على نتيجة غير مفهومة).
    return { result: "FAILURE", reason: "invalid_provider_result" };
  } catch (err) {
    // خطأ المزوّد = فشل (fail-closed).
    return { result: "FAILURE", reason: "provider_error" };
  }
}

/**
 * الرسالة العربية المناسبة لنتيجة الفحص (تُستخدم في رسائل النجاح بعد الكتابة).
 * @returns {string|null} null عندما لا حاجة لرسالة (NORMAL).
 */
function m07HandleResult(screening) {
  if (!screening) return null;
  if (screening.result === "FAILURE") return "تم استلام المحتوى، سيظهر بعد اكتمال الفحص الآلي";
  if (screening.result === "FLAGGED") return "تم استلام المحتوى، وهو قيد المراجعة";
  return null;
}

/**
 * تسجيل فشل فحص عبر RPC (يُستخدم لبلاغات الموارد — لا فحص DB لها).
 * @returns {Promise<object|null>} خطأ Supabase أو null عند النجاح.
 */
async function m07RecordScreeningFailure(surface, contentId, contentVersion, failureReason) {
  if (typeof supabaseClient === "undefined" || !supabaseClient) return null;
  const { error } = await supabaseClient.rpc("fn_m07_record_screening_failure", {
    p_surface: surface,
    p_content_id: contentId || null,
    p_content_version: contentVersion || 1,
    p_failure_reason: failureReason || null,
  });
  return error || null;
}