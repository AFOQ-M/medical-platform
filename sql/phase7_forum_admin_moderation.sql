-- ============================================================
-- Phase 7 — Forum Admin Moderation + Grant Hardening
-- ============================================================
--
-- يعالج ملاحظتين من تدقيق الإنتاج النهائي:
-- (1) لا توجد صلاحية أدمن لمراجعة بلاغات المنتدى — الآن تُضاف.
-- (2) جداول المنتدى الأربعة تحمل صلاحيات TRUNCATE/TRIGGER/REFERENCES/
--     MAINTAIN لـ anon/authenticated دون داعٍ (لم تُشمل بتحصين M1/M9
--     لأنها أُنشئت لاحقًا) — تُسحَب الآن لتتوافق مع نفس معيار الجداول
--     الأساسية.
--
-- لا DROP لأي جدول. لا تعديل على أي جدول خارج المنتدى. لا تعديل على
-- user_permissions (لا نوع صلاحية جديد — إعادة استخدام entity_type
-- الموجود أصلًا 'reports' لتفادي أي تعديل على جدول الصلاحيات نفسه).
-- ============================================================

-- ------------------------------------------------------------
-- 1) تحصين Grants — سحب TRUNCATE/TRIGGER/REFERENCES/MAINTAIN من
--    anon/authenticated على جداول المنتدى الأربعة (نفس نمط M9)
-- ------------------------------------------------------------

revoke truncate, trigger, references, maintain on forum_categories from anon, authenticated;
revoke truncate, trigger, references, maintain on forum_topics     from anon, authenticated;
revoke truncate, trigger, references, maintain on forum_replies    from anon, authenticated;
revoke truncate, trigger, references, maintain on forum_reports    from anon, authenticated;

-- ------------------------------------------------------------
-- 2) سياسات RLS جديدة — مراجعة الأدمن لبلاغات المنتدى
-- ------------------------------------------------------------
-- إعادة استخدام fn_is_super_admin()/fn_has_permission('reports', ...)
-- الموجودتين أصلًا (schema_phase2.sql) — بنفس منطق صلاحية "التقارير"
-- الحالية للموارد، بدل نظام صلاحيات منفصل للمنتدى.

-- الأدمن (super_admin أو من لديه صلاحية 'reports'/'view') يرى كل
-- البلاغات، وليس فقط بلاغاته هو.
create policy "admin_read_all_forum_reports"
  on forum_reports for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

-- الأدمن (بصلاحية 'reports'/'edit') يستطيع تحديث حالة البلاغ
-- (status/reviewed_at/reviewed_by) — المستخدم العادي يبقى بلا أي
-- صلاحية UPDATE على forum_reports كما كان (لا تغيير على تلك السياسة).
create policy "admin_update_forum_reports"
  on forum_reports for update
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'))
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

-- ------------------------------------------------------------
-- 3) سياسات RLS جديدة — رؤية الأدمن الكاملة للمحتوى المُبلَّغ عنه
-- ------------------------------------------------------------
-- ضرورية لأن سياسة القراءة العامة الحالية تُخفي المواضيع/الردود
-- المخفاة (is_hidden=true) عن غير صاحبها — الأدمن يحتاج رؤيتها
-- لمراجعة البلاغ نفسه (بما فيها ما أخفاه هو مسبقًا).

create policy "admin_read_all_forum_topics"
  on forum_topics for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

create policy "admin_read_all_forum_replies"
  on forum_replies for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

-- ------------------------------------------------------------
-- 4) سياسات RLS جديدة — إخفاء/إظهار الأدمن لمحتوى مُبلَّغ عنه
-- ------------------------------------------------------------
-- سياسات UPDATE إضافية (منفصلة عن update_own_forum_topics/replies
-- الموجودتين أصلًا لصاحب المحتوى — لا تعديل عليهما). الواجهة الإدارية
-- تُحدِّث حقل is_hidden فقط (بنفس نمط toggleResourceHidden الحالي
-- للموارد)، لكن RLS هنا يسمح بـUPDATE عمومًا (Postgres RLS لا يقيّد
-- على مستوى عمود واحد بسهولة) — نفس المعيار المتّبع فعليًا في كل
-- سياسات الأدمن الأخرى بالمشروع (resources/courses).

create policy "admin_update_forum_topics_moderation"
  on forum_topics for update
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'))
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

create policy "admin_update_forum_replies_moderation"
  on forum_replies for update
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'))
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

-- ============================================================
-- نهاية Phase 7 — لا DROP، لا تعديل على أي جدول/سياسة موجودة سابقًا.
-- ============================================================
