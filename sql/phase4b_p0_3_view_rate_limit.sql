-- ============================================================
-- Phase 4B — P0-3: تحديد معدّل عدّاد المشاهدات (view_count)
-- ============================================================
--
-- ⚠️ ملاحظة مصدر هذا الملف: هذا إعادة بناء لملف كُتب أصلاً في محادثة
-- سابقة (مرتبطة بتدقيق حي على قاعدة بيانات هذا المشروع عبر Supabase
-- MCP) لكنه لم يُرفَع ضمن أي أرشيف/zip. أُعيد بناؤه هنا استنادًا إلى
-- الوصف الدقيق لتصميمه في نص تلك المحادثة، بنفس نمط
-- sql/phase4a_p0_4_report_rate_limit.sql (المرجع المعماري الوحيد
-- الموثّق فعليًا في هذا الـrepo لهذا النوع من المشاكل). لم يُطبَّق هذا
-- الملف على أي قاعدة بيانات حية بعد — **راجعه وقارنه يدويًا مع القاعدة
-- الفعلية قبل التنفيذ**، خصوصًا لو كانت نسخة مطبَّقة فعلاً هناك.
--
-- المشكلة:
--   increment_resource_view(uuid) الحالية (phase3_engagement.sql) تزيد
--   view_count بمقدار 1 عند كل استدعاء دون أي حد — تحديث متكرر لنفس
--   المورد من نفس الزائر (تحديث الصفحة، إعادة فتحها) يضخّم العدّاد
--   بلا معنى إحصائي حقيقي.
--
-- القرار المعماري:
--   نفس نمط P0-4 (دالة SECURITY DEFINER + جدول RLS بلا أي policy
--   عامة + تجزئة IP بـ sha256 + insert-then-lock)، مع فرق جوهري واحد:
--   الفعل هنا سلبي/تلقائي (مشاهدة صفحة) وليس فعلاً يبادر به المستخدم
--   (إرسال بلاغ)، فالسلوك المناسب عند تجاوز الحد هو "صمت" (لا زيادة،
--   لا استثناء) بدل الرفض الصريح بخطأ كما في submit_public_report.
--
-- الآلية:
--   - مفتاح المعدّل rate_key = sha256(sha256(IP) || ':' || resource_id)
--     أي مزدوج: لكل زوج (مصدر، مورد) عدّاده الخاص — مشاهدة مورد A لا
--     تؤثر على نافذة مورد B لنفس الزائر.
--   - نافذة تهدئة (cooldown) ثابتة: 30 دقيقة منذ آخر مشاهدة فعلية
--     محسوبة لنفس الزوج. هذا رقم مقترح غير موثَّق في أي مكان آخر في
--     الـrepo — عدّله حسب الحاجة قبل التطبيق.
--   - داخل نافذة التهدئة: لا زيادة على view_count، لا استثناء يُرفع،
--     لا أثر ظاهر للزائر (المورد نفسه يُعرض بشكل طبيعي).
--   - بعد انتهاء النافذة: مشاهدة جديدة تُحتسب وتُحدَّث last_viewed_at.
--   - شرط status = 'published' يُفحص أولاً، قبل أي لمس لجدول
--     resource_view_cooldowns — موارد غير منشورة/غير موجودة تتصرف
--     تمامًا كما كانت (لا شيء يحدث، لا صف تهدئة يُنشأ).
--
-- التوقيع محفوظ بدقة: increment_resource_view(uuid) — نفس الاسم، نفس
-- معامل واحد uuid، نفس returns void، نفس language plpgsql، نفس
-- security definer، نفس set search_path = public. هذا مقصود: أي كود
-- JS حالي (js/app.js) يستدعيها بنفس التوقيع دون أي تعديل مطلوب على
-- طرف العميل.
--
-- الخصوصية: لا يُخزَّن IP الخام أبدًا — يُشتق منه rate_key مجزّأ فقط
-- (sha256)، بنفس القيد الصادق المذكور في P0-4: هذا استعارة زائفة
-- (pseudonymous) لا إخفاء هوية مضمون. مصدر IP هو ترويسة
-- cf-connecting-ip نفسها المستخدمة في submit_public_report، لنفس
-- السبب الموثَّق هناك (موثوقة خلف Cloudflare، غير قابلة للتزوير من
-- العميل خلافًا لـ x-forwarded-for).
--
-- الأمان:
--   - resource_view_cooldowns محمي بـ RLS بدون أي policy على الإطلاق
--     (لا SELECT ولا INSERT ولا UPDATE من anon/authenticated) — الوصول
--     الوحيد من داخل الدالة SECURITY DEFINER نفسها.
--   - لا تغيير على resources.view_count نفسه (نوع العمود/القيمة
--     الافتراضية) ولا على أي سياسة RLS أخرى في المشروع.
--   - لا صلاحية service_role جديدة لأي كود متصفح.
--
-- الترحيل: ملف جديد منفصل، آمن لإعادة التشغيل (drop-before-create
-- صريح للدالة، create table/policy بصيغة if not exists).
--
-- التراجع:
--   لاستعادة السلوك القديم (زيادة بلا حد، غير موصى به):
--     أعد تطبيق تعريف increment_resource_view من phase3_engagement.sql
--     كما هو (بدون منطق cooldown).
--   لإزالة آلية التهدئة بالكامل لاحقًا:
--     drop table if exists resource_view_cooldowns;
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1) جدول تتبّع آخر مشاهدة لكل زوج (مصدر، مورد) — بيانات مؤقتة/
--    مستعارة فقط، لا صلة له بجدول resources ولا بأي بيانات مستخدم.
-- ------------------------------------------------------------
create table if not exists resource_view_cooldowns (
  rate_key       text primary key,                 -- sha256(sha256(ip) || ':' || resource_id)
  last_viewed_at timestamptz not null default '-infinity'
);

comment on table resource_view_cooldowns is
  'حماية P0-3: آخر وقت احتُسبت فيه مشاهدة فعلية لكل زوج (هاش مصدر، مورد)، لمنع تضخيم view_count من التحديث المتكرر. لا وصول مباشر من العميل — فقط عبر increment_resource_view().';

alter table resource_view_cooldowns enable row level security;

-- عمدًا: لا توجد أي سياسة هنا (نفس نمط report_rate_limits في P0-4) —
-- تفعيل RLS بلا أي policy يعني رفض كل وصول مباشر افتراضيًا، والوصول
-- الوحيد الممكن هو من داخل الدالة SECURITY DEFINER أدناه.

-- ------------------------------------------------------------
-- 2) إعادة تعريف increment_resource_view بنفس التوقيع بالضبط
-- ------------------------------------------------------------
drop function if exists increment_resource_view(uuid);

create or replace function increment_resource_view(p_resource_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cooldown constant interval := interval '30 minutes'; -- مقترح، عدّله قبل التطبيق إن لزم
  v_raw_ip   text;
  v_rate_key text;
  v_row      public.resource_view_cooldowns;
begin
  -- نفس شرط الأصل تمامًا: فقط الموارد المنشورة تُحتسب، ويُفحص هذا
  -- أولاً قبل أي لمس لجدول التهدئة — مورد غير منشور/غير موجود لا ينشئ
  -- أي صف تهدئة ولا يغيّر أي شيء (سلوك مطابق للنسخة السابقة تمامًا).
  if not exists (
    select 1 from public.resources
    where id = p_resource_id and status = 'published'
  ) then
    return;
  end if;

  -- استخراج IP العميل عبر cf-connecting-ip — نفس المصدر والمنطق
  -- الموثَّق في submit_public_report (P0-4)، لنفس السبب: موثوقة خلف
  -- Cloudflare وغير قابلة للتزوير من العميل خلافًا لـ x-forwarded-for.
  begin
    v_raw_ip := current_setting('request.headers', true)::json ->> 'cf-connecting-ip';
  exception when others then
    v_raw_ip := null;
  end;

  if v_raw_ip is null or btrim(v_raw_ip) = '' then
    v_raw_ip := 'unknown';
  end if;

  -- مفتاح مزدوج: هاش المصدر + المورد معًا، بحيث تكون نافذة التهدئة
  -- لكل زوج (زائر، مورد) لا لكل زائر بشكل عام ولا لكل مورد بشكل عام.
  v_rate_key := encode(
    digest(encode(digest(btrim(v_raw_ip), 'sha256'), 'hex') || ':' || p_resource_id::text, 'sha256'),
    'hex'
  );

  insert into public.resource_view_cooldowns (rate_key, last_viewed_at)
  values (v_rate_key, '-infinity')
  on conflict (rate_key) do nothing;

  select * into v_row
  from public.resource_view_cooldowns
  where rate_key = v_rate_key
  for update;

  if now() - v_row.last_viewed_at < v_cooldown then
    -- داخل نافذة التهدئة: صمت تام — لا زيادة، لا استثناء. الفعل سلبي
    -- (مشاهدة صفحة) وليس فعلاً يستحق رفضًا صريحًا كما في P0-4.
    return;
  end if;

  update public.resource_view_cooldowns
    set last_viewed_at = now()
    where rate_key = v_rate_key;

  update public.resources
    set view_count = view_count + 1
    where id = p_resource_id and status = 'published';
end;
$$;

comment on function increment_resource_view(uuid) is
  'يزيد view_count لمورد منشور بحد أقصى مرة واحدة كل 30 دقيقة لكل زوج (هاش مصدر، مورد). P0-3. نفس التوقيع القديم — لا تغيير مطلوب على طرف العميل.';

-- نفس صلاحية التنفيذ التي كانت للنسخة الأصلية.
grant execute on function increment_resource_view(uuid) to anon, authenticated;

-- ============================================================
-- 3) استعلامات تحقق (Verification) — نفس أسلوب الملفات السابقة
-- ============================================================

-- 3.a الجدول الجديد موجود وRLS مفعّل عليه، بلا أي policy (يجب صفر صفوف)
select relname, relrowsecurity from pg_class where relname = 'resource_view_cooldowns';
select policyname from pg_policies where tablename = 'resource_view_cooldowns';

-- 3.b تعريف الدالة الكامل — للمراجعة اليدوية (تحقّق من: نفس التوقيع،
--     security definer، وجود resource_view_cooldowns وv_cooldown)
select pg_get_functiondef(p.oid)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'increment_resource_view' and n.nspname = 'public';

-- 3.c resources.view_count لم يتغيّر (نوع/قيمة افتراضية)
select data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'resources' and column_name = 'view_count';

-- 3.d لا تغيير غير مقصود على جداول/سياسات أخرى في المشروع
select count(*) from pg_class where relname = 'report_rate_limits';        -- يجب أن يبقى موجودًا كما هو (P0-4)
select policyname from pg_policies where tablename in ('profiles', 'user_permissions');
select conname from pg_constraint where conrelid = 'subjects'::regclass and contype = 'c'; -- قيد semester

-- ملاحظة اختبار صادقة: الاستدعاء من SQL Editor مباشرة لا يحمل ترويسة
-- cf-connecting-ip حقيقية (تلك موجودة فقط في طلبات PostgREST/HTTP
-- الفعلية عبر الموقع)، فكل استدعاءات الاختبار من المحرر ستقع تحت مفتاح
-- 'unknown' الموحّد — يفحص هذا منطق التهدئة نفسه بشكل صحيح، لكن ليس
-- بالضبط سلوك الزائر الحقيقي لكل IP. الاختبار الحقيقي يتطلب استدعاء
-- عبر الموقع الفعلي أو curl/Postman على نقطة نهاية PostgREST الحقيقية.
