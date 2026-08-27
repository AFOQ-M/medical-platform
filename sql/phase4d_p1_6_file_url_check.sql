-- ============================================================
-- Phase 4D — P1-6: قيد قاعدة بيانات على resources.file_url
-- ============================================================
--
-- يفرض على مستوى القاعدة بالضبط نفس السياسة المطبَّقة فعليًا اليوم من
-- طرف العميل في isValidResourceUrl() (admin/admin.js) وsafeResourceUrl()
-- (js/app.js): مخطّط http/https فقط، وغير فارغ بعد إزالة المسافات
-- الطرفية. لا يغيّر أي سلوك مقبول حاليًا عبر واجهة الأدمن — فقط يمنع
-- عبور القيم المرفوضة أصلًا من أي مسار كتابة يتجاوز تلك الواجهة.
--
-- التسمية تتبع نمط بقية قيود الجدول (resources_<column>_check) كما هو
-- مستخدَم فعليًا لـ type/language/source_type/status/storage_provider.
--
-- مبني على P1-6-IMPLEMENTATION-PLAN.md (مُوافَق عليه) — بلا أي توسيع
-- في النطاق. لا تعديل على isValidResourceUrl()، لا على RLS، لا على أي
-- عمود/جدول آخر.
-- ============================================================

alter table public.resources
  add constraint resources_file_url_check
  check (
    btrim(file_url) <> ''
    and btrim(file_url) ~* '^https?://\S+'
  );

comment on constraint resources_file_url_check on public.resources is
  'P1-6: يفرض أن يكون file_url رابطًا مطلقًا بمخطّط http/https غير فارغ — يطابق isValidResourceUrl() (admin/admin.js) وsafeResourceUrl() (js/app.js) دون تغيير سلوكهما.';

-- ============================================================
-- Rollback (نفّذ يدويًا فقط عند الحاجة — غير مُفعَّل هنا):
-- alter table public.resources drop constraint resources_file_url_check;
-- ============================================================
