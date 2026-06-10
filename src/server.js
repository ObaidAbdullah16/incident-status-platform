const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CHECK_INTERVAL_MS = Number(process.env.CHECK_INTERVAL_MS || 15000);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || "";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
}

function baseUrl() {
  return process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
}

function defaultStore() {
  const base = baseUrl();
  return {
    meta: {
      createdAt: now(),
      name: "SignalOps Status"
    },
    simulation: {
      checkout: false,
      database: false
    },
    services: [
      {
        id: "svc_checkout",
        name: "Checkout API",
        url: `${base}/sample/checkout`,
        method: "GET",
        expectedMin: 200,
        expectedMax: 299,
        timeoutMs: 2500,
        failureThreshold: 2,
        autoRecovery: true,
        runbook: "Restart service task, clear stale DB connections, and verify checkout latency.",
        demoKey: "checkout",
        status: "operational",
        failures: 0,
        successes: 0,
        responseTimeMs: 0,
        uptimeChecks: 0,
        successfulChecks: 0,
        lastCheckedAt: null,
        lastRecoveryAt: null,
        createdAt: now()
      },
      {
        id: "svc_inventory",
        name: "Inventory API",
        url: `${base}/sample/inventory`,
        method: "GET",
        expectedMin: 200,
        expectedMax: 299,
        timeoutMs: 2500,
        failureThreshold: 2,
        autoRecovery: true,
        runbook: "Restart inventory worker and verify cache synchronization.",
        status: "operational",
        failures: 0,
        successes: 0,
        responseTimeMs: 0,
        uptimeChecks: 0,
        successfulChecks: 0,
        lastCheckedAt: null,
        lastRecoveryAt: null,
        createdAt: now()
      },
      {
        id: "svc_database",
        name: "Database Read Model",
        url: `${base}/sample/database`,
        method: "GET",
        expectedMin: 200,
        expectedMax: 299,
        timeoutMs: 2500,
        failureThreshold: 2,
        autoRecovery: true,
        runbook: "Rotate read replica target and refresh connection pool.",
        demoKey: "database",
        status: "operational",
        failures: 0,
        successes: 0,
        responseTimeMs: 0,
        uptimeChecks: 0,
        successfulChecks: 0,
        lastCheckedAt: null,
        lastRecoveryAt: null,
        createdAt: now()
      }
    ],
    incidents: [],
    events: [
      {
        id: id("evt"),
        type: "system",
        message: "Status platform initialized",
        createdAt: now()
      }
    ]
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(defaultStore(), null, 2));
  }
}

function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function saveStore(store) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

function addEvent(store, type, message, details = {}) {
  store.events.unshift({
    id: id("evt"),
    type,
    message,
    details,
    createdAt: now()
  });
  store.events = store.events.slice(0, 80);
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function openIncident(store, service, result) {
  let incident = store.incidents.find(item => item.serviceId === service.id && item.status === "open");
  if (incident) return incident;

  incident = {
    id: id("inc"),
    serviceId: service.id,
    serviceName: service.name,
    title: `${service.name} health check failing`,
    severity: service.failures >= service.failureThreshold * 2 ? "critical" : "degraded",
    status: "open",
    summary: result.error || `Expected ${service.expectedMin}-${service.expectedMax}, received ${result.statusCode}`,
    startedAt: now(),
    resolvedAt: null,
    timeline: [
      {
        at: now(),
        message: "Incident opened by automated health monitor"
      }
    ]
  };
  store.incidents.unshift(incident);
  addEvent(store, "incident", `Opened incident for ${service.name}`, { incidentId: incident.id });
  sendAlert("incident.opened", incident).catch(() => {});
  return incident;
}

function resolveIncident(store, service, note = "Service recovered") {
  const incident = store.incidents.find(item => item.serviceId === service.id && item.status === "open");
  if (!incident) return null;

  incident.status = "resolved";
  incident.resolvedAt = now();
  incident.timeline.unshift({
    at: now(),
    message: note
  });
  addEvent(store, "recovery", `Resolved incident for ${service.name}`, { incidentId: incident.id });
  sendAlert("incident.resolved", incident).catch(() => {});
  return incident;
}

async function sendAlert(type, payload) {
  if (!ALERT_WEBHOOK_URL) return;

  try {
    await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, payload, sentAt: now() })
    });
  } catch {
    // Keep monitoring alive even when the alert endpoint is unavailable.
  }
}

async function probeService(service) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutMs || 2500);

  try {
    const response = await fetch(service.url, {
      method: service.method || "GET",
      signal: controller.signal
    });
    const responseTimeMs = Date.now() - started;
    const ok = response.status >= service.expectedMin && response.status <= service.expectedMax;
    return {
      ok,
      statusCode: response.status,
      responseTimeMs,
      error: ok ? null : `Unexpected HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      responseTimeMs: Date.now() - started,
      error: error.name === "AbortError" ? "Request timed out" : error.message
    };
  } finally {
    clearTimeout(timer);
  }
}

function statusFromFailures(service) {
  if (service.failures >= service.failureThreshold * 2) return "outage";
  if (service.failures >= service.failureThreshold) return "degraded";
  return "operational";
}

async function runRecovery(store, service, incident) {
  if (!service.autoRecovery) return;

  const cooldownMs = Number(process.env.RECOVERY_COOLDOWN_MS || 60000);
  if (service.lastRecoveryAt && Date.now() - new Date(service.lastRecoveryAt).getTime() < cooldownMs) {
    return;
  }

  service.status = "recovering";
  service.lastRecoveryAt = now();
  if (incident) {
    incident.timeline.unshift({
      at: now(),
      message: `Auto-recovery started: ${service.runbook || "Default restart runbook"}`
    });
  }
  addEvent(store, "recovery", `Auto-recovery started for ${service.name}`, { serviceId: service.id });

  if (service.demoKey) {
    store.simulation[service.demoKey] = false;
    addEvent(store, "recovery", `Demo dependency reset for ${service.name}`, { serviceId: service.id });
    return;
  }

  if (process.env.RECOVERY_WEBHOOK_URL) {
    try {
      await fetch(process.env.RECOVERY_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          serviceId: service.id,
          serviceName: service.name,
          runbook: service.runbook,
          incidentId: incident ? incident.id : null
        })
      });
    } catch {
      addEvent(store, "recovery", `Recovery webhook failed for ${service.name}`, { serviceId: service.id });
    }
  }
}

async function checkService(serviceId) {
  const store = loadStore();
  const service = store.services.find(item => item.id === serviceId);
  if (!service) return null;

  const result = await probeService(service);
  service.lastCheckedAt = now();
  service.responseTimeMs = result.responseTimeMs;
  service.uptimeChecks = (service.uptimeChecks || 0) + 1;

  if (result.ok) {
    service.failures = 0;
    service.successes = (service.successes || 0) + 1;
    service.successfulChecks = (service.successfulChecks || 0) + 1;
    const hadIncident = store.incidents.some(item => item.serviceId === service.id && item.status === "open");
    service.status = "operational";
    if (hadIncident) {
      resolveIncident(store, service, "Automated monitor confirmed recovery");
    }
  } else {
    service.failures = (service.failures || 0) + 1;
    service.successes = 0;
    service.status = statusFromFailures(service);
    if (service.failures >= service.failureThreshold) {
      const incident = openIncident(store, service, result);
      incident.timeline.unshift({
        at: now(),
        message: result.error || "Health check failed"
      });
      await runRecovery(store, service, incident);
    }
  }

  saveStore(store);
  return { service, result };
}

async function checkAllServices() {
  const store = loadStore();
  const ids = store.services.map(service => service.id);
  for (const serviceId of ids) {
    await checkService(serviceId);
  }
}

function overview(store) {
  const counts = store.services.reduce((acc, service) => {
    acc[service.status] = (acc[service.status] || 0) + 1;
    return acc;
  }, {});
  const openIncidents = store.incidents.filter(incident => incident.status === "open");
  const avgResponseTime = Math.round(
    store.services.reduce((sum, service) => sum + (service.responseTimeMs || 0), 0) /
      Math.max(store.services.length, 1)
  );
  const successfulChecks = store.services.reduce((sum, service) => sum + (service.successfulChecks || 0), 0);
  const totalChecks = store.services.reduce((sum, service) => sum + (service.uptimeChecks || 0), 0);

  return {
    overallStatus: openIncidents.some(item => item.severity === "critical")
      ? "outage"
      : openIncidents.length > 0 || counts.degraded || counts.recovering
        ? "degraded"
        : "operational",
    counts,
    totalServices: store.services.length,
    openIncidents: openIncidents.length,
    avgResponseTime,
    uptimePercent: totalChecks === 0 ? 100 : Number(((successfulChecks / totalChecks) * 100).toFixed(2))
  };
}

function serveStatic(req, res) {
  const rawPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    notFound(res);
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      notFound(res);
      return;
    }
    const type = MIME_TYPES[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(content);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const store = loadStore();

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, service: "incident-status-platform", checkedAt: now() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sample/checkout") {
    if (store.simulation.checkout) {
      json(res, 503, { ok: false, error: "Simulated checkout dependency failure" });
      return;
    }
    json(res, 200, { ok: true, service: "checkout" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sample/inventory") {
    json(res, 200, { ok: true, service: "inventory" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sample/database") {
    if (store.simulation.database) {
      json(res, 500, { ok: false, error: "Simulated database read replica failure" });
      return;
    }
    json(res, 200, { ok: true, service: "database-read-model" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/overview") {
    json(res, 200, {
      overview: overview(store),
      services: store.services,
      incidents: store.incidents.slice(0, 10),
      events: store.events.slice(0, 20)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/services") {
    json(res, 200, { services: store.services });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/services") {
    const body = await readBody(req);
    if (!body.name || !body.url) {
      json(res, 400, { error: "Service name and URL are required" });
      return;
    }
    const service = {
      id: id("svc"),
      name: String(body.name).trim(),
      url: String(body.url).trim(),
      method: body.method || "GET",
      expectedMin: Number(body.expectedMin || 200),
      expectedMax: Number(body.expectedMax || 399),
      timeoutMs: Number(body.timeoutMs || 2500),
      failureThreshold: Number(body.failureThreshold || 2),
      autoRecovery: Boolean(body.autoRecovery),
      runbook: body.runbook || "Investigate recent deploys and restart the container task if needed.",
      status: "operational",
      failures: 0,
      successes: 0,
      responseTimeMs: 0,
      uptimeChecks: 0,
      successfulChecks: 0,
      lastCheckedAt: null,
      lastRecoveryAt: null,
      createdAt: now()
    };
    store.services.unshift(service);
    addEvent(store, "service", `Added service ${service.name}`, { serviceId: service.id });
    saveStore(store);
    json(res, 201, { service });
    return;
  }

  const checkMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/check$/);
  if (req.method === "POST" && checkMatch) {
    const result = await checkService(checkMatch[1]);
    if (!result) {
      notFound(res);
      return;
    }
    json(res, 200, result);
    return;
  }

  const simulateMatch = url.pathname.match(/^\/api\/services\/([^/]+)\/simulate-failure$/);
  if (req.method === "POST" && simulateMatch) {
    const service = store.services.find(item => item.id === simulateMatch[1]);
    if (!service || !service.demoKey) {
      json(res, 400, { error: "Only demo services can be failed from the dashboard" });
      return;
    }
    store.simulation[service.demoKey] = true;
    service.status = "degraded";
    addEvent(store, "service", `Simulated failure for ${service.name}`, { serviceId: service.id });
    saveStore(store);
    json(res, 200, { service });
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/services\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const index = store.services.findIndex(item => item.id === deleteMatch[1]);
    if (index === -1) {
      notFound(res);
      return;
    }
    const [removed] = store.services.splice(index, 1);
    addEvent(store, "service", `Removed service ${removed.name}`, { serviceId: removed.id });
    saveStore(store);
    json(res, 200, { removed });
    return;
  }

  const resolveMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
  if (req.method === "POST" && resolveMatch) {
    const incident = store.incidents.find(item => item.id === resolveMatch[1]);
    if (!incident) {
      notFound(res);
      return;
    }
    const service = store.services.find(item => item.id === incident.serviceId) || { id: incident.serviceId, name: incident.serviceName };
    incident.status = "resolved";
    incident.resolvedAt = now();
    incident.timeline.unshift({ at: now(), message: "Manually resolved from dashboard" });
    addEvent(store, "incident", `Manually resolved ${incident.title}`, { incidentId: incident.id });
    if (service.status) service.status = "operational";
    saveStore(store);
    json(res, 200, { incident });
    return;
  }

  notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (
      req.url.startsWith("/api/") ||
      req.url.startsWith("/sample/") ||
      req.url === "/health"
    ) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  ensureStore();
  console.log(`Incident status platform listening on ${PORT}`);
  checkAllServices().catch(() => {});
  setInterval(() => {
    checkAllServices().catch(error => {
      const store = loadStore();
      addEvent(store, "system", `Scheduled check failed: ${error.message}`);
      saveStore(store);
    });
  }, CHECK_INTERVAL_MS);
});
