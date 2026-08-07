function initChart() {
  const canvas = document.getElementById("trendChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (typeof Chart === "undefined") {
    console.error("Chart.js 未載入！");
    return;
  }

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "7天資產走勢",
        data: [],
        borderColor: "#00e676",
        backgroundColor: "rgba(0, 230, 118, 0.1)",
        borderWidth: 2,
        fill: true,
        tension: 0.2,
        pointRadius: 0,         // 平時隱藏圓點，避免資料多時點點擠在一起
        pointHoverRadius: 6    // 滑鼠游標移上去時才顯現圓點
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
        }
      },
      scales: {
        x: {
          grid: { color: "#1e293b" },
          ticks: {
            color: "#64748b",
            maxTicksLimit: 14,    // ⚡ 強制最多只均勻顯示 14 個時間標籤
            maxRotation: 0,       // 保持文字水平，不旋轉
            autoSkip: true        // 自動過濾過密的時間點
          }
        },
        y: {
          grid: { color: "#1e293b" },
          ticks: { color: "#64748b" }
        }
      }
    }
  });
}
