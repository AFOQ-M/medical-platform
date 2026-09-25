# الوضع الحالي — تقرير شامل وصادق (2026-09-25)

> الوثيقة الوحيدة التي تعكس حالة المستودع الفعلية لحظة كتابتها.
> اسم المشروع: `afoq-courses-mvp`. العامل: opencode / big-pickle.
> **أحدث تحديث (المهمة الشاملة + اختبار السعة/التحميل):** NEW-01/02/03/04/06/07/08
> منفَّذة بمواصفة واختبارات، وإتمام Group E وGroup F، **وإضافة عملة جديدة بالكامل:
> اختبار Capacity/Load/Stress** (حزام `scripts/load-test-harness.js` + رحلة متصفح
> + `LOAD-TEST-REPORT.md` + 28 شهادة قياس في `test/artifacts/load/`)
> — إجمالي 16 مجموعة unit = **162/162 خضراء**، والاستعداد للـ commit الأول authorized.

---

## 1) المشكلة الحالية في جملة واحدة

**المشروع "شبه مكتمل" لكن بلا أي نقطة إرساء: لا يوجد commit واحد في git،
قائمة المراحل (G-13/G-14/NEW-01..08) بعضها منفَّذ في الكود وبعضها غير
منفَّذ إطلاقًا ولا يملك تعريفًا تفصيليًا، وكل ما يحيط بذلك موثَّق هنا
بصدق (تم، غير منفَّذ، غير قابل للتحقق مع السبب).**

---

## 2) الخط الأساسي (BASELINE) — حقائق قاطعة

| البند | القيمة |
|---|---|
| الفرع (branch) | `master` |
| الـ commits | **صفر** — `git log` يفشل: "does not have any commits yet" |
| ملفات staged | **109** (`git add -A` تم بعد إزالة ملفّي `.bak`، لكن بلا commit) |
| ZIP | `C:\Users\For LabTop\Desktop\mu\medical-platform\afoq-courses-mvp.zip` — 4,367,303 bytes (بُنِي مبكرًا اليوم) |
| اختبار السعة (جديد) | حزام Node صفري الاعتماديات `scripts/load-test-harness.js` + رحلة متصفح Playwright + `LOAD-TEST-REPORT.md` + 28 شهادة `test/artifacts/load/` |
| الاختبارات (unit) | **74/74 خضراء** بالأصل (6 مجموعات) — **162/162** بعد جلسة المعالجة (16 مجموعة) |
| E2E (test-full.js) | نُفِّذ ضد خادم محلي + كروم حقيقي — الأدلة في `test/artifacts/` |
| نشر الموقع الحي | النطاق الحقيقي: **`afoq-m.pages.dev`** (Cloudflare، يعمل على الجذر) — كان تخمين `afoq-m.github.io/medical-platform` (404) خاطئًا، وتم إعادة توجيه meta/sitemap إليه محليًا |
| بيانات قاعدة Supabase | **0 دورات / 0 سنوات / 0 موارد منشورة** في الجداول العامة |
| جلسة أدمن | **غير متوفرة** — لا توجد اعتمادات، لن نختلقها |

### الاختبارات (162/162 عبر 16 مجموعة)
| المجموعة | العدد | الدليل |
|---|---|---|
| test-google-auth-state.js | 10 | جلسة ضيف + 422 |
| test-account-sidebar.js | 12 | مع createElementNS |
| test-forum.js | 20 | + إصلاح سطر 372 |
| test-admin-helpers.js | 13 | مساعدات الجداول |
| test-admin-delete.js | 10 | حوار حذف |
| test-admin-permissions.js | 9 | صلاحيات |
| test-admin-reports.js | 9 | G-13 |
| test-admin-drawers.js | 17 | G-14 |
| test-focus-traps.js | 11 | NEW-01 |
| test-admin-confirm.js | 10 | NEW-02 |
| test-admin-validation.js | 11 | NEW-03 |
| test-subject-pagination.js | 7 | NEW-04 |
| test-admin-pagination.js | 5 | NEW-06 |
| test-forum-meta.js | 7 | NEW-07 |
| test-lazy-images.js | 6 | NEW-08 |
| test-footer-svg-focus.js | 5 | Group E — فوكة SVGs الفوتر |

---

## 3) حالة المراحل (من قائمتك — فحص صادق في الكود)

| المرحلة | العنوان | الحالة الفعلية | الدليل |
|---|---|---|---|
| STAGE 1 | G-13 قائمة بلاغات موحّدة | ✅ **منفَّذ وموثَّق باختبار** `test/test-admin-reports.js` (9/9) | `admin/admin.js:2009` (loadReports)، `admin/index.html:512`، `css/style.css:1632` |
| STAGE 2 | G-14 Drawer نماذج | ✅ **منفَّذ وموثَّق باختبار** `test/test-admin-drawers.js` (17/17) | `admin/admin.js:1180-1265` (focus trap للـdrawer)، `admin/index.html:272/402`، css:1706 |
| STAGE 3 | NEW-01 Focus Traps | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** `MASTER-REMEDIATION-SPEC.md` — اختبار `test/test-focus-traps.js` (11/11) | `js/app.js:510-561` (wireDialogOverlay)، فخّauth `js/auth.js`، استعادة تركيز auth.js:663 |
| STAGE 4 | NEW-02 Destructive Confirm | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — بديل `window.confirm` داخل الصفحة؛ اختبار `test/test-admin-confirm.js` (10/10) | `admin/admin.js:2900` (showDestructiveConfirm)، فافوريت مؤجَّل: `favorites.html:241` |
| STAGE 5 | NEW-03 Field Validation | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — `validateResourceForm()`/`validateCourseForm()` + blur/input + رسائل عربية + aria؛ اختبار `test/test-admin-validation.js` (11/11) | `admin/admin.js:1926+` (كتلة NEW-03)، `css/style.css:.field-error` |
| STAGE 6 | NEW-04 Subject Pagination | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — سحب كامل عبر دفعات `.range()` (100/دفعة) بلا ترقيم UI؛ اختبار `test/test-subject-pagination.js` (7/7) | `subject.html` (~156-177) حلقة مجزأة |
| STAGE 7 | NEW-06 Admin Pagination | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — جلب جداول الأدمن كاملًا عبر `loadAdminTableChunked()` بدفعات `.range()` بلا `.limit(1000)` وبلا ترقيم UI؛ اختبار `test/test-admin-pagination.js` (5/5) | `admin/admin.js:1675-1688` (المجزئ)، :1815 (loadResources)، :1795 (loadSubjects) |
| STAGE 8 | NEW-07 Topic Social Meta | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — كتلة `og:/twitter:` السبعة في `forum-topic.html` مطابقة للمرجع؛ اختبار `test/test-forum-meta.js` (7/7) | `forum-topic.html:9-19`، نفس صورة forum.html/courses.html |
| STAGE 9 | NEW-08 Lazy/Async Images | ✅ **منفَّذ في جلسة المعالجة مع مواصفة** — `loading="lazy"` + `decoding="async"` لغلاف بطاقة الدورة (الصورة الوحيدة المنشأة JS للبطاقات) والشعارات بلا lazy؛ اختبار `test/test-lazy-images.js` (6/6) | `courses.html:~126`، بطاقات الموارد أيقونات SVG (بلا `<img>`) |
| FINAL | التقرير النهائي | ✅ **مكتوب في `MASTER-REMEDIATION-REPORT.md`** مع إعادة توليد شواهد D-RT + مسح أمن/وصولية نظيف؛ فقط **بلا commit** يبقى معلّقًا بإذنك | `MASTER-REMEDIATION-REPORT.md`، `P*-REPORT.md`، README.md |

> ملاحظة: **NEW-05 غير موجود إطلاقًا** في قائمتك ولا في سجل المحادثة الكامل (0 نتيجة).

---

## 4) ما تم في هذه الليلة تحديدًا (آخر جلسة)

1. **D-RT-01..11 منفَّذة بالكروم الحقيقي** عبر `test/test-runtime-deferred.js` الجديد
   (النتائج: 8 VERIFIED، 1 PARTIAL، 2 NOT-VERIFIED) — الأدلة:
   `test/artifacts/runtime-deferred/` (report.json + report.utf8.txt + 6 لقطات RTL).
2. **`P1.5-DESIGN-DEFERRED-ITEMS.md` حُدِّثت** بصدق لكل بند (VERIFIED/PARTIAL/NOT-VERIFIED + السبب).
3. إصلاح وجد 422 (جلسة ضيف) في `js/auth.js` + اختباران جديدان (Test G/H) — 10/10.
4. إصلاح فجوة mock قديمة في `test-account-sidebar.js` (createElementNS) — 12/12.
5. إصلاح سطر 372 في `test-forum.js` (حرف عربي تالف) — 20/20.
6. E2E `test-full.js` نُفِّذ ضد localhost بالكروم (test-full.js أصبح يقبل `BASE_URL`).
7. 74/74 كلها خضراء بعد آخر تعديل.
8. 109 ملفًا staged (بلا commit). ZIP أعيد بناؤه.
9. **جلسة المعالجة الشاملة (نفس اليوم):**
   - NEW-01 فخاخ التركيز (11/11)؛ NEW-02 تأكيد الإجراءات المدمرة داخل الصفحة (10/10)؛
     NEW-03 تحقق الحقول (11/11)؛ NEW-04 ترقيم موارد المواد بدفعات range() (7/7)؛
     NEW-06 جلب جداول الأدمن بدفعات range() (5/5)؛ NEW-07 meta الاجتماعي لـ forum-topic
     (7/7)؛ NEW-08 lazy/async لغلاف بطاقة الدورة (6/6).
   - إجمالي **15 مجموعة = 157/157 خضراء**، مع `MASTER-REMEDIATION-SPEC.md` كمواصفة وحيدة.
   - NEW-06 استلزم إضافة `.range`+تقطيع لـ `makeMockSupabase` في اختباري الـ drawers/reports.
   - (بلا commit — يبقى البند معلّقًا بانتظار إذن مستقل.)
10. **إتمام Group E (نفس اليوم):** معالجة `focusable="false"` لـ**كل** أيقونات SVGs في
    الصفحات العامة (65 SVG في 13 فوتر social + كل أيقونات الشعار/الروابط/العودة للأعلى)
    بمعيار أن لا `<svg>` ينال التركيز منفردًا؛ اختبار `test/test-footer-svg-focus.js` (5/5).
    بند 422/caption مُسقَط بلا إجراء (لا يوجد بالكود؛ Test G/H يغطي المسار). إجمالي
    **16 مجموعة = 162/162 خضراء**. (بلا commit).
11. **Group F (نفس اليوم):** إعادة توليد شواهد D-RT بالكامل ضد الخادم الحي
    (بعدما تُلِفت بنتيجة جلسة ضد خادم غير مشغّل) → **8 VERIFIED / 1 PARTIAL /
    2 NOT-VERIFIED** + 6 لقطات محدثة في `test/artifacts/runtime-deferred/`؛
    مسح أمن/وصولية نظيف (لا inline handlers، لا blank بلا rel، لا js:/data:
    hrefs، لا iframe بلا title، لا img بلا alt، لا eval/Function/document.write،
    لا أسرار مدمجة، إفلات قوي لكل بيانات DB). **التقرير النهائي
    `MASTER-REMEDIATION-REPORT.md` مكتوب.** (بلا commit).
12. **حلّ لغز النشر (بعد إذنك):** أُكِّد أن النطاق الفعلي **`afoq-m.pages.dev`**
    (Cloudflare Pages، يُخدَم من الجذر) يعمل — إدارة الموقع حية! — والبند
    "404" كان سببه تخمين `afoq-m.github.io/medical-platform` الخاطئ. **حُدِّثت
    كل روابط meta (canonical/og:url/og:image/twitter:image) في الـ11 صفحة عامة
    و`sitemap.xml` و`robots.txt` إلى النطاق الحي** (36 استبدالًا عبر node،
    بلا كسر أي اختبار — كل المتأثرة خضراء). لُوحظ أن البناء المنشور حاليًا
    أقدم من محليّنا (يجب رفعه ليصل كل الإصلاح). (بلا commit).
13. **اختبار السعة/التحميل/الإجهاد (المهمة الجديدة — 2026-09-25):** بُني حزام
    `scripts/load-test-harness.js` (Node stdlib صفري الاعتماديات — لا k6/autocannon/
    artillery/ab/hey/wrk/vegeta على الجهاز) + رحلة متصفح `scripts/load-browser-journey.js`
    (Playwright). نُفِّذت:
    - **محلي (loopback، dev-server 3100):** منحنى معتمد 1→5→10→25→50→100→150→200→300→500→800→1200→1600→3000→5000 VU —
      **صفر أخطاء في كل الجولات (15 اكتتاب + غرق 60 ثانية عند 100 VU)**؛ الخادم
      صمد حتى 5000 VU (p95 2418ms) والانحناء المُقاس بين 3000–5000 VU
      (p95 684ms→2418ms)؛ حتى 300 VU p95 < 100ms.
    - **Supabase قراءة عامة فقط (REST بمرايا أعمدة التطبيق):** 1/5/10 VU — 0% أخطاء
      بعد إصلاح خطأ قوالب الحزام (أعمدة خاطئة)؛ أفضل: 10 VU → 34.8 RPS، p95 530ms.
    - **حي Cloudflare (قراءة فقط، متحفظ):** 1/5/10 (home) و10/25 (تنقل) — 0% أخطاء بعد
      تتبّع إعادة التوجيه 308 (clean-URLs)؛ ذيل أبطأ عند 25 VU (p99 8124ms) — دليل
      متحفظ على البناء الحر، **ليس ضمان سعة**.
    - **رحلة متصفح:** 2 رحلات متوازية × 7 صفحات = 14/14 HTTP 200 على localstack.
    كل الأرقام مسجّلة في `test/artifacts/load/*.json` وموثّقة في **`LOAD-TEST-REPORT.md`**. (بلا commit).

---

## 5) المشاكل المعلّقة المعروفة (KNOWN ISSUES)

1. **لا commit في git إطلاقًا** — أخطر بند؛ كل العمل معرّض للضياع إن حدث أي حادث قرص.
2. **النشر الحي (حُلَّ اللغز):** الموقع الفعلي على **Cloudflare Pages —
   `https://afoq-m.pages.dev/`** (يعمل على الجذر! `/admin/` يُخدَم فعليًا)
   وليس GitHub Pages. الروابط القديمة `afoq-m.github.io/medical-platform`
   كانت هي المصدر الزائف لـ404. تم **إعادة توجيه كل canonical/og:url/
   og:image/twitter:image في الـ11 صفحة عامة + `sitemap.xml` + `robots.txt`
   إلى النطاق الحي** (بعد إذنك). ملاحظة تحقق حي: البناء المنشور حاليًا
   **أقدم** من محليّنا (أيقونات الهيدر emoji، فوتر بلا focusable) — يجب
   رفع البناء الحالي ليصل الإصلاح للجمهور.
3. **قاعدة بيانات شبه فارغة من المنشور** — كل "مسارات النجاح" البيانية
   (دورة حقيقية، سنة حقيقية، مادة بموارد) لا يمكن عرضها في المتصفح لعدم وجود صفوف.
4. **جلسة أدمن غير متوفرة** → مراحل G-12/G-13/G-14/G-19 زمنيًا غير متحققة
   (NOT-VERIFIED) وستبقى كذلك حتى تتوفر اعتمادات أو من يقوم بها إنسانًا.
5. **رسالة `Failed to load resource: 422` تبقى في شبكة المتصفح** لكل صفحة عند
   أول تحميل سياق جديد (رسالة كروم قياسية لطلب فاشل؛ رسالة التطبيق المزعجة أُزيلت).
6. ~~**5 أيقونات `footer-social` بلا `focusable="false"`**~~ — **مُعالَج في Group E**: كل
   أيقونات الفوتر (65 SVG عبر 13 صفحة) + كل SVG آخر في الصفحات العامة صارت
   `focusable="false"`، مع اختبار `test/test-footer-svg-focus.js` (5/5).
7. ~~**بقي في Group E**~~ — **استُكمل في Group F**: شواهد D-RT أُعيد توليدها
   بالكامل ضد الخادم الحي (8/1/2) والمسح الأمني/الوصولية نظيف، والتقرير النهائي
   `MASTER-REMEDIATION-REPORT.md` مكتوب. بند «اختبار مخفي لعنوان التبويب في
   مسار 422» **مُسقَط بلا إجراء** (لا يوجد بالكود؛ Test G/H يغطي المسار).
   (كل ما سبق بلا commit).

---

## 6) ما لا يمكن التحقق منه مع السبب (HONEST NOT-VERIFIED)

| البند | لماذا؟ |
|---|---|
| مسارات النجاح لكل الصفحات الواعية بـ id | لا بيانات منشورة في Supabase |
| جلسة الأدمن الكاملة (CRUD/أقفال/MFA/طوابير) | لا اعتمادات أدمن |
| النشر الحي | ⚠️ `afoq-m.github.io` (القديم) يعيد 404 = **مهمل**. النطاق الفعلي: `afoq-m.pages.dev` يعمل (موقع Cloudflare) — نُقلت إليه كل روابط meta/sitemap محليًا؛ يعتمد الرفع الفعلي على الناشر |
| تباين WCAG للـ warning tokens (G-19) | يحتاج عيون إنسان + جلسة أدمن |
| إعلانات قارئ الشاشة (D-RT-08 الصوتي) | يحتاج قارئ شاشة فعلي |

---

## 7) خطوات مقترحة تالية (بلا أي مساس بالعمل القائم)

1. **`git commit`** — أول نقطة إرساء (الآن **موثَّق صراحةً** في المهمة الشاملة،
   الرسالة: `chore: anchor AFOQ remediation baseline`). سيؤمّن كل ما بُني (incl.
   شهادات السعة وحزامها وتقريرها). **هذا البند الوحيد المتبقي الحرج وقد اكتمل كل
   جهد الـ remediation واختبار السعة قبله.**
2. تحديث النشر الحي (Cloudflare Pages — `afoq-m.pages.dev`) بشخص يملك وصولًا،
   وإعادة فحص مسارات النجاح بعد إضافة بيانات حقيقية، ومراجعة أقران لـ G-19
   (تباين warning tokens).
3. إعادة بناء ZIP بعد التقرير النهائي ونقله لمجلد الأب (تحقق حجمه).

---

## 8) اختبار السعة/التحميل — الخلاصة (تفاصيل كاملة في `LOAD-TEST-REPORT.md`)

| الطبقة | ما اختُبر | أفضل/أنظف | أسوأ ذيل | أخطاء صلبة |
|---|---|---|---|---|
| محلي (dev-server) | تنقل عام + أصول + الرئيسية + غرق 60s | 100 VU → 6,619 RPS، p95 21ms | 5000 VU → p95 2418ms / p99 2928ms | **0** في 18 جولة |
| Supabase (قراءة) | قراءات كتالوج + بحث | 10 VU → 34.8 RPS، p95 530ms | p99 1073ms @10 VU | **0** (بعد إصلاح قالب الحزام) |
| Cloudflare حي (متحفظ) | home + تنقل عام | 5 VU → p95 959ms | 25 VU → p99 8124ms | 0 (مهلة واحدة @10 VU home = 1.1%) |
| متصفح | 2 رحلات × 7 صفحات | 14/14 HTTP 200 | — | 0 |

**أحكام (معايير اختبار لا وعود منتج):**
- طبقة الاستضافة الثابتة: **تحقَّق** (≤300 VU p95<100ms محليًا؛ حتى عند 5000 VU صفر أخطاء).
- انحناء الاستضافة الثابتة: **مُقاس 3000–5000 VU محليًا**.
- مسار الأصول: **تحقَّق** (assets 100 VU p95 29ms؛ home 200 VU p95 81ms).
- قراءات Supabase العامة: **تحقَّق (قراءة فقط، ≤10 VU)**.
- الضغط المتواصل على Cloudflare الحر: **جزئي / ليس ضمانًا** — 10 VU home أعطت 1.1% مهلات.
- مسارات الكتابة/الإدارة/الدفع: **خارج نطاق أي اختبار (GET فقط)** → لا يوجد دليل سعة لها.