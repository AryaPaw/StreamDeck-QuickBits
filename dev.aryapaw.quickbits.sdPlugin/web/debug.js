const statsEl = document.getElementById("stats");
const eventsBody = document.getElementById("eventsBody");
const backoffEl = document.getElementById("backoff");
const kindFilter = document.getElementById("kindFilter");
const bucketFilter = document.getElementById("bucketFilter");
const exportBtn = document.getElementById("exportBtn");

let chart;
let lastEvents = [];
let lastEventsKey = "";

function eventsKey(events) {
	if (!events.length) return "";
	return `${events[0].ts}:${events.length}:${events[0].kind}:${events[events.length - 1].ts}`;
}

function fmtTime(ts) {
	return new Date(ts).toLocaleTimeString();
}

function fmtMs(ms) {
	if (ms <= 0) return "0s";
	if (ms < 60_000) return Math.ceil(ms / 1000) + "s";
	return Math.ceil(ms / 60_000) + "m";
}

function renderStats(metrics) {
	const { rolling30s, backoff } = metrics;
	statsEl.innerHTML = `
		<div class="stat"><label>API (30s)</label><strong>${rolling30s.total}/${rolling30s.limit}</strong></div>
		<div class="stat"><label>Events buffered</label><strong>${metrics.eventCount}</strong></div>
		<div class="stat"><label>429 backoff</label><strong>${fmtMs(backoff.blockedMs)}</strong></div>
		<div class="stat"><label>Request limit</label><strong>${backoff.requestLimit}/30s</strong></div>
	`;

	if (backoff.blockedMs > 0) {
		backoffEl.textContent = `Spotify API paused after 429 — retry in ${fmtMs(backoff.blockedMs)} (limit ${backoff.requestLimit}/30s)`;
	} else {
		backoffEl.textContent = "";
	}
}

function perMinuteKey(perMinute) {
	return perMinute.map((p) => `${p.minute}:${p.request}:${p.skipped}:${p.blocked}:${p.r429}`).join("|");
}

function renderChart(perMinute) {
	const labels = perMinute.map((p) => new Date(p.minute).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
	const requests = perMinute.map((p) => p.request);
	const skipped = perMinute.map((p) => p.skipped + p.blocked);
	const r429 = perMinute.map((p) => p.r429);

	const ctx = document.getElementById("chart");

	if (chart) {
		if (chart.__dataKey === perMinuteKey(perMinute)) {
			return;
		}
		chart.data.labels = labels;
		chart.data.datasets[0].data = requests;
		chart.data.datasets[1].data = skipped;
		chart.data.datasets[2].data = r429;
		chart.__dataKey = perMinuteKey(perMinute);
		chart.update("none");
		return;
	}

	chart = new Chart(ctx, {
		type: "bar",
		data: {
			labels,
			datasets: [
				{ label: "Requests", data: requests, backgroundColor: "rgba(29,185,84,0.7)" },
				{ label: "Skipped/Blocked", data: skipped, backgroundColor: "rgba(212,165,32,0.7)" },
				{ label: "429", data: r429, backgroundColor: "rgba(248,113,113,0.8)" }
			]
		},
		options: {
			responsive: true,
			animation: false,
			plugins: { legend: { labels: { color: "#aaa" } } },
			scales: {
				x: { stacked: true, ticks: { color: "#666" }, grid: { color: "#222" } },
				y: { stacked: true, ticks: { color: "#666", precision: 0 }, grid: { color: "#222" } }
			}
		}
	});
	chart.__dataKey = perMinuteKey(perMinute);
}

function renderEvents(events) {
	const kind = kindFilter.value;
	const bucket = bucketFilter.value;
	const filtered = events.filter((e) => {
		if (kind && e.kind !== kind) return false;
		if (bucket && e.bucket !== bucket) return false;
		return true;
	});

	eventsBody.innerHTML = filtered
		.map((e) => {
			const track = [e.trackTitle, e.trackArtist].filter(Boolean).join(" — ") || "—";
			return `<tr>
				<td>${fmtTime(e.ts)}</td>
				<td class="kind-${e.kind}">${e.kind}</td>
				<td>${e.bucket}</td>
				<td>${e.method} ${e.endpoint}</td>
				<td>${escapeHtml(track)}</td>
				<td>${escapeHtml(e.reason || "")}</td>
			</tr>`;
		})
		.join("");
}

function escapeHtml(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function refresh() {
	try {
		const [metricsRes, eventsRes] = await Promise.all([
			fetch("/debug/api/metrics"),
			fetch("/debug/api/events?limit=200")
		]);
		if (!metricsRes.ok || !eventsRes.ok) return;
		const metrics = await metricsRes.json();
		const { events } = await eventsRes.json();
		lastEvents = events;
		renderStats(metrics);
		renderChart(metrics.perMinute || []);
		const key = eventsKey(events);
		if (key !== lastEventsKey) {
			lastEventsKey = key;
			renderEvents(events);
		}
	} catch {
		// plugin may be restarting
	}
}

kindFilter.addEventListener("change", () => renderEvents(lastEvents));
bucketFilter.addEventListener("change", () => renderEvents(lastEvents));
exportBtn.addEventListener("click", () => {
	window.location.href = "/debug/api/export";
});

refresh();
setInterval(refresh, 3000);
