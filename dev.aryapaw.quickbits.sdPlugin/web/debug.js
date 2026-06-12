const statsEl = document.getElementById("stats");
const eventsBody = document.getElementById("eventsBody");
const backoffEl = document.getElementById("backoff");
const chartTitleEl = document.getElementById("chartTitle");
const kindFilter = document.getElementById("kindFilter");
const bucketFilter = document.getElementById("bucketFilter");
const hoursFilter = document.getElementById("hoursFilter");
const exportBtn = document.getElementById("exportBtn");

let chart = null;
let lastEvents = [];
let lastEventsKey = "";
let chartRangeKey = "1";

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
	const mins = Math.ceil(ms / 60_000);
	if (mins < 60) return mins + "m";
	const hours = Math.floor(mins / 60);
	const remMins = mins % 60;
	return remMins > 0 ? hours + "h " + remMins + "m" : hours + "h";
}

function chartTitleFor(hours, bucketMs) {
	const unit = bucketMs >= 300_000 ? "5 min" : "minute";
	return `Requests per ${unit} (last ${hours}h)`;
}

function destroyChart() {
	if (chart) {
		chart.destroy();
		chart = null;
	}
}

function fillBucketGaps(perBucket, hours, bucketMs) {
	const now = Date.now();
	const start = now - hours * 60 * 60 * 1000;
	const alignedStart = Math.floor(start / bucketMs) * bucketMs;
	const map = new Map((perBucket || []).map((row) => [row.bucket, row]));
	const filled = [];

	for (let t = alignedStart; t <= now; t += bucketMs) {
		const row = map.get(t);
		filled.push(
			row || {
				bucket: t,
				request: 0,
				skipped: 0,
				cache_hit: 0,
				blocked: 0,
				r429: 0
			}
		);
	}

	return filled;
}

function renderStats(metrics) {
	const { rolling30s, backoff, requestsToday } = metrics;
	statsEl.innerHTML = `
		<div class="stat"><label>API (30s)</label><strong>${rolling30s.total}/${rolling30s.limit}</strong></div>
		<div class="stat"><label>Plugin cap today</label><strong>${requestsToday?.count ?? 0}/${requestsToday?.limit ?? 300}</strong></div>
		<div class="stat"><label>Events in window</label><strong>${metrics.eventCount}</strong></div>
		<div class="stat"><label>429 backoff</label><strong>${fmtMs(backoff.blockedMs)}</strong></div>
	`;

	if (backoff.blockedMs > 0) {
		backoffEl.textContent = `Spotify API blocked after 429 — no outbound calls for ${fmtMs(backoff.blockedMs)} (limit ${backoff.requestLimit}/30s)`;
	} else {
		backoffEl.textContent = "";
	}
}

function perBucketKey(perBucket) {
	return perBucket.map((p) => `${p.bucket}:${p.request}:${p.skipped}:${p.blocked}:${p.r429}`).join("|");
}

function renderChart(perBucket, bucketMs, hours) {
	const rows = fillBucketGaps(perBucket, hours, bucketMs);
	const labels = rows.map((p) =>
		new Date(p.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	);
	const requests = rows.map((p) => p.request);
	const skipped = rows.map((p) => p.skipped + p.blocked);
	const r429 = rows.map((p) => p.r429);
	const rangeKey = `${hours}:${bucketMs}`;
	const dataKey = `${rangeKey}:${perBucketKey(rows)}`;

	chartTitleEl.textContent = chartTitleFor(hours, bucketMs);

	const ctx = document.getElementById("chart");
	const rangeChanged = chartRangeKey !== rangeKey;
	if (rangeChanged) {
		destroyChart();
		chartRangeKey = rangeKey;
	}

	if (chart) {
		if (chart.__dataKey === dataKey) {
			return;
		}
		chart.data.labels = labels;
		chart.data.datasets[0].data = requests;
		chart.data.datasets[1].data = skipped;
		chart.data.datasets[2].data = r429;
		chart.__dataKey = dataKey;
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
			maintainAspectRatio: false,
			animation: false,
			plugins: { legend: { labels: { color: "#aaa" } } },
			scales: {
				x: {
					stacked: true,
					ticks: { color: "#666", maxRotation: 0, autoSkip: true, maxTicksLimit: 24 },
					grid: { color: "#222" }
				},
				y: {
					stacked: true,
					ticks: { color: "#666", precision: 0 },
					grid: { color: "#222" },
					beginAtZero: true
				}
			}
		}
	});
	chart.__dataKey = dataKey;
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
		const hours = Number.parseInt(hoursFilter.value, 10) || 1;
		const [metricsRes, eventsRes] = await Promise.all([
			fetch(`/debug/api/metrics?hours=${hours}`),
			fetch("/debug/api/events?limit=200")
		]);
		if (!metricsRes.ok || !eventsRes.ok) return;
		const metrics = await metricsRes.json();
		const { events } = await eventsRes.json();
		lastEvents = events;
		renderStats(metrics);
		const perBucket = metrics.perBucket || metrics.perMinute || [];
		renderChart(perBucket, metrics.bucketMs || 60_000, metrics.windowHours || hours);
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
hoursFilter.addEventListener("change", () => {
	destroyChart();
	chartRangeKey = "";
	refresh();
});
exportBtn.addEventListener("click", () => {
	window.location.href = "/debug/api/export";
});

refresh();
setInterval(refresh, 3000);
