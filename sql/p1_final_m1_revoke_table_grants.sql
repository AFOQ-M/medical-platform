-- P1-Final M1: Defense-in-depth — explicit REVOKE on tables that are already
-- protected by RLS-with-no-policies (deny-all today), matching the pattern
-- already used on public.admin_session_lock. Closes the gap where a future
-- accidental policy addition on these two tables would otherwise inherit
-- broad table-level GRANTs. Access continues to flow only through the
-- existing SECURITY DEFINER RPCs (submit_public_report, increment_resource_view).
-- Applied to production and verified live (see P1-FINAL-REPORT.md, M1).

revoke all on public.report_rate_limits from anon, authenticated, public;
revoke all on public.resource_view_cooldowns from anon, authenticated, public;
