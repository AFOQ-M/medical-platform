-- ============================================================
-- Phase 4C — تعديل محدود على P1-7B: First Session Wins
-- ============================================================
--
-- سياق: sql/phase4b_p1_7b_admin_session_lock.sql (المطبَّق مسبقًا) كان
-- ينفّذ "New Session Wins" في حالة واحدة فقط: عندما تحاول نفس الحساب
-- (نفس auth.uid()) الحصول على القفل مرة ثانية بينما قفلها القديم لا
-- يزال فعّالًا (لم ينتهِ TTL بعد) — كانت الدالة تُبطل قفل الحساب القديم
-- تلقائيًا (UPDATE أول يُصفّر الصف إن كان user_id = v_uid) ثم تمنحه
-- قفلًا جديدًا فورًا (UPDATE ثانٍ). هذا يعني أن متصفحًا/تبويبًا ثانيًا
-- لنفس الحساب كان يطرد التبويب الأول (الذي يفشل عند heartbeat التالي
-- خلال ≤25 ثانية بسبب عدم تطابق session_token).
--
-- لحسابين مختلفين، السلوك كان بالفعل "First Session Wins" (الشرط
-- `user_id is null or expires_at < now()` في الـ UPDATE الثاني يرفض أي
-- حساب آخر ما دام قفل الأول فعّالًا) — لم يكن يحتاج تعديلًا.
--
-- التعديل هنا: حذف الـ UPDATE الأول (تصفير الذاتي) بالكامل من
-- acquire_admin_session_lock(). لم يعد هناك أي استثناء لـ "نفس
-- المستخدم" — أي محاولة acquire ثانية بينما القفل فعّال (لأي مستخدم،
-- بما فيه صاحب القفل نفسه من تبويب/متصفح آخر) تُرفض بـ
-- `{acquired:false, reason:'locked'}` دون أي لمس لصف القفل الحالي.
--
-- هذا يجعل الدالة عبارة عن UPDATE...WHERE ذرّي واحد فقط بدل اثنين —
-- أبسط، وضمان الذرّية (row lock من Postgres على صف الـ singleton)
-- كما هو، بل أصبح أوضح لأن العملية لم تعد بحاجة لتنسيق بين تحديثين.
--
-- لا تغيير على refresh_admin_session_lock()/release_admin_session_lock()،
-- ولا على الجدول، ولا على RLS/الصلاحيات، ولا على MFA (P1-7A)، ولا على
-- أي صلاحيات super_admin/admin/staff. CREATE OR REPLACE فقط على دالة
-- acquire_admin_session_lock() — إضافي بالكامل، بلا DROP.
-- ============================================================

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

  -- First Session Wins: محاولة الحصول على القفل تنجح فقط إن كان فارغًا
  -- تمامًا (لا أدمن حاليًا) أو منتهي الصلاحية (TTL انقضى). لا يوجد أي
  -- استثناء لصاحب القفل الحالي — إن كانت هذه نفس الحساب من تبويب/متصفح
  -- آخر بينما قفلها الأول لا يزال فعّالًا، تُرفض المحاولة الثانية تمامًا
  -- والقفل الأول يبقى كما هو دون أي تعديل (لا UPDATE آخر يسبق هذا).
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
  'P1-7B (Phase 4C — First Session Wins): محاولة الحصول على قفل الأدمن الوحيد. تنجح فقط إن كان القفل فارغًا أو منتهي الصلاحية. أي محاولة ثانية (حتى من نفس الحساب) تُرفض دون المساس بالقفل الحالي. atomic عبر UPDATE...WHERE واحد على صف singleton. لا تُسرّب أي معلومة عن صاحب القفل الحالي.';

-- الصلاحيات لا تتغيّر (كانت مضبوطة مسبقًا على الدالة، وCREATE OR REPLACE
-- يحافظ عليها، لكن نُعيد فرضها صراحة هنا لضمان عدم اختلاف الحالة أبدًا).
revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ============================================================
-- Rollback (نفّذ يدويًا فقط عند الحاجة — غير مُفعَّل هنا): يعيد الدالة
-- إلى نسخة "New Session Wins" (self-release) عبر CREATE OR REPLACE
-- بالتعريف الأصلي في sql/phase4b_p1_7b_admin_session_lock.sql. لا
-- DROP هنا لأن الدالة يجب أن تبقى موجودة دائمًا (P1-7B يعتمد عليها).
-- ============================================================
