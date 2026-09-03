/**
 * test-full.js
 * ------------------------------------------------------------------
 * AFOQ — Comprehensive READ-ONLY production browser audit.
 *
 * This is a standalone test file. It does NOT touch, replace, or
 * depend on any existing test.js in the project, and it performs
 * NO mutations of any kind:
 *   - no INSERT / UPDATE / DELETE against Supabase
 *   - no course/lesson creation
 *   - no admin login attempts, no credential prompting
 *   - no writes to any project file
 *
 * Requirements to run this yourself:
 *   npm install -D playwright
 *   npx playwright install chromium
 *   node test/test-full.js
 *
 * This script was authored and reviewed in an environment whose
 * outbound network is allowlisted and does NOT include
 * afoq-m.github.io, so it could not be executed there. Run it from
 * a machine/CI job with normal internet access.
 * ------------------------------------------------------------------
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://afoq-m.github.io/medical-platform';
const OUT_DIR = path.join(__dirname, 'artifacts');
const SCREENSHOTS_DIR = path.join(OUT_DIR, 'screenshots');

const KNOWN_EXPECTED = [
  // Anonymous Auth is intentionally disabled — this signup call is
  // expected to 422 and must NOT be classified as a real failure.
  { urlIncludes: '/auth/v1/signup', status: 422, label: 'Anonymous Auth disabled (expected)' },
];

function ensureDirs() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function isKnownExpected(url, status) {
  return KNOWN_EXPECTED.some(k => url.includes(k.urlIncludes) && status === k.status);
}

/** Attach console/page-error/network listeners to a page and return
 *  a mutable report object that fills in as the page is used. */
function instrumentPage(page, report) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      report.consoleErrors.push(msg.text());
    }
  });

  page.on('pageerror', (err) => {
    report.pageErrors.push(String(err && err.message ? err.message : err));
  });

  page.on('requestfailed', (req) => {
    report.failedRequests.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure() && req.failure().errorText,
    });
  });

  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) {
      const url = res.url();
      if (isKnownExpected(url, status)) {
        report.knownExpected.push({ url, status });
      } else {
        report.httpErrors.push({ url, status });
      }
    }
  });
}

function freshReport() {
  return {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    httpErrors: [],
    knownExpected: [],
  };
}

async function checkStaticPage(browser, urlPath, { needsRealId = false } = {}) {
  const url = `${BASE}/${urlPath}`;
  const report = freshReport();
  const page = await browser.newPage();
  instrumentPage(page, report);

  let httpStatus = null;
  let finalUrl = null;
  let title = null;
  let navError = null;

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    httpStatus = resp ? resp.status() : null;
    finalUrl = page.url();
    title = await page.title();
    // Give any async data-loading a moment to settle / surface errors.
    await page.waitForTimeout(1500);
  } catch (e) {
    navError = String(e && e.message ? e.message : e);
  }

  await page.close();

  return {
    urlPath,
    url,
    needsRealId,
    httpStatus,
    finalUrl,
    title,
    navError,
    ...report,
  };
}

async function testHomepage(browser) {
  const report = freshReport();
  const page = await browser.newPage();
  instrumentPage(page, report);

  const result = { name: 'Homepage' };

  const resp = await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle', timeout: 20000 });
  result.httpStatus = resp ? resp.status() : null;
  result.finalUrl = page.url();
  result.title = await page.title();

  // Locate the Courses button by its exact visible text.
  const coursesBtn = page.locator('a:has-text("أكاديمية أفق الطبية")').first();
  const btnCount = await page.locator('a:has-text("أكاديمية أفق الطبية")').count();
  result.buttonCount = btnCount;

  let visibleWithoutScroll = false;
  let href = null;
  if (btnCount > 0) {
    href = await coursesBtn.getAttribute('href');
    const box = await coursesBtn.boundingBox();
    const viewport = page.viewportSize();
    if (box && viewport) {
      visibleWithoutScroll = box.y >= 0 && box.y + box.height <= viewport.height;
    }
  }
  result.href = href;
  result.visibleWithoutScroll = visibleWithoutScroll;

  await ensureDirs();
  const screenshotPath = path.join(SCREENSHOTS_DIR, '01-homepage.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  result.screenshot = screenshotPath;

  await page.waitForTimeout(1000); // let any late console/network errors surface
  Object.assign(result, report);

  // --- Navigation test: actually click the button ---
  let navResult = null;
  if (btnCount > 0) {
    navResult = freshReport();
    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }),
        coursesBtn.click(),
      ]);
      navResult.finalUrl = page.url();
      navResult.title = await page.title();
      navResult.reached = navResult.finalUrl.includes('/courses.html');
    } catch (e) {
      navResult.navError = String(e && e.message ? e.message : e);
    }
  }
  result.navigation = navResult;

  await page.close();
  return result;
}

async function testCoursesListing(browser, page) {
  // If a page from navigation is passed in, reuse it; otherwise open fresh.
  const report = freshReport();
  const ownPage = !page;
  if (ownPage) {
    page = await browser.newPage();
    instrumentPage(page, report);
    await page.goto(`${BASE}/courses.html`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
  } else {
    instrumentPage(page, report);
    await page.waitForTimeout(500);
  }

  const result = { name: 'Courses Listing' };
  result.finalUrl = page.url();
  result.title = await page.title().catch(() => null);
  result.dir = await page.evaluate(() => document.documentElement.getAttribute('dir')).catch(() => null);

  // Give client-side Supabase fetch time to resolve, then look for course cards.
  await page.waitForTimeout(2000);

  const courseCardSelector = '[data-course-id], .course-card, a[href^="course.html?id="]';
  const courseCards = page.locator(courseCardSelector);
  const cardCount = await courseCards.count().catch(() => 0);
  result.publishedCourseCardsFound = cardCount;

  let firstCourseHref = null;
  if (cardCount > 0) {
    firstCourseHref = await courseCards.first().getAttribute('href').catch(() => null);
  }
  result.firstCourseHref = firstCourseHref;

  await ensureDirs();
  const screenshotPath = path.join(SCREENSHOTS_DIR, '02-courses-listing.png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  result.screenshot = screenshotPath;

  Object.assign(result, report);
  if (ownPage) await page.close();
  return { result, page: ownPage ? null : page, firstCourseHref };
}

async function testCourseDetail(browser, courseHref) {
  if (!courseHref) {
    return { name: 'Course Detail', verified: false, reason: 'no published course available' };
  }
  const report = freshReport();
  const page = await browser.newPage();
  instrumentPage(page, report);

  const url = courseHref.startsWith('http') ? courseHref : `${BASE}/${courseHref}`;
  const result = { name: 'Course Detail', url };

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch((e) => {
    result.navError = String(e && e.message ? e.message : e);
    return null;
  });
  result.httpStatus = resp ? resp.status() : null;
  result.finalUrl = page.url();
  result.title = await page.title().catch(() => null);

  await page.waitForTimeout(1500);

  // Lessons: capture visible lesson titles/order if present.
  const lessonSelector = '[data-lesson-id], .lesson-item, .lesson-card';
  const lessons = page.locator(lessonSelector);
  const lessonCount = await lessons.count().catch(() => 0);
  result.lessonsFound = lessonCount;

  await ensureDirs();
  const screenshotPath = path.join(SCREENSHOTS_DIR, '03-course-detail.png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  result.screenshot = screenshotPath;

  Object.assign(result, report);
  await page.close();
  return result;
}

async function testInvalidCourseId(browser) {
  const report = freshReport();
  const page = await browser.newPage();
  instrumentPage(page, report);

  const url = `${BASE}/course.html?id=invalid-test-id`;
  const result = { name: 'Invalid Course ID', url };

  const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch((e) => {
    result.navError = String(e && e.message ? e.message : e);
    return null;
  });
  result.httpStatus = resp ? resp.status() : null;
  result.finalUrl = page.url();

  await page.waitForTimeout(1500);

  // Heuristic: page should show some not-found / empty-state text, not a
  // blank/broken layout. Adjust selector to match the real markup.
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  result.bodyTextSample = bodyText.slice(0, 500);
  result.hasUncaughtErrors = report.pageErrors.length > 0;

  Object.assign(result, report);
  await page.close();
  return result;
}

async function testAdminReadOnly(browser) {
  // This test NEVER logs in and NEVER supplies credentials. It only
  // checks whether the browser already has an authenticated session
  // (e.g. via a pre-existing storageState passed to the browser
  // context outside this script). If not authenticated, it reports
  // NOT VERIFIED, per the task's rules.
  const report = freshReport();
  const page = await browser.newPage();
  instrumentPage(page, report);

  const url = `${BASE}/admin/index.html`;
  const result = { name: 'Admin (read-only)', url };

  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch((e) => {
    result.navError = String(e && e.message ? e.message : e);
  });
  await page.waitForTimeout(1500);

  const loginFormVisible = await page.locator('text=تسجيل دخول الأدمن').isVisible().catch(() => false);
  result.authenticatedSessionAvailable = !loginFormVisible;

  if (!result.authenticatedSessionAvailable) {
    result.verdict = 'NOT VERIFIED — no authenticated admin session available';
    await page.close();
    return result;
  }

  // Only reached if a session already exists (e.g. injected storageState).
  const coursesTab = page.locator('text=Courses, text=الدورات, text=المواد التعليمية').first();
  result.coursesTabFound = await coursesTab.count().catch(() => 0) > 0;
  if (result.coursesTabFound) {
    await coursesTab.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  await ensureDirs();
  const screenshotPath = path.join(SCREENSHOTS_DIR, '04-admin-courses.png');
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  result.screenshot = screenshotPath;

  Object.assign(result, report);
  await page.close();
  return result;
}

async function main() {
  ensureDirs();
  const browser = await chromium.launch();
  const fullReport = {};

  // 1 & 2 — Homepage + navigation to Courses
  fullReport.homepage = await testHomepage(browser);

  // 3 — Courses listing (reuse the page we navigated to, if reachable)
  fullReport.coursesListing = { name: 'Courses Listing', reachedViaHomepageNav: false };
  let firstCourseHref = null;
  {
    const { result } = await testCoursesListing(browser, null);
    fullReport.coursesListing = result;
    firstCourseHref = result.firstCourseHref;
  }

  // 5/6 — Course detail + lessons (only if a real published course exists)
  fullReport.courseDetail = await testCourseDetail(browser, firstCourseHref);

  // 7 — Invalid course ID
  fullReport.invalidCourseId = await testInvalidCourseId(browser);

  // 8 — Existing static pages (dynamic ones flagged as needing a real ID)
  const staticPages = [
    { path: 'index.html' },
    { path: 'platform.html' },
    { path: 'university.html', needsRealId: true },
    { path: 'faculty.html', needsRealId: true },
    { path: 'year.html', needsRealId: true },
    { path: 'semester.html', needsRealId: true },
    { path: 'subject.html', needsRealId: true },
    { path: 'search.html' },
    { path: 'favorites.html' },
    { path: 'courses.html' },
  ];
  fullReport.staticPages = [];
  for (const p of staticPages) {
    fullReport.staticPages.push(await checkStaticPage(browser, p.path, { needsRealId: p.needsRealId }));
  }

  // 12 — Admin, read-only only
  fullReport.admin = await testAdminReadOnly(browser);

  await browser.close();

  ensureDirs();
  const jsonPath = path.join(OUT_DIR, 'report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(fullReport, null, 2), 'utf-8');
  console.log(`Full report written to ${jsonPath}`);
  console.log(JSON.stringify(fullReport, null, 2));
}

main().catch((e) => {
  console.error('test-full.js crashed:', e);
  process.exit(1);
});
