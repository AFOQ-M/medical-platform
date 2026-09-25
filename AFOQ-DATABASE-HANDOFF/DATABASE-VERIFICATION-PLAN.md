# AFOQ — DATABASE VERIFICATION PLAN (خطة تحقق ما بعد التطبيق)

> تُنفَّذ من Claude بعد تطبيق كل ملف مقابل بيئة **sandbox/staging أولًا** ثم الحي
> بحذر. كل فقرة ترتبط بأمر/سلوك قابل للفحص فعليًا.

---

## M11 — Admin Session Lock ACL

**مشارط الـ sandbox:** requester accounts:
- `A_super`: super_admin نشط.
- `A_admin_perm`: admin (أو staff) **مع** سطر `user_permissions.active=true`.
- `A_staff_auto`: staff تلقائي بلا أي user_permissions (يُمثِّل الحساب الذي سبق أن
  احتكر القفل).

| # | التحقق | المتوقع |
|---|---|---|
| 1 | `A_staff_auto` يستدعي `acquire_admin_session_lock()` | `{"acquired": false, "reason": "not_authorized"}` |
| 2 | الركن المكدس: قبل تطبيق M11 كان `A_staff_auto` يحصل على lock | مقارنة تسجل "كان يسمح" |
| 3 | `A_admin_perm` يستدعيها | `acquired: true` + session_token صحيح |
| 4 | `A_super` أثناء وجود قفل فعّال لـ A_admin_perm | `acquired: false, reason: "locked"` (First Session Wins يُحترم) |
| 5 | `A_super` بعد انقضاء TTL (90s) | `acquired: true` (انتهاء الصلاحية يُحرّر) |
| 6 | إعادة `acquire` من نفس صاحب القفل Activ | في نافذة TTL تُرفض (`locked`) — FSW حتى لنفس الحساب |
| 7 | `refresh_admin_session_lock` يبقى يعمل لصاحب القفل الحالي (دون تغيير من M11) | تحديث last_seen، بلا أثر على الإذن |
| 8 | `release_admin_session_lock` لغير صاحب القفل | `released: false` أو لا مساس (حسب phase4c الحالي) — بدون تغيير |

## F4 — Forum Owner Update Guard

| # | التحقق | المتوقع |
|---|---|---|
| 1 | مستخدم غير أدمن يعدّل `is_hidden = true` على own topic (UPDATE) | `42501 not_authorized` (الاستثناء) |
| 2 | نفس المستخدم يعدّل `author_name` على own reply | `42501 not_authorized` |
| 3 | نفس المستخدم يعدّل `category_id` على own topic | `42501 not_authorized` |
| 4 | نفس المستخدم يعدّل `title` أو `content` على own topic/reply | نجاح (مسموح) |
| 5 | أدمن (fn_has_permission('reports','edit') أو super_admin) يعدّل `is_hidden` على أي موضوع | نجاح (لا يتأثر حارس F4) |
| 6 | رفع تقرير deprecated: أي تغيير عبر PostgREST على row يملكه غيره | رفض RLS كما هو (لم يتغير) |
| 7 | Inserts غير متأثرة (الـ guard on UPDATE فقط) | Insert منشور عادي يعمل |

## F5 — Forum Report Integrity + Rate Limit

| # | التحقق | المتوقع |
|---|---|---|
| 1 | إدراج بلاغ forum مع `status='reviewed'`, `reviewed_by=<uuid>` | مخالفة RLS (`with check` فشل) |
| 2 | إدراج بلاغ normal من عميل حقيقي | status يُفرَض `'pending'`, reviewed_by/reviewed_at NULL |
| 3 | 11 بلاغًا لنفس reporter_id خلال <10 دقائق | الحادي عشر يرفع `rate_limit_exceeded` |
| 4 | بعد انقضاء 10 دقائق منذ أول بلاغ | نافذة تُصفَّر ويُقبل البلاغ التالي |
| 5 | `submit_public_report(<unpublished resource>)` | `not_found` رفع (no row inserted) |
| 6 | `submit_public_report(<published resource>)` بعد نفس cf-connecting-ip 5 مرات/10د | السادسة `rate_limit_exceeded` (P0-4 يُحترم) |
| 7 | `submit_public_report` تُدرج في `reports` مع reason/note null-safety | سطر واحد، note فارغ → NULL |
| 8 | anon يدرج بلاغ forums | مرفوض (سياسة anon ليست ضمن insert) |

## أوامر ساندة (PostgREST عبر psql/REST)

- مراقبة الحالة: `select * from public.admin_session_lock;`
- محاكاة requester: `set local role authenticated; select public.acquire_admin_session_lock();`
- اختبار RLS/trigger بأقل تأثير: استخدم رول test أو `set request.headers` مع اختبارها في
  transaction (rollback). لا تنفِّذ في production مباشرة قبل إكمال matrix في staging.

## قاعدة صارمة

- لا يُعتبر تحقق ناجحًا إلَّا بوجود `APPLIED` سجّلتها Claude في DATABASE-FINDINGS.md
  ونتائج grid فعلية في DATABASE-TEST-MATRIX.md. التوقعات أعلاه ليست نتائج.