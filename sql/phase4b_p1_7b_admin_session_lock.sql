-- ============================================================
-- Phase 4B — P1-7B: Single-Admin Session Lock
-- ============================================================
--
-- ⚠️ ملاحظة تسمية مهمة (اكتُشفت أثناء الـ audit، راجع التقرير المرفق):
--   الملف sql/phase4b_p1_7b_mfa_enforcement.sql الموجود مسبقًا يحمل
--   بالفعل تسمية "P1-7B" لميزة MFA enforcement (والتعليقات داخل
--   admin/admin.js وadmin/index.html تستخدم نفس التسمية لنفس الميزة).
--   طلب التنفيذ الحالي يسمي ميزة القفل الفردي هذه "P1-7B" أيضًا بينما
--   يشير إلى MFA باعتبارها "P1-7A". لم يُعَد ترقيم أي شيء قديم (ولا
--   يجوز حسب التعليمات) — هذا الملف يُبقي اسمه الحرفي كما طُلب صراحة
--   في التعليمات (قسم 10)، لكن التعارض في الترقيم بين P1-7A/P1-7B
--   يحتاج توضيحًا/تصحيحًا من صاحب المشروع قبل أي مرحلة لاحقة تعتمد على
--   هذا الترقيم. لا علاقة تقنية بين هذا الملف وملف MFA؛ كلاهما مستقل
--   تمامًا ولا يعدّل أحدهما الآخر.
--
-- الهدف: منع وجود أكثر من جلسة Admin (super_admin/admin/staff) فعّالة
-- واحدة في لوحة التحكم في آن واحد، بفرض server/DB-enforced، مع TTL +
-- heartbeat يمنع بقاء القفل للأبد عند انقطاع الجهاز.
--
-- التصميم:
--   جدول singleton بصف واحد ثابت دائمًا (id boolean = true فقط، PK
--   يمنع أي صف ثانٍ). حالة "لا يوجد أدمن حاليًا" = user_id IS NULL.
--   الـ acquire/refresh/release الثلاثة كلها UPDATE ... WHERE بشرط
--   دقيق داخل SECURITY DEFINER function واحدة لكل عملية — الذرّية هنا
--   مضمونة من محرّك Postgres نفسه: أي UPDATE ثانٍ يحاول تعديل نفس
--   الصف بينما معاملة أولى لم تُنهِ COMMIT بعد يُحجب (row lock) حتى
--   تنتهي الأولى، ثم يعيد تقييم شرط WHERE على القيم الجديدة (Read
--   Committed / EvalPlanQual) — فلا يمكن لمعاملتين متزامنتين أن تفوزا
--   معًا بالقفل، بغض النظر عن التوقيت الدقيق لوصولهما.
--
--   الجدول نفسه: RLS مفعّلة، وبلا أي policy إطلاقًا (deny-by-default
--   الكامل لكل من anon/authenticated عبر PostgREST/الجدول مباشرة)، مع
--   REVOKE صريح لكل الصلاحيات من anon/authenticated أيضًا (دفاع مضاعف؛
--   Supabase تمنح افتراضيًا SELECT/INSERT/UPDATE/DELETE لـ anon
--   وauthenticated على أي جدول جديد ما لم تُسحب صراحة — تحقّقنا من هذا
--   حيًا على جدول admin_activity_log قبل كتابة هذا الملف). المسار
--   الوحيد المسموح به لأي تفاعل مع هذا الجدول هو عبر الثلاث دوال أدناه
--   فقط، وكل واحدة منها تتحقق من auth.uid() وملكية القفل بنفسها قبل
--   أي تعديل.
--
--   لا نخزّن access_token/refresh_token إطلاقًا. session_token هنا هو
--   UUID عشوائي يُنشأ داخل الدالة نفسها (gen_random_uuid())، لا علاقة
--   له بأي Supabase Auth token — دوره الوحيد إثبات أن الـ heartbeat/
--   release القادم هو من نفس التبويب/الجلسة التي فازت بالقفل، حتى لا
--   يُبطل تحميل صفحة ثانٍ لنفس المستخدم قفل تبويب أول له عبر الخطأ.
--
-- TTL/Heartbeat:
--   TTL ثابت 90 ثانية (غير قابل للتغيير من طرف العميل — لا نثق بأي
--   قيمة TTL يرسلها العميل إطلاقًا؛ الدالة لا تقبل بارامتر TTL أصلاً).
--   الـ Dashboard (admin.js) ترسل refresh كل 25 ثانية تقريبًا — أي ما
--   يقارب 3 فرص heartbeat قبل انتهاء TTL، فيتحمّل النظام انقطاع شبكة
--   عابر واحد أو اثنين دون أن يخسر الأدمن الفعّال قفله، بينما أي جهاز
--   يُغلق فعليًا (تبويب/متصفح/شبكة) يتحرر قفله خلال ~90 ثانية كحد
--   أقصى بلا أي تدخل يدوي.
--
-- هذا الملف إضافي بالكامل (CREATE TABLE ... IF NOT EXISTS معكوس بحذر،
-- CREATE OR REPLACE FUNCTION) ولا يعدّل أي جدول/دالة/سياسة قديمة على
-- الإطلاق. راجع قسم "Rollback" في نهاية الملف لإزالته بالكامل بأمان.
-- ============================================================

-- ------------------------------------------------------------
-- 1. الجدول (singleton — صف واحد ثابت فقط طوال عمر الجدول)
-- ------------------------------------------------------------

create table if not exists public.admin_session_lock (
  id boolean primary key default true,
  user_id uuid references auth.users(id) on delete cascade,
  session_token uuid,
  acquired_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint admin_session_lock_singleton_row check (id = true),
  -- إما القفل فارغ بالكامل (لا أدمن حاليًا) أو ممتلئ بالكامل — لا حالة
  -- جزئية (user_id بلا session_token مثلاً) تتسرب أبدًا عبر أي مسار.
  constraint admin_session_lock_full_or_empty check (
    (user_id is null and session_token is null and acquired_at is null and last_seen_at is null and expires_at is null)
    or
    (user_id is not null and session_token is not null and acquired_at is not null and last_seen_at is not null and expires_at is not null)
  )
);

comment on table public.admin_session_lock is
  'P1-7B: صف singleton واحد فقط (id=true) يمثّل القفل الحالي للوحة التحكم. لا وصول مباشر مسموح — فقط عبر acquire/refresh/release_admin_session_lock(). لا RLS policies عمدًا (deny-all).';

-- الصف الوحيد الذي سيوجد بهذا الجدول أبدًا — يُنشأ مرة هنا إن لم يوجد.
insert into public.admin_session_lock (id) values (true)
on conflict (id) do nothing;

-- RLS مفعّلة أصلاً تلقائيًا عبر rls_auto_enable() event trigger
-- الموجود في المشروع، لكن نفرضها هنا صراحة للوضوح/التوثيق ولضمان
-- الحالة حتى لو تغيّر ذلك الـ trigger مستقبلاً.
alter table public.admin_session_lock enable row level security;

-- لا CREATE POLICY هنا عمدًا — الجدول deny-all بالكامل من PostgREST
-- (anon وauthenticated معًا)، والوصول الوحيد المسموح به هو عبر
-- SECURITY DEFINER functions أدناه فقط.

-- دفاع مضاعف: سحب صريح لكل الصلاحيات الافتراضية التي تمنحها Supabase
-- تلقائيًا لأي جدول جديد (تحقّقنا حيًا أن هذا هو السلوك الافتراضي).
revoke all on public.admin_session_lock from anon, authenticated, public;


-- ------------------------------------------------------------
-- 2. acquire_admin_session_lock()
-- ------------------------------------------------------------
-- تُستدعى بعد نجاح تسجيل الدخول (وبعد استيفاء MFA إن وُجد) وقبل عرض
-- الـ Dashboard مباشرة. auth.uid() فقط هو مصدر هوية المستخدم — لا
-- بارامتر user_id من العميل إطلاقًا.

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

  if v_role is null or v_active is not true or v_role not in ('super_admin', 'admin', 'staff') then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- إن كان هذا نفس المستخدم صاحب القفل الحالي (إعادة تحميل صفحة دون
  -- logout نظيف، أو تبويب ثانٍ لنفس الحساب) نحرّر قفله القديم أولاً
  -- كي لا يحجب نفسه عن نفسه. التبويب القديم (إن بقي مفتوحًا) سيفشل
  -- refresh لاحقًا لعدم تطابق session_token فيُنهى بأمان (قسم 8).
  update public.admin_session_lock
     set user_id = null, session_token = null, acquired_at = null,
         last_seen_at = null, expires_at = null, updated_at = now()
   where id = true and user_id = v_uid;

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
  'P1-7B: محاولة الحصول على قفل الأدمن الوحيد. atomic عبر UPDATE...WHERE على صف singleton. لا تُسرّب أي معلومة عن صاحب القفل الحالي.';

revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;


-- ------------------------------------------------------------
-- 3. refresh_admin_session_lock(p_session_token uuid) — heartbeat
-- ------------------------------------------------------------

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
    -- إما القفل لم يعد ملك هذا المستخدم، أو انتهت صلاحيته، أو
    -- session_token لا يطابق (تبويب قديم بعد تحميل تبويب جديد لنفس
    -- الحساب). العميل يجب أن يعامل هذا كـ forced logout فورًا.
    return jsonb_build_object('ok', false, 'reason', 'not_owner_or_expired');
  end if;
end;
$function$;

comment on function public.refresh_admin_session_lock(uuid) is
  'P1-7B: heartbeat دوري من الـ Dashboard. يمدّد expires_at فقط إذا كان auth.uid() الحالي هو نفسه صاحب القفل وsession_token مطابق ولم تنتهِ الصلاحية بعد.';

revoke all on function public.refresh_admin_session_lock(uuid) from public, anon;
grant execute on function public.refresh_admin_session_lock(uuid) to authenticated;


-- ------------------------------------------------------------
-- 4. release_admin_session_lock(p_session_token uuid) — logout
-- ------------------------------------------------------------

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
  'P1-7B: تحرير طوعي للقفل عند logout. لا يفعل شيئًا (يُرجع false بصمت) إن لم يكن المستخدم/التوكن يطابقان صاحب القفل الحالي — لا يمكن لمستخدم تحرير قفل مستخدم آخر.';

revoke all on function public.release_admin_session_lock(uuid) from public, anon;
grant execute on function public.release_admin_session_lock(uuid) to authenticated;

-- ============================================================
-- Rollback كامل وآمن (نفّذ يدويًا فقط عند الحاجة — غير مُفعَّل هنا):
--
--   drop function if exists public.release_admin_session_lock(uuid);
--   drop function if exists public.refresh_admin_session_lock(uuid);
--   drop function if exists public.acquire_admin_session_lock();
--   drop table if exists public.admin_session_lock;
--
-- آمن دائمًا لأن الجدول لا يحتوي إلا صفًا تشغيليًا واحدًا لا بيانات
-- تاريخية/حقيقية يُخشى فقدانها.
-- ============================================================
