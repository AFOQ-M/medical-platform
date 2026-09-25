-- ============================================================
-- AFOQ — PROPOSED — NOT APPLIED
-- M13 — Forum Report Creation Integrity + Rate Limit (F5)
-- ============================================================
--
-- **STATUS: PROPOSED — NOT APPLIED.** This file changes production
-- database objects (RLS policy + SECURITY DEFINER function + trigger +
-- new rate-limit table). It must be applied by the CLAUDE DATABASE
-- PHASE and verified there. Big Pickle does NOT apply it.
--
-- FINDING: F5 — Report Integrity / Owner-Update / no forum rate limit
-- Root Cause A (forgery of moderation state):
--   "insert_own_forum_reports" policy
--     with check (reporter_id = auth.uid() and fn_forum_is_real_user())
--   governs only the reporter identity; the client can therefore insert
--   arbitrary values in moderation columns on a fresh row, e.g.
--     status = 'reviewed', reviewed_by = <any profile>, reviewed_at = now()
--   Forging a reviewed/dismissed state without an admin action.
-- Root Cause B (report flooding):
--   forum_reports has NO rate limit (public resource reports were
--   rate-limited in P0-4 via submit_public_report/report_rate_limits,
--   but forum reports are inserted directly from the client with no
--   per-source throttling) → the admin moderation queue is spoolable
--   by a single authenticated account.
-- Root Cause C (unpublished-target reporting):
--   submit_public_report(p_resource_id,...) inserts a report for ANY
--   resource id without verifying the target is published; a report
--   modal is only surfaced on published resources in the UI, but the
--   RPC itself must enforce the invariant at the DB layer.
--
-- Client reality (verified, Big Pickle scope):
--   js/forum.js submitForumReport() builds the payload explicitly from
--   {reporter_id, reason, details, topic_id, reply_id} — the web client
--   never sends status/reviewed_by/reviewed_at, so no app change is
--   required for Root Cause A; the exposure is API-level only. The
--   DB-enforced fix below protects all clients at once.
--
-- AFFECTED TABLES: forum_reports (policy + guard), forum_reports
--   (new table forum_report_rate_limits), reports (via redefined RPC)
-- AFFECTED POLICIES: "insert_own_forum_reports" (recreated tighter)
-- AFFECTED RPCs: submit_public_report(uuid,text,text) (redefined)
-- AFFECTED functions: NEW fn_forum_report_write_guard(), and the
--   rate-limit support table.
-- AUTHORIZATION EFFECT:
--   1) new forum reports are pinned to status='pending',
--      reviewed_by=null, reviewed_at=null — moderation state can only
--      be produced by admin_update_forum_reports (phase7), never forged.
--   2) a per-user sliding window (10 reports / 10 min) is enforced on
--      insert, keyed on reporter_id (authenticated identity, no IP
--      hashing needed — anon cannot insert by policy).
--   3) submit_public_report refuses non-existent/unpublished
--      resources ('not_found') while keeping the P0-4 rate-limit cap.
-- SECURITY RATIONALE: closes F5 at the DB layer regardless of client;
--   preserves admin moderation contract (admin_update_forum_reports is
--   untouched); rate limit is server-side and cannot be bypassed by
--   dropping browser-side throttling.
-- MIGRATION ORDER: after M12. Independent of M11. Requires phase6
--   forum tables, phase7 admin policies, schema_phase2 admin fns,
--   phase4a/phase4b submit_public_report current definitions.
-- ROLLBACK: drop trigger, drop function, drop table, restore prior
--   policy/function bodies (documented at bottom).
-- REQUIRED VERIFICATION: (1) non-admin inserts report with
--   status='reviewed' → rejected; (2) normal insert → status forced to
--   'pending'; (3) >10 forum reports in 10 min → rate_limit_exceeded;
--   (4) submit_public_report on unpublished resource → not_found;
--   (5) submit_public_report on published resource still works and the
--   P0-4 5/10min resource cap still applies.
-- ============================================================

-- ------------------------------------------------------------
-- A. tighten insert policy — REPLACES the phase6 definition
-- ------------------------------------------------------------
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

-- ------------------------------------------------------------
-- B. per-user report rate limit (forum)
-- ------------------------------------------------------------
create table if not exists public.forum_report_rate_limits (
  reporter_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null default now(),
  report_count integer not null default 0
);

comment on table public.forum_report_rate_limits is
  'F5/M13: عدّاد مؤقت لكل مبلّغ (يُعرَّف بهويته authenticated لا IP) لمنع إغراق قائمة مراجعة بلاغات المنتدى. لا وصول مباشر — يُدار من trigger SECURITY DEFINER فقط.';

alter table public.forum_report_rate_limits enable row level security;

-- لا سياسات RLS متعمّدة: كل الوصول المباشر مرفوض؛ تعديله حصري عبر
-- دالة SECURITY DEFINER (نفس مبدأ report_rate_limits في P0-4).

-- ------------------------------------------------------------
-- C. guard trigger — pins moderation columns + enforces the window
-- ------------------------------------------------------------
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
  -- C.1 ثبّت حالة البلاغ الجديد — لا يمكن تزوير حالة مراجعة عند الإنشاء.
  new.status      := 'pending';
  new.reviewed_by := null;
  new.reviewed_at := null;

  -- C.2 نافذة حد زمني لكل مبلّغ.
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

-- ------------------------------------------------------------
-- D. submit_public_report — refuse non-published targets
-- ------------------------------------------------------------
-- إعادة تعريف كاملة preserving the CURRENT P0-4/P0-3 semantics plus
-- the new published-target guard. (phase4b definition is the live one.)
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
  -- C.3 (F5) الهدف يجب أن يكون موردًا منشورًا فعلًا.
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

-- ------------------------------------------------------------
-- ROLLBACK (documented; run manually, do NOT execute here)
-- ------------------------------------------------------------
--   drop trigger if exists trg_forum_report_write_guard on public.forum_reports;
--   drop function if exists public.fn_forum_report_write_guard();
--   drop table if exists public.forum_report_rate_limits;
--   drop policy if exists "insert_own_forum_reports" on public.forum_reports;
--   -- أعد تعريف insert_own_forum_reports من phase6_forum_mvp.sql،
--   -- وأعد تعريف submit_public_report من phase4b_p0_3_p0_4_digest_schema_fix.sql
-- ============================================================