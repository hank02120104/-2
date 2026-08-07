let holdings = JSON.parse(localStorage.getItem("myHoldings")) || [];
let historyData = JSON.parse(localStorage.getItem("myAssetHistory")) || [];

let usdTwdRate = 32.25; 
let liveQuotes = {};
let trendChart = null;
let countdown = 60;

document.addEventListener("DOMContentLoaded", () => {
  initChart();
  renderAll();
  fetchData();

  // 倒數計時器
  setInterval(() => {
    countdown--;
    const el = document.getElementById("countdownText");
    if (el) el.textContent = `${countdown} 秒後更新`;
    if (countdown <= 0) {
      countdown = 60;
      fetchData();
    }
  }, 1000);

  // 新增持股表單
  const form = document.getElementById("addForm");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      let symbol = document.getElementById("symbol").value.trim().toUpperCase();
      const name = document.getElementById("name").value.trim();
      const market = document.getElementById("market").value;
      const cost = parseFloat(document.getElementById("cost").value);
      const qty = parseFloat(document.getElementById("qty").value);

      if (market === "TW" && !symbol.includes(".")) {
        symbol += ".TW";
      }

      const idx = holdings.findIndex(h => h.symbol === symbol);
      if (idx >= 0) {
        holdings[idx] = { symbol, name, market, cost, qty };
      } else {
        holdings.push({ symbol, name, market, cost, qty });
      }

      saveAndRefresh();
      form.reset();
    });
  }
});

function manualRefresh() {
  countdown = 60;
  const el = document.getElementById("countdownText");
  if (el) el.textContent = `60 秒後更新`;
  fetchData();
}

function saveAndRefresh() {
  localStorage.setItem("myHoldings", JSON.stringify(holdings));
  fetchData();
}

function deleteStock(symbol) {
  if (confirm(`確定刪除 ${symbol}？`)) {
    holdings = holdings.filter(h => h.symbol !== symbol);
    saveAndRefresh();
  }
}

// 採用穩定的抓取機制 (透過公共 API 轉接)
async function fetchData() {
  updateTime();
  if (holdings.length === 0) {
    renderAll();
    return;
  }

  const symbols = holdings.map(h => h.symbol);
  if (!symbols.includes("USDTWD=X")) symbols.push("USDTWD=X");

  const query = encodeURIComponent(symbols.join(","));
  const primaryApi = `https://api.allorigins.win/raw?url=${encodeURIComponent('https://query1.finance.yahoo.com/v7/finance/quote?symbols=' + query)}`;

  try {
    const res = await fetch(primaryApi);
    if (res.ok) {
      const data = await res.json();
      const results = data.quoteResponse?.result || [];
      
      results.forEach(q => {
        if (q.symbol === "USDTWD=X") {
          usdTwdRate = q.regularMarketPrice || usdTwdRate;
        } else {
          liveQuotes[q.symbol] = q.regularMarketPrice;
        }
      });
    }
  } catch (e) {
    console.warn("無法取得即時資料，將維持上一次成功連線的價格或成本價");
  }

  renderAll();
}

function renderAll() {
  const rateEl = document.getElementById("usdTwdRate");
  if (rateEl) rateEl.textContent = usdTwdRate.toFixed(3);

  let totalValueTwd = 0;
  let totalCostTwd = 0;
  let tickerHtml = "";

  const grid = document.getElementById("holdingsGrid");
  if (!grid) return;
  grid.innerHTML = "";

  if (holdings.length === 0) {
    grid.innerHTML = `<div style="color:var(--muted); grid-column: span 3;">目前沒有持股，請使用上方表單新增。</div>`;
  }

  holdings.forEach(item => {
    const hasLivePrice = liveQuotes[item.symbol] !== undefined;
    const price = hasLivePrice ? liveQuotes[item.symbol] : item.cost;
    const isUS = item.market === "US";
    const rate = isUS ? usdTwdRate : 1;

    const valTwd = price * item.qty * rate;
    const costTwd = item.cost * item.qty * rate;
    const pnlTwd = valTwd - costTwd;
    const pnlRate = item.cost > 0 ? ((price - item.cost) / item.cost) * 100 : 0;

    totalValueTwd += valTwd;
    totalCostTwd += costTwd;

    const isProfit = pnlTwd >= 0;
    const colorClass = isProfit ? "val-up" : "val-down";
    const sign = isProfit ? "+" : "";

    let priceDisplay = `$${price.toFixed(2)}`;
    if (!hasLivePrice) {
      priceDisplay = `<span style="color:#f59e0b;" title="使用成本估算">$${price.toFixed(2)}</span>`;
    }

    const card = document.createElement("div");
    card.className = "stock-card";
    card.innerHTML = `
      <div>
        <div class="stock-header">
          <span class="stock-symbol">${item.name} (${item.symbol})</span>
          <span class="badge">${item.market}</span>
        </div>
        <div class="stock-info">
          <div>現價: ${priceDisplay}</div>
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

  const totalPnl = totalValueTwd - totalCostTwd;
  const totalPnlRate = totalCostTwd > 0 ? (totalPnl / totalCostTwd) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";

  document.getElementById("totalMarketValue").textContent = `$${Math.round(totalValueTwd).toLocaleString()}`;
  document.getElementById("totalCost").textContent = `$${Math.round(totalCostTwd).toLocaleString()}`;
  
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

  document.getElementById("tickerTrack").innerHTML = tickerHtml ? (tickerHtml + tickerHtml) : '<span class="ticker-item">尚無持股資料</span>';

  if (totalValueTwd > 0) {
    recordHistory(totalValueTwd);
  } else {
    updateChart([], []);
  }
}

function recordHistory(value) {
  const timeStr = new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  
  if (historyData.length === 0 || historyData[historyData.length - 1].time !== timeStr) {
    historyData.push({ time: timeStr, val: Math.round(value) });
    if (historyData.length > 30) historyData.shift();
    localStorage.setItem("myAssetHistory", JSON.stringify(historyData));
  } else {
    historyData[historyData.length - 1].val = Math.round(value);
  }

  const labels = historyData.map(d => d.time);
  const values = historyData.map(d => d.val);
  updateChart(labels, values);
}

function updateTime() {
  const el = document.getElementById("currentTime");
  if (el) el.textContent = new Date().toLocaleTimeString('zh-TW');
}

function initChart() {
  const canvas = document.getElementById("trendChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (typeof Chart === 'undefined') return;

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "總市值 (TWD)",
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
        x: { grid: { color: "#1e293b" }, ticks: { color: "#64748b" } },
        y: { grid: { color: "#1e293b" }, ticks: { color: "#64748b" } }
      }
    }
  });
}

function updateChart(labels, data) {
  if (trendChart) {
    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = data;

    const pnlEl = document.getElementById("totalPnl");
    const isProfit = pnlEl ? pnlEl.classList.contains("val-up") : true;
    
    trendChart.data.datasets[0].borderColor = isProfit ? "#00e676" : "#ff4d4d";
    trendChart.data.datasets[0].backgroundColor = isProfit ? "rgba(0, 230, 118, 0.1)" : "rgba(255, 77, 77, 0.1)";

    trendChart.update();
  }
}