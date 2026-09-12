-- ============================================================
-- P1-Final M10 — Revoke MAINTAIN (PG17) from anon/authenticated
-- ============================================================
--
-- ⚠️ STATUS: هذا الملف توثيقي فقط (repository/source-control parity) —
-- نفس نمط p1_final_m9_core_table_grant_hardening.sql. لا يُنفَّذ كجزء
-- من هذه المهمة بأي حال (لا اتصال بقاعدة بيانات حية من بيئة العمل هذه).
-- يوثّق التغيير المقترح لإغلاق البند المتبقي الذي أعلنه m9 بنفسه:
-- صلاحية MAINTAIN (خاصية Postgres 17 الجديدة: تشمل VACUUM/ANALYZE/
-- REINDEX/CLUSTER) لا تزال ممنوحة لـ anon/authenticated على الجداول
-- التسعة أدناه، وهي — مثل TRUNCATE تمامًا — غير مضبوطة بـ RLS إطلاقًا.
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
--    سواء على جداول lz أم على هذه الجداول التسعة.
-- 4) لا توسّع في صلاحيات anon/authenticated: REVOKE يزيل صلاحية فقط؛
--    لا يُمنح أي شيء جديد بأي شكل (لا GRANT ولا معاملة عكسية).
--    REVOKE على مستوى جدول لا يمكن أبدًا أن يزيد ما يستطيع anon فعله.
--
-- الخلاصة: REVOKE MAINTAIN لا يمس أي مسار وصول قائم (SELECT/RLS-CRUD/
-- RPCs) ويعالج الصدع الحقيقي الوحيد المتبقي من m9 — صلاحية جدول لا
-- يضبطها RLS. الإثبات أعلاه إثبات ثابت (static) من النصوص؛ لا أثر
-- تنفيذي حي هنا.
--
-- ⚠️ متطلب إصدار: MAINTAIN صالحة فقط على PostgreSQL 17+ (الخاصية
--   المعاد تسميتها من مساحة الأسماء "M" القديمة). أي محاولة تنفيذ على
--   إصدار أقدم يرفضها Postgres برسالة "unrecognized privilege type".
--   عند التطبيق الفعلي على قاعدة حية لاحقًا: تأكد من server_version >= 17
--   أولًا (عبر `SHOW server_version;`).
--
-- يعتمد ترتيبًا لا على شيء (منفصل عن m9) لكنه يأتي بعده توثيقيًا؛ لا
-- يُعدَّل p1_final_m9_core_table_grant_hardening.sql نفسه.
-- ============================================================

revoke maintain on
  public.universities,
  public.faculties,
  public.years,
  public.subjects,
  public.resources,
  public.profiles,
  public.user_permissions,
  public.reports,
  public.admin_activity_log
from anon, authenticated;