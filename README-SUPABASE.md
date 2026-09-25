# متطلبات Supabase — دليل الإعداد الكامل

هذا الملف يغطّي **كل متطلبات قاعدة البيانات** التي يحتاجها الموقع ليعمل بالكامل
(بحث، صلاحيات دقيقة، منتدى، دورات، لوحة تحكم، قفل جلسات، MFA). الملفات في `sql/`
مكتوبة بترتيب تنفيذي — شغّلها بالترتيب أدناه على **مشروع Supabase واحد**.

> الواجهة **Frontend ثابتة بالكامل** (HTML/CSS/JS بلا build) — لا يوجد خادم وسيط.
> المتصفح يتصل مباشرة بـ Supabase عبر مفتاح `anon public` (آمن للاستخدام العلني
> لأنه محكوم بسياسات RLS؛ **لا** تستخدم `service_role` أبدًا في أي كود يُنشر).

---

## 1) إنشاء المشروع والمفاتيح

1. أنشئ مشروعًا على [supabase.com](https://supabase.com) (اختر region جديدًا، لاحظ `Project Ref`).
2. من القائمة الجانبية: **Project Settings → API**، انسخ:
   - **Project URL** — مثال: `https://<ref>.supabase.co`
   - **anon public key** — يبدأ عادةً بـ `eyJ...`
3. ضع القيمتين في **`js/supabase-client.js`** فقط (الملف الوحيد المسؤول عن الاتصال):

   ```js
   const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
   const SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";
   ```

4. **تأكيد المتطلب:** الموقع يعتمد على مكتبة `supabase-js` الـ UMD من jsdelivr المثبّتة
   داخل الصفحات (رابط ذا `integrity`/`crossorigin=anonymous`). لا تحتاج تثبيت npm.

---

## 2) ترتيب تشغيل ملفات sql (إلزامي)

شغّل ملفات `sql/` في SQL Editor **بهذا الترتيب** على مشروع جديد. الملفات تتراكم
فوق بعضها (لا موجودة مسبقًا في قاعدة فارغة).

| # | الملف | يضيف |
|---|-------|------|
| 1 | `schema.sql` | الجداول الأساسية الخمسة + RLS + سياسات |
| 2 | `schema_phase2.sql` | `profiles` + `user_permissions` + `admin_activity_log` + `fn_has_permission()` + `search_resources()` v1 |
| 3 | `schema_phase2_5.sql` | جدول `faculties` + `years.faculty_id` + نطاق صلاحية `faculty` |
| 4 | `schema_phase2_5_part2.sql` | تحديث `search_resources()` للكلية + تصلّيب `years.faculty_id` |
| 5 | `phase3_engagement.sql` | `resources.view_count` + `resources.verified` + `increment_resource_view(uuid)` |
| 6 | `phase3_search_compatibility.sql` | **إصلاح إلزامي**: حذف نسختَي `search_resources()` المتعارضتين وإنشاء نسخة كنونية واحدة |
| 7 | `phase4_p1_1_search_resources_pagination.sql` | `p_limit`/`p_offset` مع clamp خادمي (ترقيم صفحات) |
| 8 | `phase4_p1_4_years_subjects_is_active.sql` | `years.is_active` + `subjects.is_active` (إخفاء ناعم) |
| 9 | `phase4a_p0_4_report_rate_limit.sql` | حد زمني للبلاغات العامة `submit_public_report()` |
| 10 | `phase4b_auth_foundation_fix.sql` | إصلاح أساس المصادقة (تخطي إنشاء profile لمستخدمي anonymous) |
| 11 | `phase4b_p0_3_view_rate_limit.sql` | تهدئة 30 دقيقة لعدّاد المشاهدات |
| 12 | `phase4b_p0_3_p0_4_digest_schema_fix.sql` | إصلاح مخطط خلاصة P0-3/P0-4 |
| 13 | `phase4b_subject_semester.sql` | عمود `subjects.semester` (`first`/`second`/`summer`) |
| 14 | `phase4b_p1_7b_mfa_enforcement.sql` | فرض MFA/تحقق AAL2 وظيفيًا (P1-7A) |
| 15 | `phase4b_p1_7b_admin_session_lock.sql` | قفل جلسة الأدمن (جلسة واحدة) + RPCs |
| 16 | `phase4c_p1_7b_first_session_wins.sql` | سياسة "أول جلسة تفوز" (First Session Wins) |
| 17 | `phase4d_p1_6_file_url_check.sql` | قيود `CHECK` على `resources.file_url` |
| 18 | `phase5_p1_courses_mvp.sql` | الدورات: `courses` + `course_lessons` + RLS + الصلاحيات |
| 19 | `phase6_forum_mvp.sql` | المنتدى: `forum_categories`/`forum_topics`/`forum_replies`/`forum_reports` |
| 20 | `phase7_forum_admin_moderation.sql` | مراجعة بلاغات المنتدى من الأدمن |
| 21 | `p1_final_m1_revoke_table_grants.sql` | REVOKE دفاع-في-العمق على `report_rate_limits`/`resource_view_cooldowns` |
| 22 | `p1_final_m2_search_path_hardening.sql` | تثبيت `search_path` على `search_resources()` و`fn_sync_year_university_from_faculty()` |
| 23 | `p1_final_m6_merge_select_policies.sql` | دمج سياسات SELECT المكررة (Perf Advisor) |
| 24 | `p1_final_m7_wrap_auth_functions.sql` | لفّ `auth.uid()`/`fn_is_super_admin()` في `(SELECT …)` مرة واحدة |
| 25 | `p1_final_m8_super_admin_aal2_enforcement.sql` | فرض AAL2 حرفيًا على Super Admin |
| 26 | `p1_final_m9_core_table_grant_hardening.sql` | نزع GRANTs عامة (TRUNCATE/TRIGGER/REFERENCES) عن anon/authenticated |
| 27 | `p1_final_m10_maintain_revoke.sql` | نزع `MAINTAIN` (PG17) عن anon/authenticated |
| 28 | `p1_final_m11_admin_session_lock_acl.sql` | إغلاق ثغرة ACL على RPCs قفل الجلسة |
| 29 | `p1_final_m12_forum_owner_update_guard.sql` | ⚠️ **مقترح — غير مطبّق** (حارس تحديث محتوى المنتدى) |
| 30 | `p1_final_m13_forum_report_integrity.sql` | ⚠️ **مقترح — غير مطبّق** (سلامة البلاغات + حد زمني) |

> ⚠️ **ملاحظتان مهمّتان:**
> - الملفان الأخيران (`M12`/`M13`) يحملان الترويسة **PROPOSED — NOT APPLIED** في صدر كل
>   ملف. يغيّران كائنات RLS حساسة، فأُجِّلا حتى مراجعة يدوية للنشر. **لا تشغّلهما** تلقائيًا
>   قبل فهمهما — راجع شروحهما أعلاه في الملفات.
> - بعض ملفات `p1_final_m*` (M8/M9/M10) تحتوي في صدرها إشارة "repository/source-control
>   parity" لأنها أُعيد كتابتها لتعكس التطبيق الحي الحرفي — التنفيذ من `sql/` هو المرجع
>   الرسمي للبيئة الحالية.

---

## 3) دالة واجهة البرمجة (RPCs) التي يستدعيها الموقع

اجعلها موجودة بعد تشغيل الخطوات أعلاه (لا حاجة لتثبيت إضافي):

| RPC | المستخدِم | الدور |
|-----|-----------|-------|
| `search_resources(query, type, university_id, …, limit, offset)` | `js/app.js` | البحث الشامل (ترقيم صفحات) |
| `increment_resource_view(uuid)` | `js/app.js` | عدّاد مشاهدات الزوار (security definer ضيق) |
| `submit_public_report(...)` | `js/app.js` | إرسال بلاغات عامة مع حد زمني |
| `acquire_admin_session_lock()` | `admin/admin.js` | قفل جلسة أدمن |
| `refresh_admin_session_lock()` | `admin/admin.js` | نبض/تمديد الجلسة المكتسبة |
| `release_admin_session_lock()` | `admin/admin.js` | فك الجلسة مع تسجيل الخروج |

---

## 4) الجداول التي يتوقعها الموقع

- الهيكل الأكاديمي: `universities` → `faculties` → `years` → `subjects` → `resources`
- الصلاحيات: `profiles`، `user_permissions`، `admin_activity_log`
- التفاعل: `reports` (بلاغات الموارد)، `report_rate_limits`، `resource_view_cooldowns`
- المنتدى: `forum_categories`، `forum_topics`، `forum_replies`، `forum_reports`
- الدورات: `courses`، `course_lessons`
- الأمان: `admin_session_lock` (قفل الجلسة)

---

## 5) إنشاء حسابات الأدمن

1. **Authentication → Users → Add user** — بريد + كلمة مرور مؤقتة + تفعيل **Auto Confirm User**.
2. يظهر صف تلقائيًا في `profiles` بدور `staff` وبدون صلاحيات (الـ trigger).
3. لأول Super Admin — نفّذ مرة في SQL Editor:
   ```sql
   update profiles set role = 'super_admin' where email = 'YOUR_EMAIL_HERE';
   ```
4. المستخدمون اللاحقون: من `/admin` ← "المستخدمون والصلاحيات" لمنح الدور
   (`staff`/`admin`) والصلاحيات لكل جامعة/كلية.

> لا يُمنح أي حساب صلاحية تلقائيًا — RLS ترفض كل شيء إلا بصفوف صلاحيات فعلية.

---

## 6) النشر والبيئة

- **الفرع المرجعي:** `master` (راجِع `README.md` للحصول على خطوات GitHub Pages).
- الموقع الحي حاليًا على **Cloudflare Pages** (`afoq-m.pages.dev`) ويرفق ملف `_headers`
  برؤوس أمان (CSP/Frame/Referrer/Permissions). عند النشر على أي CDN آخر، انقل تلك الرؤوس بنفسك.
- **CI:** `.github/workflows/ci.yml` يشغّل `npm ci` ثم `npm test` (وحدة 21 ملفًا).
- **الاختبار المحلي:** `node scripts/dev-server.js --port 3100` أو `python3 -m http.server`.
- مجموعة الوحدات لا تحتاج أي اتصال حي بـ Supabase؛ الاختبارات الحيّة (`test-full.js`,
  `test-runtime-deferred.js`) تتطلب هدفًا حيًا وتُستدعى يدويًا بشكل صريح.

---

## 7) تحقق سريع بعد الإعداد

- افتح `index.html` محليًا/حيًّا → يجب ألا يظهر أي `console.error` من Supabase.
- صفحة `search.html` يجب أن تعيد نتائج فورية من الهيدر (تستدعي `search_resources`).
- سجّل دخول إلى `/admin` بحساب وله صلاحيات → لوحة تحكم تعمل.
- فعّل MFA لحساب Super Admin (فرض AAL2) — بدونها قد تُرفض عملياته الإدارية.