-- ============================================================
-- AFOQ — NOT APPLIED — M-07 — Automated Content Screening (Group B)
-- ============================================================
--
-- **STATUS: NOT APPLIED — PARITY REFERENCE (B4).** This file is the
-- implementation deliverable for M-07 (Group B). It is NOT applied to
-- any database in this session (0 commits / 0 pushes / 0 deployments /
-- 0 production migrations). It remains the parity reference for a
-- future controlled apply (sandbox/staging first, per M12/M16 pattern).
--
-- M-07 delivers the database layer for automated content screening of
-- ordinary user content:
--   - m07_screening_events: append-only audit of every screening run
--   - m07_moderation_cases: FLAGGED content awaiting a moderator
--     decision (KEEP → publish / HIDE → stays hidden)
--   - m07_moderator_recipients: Superadmin-only notification config
--     (data path only — no email delivery provider exists yet)
--   - m07_backlog_state: retry bookkeeping for the backlog processor
--   - enforcement: BEFORE INSERT/UPDATE triggers on forum_topics and
--     forum_replies hold content hidden on FAILURE/FLAGGED (invariant
--     A: provider-unavailable/missing-result must never publish)
--   - fn_m07_screen(): the pluggable screening boundary (SECURITY
--     DEFINER). Currently provider-neutral and fail-closed: no provider
--     configured → result 'failure' / 'no_provider_configured'.
--
-- Approved policy decisions (B1/B2 baseline + B3 design, 2026-09-27):
--   G1 scope: ordinary user content only — forum topics, forum replies,
--      forum reports, resource reports. Admin content OUT OF SCOPE.
--   G2 FAILURE = hold-hidden (content inserted but is_hidden=true;
--      author still sees own content; backlog re-screens later). No
--      raise → the failure event survives (§12 preserve failure info).
--   G3 FLAGGED = hold-hidden + moderation case. NORMAL = as-is.
--   G4 admin (fn_is_super_admin OR reports/edit) is exempt from
--      screening (admin content out of scope).
--   G5 reports are internal (admin queue): FAILURE never blocks a
--      report — screening events are recorded only (forum reports via
--      DB trigger; resource reports via client RPC, since the DB does
--      not screen resource reports — documented limitation).
--   G6 submit_public_report is NOT redefined (M13 parity preserved).
--   G7 M-07 is forward-looking: the backlog processor re-screens
--      existing content but never changes the visibility of content
--      that was already published (FLAGGED → case only). It publishes
--      only content that was HELD by a previous failure and now screens
--      NORMAL (the approved retry/recovery path, §12).
--   G8 content_version tracks screening versions: the screening
--      trigger fires only when title/content changes (topics) or
--      content changes (replies).
--
-- Requires: schema_phase2 (fn_has_permission, fn_is_super_admin),
--   phase6 forum tables (forum_topics, forum_replies, forum_reports),
--   phase7 admin policies, M12 (owner-update guard), M13 (report
--   integrity), M16 (ban enforcement). Trigger order on UPDATE:
--   trg_forum_guard_owner_update (M12) < trg_forum_touch_updated_at
--   < trg_m07_content_version < trg_m07_screening_enforcement.
--
-- ROLLBACK: drop triggers, drop functions, drop policies, drop tables,
--   drop content_version columns (documented at bottom).
-- ============================================================

-- ------------------------------------------------------------
-- A. content_version — إصدار المحتوى (أساس فحص الإصدارات)
-- ------------------------------------------------------------
alter table public.forum_topics add column if not exists content_version integer not null default 1;
alter table public.forum_replies add column if not exists content_version integer not null default 1;

comment on column public.forum_topics.content_version is
  'M-07: إصدار المحتوى — يزداد عند كل تعديل title/content؛ الفحص مرتبط بالإصدار (ثابتة B).';
comment on column public.forum_replies.content_version is
  'M-07: إصدار المحتوى — يزداد عند كل تعديل content؛ الفحص مرتبط بالإصدار (ثابتة B).';

-- ------------------------------------------------------------
-- B. m07_screening_events — سجل فحص ثابت (append-only)
-- ------------------------------------------------------------
create table public.m07_screening_events (
  id uuid primary key default gen_random_uuid(),
  surface text not null check (surface in ('forum_topic', 'forum_reply', 'forum_report', 'resource_report')),
  content_id uuid,
  content_version integer not null default 1 check (content_version >= 1),
  result text not null check (result in ('normal', 'flagged', 'failure')),
  failure_reason text check (failure_reason is null or char_length(failure_reason) <= 200),
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index m07_screening_events_content_idx
  on public.m07_screening_events (surface, content_id, content_version, created_at desc);

comment on table public.m07_screening_events is
  'M-07: سجل فحص ثابت (لا UPDATE ولا DELETE) — كل نتيجة فحص (normal/flagged/failure) مع السبب والمحتوى والإصدار. content_id قابل للـ null لالتقاط فشل فحص بلاغات الموارد (لا يوجد محتوى بعد).';

alter table public.m07_screening_events enable row level security;

-- ------------------------------------------------------------
-- C. m07_moderation_cases — حالات الوساطة (FLAGGED)
-- ------------------------------------------------------------
create table public.m07_moderation_cases (
  id uuid primary key default gen_random_uuid(),
  screening_event_id uuid not null references public.m07_screening_events(id),
  surface text not null check (surface in ('forum_topic', 'forum_reply')),
  content_id uuid not null,
  content_version integer not null check (content_version >= 1),
  status text not null default 'open' check (status in ('open', 'resolved')),
  decision text check (decision in ('keep', 'hide')),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint m07_cases_consistency check (
    (status = 'open' and decision is null and decided_by is null and decided_at is null)
    or (status = 'resolved' and decision is not null and decided_by is not null and decided_at is not null)
  )
);

create index m07_moderation_cases_open_idx on public.m07_moderation_cases (status, created_at desc);

comment on table public.m07_moderation_cases is
  'M-07: حالة وساطة لمحتوى FLAGGED — مفتوحة (open) بلا قرار، أو محلولة (resolved) بقرار keep/hide + من قرر ومتى. الكتابة عبر دوال SECURITY DEFINER فقط (المشغّل + fn_m07_decide_case).';

alter table public.m07_moderation_cases enable row level security;

-- ------------------------------------------------------------
-- D. m07_moderator_recipients — مستلمو إشعارات الفحص (Superadmin فقط)
-- ------------------------------------------------------------
create table public.m07_moderator_recipients (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

comment on table public.m07_moderator_recipients is
  'M-07: مستلمو إشعارات نتائج الفحص — مسار بيانات فقط (لا يوجد مزوّد بريد إلكتروني بعد؛ التسليم NOT VERIFIED في B6). الإدارة عبر fn_m07_add_recipient/fn_m07_remove_recipient (Superadmin فقط).';

alter table public.m07_moderator_recipients enable row level security;

-- ------------------------------------------------------------
-- E. m07_backlog_state — سجل محاولات قائمة الانتظار (داخلي)
-- ------------------------------------------------------------
create table public.m07_backlog_state (
  surface text not null check (surface in ('forum_topic', 'forum_reply')),
  content_id uuid not null,
  content_version integer not null check (content_version >= 1),
  last_attempt_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count >= 1),
  last_result text not null check (last_result in ('normal', 'flagged', 'failure')),
  primary key (surface, content_id, content_version)
);

comment on table public.m07_backlog_state is
  'M-07: دفتر محاولات معالج قائمة الانتظار (داخلي — لا وصول عميل). يمنع إعادة فحص لا نهائية ويمنح رؤية لمسار إعادة المحاولة (§12).';

alter table public.m07_backlog_state enable row level security;

-- ------------------------------------------------------------
-- F. fn_m07_screen — حدود الفحص القابلة للتبديل (pluggable boundary)
-- ------------------------------------------------------------
create or replace function public.fn_m07_screen(
  p_surface text,
  p_content_id uuid,
  p_content_version integer,
  p_content text,
  p_author_id uuid
) returns public.m07_screening_events
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_event public.m07_screening_events;
begin
  -- نقطة التبديل الوحيدة: عند تهيئة مزوّد فحص (قرار مستقبلي)، يُستبدل
  -- جسم هذه الدالة باستدعاء المزوّد وإدراج نتيجته. حاليًا لا مزوّد
  -- مُهيّأ → FAILURE (fail-closed — ثابتة A: لا نشر بلا فحص).
  insert into public.m07_screening_events (surface, content_id, content_version, result, failure_reason, actor_id)
  values (p_surface, p_content_id, p_content_version, 'failure', 'no_provider_configured', p_author_id)
  returning * into v_event;

  return v_event;
end;
$function$;

comment on function public.fn_m07_screen(text, uuid, integer, text, uuid) is
  'M-07: حدود الفحص القابلة للتبديل (SECURITY DEFINER). حاليًا fail-closed: لا مزوّد → failure/no_provider_configured. تُستدعى من مشغّلات الإنفاذ ومن معالج قائمة الانتظار فقط.';

-- ------------------------------------------------------------
-- G. fn_m07_content_version — زيادة إصدار المحتوى عند التعديل
-- ------------------------------------------------------------
create or replace function public.fn_m07_content_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  new.content_version := old.content_version + 1;
  return new;
end;
$function$;

comment on function public.fn_m07_content_version() is
  'M-07: يزيد content_version عند تعديل title/content (المواضيع) أو content (الردود) — يعمل قبل مشغّل الفحص (ترتيب أبجدي) فيرى الفحص الإصدار الجديد.';

-- ------------------------------------------------------------
-- H. fn_m07_screening_enforcement — الإنفاذ (hold-hidden)
-- ------------------------------------------------------------
create or replace function public.fn_m07_screening_enforcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_event public.m07_screening_events;
  v_surface text;
  v_content text;
begin
  -- G4: محتوى الأدمن خارج نطاق M-07 — لا فحص ولا إخفاء.
  if public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit') then
    return new;
  end if;

  -- فصل الوصول إلى الحقول حسب الجدول: forum_topics لها title، forum_replies لا.
  -- (نمط CASE السابق كان يحلّ new.title حتى لصفوف forum_replies → 42703.)
  if tg_table_name = 'forum_topics' then
    v_surface := 'forum_topic';
    v_content := new.title || E'\n' || new.content;
  else
    v_surface := 'forum_reply';
    v_content := new.content;
  end if;

  v_event := public.fn_m07_screen(v_surface, new.id, new.content_version, v_content, new.author_id);

  -- G2/G3: FAILURE و FLAGGED → المحتوى محجوز (is_hidden=true) ولا يُنشر.
  -- لا raise إطلاقًا: الحدث محفوظ (لا تراجع) ومسار إعادة المحاولة عبر
  -- قائمة الانتظار (§12). SECURITY DEFINER إلزامي: التعديل على is_hidden
  -- يتم بصلاحيات المالك بعد أن مرّ حارس M12 (الذي قيّم المتصل).
  if v_event.result = 'failure' then
    new.is_hidden := true;
  elsif v_event.result = 'flagged' then
    new.is_hidden := true;
    insert into public.m07_moderation_cases (screening_event_id, surface, content_id, content_version)
    values (v_event.id, v_surface, new.id, new.content_version);
  end if;

  return new;
end;
$function$;

comment on function public.fn_m07_screening_enforcement() is
  'M-07: إنفاذ الفحص على حدود قاعدة البيانات — FAILURE/FLAGGED → is_hidden=true (hold-hidden)؛ FLAGGED يُنشئ حالة وساطة؛ NORMAL بلا تغيير؛ الأدمن مستثنى (G4).';

-- ------------------------------------------------------------
-- I. fn_m07_report_screening — تسجيل فحص بلاغات المنتدى (لا حجب)
-- ------------------------------------------------------------
create or replace function public.fn_m07_report_screening()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_event public.m07_screening_events;
begin
  -- G5: البلاغات داخلية (قائمة مشرف) — لا تُحجب أبدًا؛ يُسجَّل حدث الفحص فقط.
  v_event := public.fn_m07_screen('forum_report', new.id, 1, new.reason || coalesce(' ' || new.details, ''), new.reporter_id);
  return new;
end;
$function$;

comment on function public.fn_m07_report_screening() is
  'M-07: يسجّل حدث فحص لكل بلاغ منتدي جديد (لا يغيّر شيئًا — البلاغات داخلية ولا تُحجب، G5).';

-- ------------------------------------------------------------
-- J. fn_m07_record_screening_failure — RPC عميل (بلاغات الموارد)
-- ------------------------------------------------------------
create or replace function public.fn_m07_record_screening_failure(
  p_surface text,
  p_content_id uuid,
  p_content_version integer,
  p_failure_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if p_surface not in ('forum_topic', 'forum_reply', 'forum_report', 'resource_report') then
    raise exception 'invalid_surface' using errcode = 'P0001', hint = 'M-07: unknown surface';
  end if;
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501', hint = 'M-07: authenticated users only';
  end if;

  -- G5: بلاغات الموارد لا تُفحص على حدود DB (قيد موثّق) — العميل يسجّل
  -- فشل الفحص هنا (content_id = null لأن المحتوى غير موجود بعد).
  insert into public.m07_screening_events (surface, content_id, content_version, result, failure_reason, actor_id)
  values (p_surface, p_content_id, coalesce(p_content_version, 1), 'failure', coalesce(p_failure_reason, 'client_recorded'), auth.uid());
end;
$function$;

comment on function public.fn_m07_record_screening_failure(text, uuid, integer, text) is
  'M-07: RPC عميل (authenticated) — يسجّل حدث فشل فحص (failure فقط) لبلاغات الموارد قبل إرسال البلاغ. سجل تدقيق؛ لا تأثير إنفاذي.';

-- ------------------------------------------------------------
-- K. fn_m07_decide_case — قرار المشرف (KEEP/HIDE)
-- ------------------------------------------------------------
create or replace function public.fn_m07_decide_case(p_case_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_case public.m07_moderation_cases;
begin
  if not (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit')) then
    raise exception 'not_authorized' using errcode = '42501', hint = 'M-07: moderator-only decision';
  end if;
  if p_decision not in ('keep', 'hide') then
    raise exception 'invalid_decision' using errcode = 'P0001', hint = 'M-07: decision must be keep or hide';
  end if;

  select * into v_case from public.m07_moderation_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'case_not_found' using errcode = 'P0001', hint = 'M-07: case not found';
  end if;
  if v_case.status <> 'open' then
    raise exception 'case_not_open' using errcode = 'P0001', hint = 'M-07: case already resolved';
  end if;

  -- KEEP → نشر المحتوى (is_hidden=false). HIDE → يبقى مخفيًا (لا تغيير).
  -- التعديل على is_hidden يمر عبر حارس M12: المتصل مشرف (reports/edit) → يمر.
  if p_decision = 'keep' then
    if v_case.surface = 'forum_topic' then
      update public.forum_topics set is_hidden = false where id = v_case.content_id;
    else
      update public.forum_replies set is_hidden = false where id = v_case.content_id;
    end if;
  end if;

  update public.m07_moderation_cases
    set status = 'resolved', decision = p_decision, decided_by = auth.uid(), decided_at = now()
    where id = p_case_id;
end;
$function$;

comment on function public.fn_m07_decide_case(uuid, text) is
  'M-07: قرار المشرف على حالة FLAGGED — keep → is_hidden=false (نشر)؛ hide → يبقى مخفيًا. مقيد بـ reports/edit.';

-- ------------------------------------------------------------
-- L. مستلمو الإشعارات — Superadmin فقط
-- ------------------------------------------------------------
create or replace function public.fn_m07_add_recipient(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if not public.fn_is_super_admin() then
    raise exception 'not_authorized' using errcode = '42501', hint = 'M-07: super_admin only';
  end if;
  insert into public.m07_moderator_recipients (user_id, created_by)
  values (p_user_id, auth.uid())
  on conflict (user_id) do nothing;
end;
$function$;

create or replace function public.fn_m07_remove_recipient(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
begin
  if not public.fn_is_super_admin() then
    raise exception 'not_authorized' using errcode = '42501', hint = 'M-07: super_admin only';
  end if;
  delete from public.m07_moderator_recipients where user_id = p_user_id;
end;
$function$;

comment on function public.fn_m07_add_recipient(uuid) is
  'M-07: إضافة مستلم إشعارات فحص — Superadmin فقط (مسار بيانات؛ لا تسليم بريد بعد).';
comment on function public.fn_m07_remove_recipient(uuid) is
  'M-07: إزالة مستلم إشعارات فحص — Superadmin فقط.';

-- ------------------------------------------------------------
-- M. fn_m07_process_backlog — معالج قائمة الانتظار (مسار إعادة المحاولة)
-- ------------------------------------------------------------
create or replace function public.fn_m07_process_backlog(p_limit integer default 50)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_processed integer := 0;
  v_event public.m07_screening_events;
  v_open_case boolean;
  v_content text;
  v_row record;
begin
  if not (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit')) then
    raise exception 'not_authorized' using errcode = '42501', hint = 'M-07: moderator-only backlog processing';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    p_limit := 50;
  end if;

  -- المرشحون: محتوى بلا حدث للإصدار الحالي (لم يُفحص بعد — محتوى سابق
  -- لتفعيل M-07 أو إصدار جديد) أو آخر حدث له = failure (مسار إعادة المحاولة).
  for v_row in
    select 'forum_topic' as surface, t.id as content_id, t.content_version, t.title, t.content, t.author_id, t.is_hidden, t.created_at
    from public.forum_topics t
    where not exists (
      select 1 from public.m07_screening_events e
      where e.surface = 'forum_topic' and e.content_id = t.id and e.content_version = t.content_version
        and e.result in ('normal', 'flagged')
    )
    union all
    select 'forum_reply' as surface, r.id as content_id, r.content_version, null::text as title, r.content, r.author_id, r.is_hidden, r.created_at
    from public.forum_replies r
    where not exists (
      select 1 from public.m07_screening_events e
      where e.surface = 'forum_reply' and e.content_id = r.id and e.content_version = r.content_version
        and e.result in ('normal', 'flagged')
    )
    order by created_at
    limit p_limit
  loop
    v_content := case when v_row.title is not null then v_row.title || E'\n' || v_row.content else v_row.content end;
    v_event := public.fn_m07_screen(v_row.surface, v_row.content_id, v_row.content_version, v_content, v_row.author_id);

    if v_event.result = 'flagged' then
      -- G7: FLAGGED → حالة وساطة فقط؛ لا تغيير رؤية للمحتوى المنشور سابقًا.
      select exists (
        select 1 from public.m07_moderation_cases c
        where c.surface = v_row.surface and c.content_id = v_row.content_id and c.status = 'open'
      ) into v_open_case;
      if not v_open_case then
        insert into public.m07_moderation_cases (screening_event_id, surface, content_id, content_version)
        values (v_event.id, v_row.surface, v_row.content_id, v_row.content_version);
      end if;
    elsif v_event.result = 'normal' and v_row.is_hidden then
      -- مسار إعادة المحاولة (§12): محتوى كان محجوزًا بسبب فشل سابق → يُنشر
      -- الآن، إلا إذا كانت هناك حالة وساطة مفتوحة (القرار للمشرف).
      select exists (
        select 1 from public.m07_moderation_cases c
        where c.surface = v_row.surface and c.content_id = v_row.content_id and c.status = 'open'
      ) into v_open_case;
      if not v_open_case then
        if v_row.surface = 'forum_topic' then
          update public.forum_topics set is_hidden = false where id = v_row.content_id;
        else
          update public.forum_replies set is_hidden = false where id = v_row.content_id;
        end if;
      end if;
    end if;

    insert into public.m07_backlog_state (surface, content_id, content_version, last_attempt_at, attempt_count, last_result)
    values (v_row.surface, v_row.content_id, v_row.content_version, now(), 1, v_event.result)
    on conflict (surface, content_id, content_version)
    do update set
      last_attempt_at = now(),
      attempt_count = public.m07_backlog_state.attempt_count + 1,
      last_result = excluded.last_result;

    v_processed := v_processed + 1;
  end loop;

  return v_processed;
end;
$function$;

comment on function public.fn_m07_process_backlog(integer) is
  'M-07: معالج قائمة الانتظار (مقيد بـ reports/edit) — يعيد فحص المحتوى غير المفحوص أو الفاشل، ينشئ حالات FLAGGED، ينشر المحتوى المحجوز الذي أصبح NORMAL (مسار إعادة المحاولة)، ويحدّث m07_backlog_state.';

-- ------------------------------------------------------------
-- N. المشغّلات
-- ------------------------------------------------------------
drop trigger if exists trg_m07_content_version on public.forum_topics;
create trigger trg_m07_content_version
  before update of title, content on public.forum_topics
  for each row execute function public.fn_m07_content_version();

drop trigger if exists trg_m07_content_version on public.forum_replies;
create trigger trg_m07_content_version
  before update of content on public.forum_replies
  for each row execute function public.fn_m07_content_version();

drop trigger if exists trg_m07_screening_enforcement on public.forum_topics;
create trigger trg_m07_screening_enforcement
  before insert or update of title, content on public.forum_topics
  for each row execute function public.fn_m07_screening_enforcement();

drop trigger if exists trg_m07_screening_enforcement on public.forum_replies;
create trigger trg_m07_screening_enforcement
  before insert or update of content on public.forum_replies
  for each row execute function public.fn_m07_screening_enforcement();

drop trigger if exists trg_m07_report_screening on public.forum_reports;
create trigger trg_m07_report_screening
  before insert on public.forum_reports
  for each row execute function public.fn_m07_report_screening();

-- ------------------------------------------------------------
-- O. سياسات RLS — قراءة مشرف فقط؛ كل الكتابة عبر دوال SECURITY DEFINER
-- ------------------------------------------------------------
create policy "moderator_read_m07_events"
  on public.m07_screening_events for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

create policy "moderator_read_m07_cases"
  on public.m07_moderation_cases for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

create policy "moderator_read_m07_recipients"
  on public.m07_moderator_recipients for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

-- ------------------------------------------------------------
-- P. المنح — لا anon، لا كتابة مباشرة، لا delete
-- ------------------------------------------------------------
grant select on public.m07_screening_events to authenticated;
grant select on public.m07_moderation_cases to authenticated;
grant select on public.m07_moderator_recipients to authenticated;

-- دوال الحدود/المشغّلات: داخلية — لا تنفيذ للعملاء.
revoke all on function public.fn_m07_screen(text, uuid, integer, text, uuid) from public, anon;
revoke all on function public.fn_m07_content_version() from public, anon;
revoke all on function public.fn_m07_screening_enforcement() from public, anon;
revoke all on function public.fn_m07_report_screening() from public, anon;

-- RPCs العميل: متاحة للمصادق فقط (التحقق الداخلي من المشرف يمنع أي استدعاء غير مصرح).
grant execute on function public.fn_m07_record_screening_failure(text, uuid, integer, text) to authenticated;
grant execute on function public.fn_m07_decide_case(uuid, text) to authenticated;
grant execute on function public.fn_m07_add_recipient(uuid) to authenticated;
grant execute on function public.fn_m07_remove_recipient(uuid) to authenticated;
grant execute on function public.fn_m07_process_backlog(integer) to authenticated;

-- ============================================================
-- ROLLBACK (documented; run manually, do NOT execute here)
-- ============================================================
--   drop trigger if exists trg_m07_content_version on public.forum_topics;
--   drop trigger if exists trg_m07_content_version on public.forum_replies;
--   drop trigger if exists trg_m07_screening_enforcement on public.forum_topics;
--   drop trigger if exists trg_m07_screening_enforcement on public.forum_replies;
--   drop trigger if exists trg_m07_report_screening on public.forum_reports;
--   drop function if exists public.fn_m07_screen(text, uuid, integer, text, uuid);
--   drop function if exists public.fn_m07_content_version();
--   drop function if exists public.fn_m07_screening_enforcement();
--   drop function if exists public.fn_m07_report_screening();
--   drop function if exists public.fn_m07_record_screening_failure(text, uuid, integer, text);
--   drop function if exists public.fn_m07_decide_case(uuid, text);
--   drop function if exists public.fn_m07_add_recipient(uuid);
--   drop function if exists public.fn_m07_remove_recipient(uuid);
--   drop function if exists public.fn_m07_process_backlog(integer);
--   drop policy if exists "moderator_read_m07_events" on public.m07_screening_events;
--   drop policy if exists "moderator_read_m07_cases" on public.m07_moderation_cases;
--   drop policy if exists "moderator_read_m07_recipients" on public.m07_moderator_recipients;
--   drop table if exists public.m07_screening_events;
--   drop table if exists public.m07_moderation_cases;
--   drop table if exists public.m07_moderator_recipients;
--   drop table if exists public.m07_backlog_state;
--   alter table public.forum_topics drop column if exists content_version;
--   alter table public.forum_replies drop column if exists content_version;
-- ============================================================