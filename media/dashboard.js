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
      drawLabelChart(lastData.perLabel[periodEl.value]);
      drawSessionChart(lastData.perSession[periodEl.value]);
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

  function render(data) {
    lastData = data;
    const hasData =
      data.perSession.allTime.length > 0 ||
      data.perLabel.allTime.length > 0 ||
      data.kpis.totalCredits > 0;
    document.getElementById("empty").classList.toggle("hidden", hasData);

    // KPIs
    document.getElementById("kpi-total").textContent = fmt(data.kpis.totalCredits);
    document.getElementById("kpi-labels").textContent = data.kpis.activeLabels;
    document.getElementById("kpi-month").textContent = fmt(data.kpis.monthCredits);
    document.getElementById("kpi-month-label").textContent = data.monthLabel;
    const change = data.kpis.percentChange;
    const changeEl = document.getElementById("kpi-change");
    if (change === null) {
      changeEl.textContent = "—";
    } else {
      changeEl.textContent = (change >= 0 ? "+" : "") + fmt(change) + "%";
    }

    document.getElementById("timeseries-title").textContent =
      "Total Cost Timeseries · " + data.monthLabel;

    drawLabelChart(data.perLabel[periodEl.value]);
    drawSessionChart(data.perSession[periodEl.value]);
    drawMonthChart(data.monthly, data.prevMonthly, data.monthLabel, data.prevMonthLabel);
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
        plugins: { legend: { position: "right" } },
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
            label: "Credits",
            data: perSession.map((s) => s.credits),
            backgroundColor: perSession.map((s) => s.color),
          },
        ],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true } },
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
        plugins: { legend: { display: true } },
        scales: {
          x: { title: { display: true, text: "Day of month" } },
          y: { beginAtZero: true },
        },
      },
    });
  }

  // Tell the extension we're ready for data.
  vscode.postMessage({ type: "ready" });
})();
