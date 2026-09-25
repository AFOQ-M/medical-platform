-- ============================================================
-- AFOQ — PROPOSED — NOT APPLIED
-- M12 — Forum Content/Moderation-Column Integrity (F4)
-- ============================================================
--
-- **STATUS: PROPOSED — NOT APPLIED.** This file changes production
-- database objects (RLS-guard triggers). It must be applied by the
-- CLAUDE DATABASE PHASE and verified there. Big Pickle does NOT
-- apply it.
--
-- FINDING: F4 — Forum Owner Update / Moderation Integrity
-- Root Cause: the two owner-UPDATE RLS policies
--     "update_own_forum_topics"   (forum_topics.author_id = auth.uid())
--     "update_own_forum_replies"  (forum_replies.author_id = auth.uid())
-- govern column mutations only via the row check author_id = auth.uid();
-- PostgreSQL RLS has no per-column UPDATE control. Consequently an
-- owner (any authenticated author) can mutate moderation/identity
-- columns on their own rows through the PostgREST UPDATE endpoint:
--     forum_topics : is_hidden, is_locked, author_name, category_id
--     forum_replies: is_hidden, author_name, topic_id
-- Concrete abuses (authorization / integrity, not confidentiality):
--   - self-unhide: admin hides a topic/reply (is_hidden=true), the
--     owner immediately un-hides it → moderation is bypassable by the
--     author of the flagged content.
--   - display-identity rewrite: owner overwrites author_name with any
--     forged display name on their own posts.
--   - content reassignment: owner moves a topic across categories or
--     a reply across topics, silently.
-- The current web client has NO topic/reply edit UI (no .update on
-- forum tables), so no application-code change is required; the
-- exposure is API-level only. Fix accordingly below.
--
-- AFFECTED TABLES: forum_topics, forum_replies
-- AFFECTED POLICIES: "update_own_forum_topics", "update_own_forum_replies"
--   (both remain, unchanged — column restriction is enforced below)
-- AFFECTED RPCs/functions: NEW function fn_forum_guard_owner_update()
-- AUTHORIZATION EFFECT: non-admin authors may keep editing owner-
--   editable business data but may NOT change moderation columns
--   (is_hidden/is_locked), identity (author_name), or cross-entity
--   references (category_id/topic_id). Admin moderation (phase7
--   admin_update_* policies) is preserved: the guard inspects the same
--   admin predicate used by those policies (fn_is_super_admin() OR
--   fn_has_permission('reports', null, 'edit')).
-- SECURITY RATIONALE: closes F4 at the database layer regardless of
--   which client performs the UPDATE; maintains the existing admin
--   moderation contract exactly.
-- MIGRATION ORDER: after M11 (admin session lock ACL). Independent of
--   M13. Applies to the same four forum tables created in phase6 —
--   requires schema_phase2 (fn_has_permission, fn_is_super_admin)
--   and phase7 (existing admin_moderation policies) to be present.
-- ROLLBACK: drop trigger for each table + drop function (documented
--   at bottom).
-- REQUIRED VERIFICATION: applied in a sandbox/staging DB first; then
--   (1) non-admin changes is_hidden on own topic → not_authorized;
--   (2) non-admin changes title/content on own topic → allowed;
--   (3) admin (fn_has_permission reports/edit) changes is_hidden on
--   a topic → allowed; (4) replies behave identically.
-- ============================================================

create or replace function public.fn_forum_guard_owner_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_is_admin boolean;
begin
  -- نفس مسند الأدمن المُستعمل في سياسات المراجعة الفعلية (phase7):
  -- super_admin أو من يملك صلاحية reports/edit.
  select (public.fn_is_super_admin() or public.fn_has_permission('reports', null, 'edit'))
    into v_is_admin;

  -- الأدمن: حرية كاملة على كل الأعمدة (مراجعة البلاغات) — بلا تغيير عما سبق.
  if v_is_admin then
    return new;
  end if;

  -- غير الأدمن (صاحب المحتوى): يُمنع تعديل أعمدة الوساطة/الهوية/الإسناد.
  if tg_table_name = 'forum_topics' then
    if new.is_hidden   is distinct from old.is_hidden
       or new.is_locked is distinct from old.is_locked
       or new.author_name is distinct from old.author_name
       or new.category_id is distinct from old.category_id
    then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'F4: moderation/identity/category columns are admin-only on forum_topics';
    end if;
  elsif tg_table_name = 'forum_replies' then
    if new.is_hidden is distinct from old.is_hidden
       or new.author_name is distinct from old.author_name
       or new.topic_id is distinct from old.topic_id
    then
      raise exception 'not_authorized'
        using errcode = '42501',
              hint = 'F4: moderation/identity/topic columns are admin-only on forum_replies';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.fn_forum_guard_owner_update() is
  'M12/F4: يمنع صاحب المحتوى (غير الأدمن) من تغيير أعمدة الوساطة/الهوية على صفوفه هو في المنتدى عبر PostgREST — دون مساس بمراجعة الأدمن (fn_is_super_admin/fn_has_permission reports/edit).';

drop trigger if exists trg_forum_guard_owner_update on public.forum_topics;
create trigger trg_forum_guard_owner_update
  before update on public.forum_topics
  for each row execute function public.fn_forum_guard_owner_update();

drop trigger if exists trg_forum_guard_owner_update on public.forum_replies;
create trigger trg_forum_guard_owner_update
  before update on public.forum_replies
  for each row execute function public.fn_forum_guard_owner_update();

-- ============================================================
-- ROLLBACK (documented; run manually, do NOT execute here)
-- ============================================================
--   drop trigger if exists trg_forum_guard_owner_update on public.forum_topics;
--   drop trigger if exists trg_forum_guard_owner_update on public.forum_replies;
--   drop function if exists public.fn_forum_guard_owner_update();
-- ============================================================