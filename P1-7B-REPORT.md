# P1-7B Report — Single Admin Session Lock

## Status
**PASS WITH LIMITATIONS**
(one item explicitly NOT VERIFIED — true multi-connection concurrency — see §9 and §14)

---

## 0. ⚠️ ملاحظة تسمية/ترقيم (اكتُشفت أثناء الـ audit)

الملف الموجود مسبقًا `sql/phase4b_p1_7b_mfa_enforcement.sql` (وكل التعليقات المرتبطة به داخل
`admin/admin.js` و`admin/index.html`) يسمي نفسه **"P1-7B"** لميزة MFA enforcement. تعليمات
التنفيذ الحالية تسمي MFA "P1-7A" وتسمي قفل الأدمن الفردي "P1-7B" — أي نفس الرقم مستخدم لميزتين
مختلفتين في مصدرين مختلفين.

لم أُعِد ترقيم أو أغيّر أي شيء في ميزة MFA القديمة (ولا يجوز حسب التعليمات). طبّقت هذه المهمة تحت
الاسم الحرفي المطلوب في قسم 10 من التعليمات (`..._p1_7b_admin_session_lock.sql`)، لكن **هذا
التعارض في الترقيم يحتاج توضيحًا/تصحيحًا منك قبل بدء أي P1 لاحقة** كي لا يتكرر الالتباس.

لا علاقة تقنية بين الميزتين؛ كل واحدة مستقلة تمامًا ولا تعدّل الأخرى — تحقّقت من ذلك حيًا (انظر §9).

---

## 1. Objective

منع وجود أكثر من جلسة Admin واحدة فعّالة (super_admin/admin/staff) في لوحة التحكم في آن واحد،
بفرض حقيقي من جهة الخادم/القاعدة (وليس client-side فقط)، مع TTL + heartbeat يمنع بقاء القفل
للأبد عند انقطاع الجهاز أو إغلاق المتصفح دون تسجيل خروج نظيف.

## 2. Files changed

| الملف | نوع التغيير |
|---|---|
| `sql/phase4b_p1_7b_admin_session_lock.sql` | **جديد** — الجدول + 3 دوال RPC |
| `admin/admin.js` | **معدَّل** — 148 سطر diff (إضافات فقط: state + دوال القفل + استدعاءاتها) |
| `admin/index.html` | **بدون تغيير** — لم يلزم أي عنصر UI جديد (استُخدم `#login-error` الموجود لعرض رسالة الرفض) |
| كل ملف آخر في المشروع (public pages، search، resources، favorites، js/app.js، js/auth.js، أي migration قديم) | **بدون تغيير** — تأكدت عبر `diff -rq` كامل بين النسخة الأصلية المرفوعة والنسخة النهائية (انظر §12) |

## 3. Database objects changed

جديد بالكامل (لا تعديل على أي جدول/دالة/سياسة قديمة):
- **جدول** `public.admin_session_lock` — صف singleton واحد فقط (`id boolean = true`)
- **دالة** `public.acquire_admin_session_lock()`
- **دالة** `public.refresh_admin_session_lock(uuid)`
- **دالة** `public.release_admin_session_lock(uuid)`

طُبّقت فعليًا على مشروع Supabase الحي (`lzmkgfxlsynaphpofblb`) عبر migration باسم
`phase4b_p1_7b_admin_session_lock`.

## 4. Session-lock design

- **Singleton row**: صف واحد ثابت طوال عمر الجدول (`PRIMARY KEY` على `id boolean` + `CHECK (id = true)`)،
  فحُذفت الحاجة لأي unique constraint إضافي — لا يمكن أن يوجد صف ثانٍ فيزيائيًا.
  "لا أدمن حاليًا" = الأعمدة كلها `NULL`؛ فرضنا ذلك أيضًا بـ `CHECK` إضافي
  (`admin_session_lock_full_or_empty`) يمنع أي حالة جزئية.
- **الذرّية (atomicity)**: كل عملية (acquire/refresh/release) هي `UPDATE ... WHERE` واحد على نفس
  الصف. Postgres يقفل الصف (`row lock`) لأي معاملة تعدّله؛ أي معاملة ثانية تحاول تعديل نفس الصف
  بالتزامن تُحجب حتى تنتهي الأولى، ثم تُعاد تقييم شرط `WHERE` على القيم الجديدة
  (Read Committed / EvalPlanQual) — فلا يمكن لمعاملتين متزامنتين أن تفوزا معًا بالقفل مهما تقاربت
  لحظة وصولهما.
- **لا تخزين لأي token حقيقي**: `session_token` هو `UUID` عشوائي (`gen_random_uuid()`) يُنشأ داخل
  الدالة نفسها، لا علاقة له بـ Supabase Auth access/refresh token — دوره الوحيد إثبات أن heartbeat/
  release القادم من نفس التبويب الذي فاز بالقفل.
- **الوصول للجدول**: `RLS` مفعّلة و**بلا أي policy إطلاقًا** (deny-all كامل من PostgREST)، مع
  `REVOKE ALL` صريح من `anon`/`authenticated` (تحقّقنا حيًا أن Supabase تمنح صلاحيات كاملة افتراضيًا
  لأي جدول جديد ما لم تُسحب — قارنّا بـ `admin_activity_log`). المسار الوحيد المتاح هو الدوال الثلاث،
  وكل واحدة `SECURITY DEFINER` مع `search_path` مضبوط، وتتحقق من `auth.uid()` وملكية القفل بنفسها.
- **user_id يُقرأ من `auth.uid()` فقط** في كل دالة — لا بارامتر `user_id` من العميل في أي مكان.

## 5. Login flow

`admin.js`: بعد نجاح `signInWithPassword` (ثم بعد نجاح MFA إن كان مطلوبًا لهذا الحساب)، الكود يمر
إلزاميًا عبر `enterDashboardWithLock(email)`:

1. `acquireAdminLock()` → RPC `acquire_admin_session_lock()`.
2. نجاح → تخزين `session_token` في متغير module-level، بدء heartbeat، عرض الداشبورد.
3. فشل (أدمن آخر فعّال، أو `not_authorized`، أو أي خطأ) → **لا تُعرض الداشبورد أبدًا** — تنظيف
   الحالة، `signOut()` فوري، رسالة عامة: *"يوجد مسؤول آخر يستخدم لوحة التحكم حاليًا. حاول لاحقًا."*
   لا يُكشف أي بريد/`user_id`/معلومة عن الجلسة الأخرى (الدالة نفسها لا تُرجع أي شيء عنها أصلاً).

MFA (P1-7A في تسمية التعليمات الحالية) لم تُمس إطلاقًا — القفل يُحاوَل *بعد* نجاح MFA كاملاً، ليس
بديلاً عنه ولا شرطًا مسبقًا له.

## 6. Logout flow

1. زر "تسجيل الخروج" → `releaseAdminLock()` (RPC `release_admin_session_lock`، best-effort:
   فشل الشبكة لا يمنع إتمام logout).
2. ثم `supabaseClient.auth.signOut()`.
3. تنظيف كل حالة الواجهة (`currentProfile`, `currentPermissions`, `currentMfaState`,
   `currentLockToken`, إيقاف الـ heartbeat timer).
4. إضافيًا: `pagehide` listener يحاول تحرير القفل مرة أخيرة عبر `fetch(..., {keepalive:true})`
   (يدعم ترويسة `Authorization` خلافًا لـ `sendBeacon`) — محاولة فرصة إضافية فقط، غير مضمونة،
   والضامن الحقيقي يبقى TTL.

## 7. Heartbeat / TTL

- **TTL** ثابت من جهة الخادم = **90 ثانية**، غير قابل للتغيير من العميل (الدالة لا تقبل أي بارامتر TTL).
- **Heartbeat** من الواجهة كل **25 ثانية** (RPC `refresh_admin_session_lock`) — أي ~3 فرص قبل
  انتهاء الـ TTL، فيتحمّل النظام انقطاع شبكة عابر مرة أو مرتين دون أن يخسر الأدمن الفعّال قفله،
  بينما جهاز مُغلَق فعليًا يتحرر قفله خلال 90 ثانية كحد أقصى بلا أي تدخل يدوي.
- إذا فشل heartbeat (القفل لم يعد ملك المستخدم، أو انتهت صلاحيته، أو `session_token` غير مطابق
  — كحالة تبويب قديم بعد فتح تبويب جديد لنفس الحساب) → `forceLockLogout()`: `signOut()` فوري +
  رسالة واضحة، بلا استمرار كـ Admin.

## 8. RLS/security

- `admin_session_lock`: `RLS ENABLED = true`, `policy_count = 0` (deny-all كامل)، وصلاحيات الجدول
  محصورة على `postgres`/`service_role` فقط (تحقّق حي، انظر §9).
- الدوال الثلاث: `SECURITY DEFINER`, `search_path = public`, `EXECUTE` ممنوح لـ `authenticated`
  فقط، ومسحوب صراحة من `anon`/`public`.
- لا `super_admin` استثناء — يخضع لنفس القفل مثل الجميع (قسم 9 من التعليمات)؛ لم تُلمس
  `fn_is_super_admin()` أو `fn_has_permission()` إطلاقًا (تحقّق حي، §9 أدناه).

## 9. Tests performed

كل الاختبارات نُفّذت حيًا على مشروع Supabase الفعلي داخل `BEGIN ... ROLLBACK` (باستثناء التحقق
الأخير من الحالة النظيفة بعد كل شيء)، عبر محاكاة مستخدمين مختلفين بضبط
`request.jwt.claims`/`role` مؤقتًا داخل نفس المعاملة — لا بيانات اختبار تُركت في الإنتاج.

| Test | Expected | Actual | Status |
|---|---|---|---|
| anon acquire | رفض (لا صلاحية تنفيذ) | `permission denied for function acquire_admin_session_lock` | **PASS** |
| non-admin authenticated acquire (uid لا يقابل أي profile) | `acquired:false, reason:not_authorized` | نفس النتيجة تمامًا | **PASS** |
| admin acquire (لا قفل حالي) | `acquired:true` + token | `acquired:true`, token مُرجَع | **PASS** |
| second admin blocked أثناء نشاط الأول | `acquired:false, reason:locked`، بلا كشف هوية الأول | نفس النتيجة، بلا أي تسريب | **PASS** |
| refresh owner | `ok:true` + `expires_at` جديد | نفس النتيجة | **PASS** |
| refresh non-owner | `ok:false, reason:not_owner_or_expired` | نفس النتيجة | **PASS** |
| release owner | `true` | `true` | **PASS** |
| release non-owner | `false` (بصمت، بلا استثناء) | `false` | **PASS** |
| expiry (قفل مُنتهٍ يدويًا في نفس المعاملة) → أدمن آخر يستطيع acquire | `acquired:true` | `acquired:true` | **PASS** |
| نفس الأدمن يعيد acquire (تبويب/تحميل جديد) يُبطل توكن التبويب القديم | refresh بالتوكن القديم يفشل، بالجديد ينجح | تحقّق تمامًا | **PASS** |
| release بعده → أدمن آخر يستطيع acquire | `acquired:true` | `acquired:true` | **PASS** |
| race condition (طلبان متزامنان فعليًا من اتصالين منفصلين) | فوز واحد فقط، بلا حالتين active معًا | **لم يُختبر بتزامن حقيقي** — الأداة المتاحة تنفّذ استعلامات SQL تسلسليًا ضمن اتصال واحد، لا تفتح اتصالين متوازيين فعليًا | **NOT VERIFIED** (انظر §14 للتبرير الهندسي البديل) |
| rollback cleanup | لا صفوف/بيانات متروكة | كل الاختبارات داخل `ROLLBACK`؛ الفحص النهائي بعدها يُظهر الصف الوحيد فارغًا كما كان قبل أي اختبار | **PASS** |

## 10. Frontend checks

- `node --check admin/admin.js` → **نجح** (لا أخطاء صياغة).
- `node --check js/auth.js` و`js/app.js` (سلامة عامة، لم يُعدَّلا) → **نجحا**.
- فحص وسوم `<script>` في `admin/index.html`: ترتيب التحميل يبقى
  `supabase-js CDN` ← `supabase-client.js` ← `app.js` ← `admin.js`، فمتغيّرات `SUPABASE_URL`/
  `SUPABASE_ANON_KEY` المستخدَمة في معالج `pagehide` الجديد متاحة فعليًا وقت التنفيذ.
- `admin/index.html` نفسه **بلا أي تعديل** — لا حاجة لعنصر UI جديد.

## 11. Live Supabase verification

بعد تطبيق الـ migration، تحقّقنا حيًا (استعلامات مباشرة على `pg_class`/`pg_policies`/
`information_schema`/`pg_proc`):

- الجدول موجود، وبه صف واحد بالضبط (`id=true`, كل الأعمدة `NULL`).
- `relrowsecurity = true`، `policy_count = 0`.
- صلاحيات الجدول: `postgres` و`service_role` فقط — **لا** `anon` ولا `authenticated`.
- الدوال الثلاث: `prosecdef = true` (SECURITY DEFINER)، `proconfig = ["search_path=public"]`.
- منح `EXECUTE`: `authenticated` (+ `postgres`/`service_role`) فقط على كل دالة — **لا** `anon`.

## 12. Regression check

- `diff -rq` كامل بين نسخة المشروع الأصلية المرفوعة والنسخة النهائية: الفرق الوحيد هو
  `admin/admin.js` (148 سطر diff، إضافات فقط) وملف SQL الجديد. لا شيء آخر تغيّر — لا public pages،
  لا search، لا resources logic، لا academic structure، لا favorites، لا `js/app.js`، لا أي
  migration قديم.
- تحقّق حي بعد التطبيق: `profiles` ما زال 4 صفوف بنفس الأدوار، `fn_has_permission` ما زال بنسختيه
  (3 و4 معاملات) كما كانتا، `fn_is_super_admin` موجودة بلا أي `CREATE OR REPLACE` جديد عليها،
  وبداية تعريف `fn_has_permission(3 معاملات)` (المرتبطة بـ MFA/P1-7A) مطابقة لما كانت عليه —
  أي لم يتأثر منطق MFA بهذا التغيير.

## 13. Rollback result

**لم يُنفَّذ Rollback فعلي** لأن كل الاختبارات تمت داخل `BEGIN...ROLLBACK` ولم يفشل أي جزء من
التطبيق الفعلي (الـ migration الحقيقية طُبّقت بنجاح ولم تحتَج تراجعًا). سكربت Rollback الآمن
موثّق داخل نهاية `sql/phase4b_p1_7b_admin_session_lock.sql` (تعليق SQL جاهز للتنفيذ اليدوي عند
الحاجة: `DROP FUNCTION`×3 ثم `DROP TABLE`) — آمن دائمًا لأن الجدول لا يحوي إلا صفًا تشغيليًا واحدًا
بلا بيانات تاريخية.

## 14. Known limitations

1. **NOT VERIFIED — تزامن حقيقي (true concurrency)**: لم أختبر طلبَي acquire من اتصالين
   منفصلين فعليًا في نفس اللحظة (الأداة المتاحة لي تُنفّذ عبر اتصال SQL واحد تسلسليًا). الضمان
   القائم بدلاً من ذلك هو **هندسي/بنيوي**: العملية هي `UPDATE ... WHERE` واحدة ذرّية على صف واحد
   محمي بـ row-level lock من محرّك Postgres نفسه — هذا نمط قياسي وموثّق لضمان singleton بدون
   race condition، لكنه يبقى ضمانًا نظريًا/تصميميًا هنا وليس نتيجة اختبار تزامن فعلي شهدته بنفسي.
   إن أردت تحققًا حيًا، يلزم تشغيل الاختبار من بيئة خارجية بإمكانها فتح اتصالين متوازيين فعليًا
   (مثال: سكربت Node/Python بـ`Promise.all`/`asyncio.gather` على مفتاحين مختلفين).
2. **سلوك متصفح/تبويبات متعددة حقيقي**: لم أختبر هذا داخل متصفح فعلي (لا أداة متصفح متاحة لي هنا)
   — فقط محاكيت المنطق المكافئ على مستوى SQL (نفس المستخدم يعيد acquire مرتين). السلوك المتوقع في
   متصفح حقيقي (تبويب قديم يُطرَد تلقائيًا عند heartbeat التالي) لم يُشاهَد بصريًا.
3. **إغلاق المتصفح/الشبكة**: `pagehide` + `fetch(keepalive)` تحسين فرصة فقط، غير مضمون (تحقّق من
   وصول الطلب فعليًا لم يُختبر في متصفح حقيقي)؛ الاعتماد الفعلي هو TTL (90 ثانية كحد أقصى).
4. **قيمة الـ TTL (90 ثانية) وheartbeat (25 ثانية)** قرار هندسي مبرر (≈3 فرص heartbeat قبل
   الانتهاء) وليس رقمًا مُختبَرًا تحت حمل إنتاجي فعلي — قابل للتعديل لاحقًا إن ظهرت حاجة عملية
   (مثلاً شبكة بطيئة جدًا لدى فريقكم).
5. تعارض تسمية "P1-7B" الموضّح في §0 يبقى بلا حل — يحتاج قرارك.

## 15. Final PASS/FAIL

**PASS WITH LIMITATIONS.** الميزة مطبَّقة وتعمل ومُتحقَّق منها حيًا لكل سيناريوهات الاختبار
القابلة للتنفيذ بالأدوات المتاحة، وكل ما لم يُختبر فعليًا مذكور صراحة في §9 و§14 دون ادّعاء
اختباره. لا تعديل خارج نطاق P1-7B. لم تُمس MFA/P1-7A، ولا super_admin استُثني، ولا بيانات اختبار
تُركت في الإنتاج.
