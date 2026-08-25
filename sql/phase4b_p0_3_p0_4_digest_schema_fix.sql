-- Phase 4B — hotfix: schema-qualify digest() calls
-- Applied live to project lzmkgfxlsynaphpofblb via Supabase migration:
--   phase4b_p0_3_fix_digest_schema_qualification
--   phase4b_p0_4_fix_digest_schema_qualification
--
-- Root cause: pgcrypto's digest() lives in schema `extensions`, not `public`.
-- Both increment_resource_view(uuid) and submit_public_report(uuid,text,text)
-- are SECURITY DEFINER with SET search_path TO 'public' (intentional hardening
-- against search-path hijacking), so unqualified digest() calls could never
-- resolve — every invocation raised:
--   ERROR: 42883: function digest(text, unknown) does not exist
--
-- Fix: schema-qualify the digest() call sites as extensions.digest(...).
-- Nothing else changed: search_path stays 'public' only (not widened),
-- SECURITY DEFINER unchanged, cooldown/rate-limit constants unchanged,
-- published-resource guard unchanged.
--
-- This file supersedes the digest() call sites in:
--   sql/phase4b_p0_3_view_rate_limit.sql   (increment_resource_view)
--   sql/phase4a_p0_4_report_rate_limit.sql (submit_public_report)
-- Those files are left unmodified as historical record; this file reflects
-- the current live definitions.

CREATE OR REPLACE FUNCTION public.increment_resource_view(p_resource_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cooldown constant interval := interval '10 minutes'; -- Phase 4B P0-3 design decision
  v_raw_ip   text;
  v_rate_key text;
  v_row      public.resource_view_cooldowns;
begin
  if not exists (
    select 1 from public.resources
    where id = p_resource_id and status = 'published'
  ) then
    return;
  end if;

  begin
    v_raw_ip := current_setting('request.headers', true)::json ->> 'cf-connecting-ip';
  exception when others then
    v_raw_ip := null;
  end;

  if v_raw_ip is null or btrim(v_raw_ip) = '' then
    v_raw_ip := 'unknown';
  end if;

  -- Phase 4B hotfix: digest() lives in the `extensions` schema, not `public`.
  v_rate_key := encode(
    extensions.digest(encode(extensions.digest(btrim(v_raw_ip), 'sha256'), 'hex') || ':' || p_resource_id::text, 'sha256'),
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
    return;
  end if;

  update public.resource_view_cooldowns
    set last_viewed_at = now()
    where rate_key = v_rate_key;

  update public.resources
    set view_count = view_count + 1
    where id = p_resource_id and status = 'published';
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_public_report(p_resource_id uuid, p_reason text, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_max_requests constant integer  := 5;
  v_window       constant interval := interval '10 minutes';
  v_raw_ip       text;
  v_rate_key     text;
  v_row          public.report_rate_limits;
begin
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
