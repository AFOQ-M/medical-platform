// ============================================================
// إعدادات الاتصال بـ Supabase
// ============================================================

const SUPABASE_URL = "https://lzmkgfxlsynaphpofblb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6bWtnZnhsc3luYXBocG9mYmxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNDE1MzQsImV4cCI6MjEwMjgxNzUzNH0.RGVtyTjS_9ZUikNM9nTkRcbsO9aGGYW9ZNOHFT86ZMY";

// عميل Supabase مشترك تستخدمه كل صفحات الموقع
// (مكتبة supabase-js يجب أن تكون محمّلة قبل هذا الملف عبر CDN، راجع أي صفحة HTML)
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
