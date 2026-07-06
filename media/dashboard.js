// @ts-check
/* global Chart, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {Record<string, any>} */
  const charts = {};

  // Read theme colors for chart text/grid lines.
  const styles = getComputedStyle(document.body);
  const fg = styles.getPropertyValue("--vscode-foreground").trim() || "#ccc";
  const grid = "rgba(127,127,127,0.2)";
  Chart.defaults.color = fg;
  Chart.defaults.borderColor = grid;
  Chart.defaults.font.family = styles
    .getPropertyValue("--vscode-font-family")
    .trim();

  /** @type {any} */
  let lastData = null;

  const periodEl = document.getElementById("period");

  document.getElementById("refresh").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });

  periodEl.addEventListener("change", () => {
    if (lastData) {
      drawPeriodCharts(lastData, periodEl.value);
    }
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "data") {
      render(message.payload);
    }
  });

  function fmt(n) {
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });
  }

  function usd(n) {
    return "$" + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function render(data) {
    lastData = data;
    const hasData =
      data.perSession.allTime.length > 0 ||
      data.perLabel.allTime.length > 0 ||
      data.kpis.allTime.cost > 0;
    document.getElementById("empty").classList.toggle("hidden", hasData);

    document.getElementById("timeseries-title").textContent =
      "Total Cost Timeseries · " + data.monthLabel;

    drawPeriodCharts(data, periodEl.value);
    drawMonthChart(data.monthly, data.prevMonthly, data.monthLabel, data.prevMonthLabel);
  }

  /** Updates the headline KPI cards for the selected period. */
  function updateKpis(data, period) {
    const k = data.kpis[period];
    document.getElementById("kpi-cost").textContent = usd(k.cost);
    document.getElementById("kpi-cost-label").textContent =
      data.periodLabels[period] + " Cost";
    document.getElementById("kpi-labels").textContent = k.activeLabels;
    document.getElementById("kpi-avg").textContent = usd(k.avgCostPerSession);

    const changeEl = document.getElementById("kpi-change");
    if (k.percentChange === null) {
      changeEl.textContent = "—";
    } else {
      changeEl.textContent =
        (k.percentChange >= 0 ? "+" : "") + fmt(k.percentChange) + "%";
    }
    document.getElementById("kpi-change-label").textContent = CHANGE_LABELS[period];
  }

  const CHANGE_LABELS = {
    thisMonth: "vs Last Month",
    lastMonth: "vs Prior Month",
    last3Months: "vs Prior 3 Months",
    allTime: "vs Previous",
  };

  /** Draws every chart whose data depends on the selected period. */
  function drawPeriodCharts(data, period) {
    updateKpis(data, period);
    drawLabelChart(data.perLabel[period]);
    drawSessionChart(data.perSession[period]);
    drawHarnessChart(data.perHarness[period]);
    drawModelChart(data.perModel[period]);
    drawRepoChart(data.perRepo[period]);
    renderTokenStats(data.tokens[period]);
    drawHeatmap(data.activity[period]);
    barChart("avgCostHarness", "avgCostHarnessChart", data.avgCostByHarness[period], usd);
    barChart("avgCostModel", "avgCostModelChart", data.avgCostByModel[period], usd);
    barChart("sessionsModel", "sessionsModelChart", data.sessionsByModel[period], count);
    barChart("avgTokensModel", "avgTokensModelChart", data.avgTokensByModel[period], compact);
    barChart("avgSubagentsModel", "avgSubagentsModelChart", data.avgSubagentsByModel[period], dec1);
    barChart("sessionsLabel", "sessionsLabelChart", data.sessionsByLabel[period], count);
  }

  /** Formats a small average to one decimal place. */
  function dec1(n) {
    return Number(n).toFixed(1);
  }

  /** Formats an integer count for ticks/tooltips. */
  function count(n) {
    return String(Math.round(n));
  }

  /** Generic horizontal bar chart used by the per-model / per-harness breakdowns. */
  function barChart(key, canvasId, slices, valueFmt) {
    destroy(key);
    const ctx = document.getElementById(canvasId);
    slices = slices || [];
    charts[key] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: slices.map((s) => s.name),
        datasets: [
          {
            data: slices.map((s) => s.credits),
            backgroundColor: slices.map((s) => s.color),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => valueFmt(c.parsed.x) } },
        },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => valueFmt(v) } } },
      },
    });
  }

  function destroy(key) {
    if (charts[key]) {
      charts[key].destroy();
      delete charts[key];
    }
  }

  function drawLabelChart(perLabel) {
    destroy("label");
    const ctx = document.getElementById("labelChart");
    charts.label = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: perLabel.map((l) => l.name),
        datasets: [
          {
            data: perLabel.map((l) => l.credits),
            backgroundColor: perLabel.map((l) => l.color),
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right" },
          tooltip: {
            callbacks: {
              label: (c) => `${c.label}: ${usd(c.parsed)}`,
            },
          },
        },
      },
    });
  }

  function drawSessionChart(perSession) {
    destroy("session");
    const ctx = document.getElementById("sessionChart");
    charts.session = new Chart(ctx, {
      type: "bar",
      data: {
        labels: perSession.map((s) => s.label),
        datasets: [
          {
            label: "Cost (USD)",
            data: perSession.map((s) => s.credits),
            backgroundColor: perSession.map((s) => s.color),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (c) => usd(c.parsed.x),
            },
          },
        },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { callback: (v) => usd(v) },
          },
        },
      },
    });
  }

  function drawMonthChart(monthly, prevMonthly, monthLabel, prevMonthLabel) {
    destroy("month");
    const ctx = document.getElementById("monthChart");
    prevMonthly = prevMonthly || [];
    // Align both series on day-of-month so they can be compared directly.
    const maxDay = Math.max(
      monthly.length ? monthly[monthly.length - 1].day : 0,
      prevMonthly.length ? prevMonthly[prevMonthly.length - 1].day : 0
    );
    const labels = [];
    for (let d = 1; d <= maxDay; d++) {
      labels.push(d);
    }
    const byDay = (series) => {
      const arr = new Array(maxDay).fill(null);
      series.forEach((m) => {
        if (m.day >= 1 && m.day <= maxDay) {
          arr[m.day - 1] = m.cumulative;
        }
      });
      return arr;
    };
    charts.month = new Chart(ctx, {
      type: "line",
      data: {
        labels: labels,
        datasets: [
          {
            label: monthLabel || "This month",
            data: byDay(monthly),
            borderColor: "#59a14f",
            backgroundColor: "rgba(89,161,79,0.15)",
            fill: true,
            tension: 0.25,
            pointRadius: 0,
          },
          {
            label: prevMonthLabel || "Last month",
            data: byDay(prevMonthly),
            borderColor: "#9c9c9c",
            backgroundColor: "rgba(156,156,156,0.08)",
            borderDash: [6, 4],
            fill: false,
            tension: 0.25,
            pointRadius: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: (c) => `${c.dataset.label}: ${usd(c.parsed.y)}`,
            },
          },
        },
        scales: {
          x: { title: { display: true, text: "Day of month" } },
          y: { beginAtZero: true, ticks: { callback: (v) => usd(v) } },
        },
      },
    });
  }

  /** Doughnut of cost split by harness (Claude Code / OpenCode / Copilot). */
  function drawHarnessChart(perHarness) {
    destroy("harness");
    const ctx = document.getElementById("harnessChart");
    charts.harness = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels: perHarness.map((s) => s.name),
        datasets: [
          {
            data: perHarness.map((s) => s.credits),
            backgroundColor: perHarness.map((s) => s.color),
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "right" },
          tooltip: { callbacks: { label: (c) => `${c.label}: ${usd(c.parsed)}` } },
        },
      },
    });
  }

  /** Horizontal bar of cost split by model. */
  function drawModelChart(perModel) {
    destroy("model");
    const ctx = document.getElementById("modelChart");
    charts.model = new Chart(ctx, {
      type: "bar",
      data: {
        labels: perModel.map((s) => s.name),
        datasets: [
          {
            label: "Cost (USD)",
            data: perModel.map((s) => s.credits),
            backgroundColor: perModel.map((s) => s.color),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => usd(c.parsed.x) } },
        },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => usd(v) } } },
      },
    });
  }

  /** Horizontal bar of cost split by repo/workspace. */
  function drawRepoChart(perRepo) {
    destroy("repo");
    const ctx = document.getElementById("repoChart");
    charts.repo = new Chart(ctx, {
      type: "bar",
      data: {
        labels: perRepo.map((s) => s.name),
        datasets: [
          {
            label: "Cost (USD)",
            data: perRepo.map((s) => s.credits),
            backgroundColor: perRepo.map((s) => s.color),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (c) => usd(c.parsed.x) } },
        },
        scales: { x: { beginAtZero: true, ticks: { callback: (v) => usd(v) } } },
      },
    });
  }

  /** Estimated USD saved per cache-read token vs. full input price (Sonnet-tier spread). */
  const CACHE_SAVINGS_PER_TOKEN = 1.8 / 1_000_000;

  /**
   * Renders token counts plus efficiency ratios as text, rather than a bar
   * chart where cache-read tokens dwarf everything else.
   */
  function renderTokenStats(tokens) {
    const t = tokens || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const el = document.getElementById("tokenStats");

    // Cache hit: cache reads vs. everything fed in (fresh input + cache writes).
    const feedIn = t.input + t.cacheWrite;
    const cacheDenom = t.cacheRead + feedIn;
    const cacheHitPct = cacheDenom > 0 ? (t.cacheRead / cacheDenom) * 100 : null;
    const cacheMult = feedIn > 0 ? t.cacheRead / feedIn : null;

    // Output vs. what was fed in (fresh input + cache writes).
    const outPct = feedIn > 0 ? (t.output / feedIn) * 100 : null;
    const outMult = feedIn > 0 ? t.output / feedIn : null;

    const savings = t.cacheRead * CACHE_SAVINGS_PER_TOKEN;

    const num = (label, value) =>
      `<div class="tstat"><span class="tstat-num">${compact(value)}</span>` +
      `<span class="tstat-lbl">${label}</span></div>`;
    const ratio = (label, mult, pct) => {
      const m = mult === null ? "—" : mult.toFixed(2) + "×";
      const p = pct === null ? "—" : fmt(pct) + "%";
      return (
        `<div class="tstat"><span class="tstat-num">${m}</span>` +
        `<span class="tstat-sub">${p}</span>` +
        `<span class="tstat-lbl">${label}</span></div>`
      );
    };

    el.innerHTML =
      `<div class="tstat-group">` +
      num("Input", t.input) +
      num("Output", t.output) +
      num("Cache Write", t.cacheWrite) +
      num("Cache Read", t.cacheRead) +
      `</div>` +
      `<div class="tstat-group">` +
      ratio("Cache Hit", cacheMult, cacheHitPct) +
      ratio("Output : In+CacheWrite", outMult, outPct) +
      `<div class="tstat"><span class="tstat-num">${usd(savings)}</span>` +
      `<span class="tstat-lbl">Est. Cache Savings</span></div>` +
      `</div>`;
  }

  // Payload is Monday-based: index 0 = Monday … 6 = Sunday.
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  /**
   * Renders a weekday × hour spend heatmap as a CSS grid (no Chart.js). Only the
   * range of hours that actually contain spend is shown, so empty early-morning
   * and late-night columns are trimmed away.
   */
  function drawHeatmap(activity) {
    const el = document.getElementById("heatmap");
    el.innerHTML = "";
    const grid = activity || new Array(168).fill(0);
    const max = grid.reduce((m, v) => (v > m ? v : m), 0);

    // Find the first and last hour-of-day with any spend across the week.
    let minHour = 24;
    let maxHour = -1;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if ((grid[d * 24 + h] || 0) > 0) {
          if (h < minHour) minHour = h;
          if (h > maxHour) maxHour = h;
        }
      }
    }
    if (maxHour < 0) {
      minHour = 0;
      maxHour = 23; // no data: show the full day rather than an empty grid
    }
    const hours = [];
    for (let h = minHour; h <= maxHour; h++) {
      hours.push(h);
    }

    // Column template: one label column + one flexible column per shown hour,
    // so the grid stretches to fill the card.
    el.style.gridTemplateColumns = `auto repeat(${hours.length}, 1fr)`;

    // Header row: blank corner + hour labels (show even hours to reduce clutter).
    el.appendChild(cell("hm-corner", ""));
    for (const h of hours) {
      el.appendChild(cell("hm-hour", h % 2 === 0 ? String(h) : ""));
    }
    for (let d = 0; d < 7; d++) {
      el.appendChild(cell("hm-day", WEEKDAYS[d]));
      for (const h of hours) {
        const v = grid[d * 24 + h] || 0;
        const c = cell("hm-cell", "");
        const intensity = max > 0 ? v / max : 0;
        c.style.backgroundColor =
          v > 0 ? `rgba(89,161,79,${0.12 + intensity * 0.88})` : "transparent";
        c.title = `${WEEKDAYS[d]} ${h}:00 — ${usd(v)}`;
        el.appendChild(c);
      }
    }
  }

  function cell(cls, text) {
    const el = document.createElement("div");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  /** Compact number formatting for axis ticks, e.g. 1.2M, 3.4k. */
  function compact(n) {
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (abs >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  // Tell the extension we're ready for data.
  vscode.postMessage({ type: "ready" });
})();
