/**
 * AFOQ — Minimal Load / Capacity / Stress Test Harness
 * =====================================================
 * Pure Node.js stdlib (http/https). No external load-test dependency.
 *
 * Modes:
 *   --target local      -> http://localhost:<port>  (repo dev-server)
 *   --target live       -> https://afoq-m.pages.dev (Cloudflare Pages, read-only)
 *   --target supabase   -> https://lzmkgfxlsynaphpofblb.supabase.co (public REST reads)
 *
 * Scenarios (composed of GET paths, read-only):
 *   A  static-home    "/"
 *   B  public-nav     representative public pages
 *   C  asset-heavy    a page + css + js + images
 *   D  api-read       public Supabase SELECT reads (no writes)
 *   E  search         public REST read filtered (no writes)
 *
 * Outputs raw JSON per phase; computes latency percentiles + error counts.
 *
 * Usage:
 *   node scripts/load-test-harness.js --target local --port 3100 --scenario B --vu 25 --duration 15 --out test/artifacts/load/phase-B-25vu.json
 *   node scripts/load-test-harness.js --target local --port 3100 --scenario A --vu 2 --duration 10 --telemetry vt1   (opt-in generator telemetry)
 *
 * SAFETY: GET only, no mutations, no auth storms, controlled VU ramp.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { URL } = require("url");
const { monitorEventLoopDelay } = require("perf_hooks");

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf("--" + name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return dflt;
}
const TARGET = arg("target", "local");
const PORT = Number(arg("port", "3100"));
const SCENARIO = arg("scenario", "B");
const VU = Number(arg("vu", "10"));
const DURATION = Number(arg("duration", "10"));
const OUT = arg("out", "");

// ------------------------------------------------------------------
// Phase 4A — opt-in generator telemetry (Node 24 stdlib only)
//   node scripts/load-test-harness.js ... --telemetry <runId>
//   or: AFOQ_LOAD_TELEMETRY=<runId> node scripts/load-test-harness.js ...
//   optional: --timewait  -> sample host TIME_WAIT via `netstat -an`
// Artifact:  test/artifacts/load/telemetry/<runId>/<runId>.generator.json
// ------------------------------------------------------------------
const TELEM_RUNID = arg("telemetry", "") || process.env.AFOQ_LOAD_TELEMETRY || "";
const TELEM_ENABLED = TELEM_RUNID.length > 0;
const TELEM_TIME_WAIT = args.includes("--timewait");

if (TELEM_ENABLED) {
  if (TELEM_RUNID === "1") {
    console.error(`AFOQ_LOAD_TELEMETRY/--telemetry cannot be "1" — set a real runId, e.g. --telemetry phase-4a-baseline.`);
    process.exit(2);
  }
  if (!validRunId(TELEM_RUNID)) {
    console.error(`Invalid telemetry runId ${JSON.stringify(TELEM_RUNID)}: must be ≤80 chars with no \\ / control chars, no "..", no leading/trailing whitespace.`);
    process.exit(2);
  }
}

const SECRETS = (() => {
  try {
    const s = fs.readFileSync(path.join(__dirname, "..", "js", "supabase-client.js"), "utf8");
    const u = s.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
    const k = s.match(/SUPABASE_ANON_KEY\s*=\s*["']([^"']+)["']/);
    return { url: u && u[1], anon: k && k[1] };
  } catch { return {}; }
})();

function baseUrl() {
  if (TARGET === "local") return `http://localhost:${PORT}`;
  if (TARGET === "live") return "https://afoq-m.pages.dev";
  if (TARGET === "supabase") return (SECRETS.url || "").replace(/\/+$/, "");
  throw new Error("unknown target");
}

const PUBLIC_PATHS = [
  "/",
  "/platform.html",
  "/courses.html",
  "/course.html",
  "/university.html",
  "/faculty.html",
  "/year.html",
  "/subject.html",
  "/forum.html",
  "/forum-topic.html",
  "/search.html",
  "/favorites.html",
];

function scenarioPaths() {
  switch (SCENARIO) {
    case "A": return ["/"];
    case "B": return PUBLIC_PATHS;
    case "C": return ["/", "/css/style.css", "/js/app.js", "/images/afoq-branding-final.webp", "/", "/js/auth.js", "/js/forum.js", "/images/favicon.png"];
    default: return PUBLIC_PATHS;
  }
}

// Supabase read queries that mirror app usage; GET-only, no writes.
function apiReads() {
  if (!SECRETS.url) return [];
  const base = baseUrl();
  const hdr = { apikey: SECRETS.anon, Authorization: "Bearer " + SECRETS.anon, Accept: "application/json" };
  const reads = [
    { path: "/rest/v1/universities?select=id,name,short_name&limit=50", hdr },
    { path: "/rest/v1/faculties?select=id,name,university_id&limit=50", hdr },
    { path: "/rest/v1/resources?select=id,title,subject_id,status&limit=50", hdr },
  ];
  // search-like filtered read (Scenario E)
  if (SCENARIO === "E") {
    reads.push({ path: "/rest/v1/courses?select=id,title,language&limit=20", hdr });
  }
  return reads.map(r => ({ ...r, full: base + r.path }));
}

function getProducer() {
  if (TARGET === "supabase") {
    const reads = apiReads();
    let i = 0;
    return () => reads[i++ % reads.length];
  }
  const paths = scenarioPaths();
  let i = 0;
  return () => ({ full: baseUrl() + paths[i++ % paths.length], path: paths[(i - 1) % paths.length] });
}

const REQ_TIMEOUT_MS = 10000;
const results = [];
let startedAt = 0;
let cancelled = false;
let telemetry = null;

function oneRequest(producer, vuId) {
  return new Promise((resolve) => {
    const spec = producer();
    let u;
    try { u = new URL(spec.full); } catch { resolve({ time: 0, status: "malformed", bodyLen: 0 }); return; }
    const lib = u.protocol === "http:" ? http : https;

    let hops = 0;
    const MAX_HOPS = 3;

    function doGet(currentUrl, startTime) {
      const libc = currentUrl.protocol === "http:" ? http : https;
      const req = libc.request(currentUrl, { method: "GET", headers: spec.hdr || { "User-Agent": "afoq-loadtest" } }, (res) => {
        const sck = res.socket || (req && req.socket) || null;
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < MAX_HOPS) {
          hops += 1;
          res.resume();
          const next = new URL(res.headers.location, currentUrl);
          doGet(next, startTime);
          return;
        }
        let len = 0;
        res.on("data", (d) => { len += d.length; });
        res.on("end", () => {
          results.push({ t: Date.now() - startTime, status: res.statusCode, len });
          if (telemetry && sck) telemetry.observeSocket(sck);
          resolve();
        });
      });
      req.on("error", () => { results.push({ t: Date.now() - startTime, status: "conn_error", len: 0 }); resolve(); });
      req.setTimeout(REQ_TIMEOUT_MS, () => { req.destroy(); results.push({ t: REQ_TIMEOUT_MS, status: "timeout", len: 0 }); resolve(); });
      req.end();
    }

    doGet(u, Date.now());
  });
}

async function vuLoop(producer, vuId, durationMs) {
  const endAt = Date.now() + durationMs;
  while (Date.now() < endAt && !cancelled) {
    if (telemetry) telemetry.requestStart();
    await oneRequest(producer, vuId);
    if (telemetry) telemetry.requestEnd();
  }
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)));
  return sorted[idx];
}

// ------------------------------------------------------------------
// Phase 4A — generator telemetry helpers
// ------------------------------------------------------------------
function validRunId(runId) {
  if (!runId || runId.length > 80) return false;
  if (/[\x00-\x1f/\\]/.test(runId)) return false;
  if (runId === "." || runId === "..") return false;
  if (runId.trim() !== runId) return false;
  return true;
}

let __prevCpuTimes = os.cpus();
function hostCpuBusyPct() {
  const cur = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < cur.length; i++) {
    const prev = __prevCpuTimes[i];
    if (!prev) continue;
    const keys = Object.keys(prev.times);
    let prevTotal = 0;
    let curTotal = 0;
    for (const k of keys) prevTotal += prev.times[k] || 0;
    for (const k of keys) curTotal += cur[i].times[k] || 0;
    idleDelta += (cur[i].times.idle || 0) - (prev.times.idle || 0);
    totalDelta += curTotal - prevTotal;
  }
  __prevCpuTimes = cur;
  if (totalDelta <= 0) return null;
  return Math.round((1 - idleDelta / totalDelta) * 1000) / 10;
}

function cpuUsagePctDelta(prev, cur, elapsedUs) {
  const d = (cur.user - prev.user) + (cur.system - prev.system);
  if (elapsedUs <= 0) return null;
  return Math.round((d / elapsedUs) * 10000) / 100;
}

function globalAgentSocketCounts() {
  const out = { sockets: null, freeSockets: null };
  try {
    const ag = http.globalAgent;
    let s = 0;
    for (const k in ag.sockets) s += ag.sockets[k] ? ag.sockets[k].length : 0;
    let f = 0;
    for (const k in ag.freeSockets) f += ag.freeSockets[k] ? ag.freeSockets[k].length : 0;
    out.sockets = s;
    out.freeSockets = f;
  } catch { /* implementation detail -> PARTIAL / NOT_AVAILABLE */ }
  return out;
}

function countTimeWait(cb) {
  execFile("netstat", ["-an"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
    if (err || !stdout) { cb(null); return; }
    const m = stdout.match(/TIME_WAIT/g);
    cb(m ? m.length : 0);
  });
}

function createGeneratorTelemetry(runId) {
  const dir = path.join(__dirname, "..", "test", "artifacts", "load", "telemetry", runId);
  const artifactPath = path.join(dir, runId + ".generator.json");
  if (fs.existsSync(artifactPath)) {
    throw new Error(`telemetry runId "${runId}" already has an artifact — refusing to overwrite: ${artifactPath}`);
  }
  fs.mkdirSync(dir, { recursive: true });

  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const distinctSockets = new Set();
  const MAX_SOCKETS = 200000;
  let socketsTruncated = false;
  let inflight = 0;

  const samples = [];
  const startedWall = Date.now();
  let lastCpu = process.cpuUsage();
  let lastSampleAt = startedWall;
  let lastBytes = 0;
  let timeWaitSeen = null;
  let tick = 0;

  const sampler = setInterval(() => {
    const now = Date.now();
    tick += 1;
    const cpu = process.cpuUsage();
    const elapsedUs = (now - lastSampleAt) * 1000;
    const mem = process.memoryUsage();
    const totalBytes = results.reduce((s, r) => s + (r.len || 0), 0);
    const ag = globalAgentSocketCounts();
    if (TELEM_TIME_WAIT && tick % 5 === 0) {
      countTimeWait((n) => { timeWaitSeen = n; });
    }
    samples.push({
      tSec: +((now - startedWall) / 1000).toFixed(1),
      tIso: new Date(now).toISOString(),
      activeVUs: VU,
      inflight,
      processCpuPct: cpuUsagePctDelta(lastCpu, cpu, elapsedUs),
      hostCpuPct: hostCpuBusyPct(),
      rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      hostFreeMemGb: Math.round((os.freemem() / 1024 / 1024 / 1024) * 100) / 100,
      hostTotalMemGb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 100) / 100,
      sockets: ag.sockets,
      freeSockets: ag.freeSockets,
      socketReuseRatio: distinctSockets.size ? Math.round((results.length / distinctSockets.size) * 1000) / 1000 : null,
      appBytesRecv: totalBytes,
      bytesPerSec: now === lastSampleAt ? null : Math.round((totalBytes - lastBytes) / ((now - lastSampleAt) / 1000)),
      timeWait: TELEM_TIME_WAIT ? timeWaitSeen : null,
      eventLoopP50Us: Math.round(eventLoop.percentiles.get(50) || 0),
      eventLoopP95Us: Math.round(eventLoop.percentiles.get(95) || 0),
      eventLoopP99Us: Math.round(eventLoop.percentiles.get(99) || 0),
      eventLoopMaxUs: Math.round(eventLoop.max || 0),
    });
    lastCpu = cpu;
    lastSampleAt = now;
    lastBytes = totalBytes;
  }, 1000);

  return {
    requestStart() { inflight += 1; },
    requestEnd() { if (inflight > 0) inflight -= 1; },
    observeSocket(sck) {
      try {
        if (distinctSockets.size >= MAX_SOCKETS) { socketsTruncated = true; return; }
        const id = (sck.localAddress || sck.remoteAddress || "?") + ":" + (sck.localPort || sck.remotePort || "?");
        distinctSockets.add(id);
      } catch { /* ignore */ }
    },
    stop() {
      clearInterval(sampler);
      eventLoop.disable();
    },
    finalize(metrics) {
      const now = Date.now();
      const elapsedMs = now - startedWall;
      const cpu = process.cpuUsage();
      const processCpuPct = cpuUsagePctDelta(lastCpu, cpu, elapsedMs * 1000);
      const artifact = {
        artifact: "afoq-load-generator-telemetry",
        schemaVersion: 2,
        runId,
        mode: "generator",
        startedAtIso: new Date(startedWall).toISOString(),
        endedAtIso: new Date(now).toISOString(),
        durationSec: DURATION,
        scenario: SCENARIO,
        target: TARGET,
        baseUrl: baseUrl(),
        vu: VU,
        samples,
        summary: {
          nominalRPS: metrics.requestsPerSecond,
          observedRPS: elapsedMs ? Math.round((metrics.totalRequests / (elapsedMs / 1000)) * 100) / 100 : 0,
          totalRequests: metrics.totalRequests,
          successful: metrics.successful,
          errorRate: metrics.errorRate,
          latencyMs: { ...metrics.latencyMs },
          processCpuPct,
          hostCpuPct: hostCpuBusyPct(),
          eventLoop: {
            status: "NOT_AVAILABLE",
            reason: "uv idle-time monitor (monitorEventLoopDelay) produced no valid statistics on this host; numeric sample fields retained only as raw diagnostics",
            p50Us: null,
            p95Us: null,
            p99Us: null,
            maxUs: null,
            meanUs: null,
          },
          distinctSockets: distinctSockets.size,
          socketsTruncated: socketsTruncated || null,
          socketReuseRatio: distinctSockets.size ? Math.round((metrics.totalRequests / distinctSockets.size) * 1000) / 1000 : null,
        },
        meta: {
          nodeVersion: process.version,
          platform: `${process.platform}/${process.arch}`,
          cpus: os.cpus().length,
          totalMemGb: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 100) / 100,
          samplerMs: 1000,
          timeWait: TELEM_TIME_WAIT,
          eventLoopNote: "monitorEventLoopDelay unreliable on this host (see summary.eventLoop.status); raw sample fields kept as diagnostics",
          classifications: {
            nominalRPS: "DERIVED",
            observedRPS: "DIRECT",
            latencyMs: "DIRECT",
            processCpuPct: "DIRECT",
            hostCpuPct: "DIRECT",
            rssMb: "DIRECT",
            heapMb: "DIRECT",
            hostFreeMemGb: "DIRECT",
            activeVUs: "DIRECT",
            inflight: "DIRECT",
            sockets: "PARTIAL",
            freeSockets: "PARTIAL",
            socketReuseRatio: "PARTIAL",
            appBytesRecv: "PARTIAL",
            bytesPerSec: "PARTIAL",
            timeWait: "PARTIAL",
            eventLoop: "NOT_AVAILABLE",
          },
        },
      };
      fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
      return artifactPath;
    },
  };
}

async function main() {
  const durationMs = DURATION * 1000;
  startedAt = Date.now();
  if (TELEM_ENABLED) telemetry = createGeneratorTelemetry(TELEM_RUNID);
  const producer = getProducer();
  const workers = Array.from({ length: VU }, (_, i) => vuLoop(producer, i, durationMs));
  await Promise.all(workers);

  const ok = results.filter(r => typeof r.status === "number" && r.status >= 200 && r.status < 300);
  const c3xx = results.filter(r => typeof r.status === "number" && r.status >= 300 && r.status < 400);
  const c4xx = results.filter(r => typeof r.status === "number" && r.status >= 400 && r.status < 500);
  const c5xx = results.filter(r => typeof r.status === "number" && r.status >= 500);
  const timeouts = results.filter(r => r.status === "timeout").length;
  const connErr = results.filter(r => r.status === "conn_error").length;
  const total = results.length;
  const errors = total - ok.length - c3xx.length;
  const elapsedSec = durationMs / 1000;
  const latencies = results.filter(r => typeof r.status === "number").map(r => r.t).sort((a, b) => a - b);

  const metrics = {
    target: TARGET,
    scenario: SCENARIO,
    baseUrl: baseUrl(),
    vu: VU,
    durationSec: DURATION,
    startedAtIso: new Date(startedAt).toISOString(),
    totalRequests: total,
    successful: ok.length,
    "3xxRedirects": c3xx.length,
    "4xx": c4xx.map(r => r.status),
    "4xxCount": c4xx.length,
    "5xxCount": c5xx.length,
    timeouts,
    connectionErrors: connErr,
    errorRate: errors ? (errors / total) : 0,
    requestsPerSecond: elapsedSec ? +(total / elapsedSec).toFixed(2) : 0,
    latencyMs: {
      p50: Math.round(pct(latencies, 50)),
      p90: Math.round(pct(latencies, 90)),
      p95: Math.round(pct(latencies, 95)),
      p99: Math.round(pct(latencies, 99)),
      max: latencies.length ? Math.round(latencies[latencies.length - 1]) : 0,
      mean: Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1)),
    },
  };

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(metrics, null, 2), "utf8");
  }

  if (telemetry) {
    telemetry.stop();
    const artifactPath = telemetry.finalize(metrics);
    console.error(`[telemetry] generator artifact written: ${artifactPath}`);
  }

  console.log(JSON.stringify(metrics));
}

main().catch((e) => { console.error(e); process.exit(1); });