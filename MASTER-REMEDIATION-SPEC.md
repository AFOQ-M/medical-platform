# MASTER-REMEDIATION-SPEC.md — المواصفة الوحيدة لمراحل NEW-01..08

> مرجع متحكَّم للمرحلة "AFOQ — MASTER ALL-IN-ONE REMEDIATION" (2026-09-24).
> كل مرحلة NEW-* تُعرَّف هنا كتابيًا قبل أي تنفيذ: العنوان ← المشكلة الحقيقية
> في الكود ← السلوك المستهدف ← شروط القبول ← حدود صارمة. أي إنفاذ لم يُستوفَ
> شروط قبوله يُعلَّم `BLOCKED-BY-MISSING-AUTHORITATIVE-SCOPE` ولا يُنفَّذ
> بافتراضات. لا تعديل على أي مواصفة بعد التوقيع دون تحديث هذا الملف.

---

## NEW-01 — Focus Traps (فخاخ التركيز لكل الطبقات العائمة)

- **المشكلة الحقيقية في الكود:** يوجد اليوم ثلاثة أنظمة عائمة:
  1. `report-modal` (كل الصفحات العامة) — مُثبَّتة فعليًا عبر `wireDialogOverlay`
     (`js/app.js:518-564`): فخ Tab + Escape + استعادة التركيز + حارس `focusin`.
  2. `auth-overlay` (`js/auth.js:313-339`) و`global-search-overlay`
     (`js/app.js:655-680`) — تملك Escape وإغلاق بالنقر على الخلفية لكن **بلا فخ
     Tab وبلا حارس focusin وبلا استعادة تركيز صريحة موحّدة**.
  3. `account-sidebar` (`js/auth.js:547-613`) — تملك Escape واستعادة تركيز
     (`closeAccountSidebar` + `accountSidebarPreviousFocus`) لكن **بلا فخ Tab وبلا
     حارس focusin**.
  4. Drawers الإدارية (`admin/admin.js:1184-1251`) — مثبَّتة بفخها الخاص وتُغطّيها
     مجموعة `test-admin-drawers.js` (17/17 خضراء).

- **السلوك المستهدف:** كل طبقة عائمة مفتوحة (hidden=false) تحصر Tab داخل
  عناصرها، تقبل Escape للغلق، تستعيد التركيز لمن فتحها، وتمنع الهروب عبر
  النقر/Tablet إلى خلفها (containment). الاختبار الوحيد المطلوب = تغطية
  `auth-overlay` و`global-search-overlay` و`account-sidebar` عبر حارس
  `focusin`/Tab متطابق للنمط الموثّق في `js/app.js`. **لا إعادة كتابة** لدوال
  أخرى، لا تغيير سلوكي، لا إزالة لأي سلوك قائم.

- **شروط القبول:**
  - `auth.js` و`app.js`: الطبقات الثلاث المذكورة تفتح/تغلق بنفس عائلة
    `_dialogFocusables`/focusin-guard في app.js، وتبقى 10/10
    (test-google-auth-state) و12/12 (test-account-sidebar) خضراء.
  - ملف اختبار جديد `test/test-focus-traps.js` يتحقق: Tab من آخر عنصر
    يلتفّ لأول، Shift+Tab من أول يلتفّ لآخر، Escape يغلق، التركيز يعود
    للمحفّز بعد الإغلاق، focusin على عنصر خارجي يُعاد للطبقة.
  - لم تُعدّل `wireDialogOverlay` ولا منطق Drawer في admin.js على الإطلاق.

- **حدود صارمة:** لا لمس لـ `report-modal` القائم ولا لـ drawers الإدارية.

---

## NEW-02 — Destructive Confirm (تأكيد الإجراءات المدمرة)

- **المشكلة الحقيقية في الكود:** `window.confirm` البنّاء المدمج في ثلاثة مواضع:
  - `admin/admin.js:713` — تعطيل التحقق بخطوتين (MFA Disable، فعل مدمر).
  - `admin/admin.js:2892` — `deleteRow()` لكل صفوف جداول الأدمن.
  - `favorites.html:241` — إزالة مورد من المفضلة (مدمر للمفضلة المحلية).
  البنّاء الأصلي: غير قابل للتنسيق، لا يدعم العناوين النصية لقراء الشاشة
  بصورة جيدة، ومتشقّق في بعض السياقات الحديثة.

- **السلوك المستهدف:** بديل تأكيد في الصفحة (inline) بنفس نمط الـ modal الموجود
  (role="dialog" aria-modal="true" aria-labelledby، زرّان: تأكيد/إلغاء)، يُبنى
  عبر JS بالDOM APIs/textContent safety (لا innerHTML لبيانات قاعدة البيانات)،
  لا يغيّر أي تدفق تجاري (نفس الترتيب، نفس الرسالة، نفس القرار). **تظل
  `favorites.html:241` دون تغيير في هذه المرحلة** لأن منطق المفضلة خارج نطاق
  الأدمن — تُوثَّق فقط في التقرير النهائي كملاحظة (مؤجَّلة).

- **شروط القبول:**
  - `admin/js`: دالة `showDestructiveConfirm({ title, message, onConfirm })`
    تُرجع فورًا وتستدعي onConfirm بعد قبول المستخدم فقط؛ إلغاء/خلفية/Escape =
    لا تنفيذ.
  - استُبدل `confirm()` في `admin.js:713` و`admin.js:2892` بهذه الدالة.
  - اختبار `test/test-admin-confirm.js` الجديد يتحقق من:
    إلغاء → لا استدعاء onConfirm، قبول → استدعاء مرة واحدة، dialog يغلق بعد
    القرار، التركيز يعود للمحفّز.
  - لا أي `window.confirm` باقٍ في `admin.js` (بحث ختامي صفري).

- **حدود صارمة:** لا تغيير في أي استعلام Supabase أو ترتيب العمليات؛ التأكيد
  واجهة فقط.

---

## NEW-03 — Field Validation (التحقق من حقول النماذج)

- **المشكلة الحقيقية في الكود:** `admin.js` لا تحوي أي `setCustomValidity` أو
  `pattern` أو `required` صريحة على حقول النماذج (فقط `required` على select في
  بعض القوالب العامة). النماذج: نموذجا `res-form` و`course-form` داخل drawers
  الإدارية.

- **السلوك المستهدف:** تحقق خفيف صحي داخل `admin.js` فقط للحقول الآتية:
  - `title` (المورد/الدورة): مطلوب وغير فارغ بعد trim.
  - `file_url` (المورد): عند `source_type !== "link"` يلزم رابط non-empty
    بصيغة URL مقبولة (`https?://` أو مسار نسبي `/...`).
  ربط عبر `addEventListener("submit")` و`blur`/`input`، رسائل نصية عربية
  بجانب الحقل مع `aria-describedby`/`setCustomValidity`، **بلا أي اعتراض على
  الحفظ الفعلي الحالي** عند البيانات الصحيحة.

- **شروط القبول:**
  - يُركّب `validateResourceForm()` / `validateCourseForm()` وتُستدعيان عند
    submit؛ submit يمنع عند الخطأ ولا يرسل شبكة.
  - اختبار `test/test-admin-validation.js` يغطي: title فارغ يُرفض؛ file_url
    سيئ يُرفض; title + رابط صحيح يمرّان; لا console.error عند الرفض.
  - كل مجموعات admin السابقة (helpers/delete/permissions/reports/drawers)
    تبقى خضراء.

- **حدود صارمة:** لا تغيير في schema/RLS؛ الصلاحية client-side فقط.

---

## NEW-04 — Subject Pagination (ترقيم موارد المادة)

- **المشكلة الحقيقية في الكود:** `subject.html` يسحب كل الموارد المنشورة
  للمادة بلا limit (`subject.html:156-161`)، والفلترة (نوع/بحث) محلية على
  القائمة الكاملة. قد يتجاوز سقف منصة Supabase (1000) في مواد ضخمة ويبطئ.
- **السلوك المستهدف:** ترقيم add-on خلفي على مستوى الصفحة: جلب كل الموارد
  المطلوبة عبر `range()` بدفعات (مثلاً 100) حتى يتوقف أو يكتمل — **مع بقاء
  الفلترة/التبويبات/البحث محلية كما هي على القائمة الكاملة المجمَّعة**. لا
  تغيير في واجهة الترقيم؛ لا pagination UI جديدة. يُحسب العدد فقط لإبعاد
  الصفحة عن سقف المنصة.

- **شروط القبول:**
  - `loadSubjectPage` يجمع عبر حلقة `range(offset, offset+99)` حتى `row < 100`
    أو لا مزيد من الصفوف، بنفس select/order، ويستمر بدقة على النتيجة.
  - معكوك ينفّذ: مجموعة 250 موردًا تُرجَع كاملة دون سقف.
  - `test/test-subject-pagination.js`: يتحقق أن `.range()` أُستُدعيت
    بالتسلسل وأن القائمة المجمَّعة كاملة وأن الترتيب `created_at desc` محفوظ.
  - لا تغيير في `subject.html` markup.

- **حدود صارمة:** لا لمس لـ `platform.html:273` (يفعل ذلك أصلاً) ولا لاي
  أي ملف آخر.

---

## NEW-06 — Admin Pagination (ترقيم لوحة الأدمن)

- **المشكلة الحقيقية في الكود:** `admin/admin.js:1802` `.limit(1000)` سقف صامت.
  في الموارد يتوقّع الترقيم الفعلي.
- **السلوك المستهدف:** استبدال السقف الصامت بنمط جلب كامل عبر
  `range()` بدفعات (100) مشابه لـ NEW-04، دون إضافة UI ترقيم
  (فلاتر admin/بحث/نوع/حالة تبقى محلية على `resourcesCache` المجمَّعة). العدد
  الإجمالي يُحسب ليُعرَض في وسم العدد أعلى الجدول إن وُجد.

- **شروط القبول:**
  - `loadResources`/`loadSubjects` (وكل دالة يمكنها تجاوز 1000) تجمع عبر
    `range()` حتى تكتمل الأفواج.
  - `test/test-admin-pagination.js` يتحقق من تسلسل range ومن اكتمالcache.
  - 9/9 admin-reports و17/17 drawers وكل مجموعات admin تبقى خضراء.

- **حدود صارمة:** لا تغيير في layout الجدول/الأزرار.

---

## NEW-07 — Topic Social Meta (وسوم Open Graph لصفحة الموضوع)

- **المشكلة الحقيقية في الكود:** `forum-topic.html` بلا أي `og:`/`twitter:`
  meta (القائمة الكاملة في ملفات أخرى: og:title/description/type/image +
  twitter:card/title/description/image).
- **السلوك المستهدف:** إضافة الكتلة نفسها بصيغتها الثابتة والموجودة في
  `forum.html` و`courses.html` مع العنوان المناسب ("الموضوع — ملتقى أفق").
- **شروط القبول:**
  - `forum-topic.html` يحتوي كل meta ذاتها (og:title/description/type/image +
  twitter:4) بنفس الرابط/image.
  - `test/test-forum-meta.js` (أو إضافة في test-forum) يتحقق من وجودها.
  - 20/20 test-forum تبقى خضراء.

- **حدود صارمة:** لا تغيير في `<title>` ولا في محتوى الصفحة.

---

## NEW-08 — Lazy / Async Images (تحميل كسول للصور)

- **المشكلة الحقيقية في الكود:** صفر استخدام لـ `loading="lazy"` أو
  `decoding="async"` في أي HTML عام (فقط brand/logos تظهر أعلى الصفحات).
- **السلوك المستهدف:** إضافة `loading="lazy"` و`decoding="async"`
  لبطاقات الموارد المنشأة ديناميكيًا في `setupResourceToolbar`/
  `buildResourceCard` (صفحات subject/search/platform/courses/favorites)
  حيث تُضاف الصور المصغّرة للبطاقات عبر JS، **مع بقاء شعار الهيدر/الفوتر
  (~المحتوى الأساسي) بدون lazy**.
- **شروط القبول:**
  - `buildResourceCard` (المشتركة في `js/app.js`) تضيف السمتين للصور
    الثابتة المحلية (afaq/materials/slides...). الصور الخارجية (Google
    Drive/من ملفات المستخدم) لا تُغيّر سياساتها currentOrigin.
  - `test/test-lazy-images.js` يتحقق أن سمة lazy موجودة على الصور
    المنشأة وأنها غائبة عن شعار header.
  - المجموعات القائمة كلها تبقى خضراء.

- **حدود صارمة:** لا IntersectionObserver زائد (بدل منه)؛ لا تغيير لعنوان
  الشعار في الـ HTML القائم.

---

## ملاحظات توثيقية (LATER / خارج النطاق)

- `favorites.html:241` (confirm إزالة المفضلة) — مذكور في NEW-02 كمؤجَّل.
- `platform.html:273` يفعل pagination أصلاً — مرجع فقط.
- `NEW-05` غير موجود — معلَّم `DOES-NOT-EXIST` ولا يُنفَّذ.

> نهاية المواصفة. أي تعديل لاحق يُحدَّث هنا أولاً مع سطر "التعديل".

---

## سجل التعديل (CHANGE LOG)

- **2026-09-25 (التعديل 1):** Group E أُضيف (خارج NEW-* — لا يمس هذه المواصفة):
  كل `<svg>` في الصفحات العامة الـ13 صار `focusable="false"` (65 أيقونة فوتر
  social + بقية الأيقونات/الشعارات)، مع `test/test-footer-svg-focus.js` (5/5).
  مرجع: `MASTER-REMEDIATION-REPORT.md`.
- **2026-09-25 (التعديل 2 — نشر):** تأكيد أن النطاق الفعلي هو
  `https://afoq-m.pages.dev` (Cloudflare Pages، الجذر) وليس
  `afoq-m.github.io/medical-platform`. أُعيد توجيه كل canonical/og:url/
  og:image/twitter:image في الـ11 صفحة عامة + `sitemap.xml` + `robots.txt`
  إلى النطاق الحي (36 استبدالًا، بلا كسر اختبارات — المتأثرة كلها خضراء).
  NEW-07 لا يربط host مطلقًا (يقارن الصفحات ببعضها) — لا أثر على شروط قبوله.