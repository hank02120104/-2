const WORKER_URL = "https://stock-proxy.honggu0212.workers.dev";

let holdings = JSON.parse(localStorage.getItem("myHoldings")) || [];
let usdTwdRate = 32.25; 
let liveQuotes = {};
let trendChart = null;

// 倒數計時器變數
let countdownSeconds = 60;
let timerInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  renderAll();
  
  // 網頁初始化：載入即時股價與歷史走勢圖
  fetchData();
  fetchWeekHistory();

  // 啟動 60 秒動態倒數計時器
  startCountdown();

  // 綁定表單新增/修改股票事件
  const form = document.getElementById("addForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      let symbol = document.getElementById("symbol").value.trim().toUpperCase();
      const name = document.getElementById("name").value.trim();
      const market = document.getElementById("market").value;
      const cost = parseFloat(document.getElementById("cost").value);
      const qty = parseFloat(document.getElementById("qty").value);

      if (!symbol || isNaN(cost) || isNaN(qty)) {
        alert("請填寫正確的股票代號、成本與股數");
        return;
      }

      if (market === "TW" && !symbol.includes(".")) symbol += ".TW";
      if (market === "TWO" && !symbol.includes(".")) symbol += ".TWO";

      const idx = holdings.findIndex(h => h.symbol === symbol);
      if (idx >= 0) {
        holdings[idx] = { symbol, name, market, cost, qty };
      } else {
        holdings.push({ symbol, name, market, cost, qty });
      }

      await saveAndSync();
      form.reset();
    });
  }
});

// 每秒動態執行的倒數計時器
function startCountdown() {
  if (timerInterval) clearInterval(timerInterval);
  countdownSeconds = 60;

  timerInterval = setInterval(async () => {
    countdownSeconds--;

    const countdownEl = document.getElementById("countdownText");
    if (countdownEl) {
      countdownEl.textContent = `${countdownSeconds} 秒後更新`;
    }

    if (countdownSeconds <= 0) {
      countdownSeconds = 60;
      await fetchData();
    }
  }, 1000);
}

// 手動更新全域函數
async function manualRefresh() {
  const refreshBtn = document.querySelector(".btn-refresh") || (typeof event !== 'undefined' ? event?.currentTarget : null);
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ 更新中...";
  }

  countdownSeconds = 60;
  const countdownEl = document.getElementById("countdownText");
  if (countdownEl) {
    countdownEl.textContent = "60 秒後更新";
  }

  await fetchData();
  await fetchWeekHistory();

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "立即更新";
  }
}
window.manualRefresh = manualRefresh;

// 儲存至本地並同步給 Cloudflare Worker
async function saveAndSync() {
  localStorage.setItem("myHoldings", JSON.stringify(holdings));
  renderAll();

  if (holdings.length > 0) {
    try {
      await fetch(`${WORKER_URL}?action=sync_holdings`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(holdings)
      });
    } catch (e) {
      console.error("同步持股失敗:", e);
    }
  }
  
  await fetchData();
}

function deleteStock(symbol) {
  if (confirm(`確定刪除 ${symbol}？`)) {
    holdings = holdings.filter(h => h.symbol !== symbol);
    saveAndSync();
  }
}

// 抓取即時報價並繪製畫面
async function fetchData() {
  updateTime();
  if (holdings.length === 0) {
    renderAll();
    return;
  }

  const symbols = holdings.map(h => h.symbol);
  if (!symbols.includes("USDTWD=X")) symbols.push("USDTWD=X");

  try {
    const res = await fetch(`${WORKER_URL}?symbols=${encodeURIComponent(symbols.join(","))}`);
    if (res.ok) {
      const data = await res.json();
      const results = data.quoteResponse?.result || [];
      results.forEach(q => {
        if (q.symbol === "USDTWD=X") usdTwdRate = q.regularMarketPrice || usdTwdRate;
        else liveQuotes[q.symbol] = q.regularMarketPrice;
      });
    }
  } catch (e) {
    console.error("抓取股價失敗:", e);
  }

  renderAll();
}

// 本地時區轉換輔助函數 (自動將時間轉為當前裝置時區的 月/日 時:分)
function formatToLocalTime(timeStr) {
  if (!timeStr) return "";

  let d = new Date(timeStr);

  // 若為純數字時間戳記字串
  if (isNaN(d.getTime()) && !isNaN(Number(timeStr))) {
    d = new Date(Number(timeStr));
  }

  // 如果成功解析為合法 Date 物件
  if (!isNaN(d.getTime())) {
    const month = d.getMonth() + 1;
    const date = d.getDate();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month}/${date} ${hours}:${minutes}`;
  }

  // 備用防呆：若 Worker 本身已回傳 "MM/DD HH:mm" 文字且非標準格式，則原樣回傳
  return timeStr;
}

// 取得 7 天資產走勢紀錄並修正時區顯示
async function fetchWeekHistory() {
  try {
    const res = await fetch(`${WORKER_URL}?action=history`);
    if (res.ok) {
      const history = await res.json();
      if (Array.isArray(history) && history.length > 0) {
        // 修正：將 Worker 回傳的時間轉為本地時間格式
        const labels = history.map(h => formatToLocalTime(h.time));
        const values = history.map(h => h.val);
        updateChart(labels, values);
      }
    }
  } catch (e) {
    console.error("無法取得歷史紀錄:", e);
  }
}

function renderAll() {
  const rateEl = document.getElementById("usdTwdRate");
  if (rateEl) rateEl.textContent = usdTwdRate.toFixed(3);

  let totalValueTwd = 0;
  let totalCostTwd = 0;
  let tickerHtml = "";

  const grid = document.getElementById("holdingsGrid");
  if (grid) {
    grid.innerHTML = "";

    holdings.forEach(item => {
      const price = liveQuotes[item.symbol] !== undefined ? liveQuotes[item.symbol] : item.cost;
      const rate = item.market === "US" ? usdTwdRate : 1;

      const valTwd = price * item.qty * rate;
      const costTwd = item.cost * item.qty * rate;
      const pnlTwd = valTwd - costTwd;
      const pnlRate = item.cost > 0 ? ((price - item.cost) / item.cost) * 100 : 0;

      totalValueTwd += valTwd;
      totalCostTwd += costTwd;

      const isProfit = pnlTwd >= 0;
      const colorClass = isProfit ? "val-up" : "val-down";
      const sign = isProfit ? "+" : "";

      const card = document.createElement("div");
      card.className = "stock-card";
      card.innerHTML = `
        <div>
          <div class="stock-header">
            <span class="stock-symbol">${item.name || item.symbol} (${item.symbol})</span>
            <span class="badge">${item.market}</span>
          </div>
          <div class="stock-info">
            <div>現價: $${price.toFixed(2)}</div>
            <div>成本: $${item.cost.toFixed(2)}</div>
            <div>股數: ${item.qty}</div>
            <div>市值(NT): $${Math.round(valTwd).toLocaleString()}</div>
            <div class="pnl-box ${colorClass}">
              <span>損益:</span>
              <span>${sign}$${Math.round(pnlTwd).toLocaleString()} (${sign}${pnlRate.toFixed(2)}%)</span>
            </div>
          </div>
        </div>
        <button class="btn-del" onclick="deleteStock('${item.symbol}')">刪除持股</button>
      `;
      grid.appendChild(card);

      tickerHtml += `<span class="ticker-item ${colorClass}">${item.symbol} $${price.toFixed(2)} (${sign}$${Math.round(pnlTwd).toLocaleString()})</span>`;
    });
  }

  const totalPnl = totalValueTwd - totalCostTwd;
  const totalPnlRate = totalCostTwd > 0 ? (totalPnl / totalCostTwd) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";

  const totalMarketValEl = document.getElementById("totalMarketValue");
  if (totalMarketValEl) totalMarketValEl.textContent = `$${Math.round(totalValueTwd).toLocaleString()}`;
  
  const totalCostEl = document.getElementById("totalCost");
  if (totalCostEl) totalCostEl.textContent = `$${Math.round(totalCostTwd).toLocaleString()}`;
  
  const pnlEl = document.getElementById("totalPnl");
  if (pnlEl) {
    pnlEl.textContent = `${pnlSign}$${Math.round(totalPnl).toLocaleString()}`;
    pnlEl.className = `stat-value ${totalPnl >= 0 ? 'val-up' : 'val-down'}`;
  }

  const pnlRateEl = document.getElementById("totalPnlRate");
  if (pnlRateEl) {
    pnlRateEl.textContent = `${pnlSign}${totalPnlRate.toFixed(2)}%`;
    pnlRateEl.className = `stat-sub ${totalPnl >= 0 ? 'val-up' : 'val-down'}`;
  }

  const tickerTrackEl = document.getElementById("tickerTrack");
  if (tickerTrackEl) {
    tickerTrackEl.innerHTML = tickerHtml ? (tickerHtml + tickerHtml) : '<span class="ticker-item">尚無持股資料</span>';
  }
}

function updateTime() {
  const el = document.getElementById("currentTime");
  if (el) el.textContent = new Date().toLocaleTimeString('zh-TW');
}

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
        label: "7天資產走勢 (5分鐘/筆)",
        data: [],
        borderColor: "#00e676",
        backgroundColor: "rgba(0, 230, 118, 0.1)",
        borderWidth: 2,
        fill: true,
        tension: 0.2,
        pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "#1e293b" }, ticks: { color: "#64748b", maxTicksLimit: 12 } },
        y: { grid: { color: "#1e293b" }, ticks: { color: "#64748b" } }
      }
    }
  });
}

function updateChart(labels, data) {
  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = data;
    trendChart.update();
  }
}
