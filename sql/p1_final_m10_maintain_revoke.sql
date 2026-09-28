-- ============================================================
-- P1-Final M10 — Revoke MAINTAIN (PG17) from anon/authenticated
-- ============================================================
--
-- ⚠️ STATUS: مُنفَّذ على القاعدة الحية (2026-09-26) عبر migration
--   p1_final_m10_live_revoke_maintain_gap_tables (Supabase MCP).
--   تم التحقق حيًا عبر aclexplode بعد التنفيذ:
--     ✅ courses / course_lessons: لا MAINTAIN ولا TRUNCATE ولا TRIGGER
--        ولا REFERENCES لـ anon/authenticated (SELECT/INSERT/UPDATE/DELETE
--        بقيت سليمة — RLS-protected CRUD).
--     ✅ forum_report_rate_limits: REVOKE ALL — deny-all كامل (مثل شقيقتها
--        report_rate_limits في M1). لا منح إطلاقًا لـ anon/authenticated.
--   هذا الملف يبقى مرجع parity لإعادة التشغيل على بيئة جديدة (idempotent).
--
-- ============================================================
-- **تحقق السلامة المطلوب (BATCH F-05 في الـ Spec) — لماذا يبقى كل
-- مسار وصول مشروع سليمًا بعد هذا الـ REVOKE:**
-- ============================================================
-- 1) القراءة العامة (Public SELECT): غير متأثرة — MAINTAIN لا تُشمل
--    عملية SELECT إطلاقًا، وSELECT تبقى ممنوحة كما هي (نفس حالة m9 مع
--    TRUNCATE/TRIGGER/REFERENCES). سياسات public_read_* إجمالًا كما هي.
-- 2) CRUD عبر RLS: غير متأثر — INSERT/UPDATE/DELETE تبقى ممنوحة
--    (بلا REVOKE عليها هنا) ومحمية بسياسات RLS القائمة عبر
--    fn_has_permission()/auth.role() (لم تُعدَّل هذه الـ migration).
-- 3) RPCs الحساسة (acquire/refresh/release_admin_session_lock,
--    submit_public_report, increment_resource_view ...): غير متأثرة —
--    هي SECURITY DEFINER وتعمل عبر مالك الدوال ولا تعتمد على MAINTAIN
--    سواء على جداول lz أم على هذه الجداول.
-- 4) مشغّل حد بلاغات المنتدى (fn_forum_report_write_guard): غير متأثر —
--    SECURITY DEFINER مملوك لـ postgres (نفس مالك forum_report_rate_limits)
--    → يعمل بصلاحيات المالك ولا يعتمد على منح anon/authenticated
--    (تحقق حي قبل التنفيذ: prosecdef=true, fn_owner=postgres).
-- 5) لا توسّع في صلاحيات anon/authenticated: REVOKE يزيل صلاحية فقط؛
--    لا يُمنح أي شيء جديد بأي شكل (لا GRANT ولا معاملة عكسية).
--    REVOKE على مستوى جدول لا يمكن أبدًا أن يزيد ما يستطيع anon فعله.
--
-- الخلاصة: REVOKE MAINTAIN لا يمس أي مسار وصول قائم (SELECT/RLS-CRUD/
-- RPCs) ويعالج الصدع الحقيقي الوحيد المتبقي من m9 — صلاحية جدول لا
-- يضبطها RLS. الإثبات أعلاه إثبات ثابت (static) من النصوص + تحقق حي
-- عبر aclexplode بعد التنفيذ.
--
-- ⚠️ متطلب إصدار: MAINTAIN صالحة فقط على PostgreSQL 17+ (الخاصية
--   المعاد تسميتها من مساحة الأسماء "M" القديمة). أي محاولة تنفيذ على
--   إصدار أقدم يرفضها Postgres برسالة "unrecognized privilege type".
--   القاعدة الحية: PostgreSQL 17.6 (تحقق حي عبر SHOW server_version).
--
-- نطاق التنفيذ الحي (2026-09-26):
--   الجداول التسعة الأساسية (universities/faculties/years/subjects/
--   resources/profiles/user_permissions/reports/admin_activity_log) كانت
--   نظيفة أصلًا على الحية (M9 مطبَّق v20260830162055 — لا MAINTAIN ولا
--   TRUNCATE ولا TRIGGER ولا REFERENCES). الفجوة الحقيقية المكتشفة بالفحص
--   الحي كانت على الجداول الثلاثة المنشأة لاحقًا (بعد M9/phase7):
--   courses, course_lessons (phase5) و forum_report_rate_limits (M13).
--   REVOKE أدناه يغطيها جميعًا (idempotent على الحية).
-- ============================================================

revoke maintain, truncate, trigger, references on
  public.universities,
  public.faculties,
  public.years,
  public.subjects,
  public.resources,
  public.profiles,
  public.user_permissions,
  public.reports,
  public.admin_activity_log,
  public.courses,
  public.course_lessons
from anon, authenticated;

-- deny-all (مثل M1/report_rate_limits): لا وصول مباشر مقصود إطلاقًا —
-- يُدار حصريًا عبر fn_forum_report_write_guard (SECURITY DEFINER).
revoke all on public.forum_report_rate_limits from anon, authenticated;