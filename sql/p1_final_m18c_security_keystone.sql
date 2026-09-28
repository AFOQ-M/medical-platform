-- ============================================================
-- AFOQ — M18-C — SECURITY KEYSTONE (WORKER RPC)
-- STATUS: APPLIED — STAGING ONLY (iwxopfipcrmbsyxtsfxr)
-- DATE: 2026-09-28
--
-- PURPOSE
--   Close the stale-result gap in the M07 worker publish path:
--   a worker result for content version N must NEVER mutate content
--   whose current version differs from N.
--
-- SCOPE (nothing else)
--   1. fn_m07_worker_publish(text, uuid, integer) — dedicated worker RPC
--   2. grants/revokes for that RPC (owner-only execute)
--   3. minimal integration: fn_m07_process_backlog publish branch now
--      calls the worker RPC instead of a raw, unfenced UPDATE
--
-- NOT MODIFIED: M6, M12, M13, M16, M17 (other than the publish branch
--   above), APPLY, queue schema, provider config, Edge Functions.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Dedicated worker RPC — version-fenced publish transition
-- ------------------------------------------------------------
create or replace function public.fn_m07_worker_publish(
  p_surface text,
  p_content_id uuid,
  p_content_version integer
)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_is_hidden boolean;
  v_current_version integer;
  v_latest_result text;
  v_open_case boolean;
  v_updated integer;
begin
  -- Authorization: same moderator predicate as the existing M07 worker
  -- path (fn_m07_process_backlog). Ordinary authenticated users are
  -- denied here; the function is additionally not granted to them.
  if not (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit')) then
    raise exception 'not_authorized'
      using errcode = '42501', hint = 'M18-C: moderator-only worker publish';
  end if;

  -- Input validation (fail-closed, deterministic outcomes).
  if p_surface not in ('forum_topic', 'forum_reply') then
    return 'invalid_surface';
  end if;
  if p_content_id is null then
    return 'invalid_content_id';
  end if;
  if p_content_version is null or p_content_version < 1 then
    return 'invalid_content_version';
  end if;

  -- Read current content state under lock — version fencing at read time.
  if p_surface = 'forum_topic' then
    select is_hidden, content_version into v_is_hidden, v_current_version
    from public.forum_topics
    where id = p_content_id
    for update;
  else
    select is_hidden, content_version into v_is_hidden, v_current_version
    from public.forum_replies
    where id = p_content_id
    for update;
  end if;

  if not found then
    return 'not_found';
  end if;

  -- CENTRAL INVARIANT: a worker result for version N must never mutate
  -- content whose current version differs from N.
  if v_current_version is distinct from p_content_version then
    return 'stale';
  end if;

  -- Fail-closed: only a NORMAL screening result for this exact version
  -- may authorize a publish. failure/flagged/missing → no transition.
  select result into v_latest_result
  from public.m07_screening_events
  where surface = p_surface
    and content_id = p_content_id
    and content_version = p_content_version
  order by created_at desc, id desc
  limit 1;

  if v_latest_result is distinct from 'normal' then
    return 'no_normal_result';
  end if;

  -- G7: an open moderation case keeps the decision with the moderator.
  select exists (
    select 1 from public.m07_moderation_cases c
    where c.surface = p_surface and c.content_id = p_content_id and c.status = 'open'
  ) into v_open_case;

  if v_open_case then
    return 'open_case';
  end if;

  -- Idempotency: already visible → no transition.
  if not v_is_hidden then
    return 'already_visible';
  end if;

  -- Version-fenced mutation (atomic): the WHERE clause re-checks the
  -- current version at mutation time.
  if p_surface = 'forum_topic' then
    update public.forum_topics
    set is_hidden = false
    where id = p_content_id and content_version = p_content_version;
  else
    update public.forum_replies
    set is_hidden = false
    where id = p_content_id and content_version = p_content_version;
  end if;

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return 'stale';
  end if;

  return 'published';
end;
$function$;

comment on function public.fn_m07_worker_publish(text, uuid, integer) is
  'M18-C Security Keystone: dedicated worker RPC for the version-fenced publish transition. Moderator-only (fn_is_super_admin OR reports/edit). Never mutates content whose current content_version differs from the worker result version. Fail-closed: only a NORMAL screening event for the exact version authorizes a publish. Idempotent via (surface, content_id, content_version). Outcomes: published|already_visible|stale|not_found|invalid_surface|invalid_content_id|invalid_content_version|no_normal_result|open_case.';

-- ------------------------------------------------------------
-- 2. Grants — NOT callable by public/anon/authenticated.
--    Owner-only execute (postgres). The intended worker path is
--    fn_m07_process_backlog (SECURITY DEFINER, moderator-gated),
--    which preserves the caller JWT so the M12 guard passes.
-- ------------------------------------------------------------
revoke all on function public.fn_m07_worker_publish(text, uuid, integer) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Integration into the existing M07 worker path — replace the raw,
--    unfenced UPDATE in fn_m07_process_backlog's publish branch with
--    the version-fenced worker RPC (minimal, directly-required change).
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
      select exists (
        select 1 from public.m07_moderation_cases c
        where c.surface = v_row.surface and c.content_id = v_row.content_id and c.status = 'open'
      ) into v_open_case;
      if not v_open_case then
        insert into public.m07_moderation_cases (screening_event_id, surface, content_id, content_version)
        values (v_event.id, v_row.surface, v_row.content_id, v_row.content_version);
      end if;
    elsif v_event.result = 'normal' and v_row.is_hidden then
      -- M18-C: publish via the version-fenced worker RPC. A stale worker
      -- result (content_version changed meanwhile) can no longer unhide
      -- newer content — the worker RPC returns 'stale' instead.
      perform public.fn_m07_worker_publish(v_row.surface, v_row.content_id, v_row.content_version);
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
  'M-07: معالج قائمة الانتظار (مقيد بـ reports/edit) — يعيد فحص المحتوى غير المفحوص أو الفاشل، ينشئ حالات FLAGGED، ينشر المحتوى المحجوز الذي أصبح NORMAL عبر fn_m07_worker_publish (M18-C: فحص إصدار صارم)، ويحدّث m07_backlog_state.';