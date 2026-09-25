// ============================================================
// خادم تطوير محلي لموقع أفق المعرفة.
//
// الميزة الأساسية: لامسّ للمسارات إطلاقًا — لا clean-url redirects،
// لا حذف/تعديل لسلسلة الاستعلام (?id=...). أي ملف يُخدم حرفيًا كما
// عنوانه، لأن إعادة كتابة المسارات من طرف serve/serve-handler هي
// أصل مشكلة سقوط معرّفات الصفحات (serve-handler#97/#178).
//
// تحسينات إضافية:
//   - تسجيل طلبات مفصّل (طريقة، مسار، نتيجة، مدّة)
//   - دعم HEAD + ETag/If-None-Match (استجابة 304) مع no-cache للهيكل
//   - حماية محسّنة من path traversal (check عبر path.relative)
//   - تعامل آمن مع روابط malformed (تجنّب انهيار decodeURIComponent)
//   - عرض عنوان LAN للاختبار من أجهزة أخرى على الشبكة
//   - إنهاء ناعم (graceful shutdown) عند Ctrl+C
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const url = require("url");
const { spawn } = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");

// ------------------------------------------------------------
// إعدادات سطر الأوامر — المنفذ القياسي 3100 (يطابق كل أدوات
// الاختبار/الأحمال: load-test-harness، load-browser-journey،
// test-runtime-deferred). لا تستخدم 3000 لأنها كانت قيمًا متفرّقة
// تسبب ارتباك (وصف ruining_ids سابقًا أصله serve-rewrite).
//   node scripts/dev-server.js             → port 3100
//   node scripts/dev-server.js 8080         → port 8080
//   PORT=8080 node scripts/dev-server.js    → port 8080
//   node scripts/dev-server.js --open       → يفتح المتصفح تلقائيًا
// ------------------------------------------------------------
const args = process.argv.slice(2);
const portArg = Number(args[0]);
const host = process.env.HOST || "0.0.0.0";
const port = Number.isInteger(portArg) && portArg > 0
  ? portArg
  : Number(process.env.PORT) || 3100;
const shouldOpen = args.includes("--open");

// Phase 4A — opt-in target telemetry (Node 24 stdlib only)
//   node scripts/dev-server.js <port> --telemetry <runId>
//   or: AFOQ_TARGET_TELEMETRY=<runId> node scripts/dev-server.js <port>
// Artifact:  test/artifacts/load/telemetry/<runId>/<runId>.target.json
// Snapshots: rewritten every 5 s (Windows hard-stop safe); final flush on SIGINT/SIGTERM.
const TELEM_RUNID = (() => {
  const fi = args.indexOf("--telemetry");
  const fromArg = fi !== -1 ? args[fi + 1] : "";
  const fromEnv = process.env.AFOQ_TARGET_TELEMETRY || "";
  const raw = fromArg || fromEnv;
  if (raw && (raw === "1" || !validRunId(raw))) {
    console.error(`Invalid target telemetry runId ${JSON.stringify(raw)}: must be a real runId (≤80 chars, no \\ / control chars, no "..", no whitespace edges).`);
    process.exit(1);
  }
  return raw;
})();
const TARGET_SNAPSHOT_MS = 5000;

const root = path.join(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonld": "application/ld+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".md": "text/markdown; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// ------------------------------------------------------------
// أدوات مساعدة
// ------------------------------------------------------------

const LAN_IPS = (() => {
  const nets = os.networkInterfaces();
  const ips = [];
  Object.values(nets).forEach((list) =>
    (list || []).forEach((n) => {
      if (n.family === "IPv4" && !n.internal) ips.push(n.address);
    })
  );
  return ips;
})();

// ------------------------------------------------------------------
// Phase 4A — target telemetry (opt-in)
// ------------------------------------------------------------------
function validRunId(runId) {
  if (!runId || runId.length > 80) return false;
  if (/[\x00-\x1f/\\]/.test(runId)) return false;
  if (runId === "." || runId === "..") return false;
  if (runId.trim() !== runId) return false;
  return true;
}

function cpuUsagePctDelta(prev, cur, elapsedUs) {
  const d = (cur.user - prev.user) + (cur.system - prev.system);
  if (elapsedUs <= 0) return null;
  return Math.round((d / elapsedUs) * 10000) / 100;
}

function createTargetTelemetry(runId, srv) {
  const dir = path.join(__dirname, "..", "test", "artifacts", "load", "telemetry", runId);
  const artifactPath = path.join(dir, runId + ".target.json");
  if (fs.existsSync(artifactPath)) {
    console.error(`Target telemetry runId "${runId}" already has an artifact — refusing to overwrite: ${artifactPath}`);
    process.exit(1);
  }
  fs.mkdirSync(dir, { recursive: true });

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const pending = new Map();
  const durations = [];
  const MAX_DURATIONS = 1000000;
  let durationsTruncated = false;
  let requests = 0;
  let prematureCloses = 0;
  const methods = {};
  const statusCounts = {};
  let activeRequests = 0;
  let activeRequestsMax = 0;
  let activeConnectionsSeen = null;

  const startedWall = Date.now();
  const startedAtIso = new Date(startedWall).toISOString();
  let lastCpu = process.cpuUsage();
  let lastSampleAt = startedWall;
  const samples = [];
  let sampler;
  let snapshotTimer;

  function requestEnter(req, startNs) {
    requests += 1;
    methods[req.method] = (methods[req.method] || 0) + 1;
    activeRequests += 1;
    if (activeRequests > activeRequestsMax) activeRequestsMax = activeRequests;
    pending.set(req, startNs);
  }

  function requestFinish(req, res) {
    statusCounts[res.statusCode] = (statusCounts[res.statusCode] || 0) + 1;
    const startNs = pending.get(req);
    if (startNs !== undefined) {
      if (durations.length < MAX_DURATIONS) {
        durations.push(Number((process.hrtime.bigint() - startNs) / 1000n));
      } else {
        durationsTruncated = true;
      }
    }
  }

  function requestClose(req, res) {
    if (activeRequests > 0) activeRequests -= 1;
    if (!res.writableFinished) prematureCloses += 1;
    pending.delete(req);
  }

  function pct(sorted, p) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
    return Math.round(sorted[idx]);
  }

  function buildSummary(final) {
    const now = Date.now();
    const elapsedMs = now - startedWall;
    const cpu = process.cpuUsage();
    const mem = process.memoryUsage();
    const sorted = durations.slice().sort((a, b) => a - b);
    const completeCount = durations.length;
    const latencyBlock = {
      status: durationsTruncated ? "NOT_AVAILABLE" : "OK",
      count: completeCount,
      truncated: durationsTruncated || null,
      p50: durationsTruncated ? null : pct(sorted, 50),
      p90: durationsTruncated ? null : pct(sorted, 90),
      p95: durationsTruncated ? null : pct(sorted, 95),
      p99: durationsTruncated ? null : pct(sorted, 99),
      max: durationsTruncated ? null : (sorted.length ? Math.round(sorted[sorted.length - 1]) : null),
      mean: durationsTruncated ? null : (completeCount ? Math.round(sorted.reduce((a, b) => a + b, 0) / completeCount) : null),
    };
    return {
      artifact: "afoq-load-target-telemetry",
      schemaVersion: 2,
      runId,
      mode: "target",
      startedAtIso,
      endedAtIso: new Date(now).toISOString(),
      elapsedSec: Math.round((elapsedMs / 1000) * 10) / 10,
      final: !!final,
      uptimeSec: Math.round(elapsedMs / 1000),
      processCpuPct: cpuUsagePctDelta(lastCpu, cpu, elapsedMs * 1000),
      rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      activeConnections: activeConnectionsSeen,
      requests,
      requestRate: elapsedMs ? Math.round((requests / (elapsedMs / 1000)) * 100) / 100 : 0,
      methods,
      statusCounts,
      activeRequestsMax,
      prematureCloses,
      latencyUs: latencyBlock,
      eventLoop: {
        status: "NOT_AVAILABLE",
        reason: "uv idle-time monitor (monitorEventLoopDelay) produced no valid statistics on this host; numeric sample fields retained only as raw diagnostics",
        p50Us: null,
        p95Us: null,
        p99Us: null,
        maxUs: null,
        meanUs: null,
      },
      samples,
      meta: {
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpus: os.cpus().length,
        samplerMs: 1000,
        snapshotMs: TARGET_SNAPSHOT_MS,
        eventLoopNote: "monitorEventLoopDelay unreliable on this host (see eventLoop.status); raw sample fields kept as diagnostics",
        classifications: {
          requests: "DIRECT",
          requestRate: "DERIVED",
          methods: "DIRECT",
          statusCounts: "DIRECT",
          latencyUs: "DIRECT (exact microseconds; NOT_AVAILABLE if truncated)",
          activeRequestsMax: "DIRECT",
          prematureCloses: "DIRECT",
          activeConnections: "DIRECT (server-side open sockets)",
          processCpuPct: "DIRECT",
          rssMb: "DIRECT",
          heapMb: "DIRECT",
          eventLoop: "NOT_AVAILABLE",
        },
      },
    };
  }

  function writeSnapshot(final) {
    try {
      const artifact = buildSummary(final);
      const tmp = artifactPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2), "utf8");
      fs.renameSync(tmp, artifactPath);
      if (final) console.error(`[telemetry] target artifact written: ${artifactPath}`);
    } catch (e) {
      console.error("[telemetry] snapshot write failed:", e.message);
    }
  }

  return {
    requestEnter,
    requestFinish,
    requestClose,
    start() {
      eventLoop.enable();
      sampler = setInterval(() => {
        const now = Date.now();
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        const elapsedUs = (now - lastSampleAt) * 1000;
        srv.getConnections((err, c) => { if (!err) activeConnectionsSeen = c; });
        samples.push({
          tSec: Math.round(((now - startedWall) / 1000) * 10) / 10,
          activeRequests,
          completed: durations.length,
          requestsTotal: requests,
          activeConnections: activeConnectionsSeen,
          processCpuPct: cpuUsagePctDelta(lastCpu, cpu, elapsedUs),
          rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
          heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
          eventLoopP95Us: Math.round(eventLoop.percentiles.get(95) || 0),
          eventLoopMaxUs: Math.round(eventLoop.max || 0),
          prematureCloses,
        });
        lastCpu = cpu;
        lastSampleAt = now;
      }, 1000);
      snapshotTimer = setInterval(() => writeSnapshot(false), TARGET_SNAPSHOT_MS);
    },
    flushFinal() {
      clearInterval(sampler);
      clearInterval(snapshotTimer);
      eventLoop.disable();
      srv.getConnections((err, c) => { if (!err) activeConnectionsSeen = c; });
      writeSnapshot(true);
    },
  };
}

function getEtag(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

const PAGE_404 = require("fs").readFileSync(
  path.join(__dirname, "..", "scripts", "404.html"),
  "utf8"
);

function sendError(res, status, message) {
  const body = PAGE_404.replace("{{STATUS}}", String(status)).replace("{{MESSAGE}}", message);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex",
  });
  res.end(body);
}

function streamFile(res, req, filePath, stats, log) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || "application/octet-stream";
  const etag = getEtag(stats);

  const headers = {
    "Content-Type": contentType,
    "ETag": etag,
    "Cache-Control": "no-cache",
    "X-Robots-Tag": "noindex",
    "X-Content-Type-Options": "nosniff",
  };

  // If-None-Match → 304 (يتحقق المتصفح من التحديثات دون إعادة تحميل كاملة)
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    log(304);
    return;
  }

  headers["Content-Length"] = stats.size;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    log(200);
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", (e) => {
    console.error("» خطأ بقراءة الملف:", e.message);
    if (!res.headersSent) sendError(res, 500, "خطأ داخلي أثناء قراءة الملف.");
  });
  stream.pipe(res);
}

// ------------------------------------------------------------
// معالج الطلبات
// ------------------------------------------------------------

let telemetry = null;

const server = http.createServer((req, res) => {
  const startTime = Date.now();
  const reqStartNanos = process.hrtime.bigint();
  if (telemetry) {
    telemetry.requestEnter(req, reqStartNanos);
    res.on("finish", () => telemetry.requestFinish(req, res));
    res.on("close", () => telemetry.requestClose(req, res));
  }
  const log = (status) => {
    const ms = Date.now() - startTime;
    const icon = status >= 500 ? "✗" : status === 404 ? "·" : "✓";
    console.log(`${icon} ${status} ${req.method} ${req.url} (${ms}ms)`);
  };

  // نسمح فقط بـ GET/HEAD. أي طريقة أخرى 405 — ليس هذا سيرفر API.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("405 — Method Not Allowed");
    log(405);
    return;
  }

  let parsed;
  try {
    parsed = url.parse(req.url);
  } catch {
    sendError(res, 400, "رابط غير صالح.");
    log(400);
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname || "/");
  } catch {
    // ترميز malformed — نتعامل مع المسار الخام بدل أن يرمي استثناء ينهي السيرفر
    pathname = parsed.pathname || "/";
  }

  // الجذر → index.html (سلوك قياسي، ليس إعادة كتابة ولا يولّد redirect)
  if (pathname === "/") pathname = "/index.html";

  const fullPath = path.normalize(path.join(root, pathname));

  // حماية صارمة من path traversal عبر path.relative (لا تقع ضحية
  // أسماء root2/root3 أو الشرطة المائلة المكررة)
  const rel = path.relative(root, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(".." + path.sep)) {
    console.log(`» BLOCKED traversal: ${req.url}`);
    sendError(res, 403, "طلب محظور: مسار خارج النطاق المسموح.");
    log(403);
    return;
  }

  fs.stat(fullPath, (err, stats) => {
    if (err || (!stats.isFile() && !stats.isDirectory())) {
      sendError(res, 404, "تعذّر العثور على الصفحة المطلوبة.");
      log(404);
      return;
    }

    if (stats.isDirectory()) {
      // مجلد: إن وُجد index.html داخله نخدمه، وإلا 404 (بدون فهرسة)
      const candidate = path.join(fullPath, "index.html");
      fs.stat(candidate, (dirErr, dirStats) => {
        if (dirErr || !dirStats.isFile()) {
          sendError(res, 404, "تعذّر العثور على الصفحة المطلوبة.");
          log(404);
          return;
        }
        streamFile(res, req, candidate, dirStats, log);
      });
      return;
    }

    streamFile(res, req, fullPath, stats, log);
  });
});

// ------------------------------------------------------------
// إدارة الأخطاء والإقلاع والإيقاف
// ------------------------------------------------------------

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`✗ المنفذ ${port} مشغول. أغلق العملية الأخرى عليه أولاً، أو استخدم منفذًا آخر:`);
    console.error(`  node scripts/dev-server.js ${port + 1}`);
    console.error("");
    process.exit(1);
  } else {
    console.error("خطأ تشغيلي:", err.message);
    process.exit(1);
  }
});

if (TELEM_RUNID) telemetry = createTargetTelemetry(TELEM_RUNID, server);

server.listen(port, host, () => {
  if (telemetry) telemetry.start();
  console.log("");
  console.log("┌──────────────────────────────────────────────────┐");
  console.log("│  أفق المعرفة — خادم تطوير (بدون rewrite للمسارات) │");
  console.log("└──────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  محلي:   http://localhost:${port}/`);
  LAN_IPS.forEach((ip) => {
    console.log(`  شبكة:   http://${ip}:${port}/`);
  });
  console.log(`  الجذر:  ${root}`);
  console.log(`  إيقاف:  Ctrl+C`);
  console.log("");
  console.log("  روابط للاختبار:");
  console.log(`    المنصة:        http://localhost:${port}/platform.html`);
  console.log(`    صفحة جامعة:    http://localhost:${port}/university.html?id=example`);
  console.log("");

  if (shouldOpen) {
    const cmd = process.platform === "win32" ? "cmd" : "xdg-open";
    const cmdArgs = process.platform === "win32"
      ? ["/c", "start", `http://localhost:${port}/`]
      : [`http://localhost:${port}/`];
    try {
      const cp = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
      cp.unref();
    } catch (e) {
      // لا نوقف السيرفر إن تعذّر فتح المتصفح
    }
  }
});

// إنهاء ناعم — إغلاق مستمع المنفذ ثم الخروج
process.on("SIGINT", () => {
  console.log("\nتم إيقاف الخادم. وداعًا!");
  if (telemetry) telemetry.flushFinal();
  server.close(() => process.exit(0));
});
// SIGTERM (بعد Ctrl+C مباشرة في بعض الإصدارات)
process.on("SIGTERM", () => {
  if (telemetry) telemetry.flushFinal();
  server.close(() => process.exit(0));
});