-- ============================================================
-- P1-Final M9 — Core Table Grant Hardening
-- ============================================================
--
-- ⚠️ STATUS: هذا الملف توثيقي فقط (repository/source-control parity).
-- الـ migration الموصوفة هنا **مُطبَّقة بالفعل على قاعدة البيانات الحية**
-- (project ref: lzmkgfxlsynaphpofblb)، مسجَّلة في
-- supabase_migrations.schema_migrations بالاسم
-- p1_final_m9_core_table_grant_hardening (version 20260830162055).
-- تم التحقق من محتواها بمطابقة pg_class.relacl الحي حرفيًا (لا TRUNCATE
-- ولا TRIGGER ولا REFERENCES ممنوحة لـ anon/authenticated على الجداول
-- التسعة أدناه) مع نص الـ migration المسجَّل قبل إنشاء هذا الملف.
--
-- لا تنفيذ مُرخَّص لهذا الملف كجزء من مهمة المزامنة هذه.
--
-- ============================================================
-- الفرق عن نمط M1 (sql/p1_final_m1_revoke_table_grants.sql):
-- ============================================================
-- M1 طبّقت REVOKE ALL على جدولين بلا أي سياسة RLS إطلاقًا (deny-all
-- بالتصميم: report_rate_limits, resource_view_cooldowns) — لا وصول
-- مباشر مقصود لهما إطلاقًا، فقط عبر RPCs (submit_public_report,
-- increment_resource_view).
--
-- الجداول التسعة هنا مختلفة جوهريًا: تُقرأ/تُكتَب مباشرة عبر PostgREST
-- بحماية RLS فعليًا (SELECT عام على universities/faculties/years/
-- subjects/resources للزوار؛ INSERT/UPDATE/DELETE من الأدمن عبر
-- fn_has_permission() ضمن سياسات RLS). لذلك **لم يُطبَّق REVOKE ALL**
-- هنا — SELECT/INSERT/UPDATE/DELETE تبقى ممنوحة وتستمر كمسار الوصول
-- الصحيح والضروري، محميةً بالكامل بسياسات RLS القائمة (لم تتغيّر بهذه
-- الـ migration).
--
-- ما تم سحبه فعليًا: TRUNCATE, TRIGGER, REFERENCES فقط. هذه الصلاحيات
-- الثلاث لا تُستخدم إطلاقًا من التطبيق، وليست مضبوطة بـ RLS على الإطلاق
-- (RLS لا يحكم TRUNCATE ولا TRIGGER ولا REFERENCES بتاتًا في Postgres).
-- TRUNCATE تحديدًا هي المخاطرة الحقيقية التي رصدها التدقيق: صلاحية على
-- مستوى الجدول لا يمكن لأي سياسة RLS تقييدها إطلاقًا. سحب
-- TRIGGER/REFERENCES تحصين إضافي بلا أي أثر وظيفي (لا استخدام مشروع لها
-- عبر واجهة PostgREST/Supabase-JS أصلاً).
--
-- ⚠️ ملاحظة نطاق (Remaining Finding — لم تُعالَج، غير مُرخَّصة هنا):
-- صلاحية MAINTAIN (خاصية Postgres 17 الجديدة: تشمل VACUUM/ANALYZE/
-- REINDEX/CLUSTER) لا تزال ممنوحة لـ anon/authenticated على هذه
-- الجداول التسعة، وهي — مثل TRUNCATE تمامًا — غير مضبوطة بـ RLS
-- إطلاقًا. لم تُذكر في التدقيق الأصلي ولم تُعالَج في هذه الـ migration
-- عمدًا (خارج النطاق المُرخَّص). تحتاج تفويضًا صريحًا منفصلاً (FIX3
-- محتمل) قبل أي تعديل عليها.
-- ============================================================

revoke truncate, trigger, references on
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
