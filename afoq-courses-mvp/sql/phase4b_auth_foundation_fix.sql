-- ============================================================
-- Phase 4B — Authentication Foundation — Step 1A
-- إصلاح معماري: منع مستخدمي Supabase Anonymous Auth (زوّار/ضيوف
-- الموقع العام) من إنشاء صفوف في public.profiles (نظام الموظفين/الإدارة).
-- ============================================================
--
-- المشكلة:
--   fn_handle_new_auth_user() كانت تُنفَّذ لكل صف جديد في auth.users
--   دون استثناء، بما في ذلك الجلسات المجهولة (Anonymous Auth) التي
--   أضفناها في خطوة أساس المصادقة العامة. النتيجة: كل زائر ضيف يحصل
--   تلقائيًا على صف profiles بدور 'staff' وactive=true، رغم أنه لا
--   يملك أي صلاحيات فعلية (لا صفوف في user_permissions).
--
-- الإصلاح:
--   إعادة تعريف نفس الدالة (create or replace — لا تغيير في التريغر
--   نفسه ولا في تعريف الجدول) بإضافة فحص مبكر: إن كان الصف الجديد في
--   auth.users يمثّل مستخدمًا مجهولاً (new.is_anonymous = true)، نتجاهله
--   ونعيد NEW فورًا دون أي إدراج في profiles.
--
-- ما لم يتغيّر عمدًا:
--   - لا تعديل على جدول profiles أو أعمدته.
--   - لا تعديل على أي سياسة RLS (لا توجد أصلاً سياسة INSERT على
--     profiles؛ الإدراج يتم فقط عبر هذه الدالة الـ security definer).
--   - لا حذف ولا ترحيل لأي صفوف profiles موجودة حاليًا (بما فيها أي
--     صفوف ضيوف قديمة من قبل هذا الإصلاح — تُترك كما هي، هذا الإصلاح
--     يمنع الحالات الجديدة فقط).
--   - سلوك المستخدمين غير المجهولين (تسجيل عادي، Google/Apple،
--     Dashboard > Add user) يبقى تمامًا كما كان.
-- ============================================================

create or replace function fn_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- زوّار Supabase Anonymous Auth ليسوا موظفين/إداريين — لا صف profiles لهم.
  if new.is_anonymous then
    return new;
  end if;

  insert into public.profiles (id, email, role, active)
  values (new.id, new.email, 'staff', true)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ملاحظة: التريغر trg_on_auth_user_created نفسه (المعرّف في
-- schema_phase2.sql) لا يحتاج أي تغيير — فقط جسم الدالة تغيّر أعلاه،
-- والتريغر سيستدعي النسخة المحدَّثة تلقائيًا في المرة القادمة.
