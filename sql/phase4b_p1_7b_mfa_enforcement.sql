-- ============================================================
-- Phase 4B — P1-7A: MFA Enforcement (اختياري حتى enrollment، RLS-level)
--
-- ⚠️ ملاحظة تسمية (P1-Final، M4): هذا الملف كان يُسمّى نفسه "P1-7B" في
-- التعليق أعلاه وقت كتابته. التسمية النهائية المعتمدة (موثَّقة في
-- sql/phase4b_p1_7b_admin_session_lock.sql وفي تقارير P1-7B-*.md
-- اللاحقة) هي: P1-7A = MFA Enforcement (هذا الملف)، وP1-7B = Admin
-- Session Lock / First Session Wins / F5 Restore. اسم الملف نفسه
-- (phase4b_p1_7b_mfa_enforcement.sql) وسجل migration المطبَّق على
-- Supabase تحت هذا الاسم بالضبط لم يُغيَّرا لتجنّب كسر migration
-- history — التصحيح هنا توثيقي فقط.
-- ============================================================
--
-- القرار المعتمد (لا يتغيّر إلا بموافقة صريحة لاحقًا):
--
--   أ) حساب بلا أي TOTP factor بحالة verified:
--      لا تغيير إطلاقًا — يستمر بنفس منطق الصلاحيات القديم تمامًا،
--      تمامًا كما كان قبل هذا الملف. (تحقّقنا حيًا أن auth.mfa_factors
--      فارغ تمامًا اليوم لكل الحسابات الأربعة الحالية، فلا أحد يتأثر
--      عند تطبيق هذا الملف.)
--
--   ب) حساب غير super_admin ولديه TOTP factor بحالة verified:
--      يُطلب aal2 (تحقّق مكتمل بالعامل الثاني عبر auth.jwt()->>'aal')
--      لأي عملية تمر عبر fn_has_permission() — أي كل عمليات RLS على
--      resources/academic_structure/reports. عند aal1 فقط: يُرفض
--      (return false) بغض النظر عن الدور/الصلاحيات الفعلية.
--
--   ج) super_admin:
--      مستثنى صراحة وبشكل دائم (في هذه المرحلة) من أي فرض MFA داخل
--      fn_has_permission() — حتى لو سجّل factor بحالة verified ولم
--      يُكمل aal2، يستمر بكامل صلاحياته دون أي منع. هذا استثناء عمل
--      مقصود، وليس سهوًا أو ثغرة.
--
-- لماذا لا تغيير على fn_is_super_admin():
--   هذه الدالة تُستخدم بشكل مستقل داخل سياسات RLS الخاصة بجداول
--   profiles وuser_permissions (تعديل/حذف)، بمعزل تام عن
--   fn_has_permission(). بما أن القرار المعتمد هو "MFA غير إجباري على
--   super_admin إطلاقًا" في هذه المرحلة، فإن ترك fn_is_super_admin()
--   دون أي شرط MFA هو **الطريقة الصحيحة** لتنفيذ ذلك القرار بدقة —
--   إضافة شرط MFA هنا كانت لتُخالف القرار المعتمد صراحة، لا أن تُحسّنه.
--   الاستثناء الوحيد المطلوب فعليًا هو داخل fn_has_permission() نفسها:
--   يُفحص v_role = 'super_admin' وتُعاد true فورًا *قبل* الوصول لأي
--   فحص MFA — تمامًا كما كان الترتيب سابقًا مع فحص الدور نفسه.
--
--   fn_is_super_admin() تبقى بلا أي CREATE OR REPLACE في هذا الملف
--   (لم تُمس إطلاقًا) — معروضة أدناه في تعليق للتوثيق فقط، لتأكيد أنها
--   فُحصت عمدًا وتُركت كما هي:
--
--   CREATE OR REPLACE FUNCTION public.fn_is_super_admin()
--    RETURNS boolean
--    LANGUAGE sql
--    STABLE SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--     select exists (
--       select 1 from profiles
--       where id = auth.uid() and role = 'super_admin' and active = true
--     );
--   $function$;
--
-- ما لم يتغيّر عمدًا في هذا الملف:
--   - نفس توقيعي (signatures) الدالتين المُعدَّلتين بالضبط.
--   - نفس RETURNS boolean.
--   - نفس STABLE SECURITY DEFINER SET search_path TO 'public'.
--   - نفس GRANTs القائمة (CREATE OR REPLACE لا يُسقط GRANTs الحالية —
--     تحقّقنا من ذلك حيًا بعد التطبيق).
--   - لا سياسات RLS جديدة ولا CREATE/DROP POLICY — كل السياسات القائمة
--     (resources، academic_structure، reports) تستدعي هاتين الدالتين
--     أصلاً، فتعديل الجسم فقط كافٍ لسريان المنطق الجديد تلقائيًا دون
--     لمس أي سياسة.
--   - لا أعمدة جديدة ولا جداول جديدة — الشرط يُقرأ مباشرة من
--     auth.mfa_factors (بنية GoTrue القائمة أصلاً) وauth.jwt().
--
-- تحقّق مسبق (Dry run داخل BEGIN...ROLLBACK قبل هذا التطبيق):
--   6 حالات اختبار مطلوبة + حالتان إضافيتان (تكافؤ overload الأربعة
--   معاملات) — جميعها طابقت التوقّع تمامًا، ثم أُعيد كل شيء بالكامل
--   (بما في ذلك تعريف الدالتين نفسه، لأن DDL في Postgres يخضع
--   للمعاملات transactional) عبر ROLLBACK قبل أي COMMIT فعلي.
-- ============================================================

create or replace function public.fn_has_permission(p_entity_type text, p_scope_id uuid, p_action text)
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_active boolean;
begin
  select role, active into v_role, v_active from profiles where id = auth.uid();

  if v_role is null or v_active is not true then
    return false;
  end if;

  -- super_admin مستثنى صراحة من فرض MFA في هذه المرحلة (استثناء عمل
  -- معتمد، راجع التعليق أعلى الملف) — لا تغيير على سلوكه الحالي.
  if v_role = 'super_admin' then
    return true;
  end if;

  -- Enforcement اختياري بالكامل: يبدأ فقط إن وُجد factor بحالة verified
  -- فعليًا لهذا الحساب تحديدًا. حساب بلا أي factor (حال كل الحسابات
  -- الحالية اليوم) لا يدخل هذا الشرط إطلاقًا ويكمل بالمنطق القديم أدناه
  -- دون أي تغيير في السلوك.
  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      return false;
    end if;
  end if;

  return exists (
    select 1 from user_permissions
    where user_id = auth.uid()
      and active = true
      and entity_type = p_entity_type
      and action = p_action
      and (
        scope_type = 'global'
        or (scope_type = 'university' and scope_id = p_scope_id)
      )
  );
end;
$function$;

create or replace function public.fn_has_permission(p_entity_type text, p_university_id uuid, p_faculty_id uuid, p_action text)
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_role text;
  v_active boolean;
begin
  select role, active into v_role, v_active from profiles where id = auth.uid();

  if v_role is null or v_active is not true then
    return false;
  end if;

  if v_role = 'super_admin' then
    return true;
  end if;

  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      return false;
    end if;
  end if;

  return exists (
    select 1 from user_permissions
    where user_id = auth.uid()
      and active = true
      and entity_type = p_entity_type
      and action = p_action
      and (
        scope_type = 'global'
        or (scope_type = 'university' and p_university_id is not null and scope_id = p_university_id)
        or (scope_type = 'faculty' and p_faculty_id is not null and scope_faculty_id = p_faculty_id)
      )
  );
end;
$function$;
