-- ============================================================
-- منصة الموارد الطبية — Phase 4B: الفصل الدراسي (semester) على المواد
--
-- إضافة فقط (Additive) — عمود واحد اختياري على subjects. لا تغيير على
-- جدول years (يبقى يمثّل السنة/المستوى الدراسي 1-6 كما هو تمامًا)، ولا
-- تغيير على هرمية universities → faculties → years → subjects →
-- resources، ولا على أي سياسة RLS موجودة.
--
-- القيم المدعومة بالضبط: first / second / summer — تطابق الثلاثة
-- المطلوبة (الفصل الأول / الفصل الثاني / الفصل الصيفي). العمود
-- NULLABLE بلا قيمة افتراضية غير null، حتى تبقى كل المواد الحالية
-- صالحة دون أي backfill أو migration مؤثرة على البيانات — "فصل غير
-- محدد" هو ببساطة NULL، وتُعامَل معاملة "قديم/legacy" في الواجهة
-- العامة (year.html) لا حذف ولا إخفاء.
--
-- لا RPC جديدة: المواد تُنشأ/تُعدَّل عبر نفس الكتابة المباشرة
-- (.from("subjects").insert/update) المستخدمة حاليًا في admin.js،
-- تمامًا كباقي أعمدة subjects (name, code). العمود الجديد يمر عبر
-- نفس سياسات RLS الحالية لجدول subjects دون أي حاجة لسياسة إضافية،
-- لأنه عمود بيانات عادي وليس مسارًا جديدًا للوصول.
-- ============================================================

-- ------------------------------------------------------------
-- 1) العمود الجديد على subjects
-- ------------------------------------------------------------

alter table subjects
  add column if not exists semester text
  check (semester in ('first', 'second', 'summer'));

comment on column subjects.semester is
  'الفصل الدراسي للمادة: first (الأول) / second (الثاني) / summer (الصيفي). NULL = غير محدد (مواد قديمة قبل إضافة هذا الحقل، أو مواد لا يفرّق فيها الأدمن بين الفصول) — تبقى ظاهرة وصالحة في الواجهة العامة دون أي معاملة خاصة سوى تصنيفها ضمن تبويب "غير محدد".';

-- لا NOT NULL ولا DEFAULT غير NULL عمدًا: فرض قيمة على كل المواد الحالية
-- والمستقبلية لم يُطلب، ويكسر مواد لا يُعرف فصلها بعد إدخالها إداريًا.

-- ============================================================
-- 2) استعلامات تحقق (Verification)
-- ============================================================

-- 2.a تأكيد وجود العمود بالقيود الصحيحة
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'subjects' and column_name = 'semester';

-- 2.b تأكيد أن قيد الفحص (check constraint) يطابق القيم الثلاث فقط
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'subjects'::regclass and contype = 'c';

-- 2.c كل المواد الحالية يجب أن تبقى semester = NULL بعد هذا الملف مباشرة
--     (لا backfill هنا) — التحقق يدوي: العدد يجب أن يساوي count(*) الكلي.
select count(*) filter (where semester is null) as null_semester_count,
       count(*) as total_subjects
from subjects;

-- 2.d سياسات RLS الحالية على subjects لم تُلمس (للمراجعة اليدوية فقط)
select policyname, cmd, roles
from pg_policies
where tablename = 'subjects'
order by policyname;
