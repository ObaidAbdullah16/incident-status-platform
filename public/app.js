const metricsEl = document.querySelector("#metrics");
const servicesEl = document.querySelector("#services");
const incidentsEl = document.querySelector("#incidents");
const eventsEl = document.querySelector("#events");
const overallStatusEl = document.querySelector("#overallStatus");
const refreshButton = document.querySelector("#refreshButton");
const serviceForm = document.querySelector("#serviceForm");

const labels = {
  operational: "Operational",
  degraded: "Degraded",
  recovering: "Recovering",
  outage: "Outage",
  critical: "Critical",
  warning: "Warning"
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short"
  }).format(new Date(value));
}

function metric(label, value, tone = "cyan") {
  return `
    <article class="metric">
      <div>
        <span>${label}</span>
        <strong>${value}</strong>
      </div>
      <div class="dot" style="background: var(--${tone}); box-shadow: 0 0 0 8px color-mix(in srgb, var(--${tone}) 14%, transparent);"></div>
    </article>
  `;
}

function statusPill(status) {
  return `<span class="status-pill ${status}">${labels[status] || status}</span>`;
}

function renderMetrics(data) {
  const o = data.overview;
  overallStatusEl.className = `status-pill ${o.overallStatus}`;
  overallStatusEl.textContent = labels[o.overallStatus] || o.overallStatus;
  metricsEl.innerHTML = [
    metric("Services", o.totalServices, "cyan"),
    metric("Open Incidents", o.openIncidents, o.openIncidents ? "amber" : "green"),
    metric("Avg Response", `${o.avgResponseTime}ms`, "violet"),
    metric("Uptime", `${o.uptimePercent}%`, "green")
  ].join("");
}

function renderServices(services) {
  servicesEl.innerHTML = services.map(service => `
    <article class="service-card">
      <div class="incident-head">
        <h3>${service.name}</h3>
        ${statusPill(service.status)}
      </div>
      <p>${service.url}</p>
      <div class="service-meta">
        <div>
          <span>Response</span>
          <strong>${service.responseTimeMs || 0}ms</strong>
        </div>
        <div>
          <span>Failures</span>
          <strong>${service.failures || 0}/${service.failureThreshold}</strong>
        </div>
        <div>
          <span>Last Check</span>
          <strong>${formatTime(service.lastCheckedAt)}</strong>
        </div>
        <div>
          <span>Recovery</span>
          <strong>${service.autoRecovery ? "Enabled" : "Manual"}</strong>
        </div>
      </div>
      <p>${service.runbook}</p>
      <div class="service-actions">
        <button type="button" data-action="check" data-id="${service.id}">Run Check</button>
        ${service.demoKey ? `<button class="warning" type="button" data-action="fail" data-id="${service.id}">Fail Demo</button>` : ""}
        <button class="danger" type="button" data-action="delete" data-id="${service.id}">Remove</button>
      </div>
    </article>
  `).join("");
}

function renderIncidents(incidents) {
  if (!incidents.length) {
    incidentsEl.innerHTML = `<div class="empty">No incidents recorded yet</div>`;
    return;
  }

  incidentsEl.innerHTML = incidents.map(incident => `
    <article class="timeline-item">
      <div class="incident-head">
        <div>
          <h3>${incident.title}</h3>
          <div class="time">${incident.serviceName} • ${formatTime(incident.startedAt)}</div>
        </div>
        ${statusPill(incident.status === "open" ? incident.severity : "operational")}
      </div>
      <p>${incident.summary}</p>
      <p>${incident.timeline?.[0]?.message || ""}</p>
      ${incident.status === "open" ? `<button class="ghost" type="button" data-action="resolve" data-id="${incident.id}">Resolve</button>` : ""}
    </article>
  `).join("");
}

function renderEvents(events) {
  if (!events.length) {
    eventsEl.innerHTML = `<div class="empty">No automation events yet</div>`;
    return;
  }

  eventsEl.innerHTML = events.map(event => `
    <article class="timeline-item">
      <div class="incident-head">
        <h3>${event.type}</h3>
        <span class="time">${formatTime(event.createdAt)}</span>
      </div>
      <p>${event.message}</p>
    </article>
  `).join("");
}

async function load() {
  const data = await api("/api/overview");
  renderMetrics(data);
  renderServices(data.services);
  renderIncidents(data.incidents);
  renderEvents(data.events);
}

servicesEl.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  const action = button.dataset.action;
  button.disabled = true;

  try {
    if (action === "check") await api(`/api/services/${id}/check`, { method: "POST" });
    if (action === "fail") await api(`/api/services/${id}/simulate-failure`, { method: "POST" });
    if (action === "delete") await api(`/api/services/${id}`, { method: "DELETE" });
    await load();
  } finally {
    button.disabled = false;
  }
});

incidentsEl.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action='resolve']");
  if (!button) return;
  button.disabled = true;
  try {
    await api(`/api/incidents/${button.dataset.id}/resolve`, { method: "POST" });
    await load();
  } finally {
    button.disabled = false;
  }
});

serviceForm.addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(serviceForm);
  const payload = Object.fromEntries(form.entries());
  payload.autoRecovery = form.get("autoRecovery") === "on";
  payload.timeoutMs = Number(payload.timeoutMs);
  payload.failureThreshold = Number(payload.failureThreshold);
  await api("/api/services", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  serviceForm.reset();
  serviceForm.autoRecovery.checked = true;
  serviceForm.timeoutMs.value = 2500;
  serviceForm.failureThreshold.value = 2;
  await load();
});

refreshButton.addEventListener("click", load);

load();
setInterval(load, 8000);
