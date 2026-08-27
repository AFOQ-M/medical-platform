-- P1-Final M6: Merge duplicate permissive SELECT policies on
-- faculties/years/subjects/resources into a single policy per table using OR,
-- resolving the Supabase Performance Advisor's "Multiple Permissive Policies"
-- finding. Semantics validated equivalent in a rolled-back transaction against
-- anon, a real staff account with global view permissions, and an authenticated
-- account with zero permissions (see P1-FINAL-REPORT.md, M6). No change to
-- INSERT/UPDATE/DELETE policies or to function permissions. Applied to production.

drop policy auth_read_all_faculties on public.faculties;
drop policy public_read_active_faculties on public.faculties;
create policy read_faculties on public.faculties for select using (
  is_active = true or fn_has_permission('academic_structure', university_id, id, 'view')
);

drop policy auth_read_all_years on public.years;
drop policy public_read_active_years on public.years;
create policy read_years on public.years for select using (
  is_active = true or fn_has_permission('academic_structure', university_id, faculty_id, 'view')
);

drop policy auth_read_all_subjects on public.subjects;
drop policy public_read_active_subjects on public.subjects;
create policy read_subjects on public.subjects for select using (
  is_active = true or fn_has_permission(
    'academic_structure',
    (select y.university_id from public.years y where y.id = subjects.year_id),
    (select y.faculty_id from public.years y where y.id = subjects.year_id),
    'view'
  )
);

drop policy auth_read_all_resources on public.resources;
drop policy public_read_published_resources on public.resources;
create policy read_resources on public.resources for select using (
  status = 'published' or fn_has_permission(
    'resources',
    (select y.university_id from public.subjects s join public.years y on y.id = s.year_id where s.id = resources.subject_id),
    (select y.faculty_id from public.subjects s join public.years y on y.id = s.year_id where s.id = resources.subject_id),
    'view'
  )
);
