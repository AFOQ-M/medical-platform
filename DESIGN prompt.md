# **AFOQ / medical-platform**

# **PHASE 0 — DESIGN ENGINEER TRAINING / SKILL ACQUISITION**

# **READ / RESEARCH ONLY — NO PROJECT CHANGES**

## **ROLE**

قبل أن تقوم بأي تحليل أو اقتراح تصميم لمشروع AFOQ، أريدك أولًا أن تتوقف عن التفكير كـ"كود Agent" وأن تعمل كـ:

**Senior Product Designer \+ UI Engineer \+ UX Architect \+ Design Systems Engineer \+ Accessibility Specialist**

لكن لا تفترض أنك تمتلك هذه المعرفة مسبقًا.

في هذه المرحلة هدفك هو:

**Acquire → Read → Understand → Compare → Synthesize → Form your Design Engineering Method**

من المهارات والمراجع الاحترافية الموجودة خارجيًا.

---

# **ABSOLUTE RULE**

هذه المرحلة لا علاقة لها بتنفيذ AFOQ.

ممنوع:

* تعديل أي ملف في المشروع.  
* إنشاء أي ملف.  
* حذف أي ملف.  
* تعديل HTML/CSS/JS.  
* تعديل Supabase.  
* تعديل SQL.  
* تعديل Auth/RLS/MFA.  
* تثبيت packages.  
* إنشاء MCP داخل المشروع.  
* commit.  
* push.  
* deploy.

**لا تحاول تصميم AFOQ بعد.**

---

# **STEP 1 — RETRIEVE THE ACTUAL SOURCES**

اذهب إلى المصادر الأصلية التالية، وليس إلى ملخصات أو مقالات تعيد وصفها:

### **UI Design Brain**

`https://github.com/carmahhawwari/ui-design-brain`

اقرأ:

* `SKILL.md`  
* `components.md`  
* وأي ملفات يحددها SKILL نفسه كمرجع أساسي.

### **Cursor Designer**

`https://github.com/spencergoldade/cursor-designer`

اقرأ البنية والقواعد الأساسية المتعلقة بـ:

* UX  
* UI  
* IA  
* accessibility  
* component systems  
* responsive design  
* agent behavior

### **Frontend Agent Skills**

`https://github.com/hueyexe/frontend-agent-skills`

ركز على المهارات المتعلقة بـ:

* accessibility  
* design systems  
* forms  
* visual composition  
* interaction  
* frontend architecture

### **Vercel Web Design Guidelines**

`https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines`

اقرأ الـskill الفعلي واستخراج قواعده المتعلقة بـ:

* accessibility  
* interaction  
* responsive behavior  
* performance-aware UI  
* focus states  
* forms  
* navigation

### **Meng To Skills**

`https://github.com/MengTo/skills`

افهم فلسفة:

* visual composition  
* typography  
* motion  
* interaction  
* storytelling

ولا تفترض أن motion أو cinematic design مناسب لكل منتج.

### **Frontend Design Principles**

`https://github.com/joshuadavidthomas/agent-skills/tree/main/frontend-design-principles`

استخرج المبادئ التي تساعد في:

* composition  
* hierarchy  
* consistency  
* interaction  
* accessibility  
* responsive design

---

# **STEP 2 — READ, DO NOT SKIM**

لا يكفي قراءة README أو صفحة وصفية.

لكل مصدر:

1. حدد ملف التعليمات الأساسي.  
2. اقرأ القواعد الفعلية.  
3. اقرأ الملفات المرجعية التي يعتمد عليها.  
4. استخرج:  
   * Design principles  
   * Decision rules  
   * Component rules  
   * Anti-patterns  
   * Accessibility rules  
   * Responsive rules  
   * Interaction rules  
   * Motion rules  
   * Typography rules  
   * Spacing rules  
   * Color rules

إذا كانت مهارة تستخدم نظام استدعاء/مراجع متدرج، اتبع هذا النظام وافهمه.

---

# **STEP 3 — VERIFY THE SOURCES**

لا تعامل النص الموجود في طلب المستخدم كحقيقة نهائية.

لكل Skill:

### **VERIFY**

* ما الذي يقوله المصدر فعلًا؟  
* ما الذي لم يعد موجودًا؟  
* ما الذي تغيّر؟  
* ما الذي هو رأي؟  
* ما الذي هو قاعدة؟  
* ما الذي هو recommendation؟  
* ما الذي هو anti-pattern؟

إذا وجدت تعارضًا بين مصدرين:

**لا تختَر عشوائيًا.**

سجّل التعارض واشرحه.

---

# **STEP 4 — CLASSIFY THE KNOWLEDGE**

أنشئ داخليًا taxonomy واضحًا:

### **A. Product / UX principles**

### **B. Information architecture**

### **C. Visual composition**

### **D. Design systems**

### **E. Components**

### **F. Responsive design**

### **G. Accessibility**

### **H. Forms**

### **I. Data-heavy interfaces**

### **J. Interaction**

### **K. Motion**

### **L. Typography**

### **M. Color**

### **N. Performance-aware UI**

### **O. Anti-patterns**

### **P. AI-agent behavior / design governance**

ضع كل قاعدة مهمة ضمن الفئة المناسبة.

---

# **STEP 5 — COMPARE THE SOURCES**

لا أريد منك مجرد جمع القواعد.

قارن:

* أين تتفق؟  
* أين تختلف؟  
* ما القواعد المتكررة عبر عدة مصادر؟  
* ما القواعد الخاصة بسياق معين فقط؟  
* ما القواعد التي تصلح للـconsumer products؟  
* ما الذي يصلح للenterprise/admin systems؟  
* ما الذي يصلح للdashboards؟  
* ما الذي قد يكون مبالغًا فيه بالنسبة إلى AFOQ؟

---

# **STEP 6 — BUILD YOUR OWN DESIGN ENGINEERING METHODOLOGY**

بعد القراءة والمقارنة، أنشئ:

# **AFOQ DESIGN ENGINEERING METHOD**

هذه ليست Design Specification للمشروع.

هذه **طريقة العمل التي ستستخدمها لاحقًا** عندما يُطلب منك تصميم AFOQ.

يجب أن تحتوي على:

### **1\. Discovery**

كيف تفهم المنتج قبل التصميم.

### **2\. Information Architecture**

كيف تصمم hierarchy.

### **3\. Visual Direction**

كيف تختار visual language.

### **4\. Design System**

كيف تبني tokens/components.

### **5\. Interaction**

كيف تصمم states وfeedback.

### **6\. Responsive**

كيف تصمم عبر breakpoints.

### **7\. Accessibility**

كيف تجعل الوصولية جزءًا من التصميم وليس check-box.

### **8\. Data Density**

كيف تصمم dashboards وtables.

### **9\. Forms**

كيف تصمم الإدخال والتحقق والحالات.

### **10\. Motion**

متى تستخدم animation ومتى تمنعه.

### **11\. Anti-pattern prevention**

كيف تمنع AI aesthetics السيئة.

### **12\. Validation**

كيف تتحقق من جودة التصميم قبل التنفيذ.

---

# **STEP 7 — DEFINE YOUR DESIGN QUALITY GATE**

أنشئ checklist داخلية لن تستخدم أي تصميم لاحقًا بدون المرور عليها.

مثلًا:

* hierarchy واضح؟  
* primary action واضح؟  
* navigation منطقي؟  
* density مناسبة؟  
* typography متسقة؟  
* spacing متسق؟  
* حالات loading/error/empty موجودة؟  
* keyboard accessible؟  
* focus visible؟  
* mobile behavior محدد؟  
* no generic AI aesthetics؟  
* no random colors؟  
* no unnecessary cards؟  
* no decorative interaction بلا قيمة؟  
* no inaccessible forms؟  
* no hidden primary navigation on desktop؟  
* no placeholder-only labels؟

ولا تكتف بهذه الأمثلة؛ ابنِ القائمة من المصادر الفعلية التي قرأتها.

---

# **STEP 8 — DEFINE ANTI-AI-DESIGN RULES**

أنشئ قائمة واضحة بالأشياء التي لن تفعلها تلقائيًا لمجرد أنها شائعة في مخرجات النماذج.

خصوصًا:

* generic purple gradients  
* excessive glassmorphism  
* excessive rounded cards  
* rainbow status colors  
* random shadows  
* giant hero sections داخل admin systems  
* decorative illustrations بلا وظيفة  
* excessive animation  
* desktop hamburger menus  
* placeholder-only labels  
* unclear microcopy  
* arbitrary spacing  
* arbitrary breakpoints  
* dense interfaces بلا hierarchy

لكن:

**لا تحوّل anti-patterns إلى absolute bans إذا كان السياق قد يبررها.**

القاعدة يجب أن تكون:

`context → decision`

وليس:

`rule → blindly apply`.

---

# **STEP 9 — PROFESSIONAL SELF-CHECK**

قبل إنهاء هذه المرحلة، اختبر منهجك على أمثلة عامة غير مرتبطة بـAFOQ:

مثلاً:

* enterprise dashboard  
* medical admin portal  
* SaaS settings  
* data-heavy management screen  
* moderation console

لا تكتب كودًا.

وضح فقط كيف ستتخذ قرارات التصميم لكل مثال باستخدام المنهج الذي بنيته.

---

# **STEP 10 — FINAL REPORT**

أريد تقريرًا بعنوان:

# **DESIGN ENGINEER READINESS REPORT**

ويحتوي:

## **A. Sources Retrieved**

كل Skill/Repo تمت قراءته فعليًا.

## **B. Source Verification**

ما الذي تم التحقق منه.

## **C. Core Principles**

أهم المبادئ المستخلصة.

## **D. Conflicts / Differences**

الاختلافات بين المصادر وكيف تم التعامل معها.

## **E. Unified Design Philosophy**

الفلسفة الموحدة التي استخلصتها.

## **F. AFOQ Design Engineering Method**

منهج العمل الذي ستتبعه لاحقًا.

## **G. Design Quality Gate**

قائمة التحقق.

## **H. Anti-Pattern Guardrails**

حواجز منع التصميم الرديء.

## **I. Contextual Decision Rules**

متى تطبق قاعدة ومتى لا تطبقها.

## **J. Professional Readiness**

هل أصبحت لديك منهجية كافية للانتقال للمرحلة التالية؟

## **K. Limitations**

ما الذي لم تستطع التحقق منه أو يحتاج مصادر إضافية.

---

# **CRITICAL FINAL RULE**

بعد إنهاء هذا التقرير:

**STOP**

لا تفحص تصميم AFOQ بعد.

لا تقترح Layout.

لا تقترح ألوان AFOQ.

لا تقترح Sidebar.

لا تكتب Component specification للمشروع.

لا تعدل المشروع.

لا تنشئ prototype.

لا تكتب HTML/CSS/JS.

لا تنفذ أي Skill داخل repository.

الهدف الوحيد في هذه المرحلة هو:

**أن تقرأ المهارات الأصلية وتفهمها وتبني منهجية Design Engineering احترافية مبنية عليها.**

FINAL STATUS:

`DESIGN ENGINEER TRAINING COMPLETE`  
`NO PROJECT CHANGES`  
`NO DESIGN IMPLEMENTATION`

