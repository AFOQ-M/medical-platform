-- ============================================================
-- AFOQ — APPLIED — LIVE DB (M15+)
-- M16 — Moderation Foundation (Phase 3): user warnings, temporary
--       bans, ban history, repeat-offender visibility
-- ============================================================
--
-- **STATUS: APPLIED — LIVE DB.** Phase 3 (Moderation
-- Foundation) delivers the database layer for forum moderation:
--   - user_warnings: immutable warning records (who/when/why/by-whom)
--   - user_bans: active + historical bans (start/expiry/revocation)
--   - enforcement: an ACTIVE ban blocks creating new forum topics
--     and replies at the DB boundary (BEFORE INSERT triggers)
--   - visibility: moderator-gated helpers for Phase 4 (admin UI)
--
-- Approved policy decisions (2026-09-26, user):
--   F1 no auto-ban (no trigger on warning count)
--   F2 ban duration is a free value set by the moderator (null = permanent)
--   F3 no auto-escalation (prior bans are history only)
--   F4 warnings keep timestamps; no 30-day window for any automatic decision
--   F5 expired bans are history only
--   F6 revocation via revoked_at/revoked_by, moderator-only
--   F7 bans do NOT block reporting (banned users may still report)
--   F8 bans block NEW topics/replies only; editing/deleting own
--      existing content stays allowed
--
-- Requires: schema_phase2 (fn_has_permission, fn_is_super_admin),
--   phase6 forum tables (forum_topics, forum_replies), phase7 admin
--   policies. Independent of M12/M13/M14/M15.
--
-- ROLLBACK: drop triggers, drop functions, drop tables, drop
--   policies (documented at bottom).
-- ============================================================

-- ------------------------------------------------------------
-- A. user_warnings — سجل تحذير ثابت (immutable)
-- ------------------------------------------------------------
create table public.user_warnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  issued_by uuid not null references auth.users(id),
  reason text not null check (btrim(reason) <> '' and char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

create index user_warnings_user_id_idx on public.user_warnings (user_id, created_at desc);

comment on table public.user_warnings is
  'M16/Phase3: سجل تحذيرات ثابت (لا تعديل ولا حذف) — من/متى/لماذا/بواسطة من. لا يُستخدم في أي قرار تلقائي (F1/F4).';

alter table public.user_warnings enable row level security;

-- ------------------------------------------------------------
-- B. user_bans — الحظر النشط + التاريخ (سجل الحظر نفسه)
-- ------------------------------------------------------------
create table public.user_bans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  issued_by uuid not null references auth.users(id),
  reason text not null check (btrim(reason) <> '' and char_length(reason) <= 500),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoke_reason text check (revoke_reason is null or char_length(revoke_reason) <= 500),
  created_at timestamptz not null default now(),
  constraint user_bans_revoke_consistency check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and revoked_by is not null)
  ),
  constraint user_bans_time_consistency check (expires_at is null or expires_at > starts_at)
);

create index user_bans_user_id_idx on public.user_bans (user_id, starts_at desc);

comment on table public.user_bans is
  'M16/Phase3: سجل الحظر الكامل (نشط + تاريخي) — يجيب عن من/بواسطة من/متى بدأ/متى ينتهي/لماذا/هل أُلغي/من ألغى/متى. لا حذف — التاريخ محفوظ (F5).';

alter table public.user_bans enable row level security;

-- ------------------------------------------------------------
-- C. دوال الرؤية (مقيدة بالمشرف — Phase 4 تستهلكها؛ رؤية فقط،
--    غير موصولة بأي إجراء تلقائي F1/F3/F5)
-- ------------------------------------------------------------
create or replace function public.fn_user_active_ban(p_user_id uuid)
returns public.user_bans
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_row public.user_bans;
begin
  -- نفس مسند القراءة الإداري المستعمل في phase7 (admin_read_*).
  if not (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'view')) then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'M16: moderator-only visibility';
  end if;

  select b.* into v_row
  from public.user_bans b
  where b.user_id = p_user_id
    and b.revoked_at is null
    and b.starts_at <= now()
    and (b.expires_at is null or b.expires_at > now())
  order by b.starts_at desc
  limit 1;

  return v_row;
end;
$function$;

comment on function public.fn_user_active_ban(uuid) is
  'M16/Phase3: رؤية فقط — يعيد الحظر النشط الحالي لمستخدم (أو null). مقيد بالمشرف (fn_is_super_admin OR reports/view). لا يُستخدم في أي إجراء تلقائي.';

create or replace function public.fn_user_warning_count(p_user_id uuid, p_since timestamptz default null)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_count integer;
begin
  -- نفس مسند القراءة الإداري المستعمل في phase7 (admin_read_*).
  if not (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'view')) then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'M16: moderator-only visibility';
  end if;

  select count(*)::integer into v_count
  from public.user_warnings w
  where w.user_id = p_user_id
    and (p_since is null or w.created_at >= p_since);

  return v_count;
end;
$function$;

comment on function public.fn_user_warning_count(uuid, timestamptz) is
  'M16/Phase3: رؤية فقط — عدد تحذيرات مستخدم (اختياريًا منذ تاريخ). مقيد بالمشرف (fn_is_super_admin OR reports/view). لا يُستخدم في أي إجراء تلقائي (F1/F4).';

-- ------------------------------------------------------------
-- D. إنفاذ الحظر — يمنع إنشاء موضوع/رد جديد أثناء حظر نشط (F8)
-- ------------------------------------------------------------
create or replace function public.fn_forum_ban_enforcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  -- SECURITY DEFINER إلزامي: لو كان INVOKER، المستخدم المحظور (بلا
  -- SELECT policy على user_bans) سيتجاوز الفحص عبر RLS الخاصة به.
  if exists (
    select 1 from public.user_bans b
    where b.user_id = new.author_id
      and b.revoked_at is null
      and b.starts_at <= now()
      and (b.expires_at is null or b.expires_at > now())
  ) then
    raise exception 'user_banned'
      using errcode = 'P0001',
            hint = 'M16: active ban — new forum submissions are blocked';
  end if;

  return new;
end;
$function$;

comment on function public.fn_forum_ban_enforcement() is
  'M16/Phase3: يمنع إنشاء موضوعات/ردود جديدة أثناء حظر نشط (F8). SECURITY DEFINER إلزامي حتى لا يتجاوز المحظور الفحص عبر RLS على user_bans.';

drop trigger if exists trg_forum_ban_enforcement on public.forum_topics;
create trigger trg_forum_ban_enforcement
  before insert on public.forum_topics
  for each row execute function public.fn_forum_ban_enforcement();

drop trigger if exists trg_forum_ban_enforcement on public.forum_replies;
create trigger trg_forum_ban_enforcement
  before insert on public.forum_replies
  for each row execute function public.fn_forum_ban_enforcement();

-- ------------------------------------------------------------
-- E. حارس سلامة صف الحظر — يمنع تعديل أعمدة الهوية/التدقيق
-- ------------------------------------------------------------
create or replace function public.fn_user_bans_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.user_id    is distinct from old.user_id
     or new.issued_by is distinct from old.issued_by
     or new.created_at is distinct from old.created_at
     or new.starts_at is distinct from old.starts_at
  then
    raise exception 'not_authorized'
      using errcode = '42501',
            hint = 'M16: identity/audit columns on user_bans are immutable';
  end if;

  return new;
end;
$function$;

comment on function public.fn_user_bans_guard() is
  'M16/Phase3: يمنع تعديل user_id/issued_by/created_at/starts_at على صفوف الحظر — يحفظ سلامة سجل التدقيق (F6).';

drop trigger if exists trg_user_bans_guard on public.user_bans;
create trigger trg_user_bans_guard
  before update on public.user_bans
  for each row execute function public.fn_user_bans_guard();

-- ------------------------------------------------------------
-- F. سياسات RLS — كتابة/قراءة = مسند المشرف المعتمد فقط
-- ------------------------------------------------------------
-- user_warnings: ثابت — INSERT/SELECT للمشرف فقط، لا UPDATE/DELETE
create policy "moderator_insert_user_warnings"
  on public.user_warnings for insert
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

create policy "moderator_read_user_warnings"
  on public.user_warnings for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

-- user_bans: INSERT/SELECT/UPDATE (إلغاء/إدارة) للمشرف فقط، لا DELETE
create policy "moderator_insert_user_bans"
  on public.user_bans for insert
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

create policy "moderator_read_user_bans"
  on public.user_bans for select
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'view'));

create policy "moderator_revoke_user_bans"
  on public.user_bans for update
  using (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'))
  with check (fn_is_super_admin() or fn_has_permission('reports', null, 'edit'));

-- ------------------------------------------------------------
-- G. المنح — لا anon إطلاقًا، لا delete
-- ------------------------------------------------------------
grant select, insert on public.user_warnings to authenticated;
grant select, insert, update on public.user_bans to authenticated;

-- دوال الرؤية: قابلة للاستدعاء عبر RPC من لوحة Phase 4 فقط
-- (التحقق الداخلي من المشرف يمنع أي استدعاء غير مصرح).
revoke all on function public.fn_user_active_ban(uuid) from public, anon;
grant execute on function public.fn_user_active_ban(uuid) to authenticated;

revoke all on function public.fn_user_warning_count(uuid, timestamptz) from public, anon;
grant execute on function public.fn_user_warning_count(uuid, timestamptz) to authenticated;

-- دوال الـtrigger: لا حاجة لمنح تنفيذ للعملاء (تُنفَّذ بصلاحيات المالك).
revoke all on function public.fn_forum_ban_enforcement() from public, anon;
revoke all on function public.fn_user_bans_guard() from public, anon;

-- ============================================================
-- ROLLBACK (documented; run manually, do NOT execute here)
-- ============================================================
--   drop trigger if exists trg_forum_ban_enforcement on public.forum_topics;
--   drop trigger if exists trg_forum_ban_enforcement on public.forum_replies;
--   drop trigger if exists trg_user_bans_guard on public.user_bans;
--   drop function if exists public.fn_forum_ban_enforcement();
--   drop function if exists public.fn_user_bans_guard();
--   drop function if exists public.fn_user_active_ban(uuid);
--   drop function if exists public.fn_user_warning_count(uuid, timestamptz);
--   drop policy if exists "moderator_insert_user_warnings" on public.user_warnings;
--   drop policy if exists "moderator_read_user_warnings" on public.user_warnings;
--   drop policy if exists "moderator_insert_user_bans" on public.user_bans;
--   drop policy if exists "moderator_read_user_bans" on public.user_bans;
--   drop policy if exists "moderator_revoke_user_bans" on public.user_bans;
--   drop table if exists public.user_warnings;
--   drop table if exists public.user_bans;
-- ============================================================