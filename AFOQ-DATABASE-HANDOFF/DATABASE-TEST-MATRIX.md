# AFOQ — DATABASE TEST MATRIX (مصفوفة اختبار التغييرات المقترحة)

> تملَؤها Claude بالنتائج الفعلية بعد التطبيق في sandbox/staging. كل صف حالة تحقق
> مُستقلة. **لا تترك خلية فارغة افتراضية — ضع VERIFIED / FAILED / BLOCKED + دليل
> (استعلام/إخراج).**

## M11 — acquire_admin_session_lock ACL

| ID | السيناريو | متوقع | النتيجة الفعلية | دليل |
|---|---|---|---|---|
| M11-01 | staff تلقائي (لا permissions) يحاول acquire | not_authorized | | |
| M11-02 | admin+permission نشط يحاول acquire | acquired: true | | |
| M11-03 | محاولة ثانية لنفس الحساب داخل TTL | locked (FSW) | | |
| M11-04 | super_admin يحاول acquire | acquired: true | | |
| M11-05 | محاولة بعد انقضاء TTL (90s) | acquired: true | | |
| M11-06 | refresh من صاحب القفل | ناجح (لم يتغير سلوكه) | | |
| M11-07 | release لغير صاحب القفل | لا مساس (حسب phase4c) | | |
| M11-08 | anon يستدعي acquire | unauthenticated | | |

## F4 — Forum Owner Update Guard

| ID | السيناريو | متوقع | النتيجة الفعلية | دليل |
|---|---|---|---|---|
| F4-01 | owner يعتّد is_hidden على own topic | 42501 not_authorized | | |
| F4-02 | owner يعتّد author_name على own reply | 42501 not_authorized | | |
| F4-03 | owner يعتّد category_id على own topic | 42501 not_authorized | | |
| F4-04 | owner يعتّد title/content على own topic | مسموح | | |
| F4-05 | admin يعتّد is_hidden على أي topic | مسموح | | |
| F4-06 | insert عادي لمستخدم | يعمل | | |

## F5 — Report Integrity + Rate Limit

| ID | السيناريو | متوقع | النتيجة الفعلية | دليل |
|---|---|---|---|---|
| F5-01 | insert forum report مع status='reviewed' | رفض by policy | | |
| F5-02 | insert normal | status→'pending', reviewed_*→NULL | | |
| F5-03 | 11 report لـ reporter_id نفسه في 10د | الحادي عشر rate_limit_exceeded | | |
| F5-04 | بعد انتهاء نافذة 10د | يُقبل مرة أخرى | | |
| F5-05 | submit_public_report(stale/unpublished) | not_found | | |
| F5-06 | submit_public_report 6 مرات من نفس IP في 10د | السادسة rate_limit_exceeded (P0-4) | | |
| F5-07 | submit_public_report وارد في reports | سطر واحد ينشأ | | |
| F5-08 | anon يدرج forum reports | مرفوض | | |

## ملاحظات الإدخال

- جداول المنتدى والمفتاح: استخدم seed من phase6 في sandbox أو CREATE TEMP مع نفس
  المخطط؛ لا تجرّب على production مباشرة قبل اكتمال matrix في staging.
- قراءات الصفوف بعد trigger: تحقق عبر `select * from forum_reports order by created_at desc;`
  لرصد القيم المثبّتة.
- حدود `report_rate_limits`/`forum_report_rate_limits` لا تحتوي بيانات مستخدم حساسة —
  مسحها بين التكرارات آمنة للاختبار.