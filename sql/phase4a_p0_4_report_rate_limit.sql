-- ============================================================
-- Phase 4A — الجزء 2: P0-4
-- حماية إرسال البلاغات العامة (reports) من الإساءة/الإرسال الآلي
-- ============================================================
--
-- المشكلة المؤكدة في التدقيق (Phase 4 Audit Report):
--   سياسة الإدراج الحالية على reports:
--     create policy "public_insert_reports" on reports for insert
--       with check (true);
--   تسمح لأي زائر مجهول (anon) بإدراج عدد غير محدود من البلاغات
--   مباشرة عبر PostgREST، دون أي حماية فعلية من طرف الخادم. هذا
--   يفتح بابًا للإزعاج/الإغراق (spam/DoS) وهو أيضًا نقطة الدخول
--   العامة نفسها التي كانت عرضة لثغرة XSS المخزّنة التي أُصلحت في
--   الجزء 1 (P0-1).
--
-- القرار المعماري (البند 4 من تعليمات الجزء 2):
--   لا توجد أي Edge Functions في هذا المشروع حاليًا (تم التحقق:
--   لا يوجد مجلد supabase/functions ولا أي استدعاء
--   supabaseClient.functions.invoke في أي ملف JS). لذلك — وبحسب
--   الترتيب المفضَّل في التعليمات (أعد استخدام آلية موجودة ← Edge
--   Function إن كانت موجودة أصلاً ← أصغر آلية داخل قاعدة البيانات) —
--   الخيار الأصغر والأنسب هو (C): آلية Rate Limiting داخل PostgreSQL
--   نفسه عبر دالة SECURITY DEFINER واحدة، دون إدخال أي بنية تحتية
--   جديدة (لا Edge Function، لا مفتاح service_role في المتصفح).
--
--   الآلية: بدلاً من إدراج reports مباشرة من المتصفح (الطريق الحالي
--   عبر supabaseClient.from("reports").insert(...))، يمر كل بلاغ
--   الآن عبر دالة واحدة submit_public_report(...) تتحقق من الحد
--   الزمني قبل تنفيذ الإدراج الفعلي. سياسة الإدراج العامة القديمة
--   (public_insert_reports) تُحذف بالكامل — بحيث لا يمكن لأي عميل
--   (حتى باستدعاء PostgREST مباشرة بمفتاح anon، متجاوزًا واجهة
--   الموقع تمامًا) إدراج صف في reports دون المرور بالدالة المحمية.
--
-- الحد المُطبَّق: 5 بلاغات كحد أقصى لكل "مفتاح تحديد معدّل" (rate-limit
-- key) خلال نافذة 10 دقائق متجددة (sliding-ish: تُعاد النافذة عند
-- أول طلب بعد انتهاء الفترة). رقم متحفظ يسمح للزائر العادي بالإبلاغ
-- عن مشكلة حقيقية أكثر من مرة دون عناء، بينما يمنع الإرسال الآلي
-- السريع المتكرر من نفس المصدر. لا يوجد حد عام يشمل كل الزوار معًا —
-- كل مفتاح (مصدر) له عدّاده الخاص، فمستخدم واحد لا يمكنه حظر غيره.
--
-- الخصوصية / تقليل البيانات (البند 5):
--   لا يُخزَّن عنوان IP الخام إطلاقًا. تُستخرج قيمة ترويسة الطلب
--   cf-connecting-ip (ترويسة قياسية موثَّقة رسميًا لكل مشاريع Supabase،
--   تصلها الدالة عبر current_setting('request.headers', true) —
--   انظر تعليق §1 داخل الدالة أدناه لتفاصيل سبب استخدامها بدل
--   x-forwarded-for)، ثم تُجزَّأ فورًا داخل الدالة بخوارزمية sha256
--   أحادية الاتجاه (pgcrypto) قبل أي كتابة على القرص. القيمة المخزَّنة
--   فعليًا في جدول report_rate_limits هي ناتج التجزئة (hash) فقط.
--   راق دقيق ومطلوب: هذا تجزيء (hashing) وليس إخفاء هوية مضمونًا
--   (anonymization) — عنوان IP الخام نص قصير ذو مساحة بحث صغيرة نسبيًا
--   (خصوصًا IPv4)، وبالتالي هجوم قاموس/جدول قوس قزح (rainbow table) على
--   هاش SHA-256 لعنوان IP قابل للتنفيذ عمليًا من طرف من يملك وصولًا
--   لقاعدة البيانات؛ الصياغة الدقيقة المعتمدة هي: "لا يُخزَّن IP الخام؛
--   يُخزَّن مفتاح مشتق بـ SHA-256 فقط. هذا مستعار (pseudonymous) وليس
--   مجهول الهوية بشكل مضمون (guaranteed anonymous)." الجدول لا يحتوي
--   أي عمود آخر يحدد هوية الزائر (لا بريد، لا معرّف جهاز، لا كوكيز)،
--   ولا صلة له بجدول reports نفسه. الصفوف "منتهية الصلاحية منطقيًا"
--   بعد مرور نافذة الوقت (10 دقائق) من آخر نشاط؛ دالة التنظيف
--   الاختيارية التي كانت هنا سابقًا (cleanup_report_rate_limits) أُزيلت
--   بعد المراجعة الأمنية النهائية — انظر §4 أدناه — والتنظيف الآن مهمة
--   يدوية عبر SQL Editor عند الحاجة فقط.
--
-- الأمان:
--   - لا تُمنح صلاحية service_role لأي كود متصفح؛ العميل يستمر
--     باستخدام مفتاح anon فقط كما كان.
--   - جدول report_rate_limits نفسه محمي بـ RLS بدون أي سياسة عامة
--     على الإطلاق (لا SELECT ولا INSERT ولا UPDATE) — الرفض هو
--     السلوك الافتراضي، والوصول الوحيد الممكن هو من داخل الدالة
--     SECURITY DEFINER نفسها.
--   - لا تغيير على سياسات admin_read_reports / admin_delete_reports
--     (لوحة تحكم الأدمن)، ولا على أي جدول آخر.
--
-- الترحيل (Migration discipline):
--   ملف جديد منفصل، لا تعديل على أي ملف ترحيل سابق. آمن لإعادة
--   التشغيل (idempotent): create table/policy/function كلها بصيغ
--   "if not exists" أو drop-before-create صريحة.
--
-- التراجع (Rollback):
--   لاستعادة السلوك القديم (غير موصى به أمنيًا):
--     create policy "public_insert_reports" on reports for insert
--       with check (true);
--   ولإزالة آلية الحد الزمني بالكامل لاحقًا:
--     drop function if exists submit_public_report(uuid, text, text);
--     drop table if exists report_rate_limits;
--   (دالة التنظيف الاختيارية أُزيلت من هذا الملف نهائيًا؛ لا شيء
--   يخصّها للتراجع عنه.)
-- ============================================================

-- pgcrypto لازمة لدالة digest() المستخدمة في تجزئة IP (sha256).
create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- 1) جدول تتبّع الحد الزمني — بيانات مؤقتة/مجهّلة فقط، لا صلة له
--    ببيانات reports نفسها ولا بأي جدول آخر.
-- ------------------------------------------------------------
create table if not exists report_rate_limits (
  rate_key     text primary key,          -- هاش sha256 لعنوان IP، وليس IP نفسه
  window_start timestamptz not null default now(),
  count        integer not null default 0
);

comment on table report_rate_limits is
  'حماية P0-4: عدّاد مؤقت لكل مصدر (هاش IP فقط) لتقييد معدّل إرسال البلاغات العامة. لا وصول مباشر من العميل — فقط عبر submit_public_report().';

alter table report_rate_limits enable row level security;

-- عمدًا: لا توجد أي سياسة SELECT/INSERT/UPDATE/DELETE هنا. تفعيل RLS
-- بدون أي سياسة يعني رفض كل الوصول المباشر افتراضيًا (anon/authenticated
-- على حد سواء) — الوصول الوحيد الممكن هو من داخل دالة SECURITY DEFINER
-- أدناه، التي تتجاوز RLS بحكم كونها مملوكة لمالك الجدول.

-- ------------------------------------------------------------
-- 2) دالة الإدراج المحمية بحد زمني (المسار الوحيد المتاح للعميل
--    لإضافة بلاغ — يحل محل الإدراج المباشر على جدول reports)
-- ------------------------------------------------------------
drop function if exists submit_public_report(uuid, text, text);

create or replace function submit_public_report(
  p_resource_id uuid,
  p_reason text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_requests constant integer  := 5;                 -- الحد الأقصى ضمن النافذة
  v_window       constant interval := interval '10 minutes'; -- طول النافذة الزمنية
  v_raw_ip       text;
  v_rate_key     text;
  v_row          public.report_rate_limits;
begin
  -- استخراج IP العميل: تم تغيير المصدر من x-forwarded-for إلى
  -- cf-connecting-ip بعد المراجعة الأمنية النهائية لهذا الملف.
  --
  -- السبب (موثّق، وليس افتراضًا): x-forwarded-for غير موثوقة في طوبولوجيا
  -- Supabase — العميل يمكنه إرسال قيمة x-forwarded-for مزوَّرة خاصة به،
  -- وبوابة Supabase لا تستبدلها بل تُلحق IP الحقيقي بعدها
  -- (مثال: "spoofed,68.65.164.215")؛ أي أن split_part(...,',',1) كما
  -- كانت مكتوبة سابقًا كانت تلتقط بالضبط القيمة القابلة للتزوير من
  -- طرف العميل، لا IP الحقيقي (موثّق في نقاش مجتمع Supabase الرسمي حول
  -- هذه المشكلة تحديدًا). هذا يجعل عدّاد الحد الزمني قابلاً للتجاوز
  -- الكامل من أي عميل يستدعي RPC مباشرة (خارج واجهة الموقع) بتغيير
  -- الترويسة المزوَّرة في كل طلب.
  --
  -- بالمقابل cf-connecting-ip تُدرَج ضمن قائمة ترويسات الطلب القياسية
  -- الموثَّقة رسميًا من Supabase نفسها لكل مشاريعها (توثيق Logging
  -- وتوثيق Debugging performance issues، حيث تستخدمها Supabase ذاتها
  -- كمثال رسمي لتصفية الطلبات حسب IP العميل داخل دالة pre-request).
  -- بوابة Supabase تجلس خلف Cloudflare لكل المشاريع، وCloudflare هو من
  -- يضبط قيمة هذه الترويسة من اتصال TCP الفعلي على حافة شبكته، فلا
  -- يمكن للعميل انتحالها أو الكتابة فوقها كما هو الحال مع
  -- x-forwarded-for. هذا هو أفضل إشارة IP موثوقة متاحة في هذه
  -- الطوبولوجيا دون إضافة أي بنية تحتية جديدة.
  --
  -- ملاحظة صادقة: هذا تحقّق ثابت (static) استنادًا إلى توثيق Supabase
  -- الرسمي وسلوك منصتها المعروف؛ لم يُختبر مباشرة ضد نقطة نهاية حية
  -- لهذا المشروع تحديدًا (انظر تقرير المراجعة).
  begin
    v_raw_ip := current_setting('request.headers', true)::json ->> 'cf-connecting-ip';
  exception when others then
    v_raw_ip := null;
  end;

  -- قيد صادق يجب توثيقه: إن كان هذا المشروع مستضافًا ذاتيًا (self-hosted)
  -- خلف بروكسي غير Cloudflare، فقد لا تصل cf-connecting-ip إطلاقًا، وكل
  -- الزوار سيقعون حينها تحت نفس المفتاح 'unknown' (حد جماعي واحد للجميع
  -- بدلاً من حد لكل مصدر) بدل حماية معطوبة قابلة للتزوير. هذا سلوك آمن
  -- افتراضيًا وليس تجاوزًا صامتًا، لكنه يستدعي تحققًا حيًا من ترويسات
  -- الطلب الفعلية لهذا المشروع تحديدًا لتأكيد وصول cf-connecting-ip.
  if v_raw_ip is null or btrim(v_raw_ip) = '' then
    v_raw_ip := 'unknown';
  end if;

  -- تجزئة أحادية الاتجاه فورًا — لا نخزّن عنوان IP الخام أبدًا،
  -- ولا حتى مؤقتًا داخل الجدول.
  v_rate_key := encode(digest(btrim(v_raw_ip), 'sha256'), 'hex');

  -- upsert-then-lock: يضمن وجود الصف أولاً (يتعامل بأمان مع تسابق
  -- أول طلبين متزامنين من نفس المصدر)، ثم يقفله لمنع تسابق العدّاد.
  -- كل الأسماء أدناه مؤهَّلة صراحةً بـ public. (بالإضافة إلى
  -- set search_path = public أعلاه) لمنع أي احتمال ظل/التقاط كائن من
  -- مخطط آخر داخل هذه الدالة SECURITY DEFINER.
  insert into public.report_rate_limits (rate_key, window_start, count)
  values (v_rate_key, now(), 0)
  on conflict (rate_key) do nothing;

  select * into v_row from public.report_rate_limits where rate_key = v_rate_key for update;

  if now() - v_row.window_start > v_window then
    -- النافذة السابقة انتهت: إعادة تعيين العدّاد والنافذة
    update public.report_rate_limits
      set window_start = now(), count = 1
      where rate_key = v_rate_key;
  elsif v_row.count >= v_max_requests then
    -- تجاوز الحد ضمن النافذة الحالية: رفض الطلب دون تنفيذ الإدراج
    raise exception 'rate_limit_exceeded'
      using errcode = 'P0001',
            hint = 'too many reports from this source, try again later';
  else
    update public.report_rate_limits
      set count = v_row.count + 1
      where rate_key = v_rate_key;
  end if;

  -- الإدراج الفعلي — نفس الحقول والسلوك تمامًا كما كان الإدراج
  -- المباشر السابق (لا تغيير في دلالة reason/note/resource_id).
  insert into public.reports (resource_id, reason, note)
  values (p_resource_id, p_reason, nullif(btrim(coalesce(p_note, '')), ''));
end;
$$;

comment on function submit_public_report(uuid, text, text) is
  'المسار الوحيد المسموح لإدراج بلاغ عام؛ يفرض حد 5 بلاغات/10 دقائق لكل مصدر (هاش IP) قبل الإدراج الفعلي في reports. P0-4.';

-- السماح لأي زائر (حتى غير مسجّل) باستدعاء الدالة نفسها فقط —
-- وليس الإدراج المباشر على الجدول.
grant execute on function submit_public_report(uuid, text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3) إغلاق مسار الإدراج المباشر غير المحمي (جوهر إصلاح P0-4)
-- ------------------------------------------------------------
drop policy if exists "public_insert_reports" on reports;

-- ملاحظة: لا تغيير على admin_read_reports / admin_delete_reports —
-- هذه السياسات (المعرَّفة في schema_phase2_5.sql) تبقى كما هي تمامًا.

-- ------------------------------------------------------------
-- 4) دالة التنظيف الاختيارية (cleanup_report_rate_limits) أُزيلت بعد
--    المراجعة الأمنية النهائية: لم تكن مطلوبة فعليًا لإصلاح P0-4 (P0-4
--    هو منع تجاوز الحد الزمني على الإدراج، لا صيانة الجدول)، وأي دالة
--    SECURITY DEFINER إضافية — حتى بدون منح execute صريح لـ
--    anon/authenticated — تُبقي سطحًا هجوميًا إضافيًا بلا داعٍ. جدول
--    report_rate_limits صغير (مفتاح واحد لكل مصدر خلال نافذة 10 دقائق)
--    ولا يمثل تراكمه بدون تنظيف دوري خطرًا تشغيليًا يستدعي دالة مخصصة؛
--    يمكن تنظيفه لاحقًا بأمر DELETE عادي من SQL Editor إن احتاج الأدمن،
--    دون الحاجة لدالة قائمة بذاتها في قاعدة الإنتاج.
--
--    idempotent: إن كانت هذه الدالة قد أُنشئت فعليًا في تشغيل سابق لهذا
--    الملف قبل هذه المراجعة، يتم حذفها هنا صراحةً.
-- ------------------------------------------------------------
drop function if exists cleanup_report_rate_limits();

-- ============================================================
-- 5) استعلامات تحقق (Verification) — نفس أسلوب الملفات السابقة
-- ============================================================

-- 5.a تأكيد أن السياسة القديمة غير المحمية لم تعد موجودة (يجب صفر صفوف)
select policyname
from pg_policies
where tablename = 'reports' and policyname = 'public_insert_reports';

-- 5.b تأكيد وجود submit_public_report وأنها security definer
select
  p.oid,
  pg_get_function_identity_arguments(p.oid) as identity_arguments,
  pg_get_function_result(p.oid) as return_type,
  p.prosecdef as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'submit_public_report'
  and n.nspname = 'public';

-- 5.c تأكيد وجود جدول report_rate_limits وأن RLS مفعّل عليه
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname = 'report_rate_limits';

-- 5.d تأكيد عدم وجود أي سياسة عامة على report_rate_limits (يجب صفر صفوف)
select policyname
from pg_policies
where tablename = 'report_rate_limits';

-- 5.e سياسات reports المتبقية بعد الترحيل (للمراجعة اليدوية) —
--     يجب ألا تظهر public_insert_reports، ويجب بقاء
--     admin_read_reports / admin_delete_reports كما هي.
select policyname, cmd, roles
from pg_policies
where tablename = 'reports'
order by policyname;

-- 5.f تأكيد عدم وجود دالة تنظيف قابلة للاستدعاء العام (يجب صفر صفوف)
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where p.proname = 'cleanup_report_rate_limits'
  and n.nspname = 'public';
