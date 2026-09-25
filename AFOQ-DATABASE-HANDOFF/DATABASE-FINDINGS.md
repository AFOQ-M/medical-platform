# AFOQ — DATABASE FINDINGS (سجل النتائج الكامل)

> **صاحب هذا السجل:** Big Pickle — طبقة التطبيق والتحليل المصدر.
> **مَن يُطبِّق:** Claude — قاعدة البيانات، عند فك تجميد DB.
> **الحالة العامة:** كل تغيير هنا `PROPOSED — NOT APPLIED` (تجميد قيد السريان).

---

## F4 — تعديل مالك محتوى المنتدى (forum owner update) — غير آمن على مستوى الأعمدة

**النتيجة:** M12 (PROPOSED) — `F4-forum-integrity.sql`

- **السبب الجذري:** السياستان `update_own_forum_topics` و`update_own_forum_replies`
  تتحكمان بالصف فقط عبر `author_id = auth.uid()`؛ RLS بلا تحكم على مستوى العمود.
  النتيجة: أي مالك (مستخدم مصادق) يستطيع عبر PostgREST UPDATE تغيير أعمدة
  الوساطة/الهوية/الإسناد على صفوفه: forum_topics.is_hidden/is_locked/author_name/
  category_id، وforum_replies.is_hidden/author_name/topic_id.
- **إساءة فعلية:**
  - self-unhide: الأدمن يخفي موضوعًا، المالك يرفع الإخفاء فورًا → تحايل على المراجعة.
  - author_name: يكتب اسمًا مستعارًا مزوّرًا على منشوراته.
  - category_id/topic_id: ينقل الموضوع/الرد عبر الكيانات بصمت.
- **واقع العميل:** لا توجد واجهة تعديل topics/replies في `js/forum.js` (لا `.update`
  على جداول المنتدى) → لا حاجة لتغيير كود التطبيق؛ التعرض API-level فقط.
- **الإصلاح:** دالة SECURITY DEFINER trigger `fn_forum_guard_owner_update()` على
  `before update` لكلا الجدولين؛ للأدمن الحرية الكاملة (نفس مسند phase7:
  `fn_is_super_admin() OR fn_has_permission('reports', null, 'edit')`)، ولغير الأدمن
  منع تغيير الأعمدة المحمية مع السماح بباقي الأعمدة (title/content/…).
- **مرجع:** `sql/phase6_forum_mvp.sql` (الجداول)، `sql/phase7_forum_admin_moderation.sql`
  (سياسات الأدمن المحفوظة كما هي).

## F5 — سلامة بلاغات المنتدى + لا حد زمني + بلاغ عن هدف غير منشور

**النتيجة:** M13 (PROPOSED) — `F5-report-integrity.sql`

- **السبب الجذري أ (تزوير حالة المراجعة):** سياسة `insert_own_forum_reports` تتحقق من
  `reporter_id = auth.uid()` فقط؛ يستطيع العميل إدراج سطر جديد بأعمدة وساطة مزوّرة
  مثل `status='reviewed'`, `reviewed_by=<any uuid>`, `reviewed_at=now()` دون أي إجراء أدمن.
- **السبب الجذري ب (إغراق قائمة المراجعة):** forum_reports بلا حد زمني؛ بلاغات
  المنتدى تُدرج مباشرة من العميل (بعكس P0-4 التي لها submit_public_report مع
  report_rate_limits) → حساب واحد يملأ طابور المراجعة بلا قيود.
- **السبب الجذري ج (هدف غير منشور):** `submit_public_report(p_resource_id,…)` لا يتحقق
  أن المورد منشور؛ تستحق الثبات على مستوى DB ولو كانت الواجهة لا تعرض إلا الموردة
  المنشورة.
- **واقع العميل:** `submitForumReport()` في `js/forum.js` يبني الحمولة من
  `{reporter_id, reason, details, topic_id, reply_id}` فقط — لا يرسل status/reviewed_by/
  reviewed_at إلى الأبد → الإصلاح DB-level يحمي كل العملاء دفعة واحدة.
- **الإصلاح:**
  1. إعادة تعريف `insert_own_forum_reports` بتثبيت `status='pending' AND
     reviewed_by IS NULL AND reviewed_at IS NULL` عند `with check`.
  2. جدول `forum_report_rate_limits` (مفتاح reporter_id عبر auth.users, RLS مفعّل
     بلا سياسات — الوصول حصري عبر SECURITY DEFINER) + trigger يثبّت حالة المراجعة
     ويفرض نافذة 10 بلاغات/10 دقائق لكل مبلّغ.
  3. `submit_public_report` تُعاد تعريفها بالتحقق `resources.status = 'published'`
     مع الإبقاء على limite P0-4 (5/10 دقائق per rate_key بـ cf-connecting-ip) وتعريف
     digest من schema `extensions` (مطابق لـ phase4b hotfix).

## M11 — حماية قفل الأدمن الوحيد من حسابات staff التلقائية (ACL)

**النتيجة:** M11 (PROPOSED) — `M11-admin-session-lock.sql`

- **السبب الجذري:** `schema_phase2.sql` ينشئ profile تلقائيًا لكل مستخدم Auth جديد
  بـ role='staff', active=true. دالة `acquire_admin_session_lock()` كانت تسمح لأي
  owner بدور ضمن ('super_admin','admin','staff') — أي أن أي مستخدم مسجّل يملك حصريًا
  قفل لوحة التحكم الوحيد ويجدّده كل <90 ثانية (إعادة acquire) → حرمان الإدارة الحقيقية
  إلى ما لا نهاية (DoS).
- **الإصلاح:** تطبيق نفس نموذج التفويض الفعلي مثل `fn_has_permission()` (p1_final_m8):
  - super_admin (نشط) → مسموح.
  - admin/staff → مسموح فقط بسطر `user_permissions.active = true` واحد على الأقل.
  - حساب staff تلقائي بلا أذونات → `not_authorized`.
  - سلوك القفل نفسه (First Session Wins من phase4c) يبقى دون أي تغيير: فقط شرط
    الوصول يُشدَّد. لا changes على refresh/release ولا DROP.

## ملاحظات تحقق ميدانية من Big Pickle (ليست قاعدة بيانات)

- كل اختبارات التطبيق المتصلة بهذا الكود (test-admin-lock-acl.js، test-forum-integrity.js،
  test-admin-mfa.js) هي static source-integrity — تثبت أن الواجهة لا ترسل أعمدة محمية
  ولا تتجاوز الحارس، ولا تُثبت سلوك RLS/trigger (ذلك في نطاق Claude ويُغطَّى في
  DATABASE-TEST-MATRIX.md بأوامر SQL فعلية ضد DB).
- لا توجد أداة تغذية (fixtures) بيانات منشورة في البيئة — أي اختبار يتطلب صفوف DB
  منشورة يبقى NOT-VERIFIED في Big Pickle حتى يوفّرها Claude أو يفك التجميد في بيئة
  اختبار منفصلة.

## تحديث Claude (يُملأ بعد التطبيق)

بعد تطبيق كل ملف: حدّث الحالة هنا إلى `APPLIED` وقم بإكمال `DATABASE-TEST-MATRIX.md`
بنتائج الأوامر الفعلية. لا تُعدّل هذه الصفحة إلا بالنتائج الفعلية لا الافتراض.