-- ============================================================
-- P1-Final M11 — Admin Session Lock ACL (authorization gate fix)
-- ============================================================
--
-- ⚠️ STATUS: NEW — طُوِّر في مهمة إكمال المشروع والإصدار النهائي
-- (FINAL-PROJECT-COMPLETION). لم يُطبَّق بعد على قاعدة البيانات
-- الحية — لا تنفيذ مُرخَّص داخل المستودع؛ التعليمات توضّح أنه
-- يجب تطبيقه يدويًا عبر Supabase SQL Editor كأي migration آخر.
--
-- ⚠️ نطاق مُرخَّص: تعديل واحد فقط محدد — دالة
-- public.acquire_admin_session_lock() (محدودة)، لا DROP لأي شيء،
-- لا تغيير على refresh/release، لا تغيير على الجدول أو RLS، لا
-- تغيير على أي policy/grant آخر.
--
-- ------------------------------------------------------------------
-- المشكلة (P1 — DoS على لوحة الأدمن):
--   sql/schema_phase2.sql يُنشئ تلقائيًا صف profiles لكل مستخدم Auth
--   جديد جدًا (role='staff', active=true افتراضيًا). دالة
--   acquire_admin_session_lock() كانت تسمح بالقفل لأي صاحب profile
--   بدور ضمن ('super_admin','admin','staff') — أي أن أي مستخدم مسجّل
--   (غير ضيف) يملك تلقائيًا دور staff نشطًا فيستطيع احتكار القفل
--   الوحيد للوحة التحكم والاحتفاظ به عبر إعادة acquire كل < 90 ثانية،
--   مسببًا حرمان الإدارة الحقيقية من الدخول indefinitely.
--
-- الإصلاح (مطابق لنموذج التفويض القائم فعليًا في fn_has_permission):
--   يُطلب إذن إداري حقيقي وليس مجرد عضوية دور:
--     * super_admin (نشط)  → مسموح (سلطة شاملة حسب تصميم المشروع)
--     * admin/staff        → مسموح فقط إن وُجد سطر user_permissions
--                            نشط واحد على الأقل لهذا المستخدم
--     * أي حساب staff تلقائي بلا أذونات → مرفوض (not_authorized)
--
-- هذا يطابق بالضبط منطق fn_has_permission() الحالي (p1_final_m8):
-- super_admin = السلطة الشاملة، بينما admin/staff يحتاجون أذونات
-- فعلية. دالة القفل لم تعد تمنح أكثر من قاعدة البيانات نفسها.
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

  if v_role is null or v_active is not true then
    return jsonb_build_object('acquired', false, 'reason', 'not_authorized');
  end if;

  -- M11: شرط التفويض الحقيقي — بدل الاكتفاء بعضوية الدور (كانت تسمح
  -- لأي حساب staff تلقائي بلا أذونات باحتكار قفل الأدمن الوحيد).
  -- super_admin = سلطة شاملة؛ admin/staff يحتاجون سطر إذن نشطًا واحدًا
  -- على الأقل (نفس شروط fn_has_permission في p1_final_m8).
  if v_role <> 'super_admin' and not exists (
    select 1 from public.user_permissions up
    where up.user_id = v_uid and up.active = true
  ) then
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
  'P1-7B (Phase 4C — First Session Wins, M11 ACL): محاولة الحصول على قفل الأدمن الوحيد. تنجح فقط إن كان القفل فارغًا أو منتهي الصلاحية، وللحسابات ذات تفويض إداري حقيقي (super_admin أو حامل سطر user_permissions نشط). أي محاولة ثانية تُرفض دون المساس بالقفل الحالي. لا تُسرّب أي معلومة عن صاحب القفل الحالي.';

-- الصلاحيات لا تتغيّر: CREATE OR REPLACE يحافظ عليها، لكن نعيد فرضها
-- صراحة هنا لضمان عدم اختلاف الحالة أبدًا (مطابق لـ phase4c).
revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;

-- ============================================================
-- Rollback (نفّذ يدويًا فقط عند الحاجة — غير مُفعَّل هنا):
-- يعيد دالة القفل إلى نسختها ما قبل M11 (المسموح بالدور فقط) عبر
-- CREATE OR REPLACE بنفس التعريف في sql/phase4c_p1_7b_first_session_wins.sql.
-- لا DROP هنا لأن الدالة يجب أن تبقى موجودة دائمًا (P1-7B يعتمد عليها).
-- ============================================================