-- ============================================================
-- AFOQ-SUPABASE-APPLY.sql — حزمة تطبيق واحدة جاهزة للصق
-- ============================================================
-- المشروع: أفق المعرفة (afoq-m.pages.dev) — Supabase ref: lzmkgfxlsynaphpofblb
-- التاريخ: 2026-09-25
--
-- ⚠️ حالة التنفيذ على القاعدة الحية (2026-09-25، عبر Supabase MCP/Management API):
--   تم تنفيذ والتحقق من كل ما يلي على lzmkgfxlsynaphpofblb:
--     ✅ STAGE 1 (P0-2): FK cascade→set null + trg_admin_lock_full_empty_guard
--        (تحقق: confdeltype='n'، حذف الصف يرفض 55006 — اختبار وظيفي حي)
--     ✅ STAGE 5 (M15): fn_mfa_aal2_ok + الدوال الثلاث ببوابة MFA/AAL2
--     ✅ إضافي: revoke all on forum_reports from anon + revoke delete from
--        authenticated (مطابقة لنية phase6 — كانت anon تملك كل الصلاحيات)
--   وُجدت مطبّقة أصلًا (لم تُعد): M11 (ACL في acquire)، M12 (حارس المنتدى)،
--   M13 (سياسة مشدّدة + جدول الحد + submit_public_report)، M14 (سياسات
--   reports الحديثة فقط)، P1-4 (authenticated يملك UPDATE فعلًا).
--   الحزمة أدناه تبقى آمنة/idempotent لإعادة التشغيل على بيئة جديدة
--   (كل العبارات CREATE OR REPLACE / DROP IF EXISTS / IF NOT EXISTS).
--
-- هذه الحزمة تنفّذ على قاعدة البيانات كل الإصلاحات التي
-- وثّقها تقرير التدقيق (.opencode/audit-report.md) وتمت مراجعتها
-- محليًا في sql/:
--
--   STAGE 1  P0-2 : admin_session_lock.user_id — cascade → set null
--                   + trigger حارس full_or_empty (يمنع الحذف)
--   STAGE 2  P1-4 : GRANT UPDATE on forum_reports (مراجعة بلاغات الأدمن)
--   STAGE 3  M14  : schema.sql replay guard (إزالة سياسات reports الضعيفة)
--   STAGE 4  M11  : acquire_admin_session_lock — ACL حقيقي (لا دور فقط)
--   STAGE 5  M15  : دوال القفل الثلاث — بوابة MFA/AAL2 (SQL-006)
--   STAGE 6  M12  : حارس تعديل صاحب المحتوى في المنتدى (F4)
--   STAGE 7  M13  : سلامة إنشاء بلاغات المنتدى + حد زمني (F5)
--   STAGE 8  تحقق  : استعلامات smoke-test
--
-- ⚠️ طريقة التنفيذ الموصى بها:
--   1) نفّذ في بيئة sandbox/staging أولًا (مطلوب لـ M12/M13).
--   2) على الحية: Supabase SQL Editor — الصق الحزمة كاملة.
--      (محرر Supabase يلفّ كل شيء في معاملة واحدة: أي فشل = rollback كامل.)
--   3) راجع مخرجات STAGE 8 قبل إغلاق المحرر.
--   4) إن فشل أي STAGE: لا تكرر الصق — اقرأ الخطأ، أصلح، أعد.
--
-- المتطلبات المسبقة (يجب أن تكون مطبّقة أصلًا):
--   schema_phase2.sql (fn_has_permission, fn_is_super_admin, M8 MFA)
--   phase4a/phase4b (submit_public_report, report_rate_limits)
--   phase6_forum_mvp.sql (جداول المنتدى + fn_forum_is_real_user)
--   phase7 (سياسات مراجعة بلاغات الأدمن admin_update_*)
-- ============================================================

-- ============================================================
-- STAGE 1 — P0-2: إصلاح FK القفل (cascade → set null) + الحارس
-- ============================================================
-- المشكلة (P0): الحذف المتسلسل كان يمسح صف القفل الوحيد عند حذف
-- مستخدم auth يحمل القفل → لوحة الأدمن تفقد قفلها نهائيًا (لا يمكن
-- إعادة إنشاء الصف عبر RLS deny-all). الإصلاح: set null + trigger
-- يفرّغ بقية الأعمدة ليبقى الصف "فارغًا بالكامل" (شرط full_or_empty)
-- ويمنع حذف الصف نفسه عبر أي مسار.

-- 1.1 إزالة أي FK قائم على الجدول (بأي اسم) ثم إعادة إنشائه بـ set null
do $fk$
declare
  v_con text;
begin
  select conname into v_con
  from pg_constraint
  where conrelid = 'public.admin_session_lock'::regclass
    and contype = 'f';
  if v_con is not null then
    execute format('alter table public.admin_session_lock drop constraint %I', v_con);
  end if;
end;
$fk$;

alter table public.admin_session_lock
  add constraint admin_session_lock_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

-- 1.2 ضمان وجود الصف الوحيد (idempotent)
insert into public.admin_session_lock (id) values (true)
on conflict (id) do nothing;

-- 1.3 حارس full_or_empty + منع الحذف
create or replace function public.fn_admin_lock_full_empty_guard()
returns trigger
language plpgsql
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'admin_session_lock singleton cannot be deleted' using errcode = '55006';
  end if;

  if new.user_id is null then
    new.session_token := null;
    new.acquired_at  := null;
    new.last_seen_at := null;
    new.expires_at   := null;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_admin_lock_full_empty_guard on public.admin_session_lock;
create trigger trg_admin_lock_full_empty_guard
  before update or delete on public.admin_session_lock
  for each row execute function public.fn_admin_lock_full_empty_guard();

-- ============================================================
-- STAGE 2 — P1-4: GRANT UPDATE على forum_reports
-- ============================================================
-- سياسات مراجعة بلاغات الأدمن (phase7: admin_update_forum_reports)
-- تحتاج صلاحية UPDATE على مستوى الجدول — بدونها تفشل المراجعة بـ42501
-- على قاعدة حية حتى لو وُجدت السياسة.
grant select, insert, update on forum_reports to authenticated;

-- ============================================================
-- STAGE 3 — M14: schema.sql replay guard (SQL-050, P0)
-- ============================================================
-- إعادة تشغيل sql/schema.sql التاريخي على قاعدة حية يعيد تثبيت
-- سياسات ضعيفة (admin_read_reports/admin_delete_reports) تمنح أي
-- مستخدم authenticated قراءة+حذف كامل قائمة البلاغات. هذا الحارس
-- يزيلها ويؤكد وجود البدائل الحديثة (auth_read_reports/auth_delete_reports).

drop policy if exists "admin_read_reports"   on public.reports;
drop policy if exists "admin_delete_reports" on public.reports;

do $guard$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'reports'
      and policyname in ('admin_read_reports', 'admin_delete_reports')
  ) then
    raise exception 'M14: legacy weak reports policies still present; abort'
      using errcode = 'P0001',
            hint = 'schema.sql was replayed AFTER this guard dropped them; re-run M14 as the final step';
  end if;
end;
$guard$;

do $assert$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'reports'
      and policyname in ('auth_read_reports', 'auth_delete_reports')
  ) then
    raise exception 'M14: modern scoped reports policies missing; must run schema_phase2 first'
      using errcode = 'P0001',
            hint = 'Run sql/schema_phase2.sql before M14';
  end if;
end;
$assert$;

-- ============================================================
-- STAGE 4 — M11: acquire_admin_session_lock — ACL حقيقي
-- ============================================================
-- أي حساب staff تلقائي (يُنشأ تلقائيًا لكل مستخدم Auth جديد) كان
-- يستطيع احتكار قفل الأدمن الوحيد. الآن يُشترط تفويض إداري حقيقي:
-- super_admin (نشط) أو سطر user_permissions نشط واحد على الأقل.
-- (ملاحظة: STAGE 5 يعيد تعريف الدالة نفسها بنسخة M11+MFA — هذا
--  STAGE يبقى للتوثيق/التسلسل الصحيح إن أُريد تطبيق M11 وحده.)

create or replace function public.acquire_admin_session_lock()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean;
  v_token uuid := gen_random_uuid();
  v_ttl constant interval := interval '90 seconds';
  v_expires timestamptz := now() + v_ttl;
  v_updated int;
begin
  if v_uid is null then
    return jsonb_build_object('acquired', false, 'reason', 'unauthenticated');
  end if;

  select role, active into v_role, v_active
  from public.profiles
  where id = v_uid;

  if v_role is null or v_active is not true then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- M11: شرط التفويض الحقيقي — بدل الاكتفاء بعضوية الدور.
  if v_role <> 'super_admin' and not exists (
    select 1 from public.user_permissions up
    where up.user_id = v_uid and up.active = true
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- First Session Wins: تنجح فقط إن كان القفل فارغًا أو منتهي الصلاحية.
  update public.admin_session_lock
     set user_id = v_uid,
         session_token = v_token,
         acquired_at = now(),
         last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where id = true
     and (user_id is null or expires_at < now());

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object(
      'acquired', true,
      'session_token', v_token,
      'expires_at', v_expires,
      'ttl_seconds', extract(epoch from v_ttl)::int
    );
  else
    return jsonb_build_object('acquired', false, 'reason', 'locked');
  end if;
end;
$function$;

comment on function public.acquire_admin_session_lock() is
  'P1-7B (Phase 4C — First Session Wins, M11 ACL): محاولة الحصول على قفل الأدمن الوحيد. تنجح فقط إن كان القفل فارغًا أو منتهي الصلاحية، وللحسابات ذات تفويض إداري حقيقي (super_admin أو حامل سطر user_permissions نشط).';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ============================================================
-- STAGE 5 — M15: دوال القفل الثلاث — بوابة MFA/AAL2 (SQL-006)
-- ============================================================
-- سد الفجوة: كانت دوال القفل تتحقق من الدور/ACL فقط دون MFA. الآن أي
-- حساب لديه عامل MFA موثّق يجب أن يدخل بجلسة aal2 (نفس منطق M8).
-- ملاحظة: نسخة acquire هنا = M11 ACL + MFA (نسخة فائقة من STAGE 4).

create or replace function public.fn_mfa_aal2_ok()
returns boolean
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if exists (
    select 1 from auth.mfa_factors
    where user_id = auth.uid() and status = 'verified'
  ) then
    return coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
  end if;
  return true;
end;
$function$;

comment on function public.fn_mfa_aal2_ok() is
  'M15: صحيح عندما لا يكون للمستخدم factor MFA موثّق، أو عندما تكون الجلسة aal2. كاذب لمستخدم موثّق العامل في جلسة aal1 — يُستخدم كبوابة موحّدة لدوال اللوحة الحساسة.';

revoke all on function public.fn_mfa_aal2_ok() from public, anon;
grant execute on function public.fn_mfa_aal2_ok() to authenticated;

create or replace function public.acquire_admin_session_lock()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_active boolean;
  v_token uuid := gen_random_uuid();
  v_ttl constant interval := interval '90 seconds';
  v_expires timestamptz := now() + v_ttl;
  v_updated int;
begin
  if v_uid is null then
    return jsonb_build_object('acquired', false, 'reason', 'unauthenticated');
  end if;

  -- M15: MFA gate BEFORE anything else (mirrors M8 ordering).
  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('acquired', false, 'reason', 'mfa_aal2_required');
  end if;

  select role, active into v_role, v_active
  from public.profiles
  where id = v_uid;

  if v_role is null or v_active is not true then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- M11: real authorization, not mere role membership.
  if v_role <> 'super_admin' and not exists (
    select 1 from public.user_permissions up
    where up.user_id = v_uid and up.active = true
  ) then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- First Session Wins: only when lock empty or expired.
  update public.admin_session_lock
     set user_id = v_uid,
         session_token = v_token,
         acquired_at = now(),
         last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where id = true
     and (user_id is null or expires_at < now());

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object(
      'acquired', true,
      'session_token', v_token,
      'expires_at', v_expires,
      'ttl_seconds', extract(epoch from v_ttl)::int
    );
  else
    return jsonb_build_object('acquired', false, 'reason', 'locked');
  end if;
end;
$function$;

comment on function public.acquire_admin_session_lock() is
  'P1-7B (Phase 4C First Session Wins + M11 ACL + M15 MFA): قفل الأدمن الوحيد. يشترط aal2 عند وجود عامل MFA موثّق، ثم تفويضًا إداريًا حقيقيًا (super_admin أو سطر user_permissions نشط)، ثم قفلًا فارغًا/منتهي الصلاحية.';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

create or replace function public.refresh_admin_session_lock(p_session_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_ttl constant interval := interval '90 seconds';
  v_expires timestamptz := now() + v_ttl;
  v_updated int;
begin
  if v_uid is null or p_session_token is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  -- M15: a downgraded session must not keep the lock breathing.
  if not public.fn_mfa_aal2_ok() then
    return jsonb_build_object('ok', false, 'reason', 'mfa_aal2_required');
  end if;

  update public.admin_session_lock
     set last_seen_at = now(),
         expires_at = v_expires,
         updated_at = now()
   where id = true
     and user_id = v_uid
     and session_token = p_session_token
     and expires_at >= now();

  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object('ok', true, 'expires_at', v_expires);
  else
    return jsonb_build_object('ok', false, 'reason', 'not_owner_or_expired');
  end if;
end;
$function$;

comment on function public.refresh_admin_session_lock(uuid) is
  'P1-7B heartbeat + M15: يمدّد expires_at فقط إذا كان auth.uid() هو صاحب القفل، والتوكن يطابق، والصلاحية باقية، والجلسة aal2 إن كان عامل MFA موثّقًا.';

revoke all on function public.refresh_admin_session_lock(uuid) from public, anon;
grant execute on function public.refresh_admin_session_lock(uuid) to authenticated;

create or replace function public.release_admin_session_lock(p_session_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_updated int;
begin
  if v_uid is null or p_session_token is null then
    return false;
  end if;

  -- M15: only a still-valid aal2 session may release the lock.
  if not public.fn_mfa_aal2_ok() then
    return false;
  end if;

  update public.admin_session_lock
     set user_id = null, session_token = null, acquired_at = null,
         last_seen_at = null, expires_at = null, updated_at = now()
   where id = true
     and user_id = v_uid
     and session_token = p_session_token;

  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

comment on function public.release_admin_session_lock(uuid) is
  'P1-7B logout + M15: تحرير طوعي للقفل، لا يعمل إلا لصاحبه بتوكن مطابق وجلسة aal2 سليمة.';

revoke all on function public.release_admin_session_lock(uuid) from public, anon;
grant execute on function public.release_admin_session_lock(uuid) to authenticated;

-- ============================================================
-- STAGE 6 — M12: حارس تعديل صاحب المحتوى في المنتدى (F4)
-- ============================================================
-- سياسات RLS "update_own_*" تحكم الصف فقط (author_id = auth.uid())
-- دون تحكم بالأعمدة. كان بإمكان صاحب المحتوى تعديل أعمدة الوساطة/
-- الهوية/الإسناد على صفوفه (is_hidden/is_locked/author_name/
-- category_id/topic_id). الحارس يمنع ذلك لغير الأدمن مع إبقاء مراجعة
-- الأدمن كما هي (fn_is_super_admin أو fn_has_permission reports/edit).

create or replace function public.fn_forum_guard_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_is_admin boolean;
begin
  select (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit'))
    into v_is_admin;

  if v_is_admin then
    return new;
  end if;

  if tg_table_name = 'forum_topics' then
    if new.is_hidden   is distinct from old.is_hidden
       or new.is_locked is distinct from old.is_locked
       or new.author_name is distinct from old.author_name
       or new.category_id is distinct from old.category_id
    then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'F4: moderation/identity/category columns are admin-only on forum_topics';
    end if;
  elsif tg_table_name = 'forum_replies' then
    if new.is_hidden is distinct from old.is_hidden
       or new.author_name is distinct from old.author_name
       or new.topic_id is distinct from old.topic_id
    then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'F4: moderation/identity/topic columns are admin-only on forum_replies';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.fn_forum_guard_owner_update() is
  'M12/F4: يمنع صاحب المحتوى (غير الأدمن) من تغيير أعمدة الوساطة/الهوية على صفوفه هو في المنتدى عبر PostgREST — دون مساس بمراجعة الأدمن (fn_is_super_admin/fn_has_permission reports/edit).';

drop trigger if exists trg_forum_guard_owner_update on public.forum_topics;
create trigger trg_forum_guard_owner_update
  before update on public.forum_topics
  for each row execute function public.fn_forum_guard_owner_update();

drop trigger if exists trg_forum_guard_owner_update on public.forum_replies;
create trigger trg_forum_guard_owner_update
  before update on public.forum_replies
  for each row execute function public.fn_forum_guard_owner_update();

-- ============================================================
-- STAGE 7 — M13: سلامة بلاغات المنتدى + حد زمني (F5)
-- ============================================================
-- أ) تثبيت حالة البلاغ الجديد (status='pending', reviewed_*=null) —
--    لا يمكن تزوير حالة مراجعة عند الإنشاء.
-- ب) حد 10 بلاغات / 10 دقائق لكل مبلّغ (جدول عدّاد داخلي بلا RLS).
-- ج) submit_public_report يرفض الأهداف غير المنشورة (not_found).

drop policy if exists "insert_own_forum_reports" on public.forum_reports;

create policy "insert_own_forum_reports"
  on public.forum_reports for insert
  with check (
    reporter_id = auth.uid()
    and fn_forum_is_real_user()
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
  );

create table if not exists public.forum_report_rate_limits (
  reporter_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default now(),
  report_count integer not null default 0
);

comment on table public.forum_report_rate_limits is
  'F5/M13: عدّاد مؤقت لكل مبلّغ (يُعرَّف بهويته authenticated لا IP) لمنع إغراق قائمة مراجعة بلاغات المنتدى. لا وصول مباشر — يُدار من trigger SECURITY DEFINER فقط.';

alter table public.forum_report_rate_limits enable row level security;

create or replace function public.fn_forum_report_write_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_max_requests constant integer := 10;
  v_window       constant interval := interval '10 minutes';
  v_row          public.forum_report_rate_limits;
begin
  new.status      := 'pending';
  new.reviewed_by := null;
  new.reviewed_at := null;

  insert into public.forum_report_rate_limits (reporter_id, window_start, report_count)
  values (new.reporter_id, now(), 0)
  on conflict (reporter_id) do nothing;

  select * into v_row
  from public.forum_report_rate_limits
  where reporter_id = new.reporter_id
  for update;

  if now() - v_row.window_start > v_window then
    update public.forum_report_rate_limits
      set window_start = now(), report_count = 1
      where reporter_id = new.reporter_id;
  elsif v_row.report_count >= v_max_requests then
    raise exception 'rate_limit_exceeded'
      using errcode = 'P0001',
            hint = 'too many forum reports from this user, try again later';
  else
    update public.forum_report_rate_limits
      set report_count = v_row.report_count + 1
      where reporter_id = new.reporter_id;
  end if;

  return new;
end;
$function$;

comment on function public.fn_forum_report_write_guard() is
  'F5/M13: يمنع الإنشاء المتلاعب ببلاغات المنتدى (status/reviewed_*) ويفرض حد 10 بلاغات/10 دقائق لكل مبلّغ.';

drop trigger if exists trg_forum_report_write_guard on public.forum_reports;
create trigger trg_forum_report_write_guard
  before insert on public.forum_reports
  for each row execute function public.fn_forum_report_write_guard();

create or replace function public.submit_public_report(p_resource_id uuid, p_reason text, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_max_requests constant integer := 5;
  v_window       constant interval := interval '10 minutes';
  v_raw_ip       text;
  v_rate_key     text;
  v_row          public.report_rate_limits;
begin
  -- (F5) الهدف يجب أن يكون موردًا منشورًا فعلًا.
  if not exists (
    select 1 from public.resources
    where id = p_resource_id and status = 'published'
  ) then
    raise exception 'not_found'
      using errcode = 'P0001',
            hint = 'resource not found or not published';
  end if;

  begin
    v_raw_ip := current_setting('request.headers', true)::json ->> 'cf-connecting-ip';
  exception when others then
    v_raw_ip := null;
  end;

  if v_raw_ip is null or btrim(v_raw_ip) = '' then
    v_raw_ip := 'unknown';
  end if;

  -- Phase 4B hotfix: digest() lives in schema `extensions`, not `public`.
  v_rate_key := encode(extensions.digest(btrim(v_raw_ip), 'sha256'), 'hex');

  insert into public.report_rate_limits (rate_key, window_start, count)
  values (v_rate_key, now(), 0)
  on conflict (rate_key) do nothing;

  select * into v_row from public.report_rate_limits where rate_key = v_rate_key for update;

  if now() - v_row.window_start > v_window then
    update public.report_rate_limits
      set window_start = now(), count = 1
      where rate_key = v_rate_key;
  elsif v_row.count >= v_max_requests then
    raise exception 'rate_limit_exceeded'
      using errcode = 'P0001',
            hint = 'too many reports from this source, try again later';
  else
    update public.report_rate_limits
      set count = v_row.count + 1
      where rate_key = v_rate_key;
  end if;

  insert into public.reports (resource_id, reason, note)
  values (p_resource_id, p_reason, nullif(btrim(coalesce(p_note, '')), ''));
end;
$function$;

-- ============================================================
-- STAGE 8 — التحقق (smoke tests) — راجع المخرجات قبل الإغلاق
-- ============================================================

-- 8.1 سياسات reports: يجب ألا تظهر admin_read_reports/admin_delete_reports
select policyname, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'reports'
order by policyname;

-- 8.2 FK القفل: يجب أن يكون on delete set null
select conname, confdeltype
from pg_constraint
where conrelid = 'public.admin_session_lock'::regclass
  and contype = 'f';
-- confdeltype: 'n' = set null (مطلوب) | 'c' = cascade (خطأ — لم يُطبَّق)

-- 8.3 دوال القفل: يجب أن تظهر النسخ M15 (MFA) — تحقق من التعليقات
select p.proname, obj_description(p.oid) as comment
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('acquire_admin_session_lock', 'refresh_admin_session_lock',
                    'release_admin_session_lock', 'fn_mfa_aal2_ok',
                    'fn_admin_lock_full_empty_guard')
order by p.proname;

-- 8.4 حراس المنتدى: يجب أن يظهرا مع triggersهما
select tgname, tgrelid::regclass as tbl
from pg_trigger
where tgname in ('trg_forum_guard_owner_update', 'trg_forum_report_write_guard',
                 'trg_admin_lock_full_empty_guard')
  and not tgisinternal
order by tgname;

-- 8.5 جدول حد بلاغات المنتدى موجود
select to_regclass('public.forum_report_rate_limits') as rate_limit_table;

-- ============================================================
-- ROLLBACK (نفّذ يدويًا فقط عند الحاجة — لا يُنفَّذ هنا)
-- ============================================================
--   -- M13
--   drop trigger if exists trg_forum_report_write_guard on public.forum_reports;
--   drop function if exists public.fn_forum_report_write_guard();
--   drop table if exists public.forum_report_rate_limits;
--   drop policy if exists "insert_own_forum_reports" on public.forum_reports;
--   -- أعد تعريف insert_own_forum_reports من phase6_forum_mvp.sql،
--   -- وأعد تعريف submit_public_report من phase4b_p0_3_p0_4_digest_schema_fix.sql
--   -- M12
--   drop trigger if exists trg_forum_guard_owner_update on public.forum_topics;
--   drop trigger if exists trg_forum_guard_owner_update on public.forum_replies;
--   drop function if exists public.fn_forum_guard_owner_update();
--   -- M15
--   drop function if exists public.fn_mfa_aal2_ok();
--   -- أعد تعريف acquire/refresh/release من M11 وphase4c (أو من نسخة احتياطية)
--   -- M14
--   -- لا rollback مطلوب (الحالة النهائية = الحالة الصحيحة للإنتاج)
--   -- STAGE 1 (P0-2)
--   drop trigger if exists trg_admin_lock_full_empty_guard on public.admin_session_lock;
--   drop function if exists public.fn_admin_lock_full_empty_guard();
--   alter table public.admin_session_lock drop constraint if exists admin_session_lock_user_id_fkey;
--   alter table public.admin_session_lock
--     add constraint admin_session_lock_user_id_fkey
--     foreign key (user_id) references auth.users(id) on delete cascade;
-- ============================================================
-- نهاية الحزمة — AFOQ-SUPABASE-APPLY.sql
-- ============================================================