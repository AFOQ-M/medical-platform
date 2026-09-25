# AFOQ — DATABASE HANDOFF PACKAGE (لـ CLAUDE DATABASE PHASE وحدها)

**صاحبه:** Big Pickle (طبقة التطبيق) — **يُسلَّم إلى Claude (قاعدة البيانات) حصرًا.**
**السياسة الجارية:** تجميد مطلق لقاعدة البيانات — لا يُطبَّق أي SQL من هذا الحزمة هنا؛
كل ملف يحمل `PROPOSED — NOT APPLIED` ويُطبَّق يدويًا عبر Supabase SQL Editor من قبل
Claude مع التحقق المطلوب.

---

## ما هذا؟

حزمة تسليم نهائية لكل تغييرات قاعدة البيانات المقترحة من عمل طبقة التطبيق،
مع أدلة يصح الاعتماد عليها (جدول البيانات الأساس `schema.sql` + كل ملفات `sql/`)،
خطة تحقق، خطة تراجع، مصفوفة اختبار، وسجل النتائج.

## الملفات

| الملف | الغرض | الحالة |
|---|---|---|
| `M11-admin-session-lock.sql` | سدّ DoS على القفل الوحيد للوحة الأدمن (P1-Final M11) | PROPOSED — NOT APPLIED |
| `F4-forum-integrity.sql` | حارس تعديل مالك المنتدى (M12/F4) | PROPOSED — NOT APPLIED |
| `F5-report-integrity.sql` | سلامة إنشاء البلاغ + حد زمني (M13/F5) | PROPOSED — NOT APPLIED |
| `DATABASE-FINDINGS.md` | السجل الكامل للنتائج والتحليل | — |
| `DATABASE-VERIFICATION-PLAN.md` | ماذا تُنفَّذ بعد التطبيق للتأكد من كل إصلاح | — |
| `DATABASE-ROLLBACK-PLAN.md` | كيفية التراجع الآمن لكل تغيير | — |
| `DATABASE-TEST-MATRIX.md` | مصفوفة اختبار تفصيلية لكل سلوك متغيّر | — |

## المرجعيات (في المستودع، غير منسوخة هنا)

- `sql/schema.sql` — المخطط الأساسي.
- `sql/schema_phase2.sql` — profiles/user_permissions/fn_has_permission/fn_is_super_admin.
- `sql/phase6_forum_mvp.sql` — جداول المنتدى.
- `sql/phase7_forum_admin_moderation.sql` — سياسات مراجعة الأدمن.
- `sql/phase4a_p0_4_report_rate_limit.sql` + `sql/phase4b_p0_3_p0_4_digest_schema_fix.sql` — تعريف submit_public_report الحي الحالي.
- `sql/phase4c_p1_7b_first_session_wins.sql` — النسخة المحورية لدالة قفل الأدمن قبل M11.
- `sql/phase4b_p1_7b_mfa_enforcement.sql` — أساس MFA (aal2) الذي تعتمد عليه واجهة Big Pickle.
- `sql/phase4b_p1_7b_admin_session_lock.sql` — أساس القفل قبل First-Session-Wins.

## ترتيب التنفيذ المقترح (في بيئة sandbox/staging أولًا)

1. `M11-admin-session-lock.sql`
2. `F4-forum-integrity.sql`  (يعتمد على schema_phase2 fns + phase7 RLS)
3. `F5-report-integrity.sql` (يعتمد على phase6/phase7 + phase4a/phase4b)

لا تبعيات بين M11 وF4/F5. كلها بعد مراحل القاعدة الحالية.

## ماذا توقّع من Claude

- التطبيق ليس تلقائيًا داخل هذه المهمة؛ يُسجَّل هنا بعد التنفيذ الفعلي.
- لكل تغيير: نفّذ، تحقّق، ثم حدّث `DATABASE-FINDINGS.md` بحالة `APPLIED`/`VERIFIED`/`FAILED`.
- لا تلمس سياسات/grant تركتها Big Pickle خارج نطاق هذه الملفات الثلاثة (التزام النطاق).