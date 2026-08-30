-- ============================================================
-- P1-Final M8 — Super Admin MFA / AAL2 Enforcement
-- ============================================================
--
-- ⚠️ STATUS: هذا الملف توثيقي فقط (repository/source-control parity).
-- الـ migration الموصوفة هنا **مُطبَّقة بالفعل على قاعدة البيانات الحية**
-- (project ref: lzmkgfxlsynaphpofblb)، مسجَّلة في
-- supabase_migrations.schema_migrations بالاسم
-- p1_final_m8_super_admin_aal2_enforcement (version 20260830162042).
-- تم التحقق من محتواها بمطابقة pg_get_functiondef() الحي حرفيًا مع نص
-- الـ migration المسجَّل قبل إنشاء هذا الملف.
--
-- لا تنفيذ مُرخَّص لهذا الملف كجزء من مهمة المزامنة هذه — وجوده هنا
-- الغرض الوحيد منه إبقاء نسخة المستودع (sql/) متسقة مع الحالة الحية،
-- بحيث لا يُضلَّل أي قارئ لاحق بالنسخة القديمة الموجودة في
-- sql/phase4b_p1_7b_mfa_enforcement.sql (التي ما زالت — عمدًا، للحفاظ
-- على دقة التاريخ — تعكس المنطق الأقدم حيث كان super_admin يُعاد صحيحًا
-- *قبل* فحص MFA). هذا الملف هو الإصلاح اللاحق لذلك المنطق.
--
-- ============================================================
-- المشكلة التي عالجتها (اكتُشفت في SUPABASE DATABASE DEEP AUDIT):
-- ============================================================
-- كانت fn_has_permission() وfn_is_super_admin() تُعيدان صلاحية كاملة
-- لحساب super_admin *قبل* فحص ما إذا كان هذا الحساب سجّل عامل MFA
-- (TOTP) بحالة verified يتطلّب aal2. النتيجة: حساب super_admin فعّل
-- MFA يبقى بكامل صلاحياته حتى في جلسة aal1 (كلمة مرور فقط بلا العامل
-- الثاني) — تحييد فعلي لحماية MFA لأعلى حساب صلاحية في النظام.
--
-- ============================================================
-- الإصلاح:
-- ============================================================
-- فحص MFA/AAL2 أصبح يُقيَّم *قبل* اختصار (shortcut) صلاحية super_admin
-- في الدوال الثلاث. حساب بلا أي factor بحالة verified غير متأثر إطلاقًا
-- (فرع "if exists (verified factor)" يُتخطّى تمامًا كما كان). منطق
-- admin/staff لم يتغيّر — فحص MFA/AAL2 كان أصلاً يسبق فحص صلاحياتهم؛
-- فقط ترتيب super_admin بالنسبة لهذا الفحص هو ما تغيّر.
--
-- السلوك النهائي المطلوب والمُحقَّق حيًا:
--   super_admin + MFA مفعّلة + aal1  = DENIED
--   super_admin + MFA مفعّلة + aal2  = ALLOWED
--   admin/staff + MFA مفعّلة + aal1  = DENIED   (لم يتغيّر)
--   admin/staff + MFA مفعّلة + aal2  = ALLOWED  (لم يتغيّر)
--   أي دور بلا MFA مفعّلة            = السلوك القديم دون أي تغيير
--
-- التوقيعات، أسماء المعاملات، أنواع الإرجاع، الـ volatility، وsearch_path
-- كلها بلا تغيير — فقط الترتيب الداخلي للفحوصات الموجودة أصلاً تغيّر.
-- لا سياسات RLS جديدة، لا أعمدة جديدة، لا جداول جديدة.
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

  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      return false;
    end if;
  end if;

  if v_role = 'super_admin' then
    return true;
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

  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
      return false;
    end if;
  end if;

  if v_role = 'super_admin' then
    return true;
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

-- fn_is_super_admin(): أُبقيت كتعبير LANGUAGE SQL واحد (نفس أسلوبها
-- السابق) لتبقى قابلة للاستخدام مباشرة داخل عبارات RLS
-- (qual/with_check). أصبحت تُعيد true فقط عندما يكون المستخدم
-- super_admin نشطًا، وفي نفس الوقت (لا يملك أي factor verified) أو
-- (يملك factor verified وهو حاليًا في aal2).
create or replace function public.fn_is_super_admin()
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'super_admin' and active = true
  )
  and (
    not exists (
      select 1 from auth.mfa_factors
      where user_id = auth.uid() and status = 'verified'
    )
    or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
  );
$function$;
