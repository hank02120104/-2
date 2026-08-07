const WORKER_URL = "https://stock-proxy.honggu0212.workers.dev";

let holdings = JSON.parse(localStorage.getItem("myHoldings")) || [];
let usdTwdRate = 32.25; 
let liveQuotes = {};
let sparklineCharts = {};

let countdownSeconds = 60;
let timerInterval = null;

document.addEventListener("DOMContentLoaded", () => {
  renderAll();
  fetchData();
  startCountdown();

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
        alert("請填寫正確資料");
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

function startCountdown() {
  if (timerInterval) clearInterval(timerInterval);
  countdownSeconds = 60;

  timerInterval = setInterval(async () => {
    countdownSeconds--;
    const countdownEl = document.getElementById("countdownText");
    if (countdownEl) countdownEl.textContent = `${countdownSeconds} 秒後更新`;

    if (countdownSeconds <= 0) {
      countdownSeconds = 60;
      await fetchData();
    }
  }, 1000);
}

async function manualRefresh() {
  const refreshBtn = document.querySelector(".btn-refresh");
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ 更新中...";
  }

  countdownSeconds = 60;
  const countdownEl = document.getElementById("countdownText");
  if (countdownEl) countdownEl.textContent = "60 秒後更新";

  await fetchData();

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "立即更新";
  }
}
window.manualRefresh = manualRefresh;

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
  loadAllSparklines();
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
      const currencyPrefix = item.market === "US" ? "US$" : "NT$";

      const valTwd = price * item.qty * rate;
      const costTwd = item.cost * item.qty * rate;
      const pnlTwd = valTwd - costTwd;
      const diffPerShare = price - item.cost;
      const pnlOriginal = diffPerShare * item.qty;

      totalValueTwd += valTwd;
      totalCostTwd += costTwd;

      const isProfit = pnlTwd >= 0;
      const colorClass = isProfit ? "val-up" : "val-down";
      const sign = isProfit ? "+" : "";
      const profitText = isProfit ? "賺" : "賠";

      const canvasId = `spark_${item.symbol.replace(/[^a-zA-Z0-9]/g, '_')}`;

      const card = document.createElement("div");
      card.className = "stock-card";
      card.innerHTML = `
        <div class="card-top">
          <div>
            <div class="card-symbol">${item.symbol}</div>
            <div class="card-name">${item.name || item.symbol}</div>
          </div>
          <span class="card-badge">${item.market === 'US' ? '美股' : '台股'}</span>
        </div>

        <div class="card-big-price">${currencyPrefix}${price.toFixed(2)}</div>
        <div class="card-price-sub">最新現價 • ${item.market === 'US' ? 'USD' : 'TWD'}</div>

        <div class="detail-row">
          <span>入場成本</span>
          <span class="detail-value">${currencyPrefix}${item.cost.toFixed(2)}</span>
        </div>
        <div class="detail-row">
          <span>持有數量</span>
          <span class="detail-value">${item.qty} 股</span>
        </div>
        <div class="detail-row">
          <span>每股價差</span>
          <span class="detail-value ${colorClass}">${sign}${diffPerShare.toFixed(2)}</span>
        </div>

        <div class="divider"></div>

        <div class="profit-section">
          <div class="profit-main ${colorClass}">${profitText} ${currencyPrefix}${Math.abs(pnlOriginal).toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
          ${item.market === 'US' ? `<div class="profit-sub ${colorClass}">約 ${sign}$${Math.round(pnlTwd).toLocaleString()} NT</div>` : ''}
        </div>

        <div class="sparkline-wrapper">
          <canvas id="${canvasId}"></canvas>
        </div>

        <div class="card-footer-action">
          <button class="btn-del" onclick="deleteStock('${item.symbol}')">刪除持股</button>
        </div>
      `;
      grid.appendChild(card);

      tickerHtml += `<span class="ticker-item ${colorClass}">${item.symbol} $${price.toFixed(2)} (${sign}$${Math.round(pnlTwd).toLocaleString()})</span>`;
    });
  }

  const totalPnl = totalValueTwd - totalCostTwd;
  const totalPnlRate = totalCostTwd > 0 ? (totalPnl / totalCostTwd) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";

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

// 載入所有持股的 2 天 5分鐘迷你走勢圖
async function loadAllSparklines() {
  for (const item of holdings) {
    try {
      const res = await fetch(`${WORKER_URL}?action=stock_history&symbol=${encodeURIComponent(item.symbol)}`);
      if (res.ok) {
        const history = await res.json();
        if (Array.isArray(history) && history.length > 0) {
          const labels = history.map(h => h.time);
          const prices = history.map(h => h.price);
          
          const isUp = prices[prices.length - 1] >= prices[0];
          renderSparkline(item.symbol, labels, prices, isUp);
        }
      }
    } catch (e) {
      console.error(`無法載入 ${item.symbol} 走勢:`, e);
    }
  }
}

// 繪製個股迷你 Sparkline 圖表
function renderSparkline(symbol, labels, data, isUp) {
  const canvasId = `spark_${symbol.replace(/[^a-zA-Z0-9]/g, '_')}`;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const strokeColor = isUp ? "#00e676" : "#ff4d4d";
  const fillColor = isUp ? "rgba(0, 230, 118, 0.15)" : "rgba(255, 77, 77, 0.15)";

  if (sparklineCharts[symbol]) {
    sparklineCharts[symbol].destroy();
  }

  sparklineCharts[symbol] = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        data: data,
        borderColor: strokeColor,
        borderWidth: 2,
        backgroundColor: fillColor,
        fill: true,
        tension: 0.3,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: true } },
      scales: {
        x: { display: false },
        y: { display: false }
      }
    }
  });
}

function updateTime() {
  const el = document.getElementById("currentTime");
  if (el) el.textContent = new Date().toLocaleTimeString('zh-TW');
}
