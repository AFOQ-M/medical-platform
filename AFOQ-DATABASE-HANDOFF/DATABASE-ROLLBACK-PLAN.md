# AFOQ — DATABASE ROLLBACK PLAN (خطة التراجع الآمن)

> تُنفَّذ يدويًا فقط عند الحاجة، وفي الترتيب المذكور. لا DROP غافلة — كل تغيير مقابل
> المرجع المحفوظ في المستودع. **لا شيء هنا يُنفَّذ تلقائيًا في هذه المهمة.**

---

## M11 — Admin Session Lock (F4-independent)

```sql
-- إعادة دالة القفل إلى النسخة ما قبل M11 (phase4c First Session Wins الأصلية):
-- أعد تعريفا من sql/phase4c_p1_7b_first_session_wins.sql مباشرةً عبر CREATE OR REPLACE.
-- لا DROP للدالة إطلاقًا: P1-7B يعتمد عليها.
-- الصلاحيات تُفرض مرة أخرى كتعبير السلامة:
revoke all on function public.acquire_admin_session_lock() from public, anon;
grant execute on function public.acquire_admin_session_lock() to authenticated;
```

التراجع لا يمس الجدول ولا RLS ولا refresh/release — يملأ فقط `acquire` بالسلوك القديم
(سماح الدور فقط) إن كانت الإشارة فنية وتتطلب ذلك مؤقتًا (غير مستحسن: يعيد ثغرة F4-DoS).

## F4 — Forum Owner Update Guard

```sql
drop trigger if exists trg_forum_guard_owner_update on public.forum_topics;
drop trigger if exists trg_forum_guard_owner_update on public.forum_replies;
drop function if exists public.fn_forum_guard_owner_update();
```

لا يمس أي policy أو grant آخر — عودة كاملة إلى الوضع ما قبل M12 (منتجات side
effects لا شيء آخر تغيّر).

## F5 — Forum Report Integrity + Rate Limit

```sql
drop trigger if exists trg_forum_report_write_guard on public.forum_reports;
drop function if exists public.fn_forum_report_write_guard();
drop table if exists public.forum_report_rate_limits;
drop policy if exists "insert_own_forum_reports" on public.forum_reports;
-- أعِد تعريف insert_own_forum_reports من sql/phase6_forum_mvp.sql
-- أعِد تعريف submit_public_report من sql/phase4b_p0_3_p0_4_digest_schema_fix.sql
```

التراجع يحذف الجدول الجديد والـ trigger والـ policy المُعاد تعريفها، ويعيد دالة
submit_public_report إلى تعريفها الحي الحالي (phase4b). انتبه: حذف policy قبل إعادة
إنشائها يترك forum_reports بلا insert policy — نفّذ السطرين بالترتيب أعلاه بلا توقف.

## قواعد عامة

1. التراجع jeder ملف تُركّز على «لك» فقط — لا حلقة رجوع عضوية تتضمن غيره.
2. أي تراجع بعد تطبيق ناجح متبوع ببيانات مكتسبة من تقارير/قفل/بلاغات: البيانات
   المحذوفة بفعل تراجع F5 (forum_report_rate_limits) عدّادات فقط — تُفقد بدون ضرر.
3. سجّل التراجع وسببه في DATABASE-FINDINGS.md قبل الانتقال.
4. إن كان الهدف استكشافًا: نفّذ داخل transaction + rollback بدل تراجع تعقيدي.