// 優先讀取網址參數 (例如 index.html?account=user1)，若無則讀 LocalStorage，最後預設 user1
const urlParams = new URLSearchParams(window.location.search);
let currentAccount = urlParams.get("account") || localStorage.getItem("currentAccount") || "user1";
let holdings = [];
let realizedList = [];
let usdTwdRate = 32.25; 
let liveQuotes = {};

let countdownSeconds = 60;
let timerInterval = null;

document.addEventListener("DOMContentLoaded", async () => {
  const accountInput = document.getElementById("accountInput");
  if (accountInput) accountInput.value = currentAccount;
  
  updateAccountTitle();

  // 1. 從 Worker 載入完整資料 (未實現持股 + 已實現紀錄)
  await loadDataFromRemote();

  // 2. 載入即時報價
  await fetchData();

  // 3. 啟動計時器
  startCountdown();

  // 4. 綁定表單提交
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

// 切換帳號
async function switchAccount() {
  const accountInput = document.getElementById("accountInput");
  const newAccount = accountInput.value.trim().toLowerCase();

  if (!newAccount) {
    alert("請輸入有效的帳號名稱");
    return;
  }

  currentAccount = newAccount;
  localStorage.setItem("currentAccount", currentAccount);
  updateAccountTitle();

  await loadDataFromRemote();
  await fetchData();
}
window.switchAccount = switchAccount;

function updateAccountTitle() {
  document.querySelectorAll(".accountTitle").forEach(el => el.textContent = currentAccount);
}

// 賣出股票邏輯
function sellStock(symbol) {
  const item = holdings.find(h => h.symbol === symbol);
  if (!item) return;

  const currentPrice = liveQuotes[symbol] || item.cost;
  const sellQtyStr = prompt(`【賣出 ${item.name || item.symbol}】\n目前持有股數：${item.qty}\n請輸入賣出股數：`, item.qty);
  if (sellQtyStr === null) return;

  const sellQty = parseFloat(sellQtyStr);
  if (isNaN(sellQty) || sellQty <= 0 || sellQty > item.qty) {
    alert("請輸入有效的賣出股數！");
    return;
  }

  const sellPriceStr = prompt(`請輸入賣出單價 (原幣)：`, currentPrice);
  if (sellPriceStr === null) return;

  const sellPrice = parseFloat(sellPriceStr);
  if (isNaN(sellPrice) || sellPrice <= 0) {
    alert("請輸入有效的賣出單價！");
    return;
  }

  const rate = item.market === "US" ? usdTwdRate : 1;
  const pnlOrig = (sellPrice - item.cost) * sellQty;
  const pnlTwd = pnlOrig * rate;

  // 1. 新增到已實現紀錄
  realizedList.unshift({
    id: Date.now(),
    date: new Date().toLocaleDateString('zh-TW'),
    symbol: item.symbol,
    name: item.name,
    market: item.market,
    cost: item.cost,
    sellPrice: sellPrice,
    qty: sellQty,
    pnlOrig: pnlOrig,
    pnlTwd: pnlTwd
  });

  // 2. 扣減或刪除未實現持股
  if (sellQty === item.qty) {
    holdings = holdings.filter(h => h.symbol !== symbol);
  } else {
    item.qty -= sellQty;
  }

  saveAndSync();
}
window.sellStock = sellStock;

// 刪除已實現紀錄
function deleteRealized(id) {
  if (confirm("確定刪除這筆賣出紀錄？")) {
    realizedList = realizedList.filter(r => r.id !== id);
    saveAndSync();
  }
}
window.deleteRealized = deleteRealized;

// 從 Worker 載入資料
async function loadDataFromRemote() {
  try {
    const res = await fetch(`${WORKER_URL}?action=get_holdings&account=${encodeURIComponent(currentAccount)}`);
    if (res.ok) {
      const data = await res.json();
      holdings = data.holdings || [];
      realizedList = data.realized || [];
      renderAll();
    }
  } catch (e) {
    console.error("讀取雲端失敗:", e);
    renderAll();
  }
}

// 動態計時器
function startCountdown() {
  if (timerInterval) clearInterval(timerInterval);
  countdownSeconds = 60;

  timerInterval = setInterval(async () => {
    countdownSeconds--;
    const countdownEl = document.getElementById("countdownText");
    if (countdownEl) countdownEl.textContent = `${countdownSeconds} 秒後更新`;

    if (countdownSeconds <= 0) {
      countdownSeconds = 60;
      await loadDataFromRemote();
      await fetchData();
    }
  }, 1000);
}

// 手動刷新
async function manualRefresh() {
  const refreshBtn = document.querySelector(".btn-refresh") || (typeof event !== 'undefined' ? event?.currentTarget : null);
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ 更新中...";
  }

  countdownSeconds = 60;
  await loadDataFromRemote();
  await fetchData();

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "立即更新";
  }
}
window.manualRefresh = manualRefresh;

// 同步資料至 Cloudflare Worker
async function saveAndSync() {
  renderAll();

  const payload = {
    holdings: holdings,
    realized: realizedList
  };

  try {
    await fetch(`${WORKER_URL}?action=sync_holdings&account=${encodeURIComponent(currentAccount)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    console.error("同步失敗:", e);
  }
  
  await fetchData();
}

function deleteStock(symbol) {
  if (confirm(`確定刪除未實現持股 ${symbol}？`)) {
    holdings = holdings.filter(h => h.symbol !== symbol);
    saveAndSync();
  }
}
window.deleteStock = deleteStock;

// 抓取即時價格
async function fetchData() {
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

// 畫面渲染邏輯
function renderAll() {
  const rateEl = document.getElementById("usdTwdRate");
  if (rateEl) rateEl.textContent = usdTwdRate.toFixed(3);

  let totalValueTwd = 0;
  let totalCostTwd = 0;
  let tickerHtml = "";

  // 1. 渲染未實現持股卡片
  const grid = document.getElementById("holdingsGrid");
  if (grid) {
    grid.innerHTML = "";

    if (holdings.length === 0) {
      grid.innerHTML = '<div style="color: var(--muted); grid-column: span 3;">尚無未實現持股。</div>';
    }

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
              <span>未實現損益:</span>
              <span>${sign}$${Math.round(pnlTwd).toLocaleString()} (${sign}${pnlRate.toFixed(2)}%)</span>
            </div>
          </div>
        </div>
        <div class="card-actions">
          <button class="btn-sell" onclick="sellStock('${item.symbol}')">💰 賣出</button>
          <button class="btn-del" onclick="deleteStock('${item.symbol}')">刪除</button>
        </div>
      `;
      grid.appendChild(card);

      tickerHtml += `<span class="ticker-item ${colorClass}">${item.symbol} $${price.toFixed(2)} (${sign}$${Math.round(pnlTwd).toLocaleString()})</span>`;
    });
  }

  // 2. 計算未實現總損益
  const totalPnl = totalValueTwd - totalCostTwd;
  const totalPnlRate = totalCostTwd > 0 ? (totalPnl / totalCostTwd) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";

  document.getElementById("totalMarketValue").textContent = `$${Math.round(totalValueTwd).toLocaleString()}`;
  
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

  // 3. 計算與渲染已實現紀錄
  let sumRealizedTwd = 0;
  const realizedTbody = document.getElementById("realizedTableBody");
  if (realizedTbody) {
    realizedTbody.innerHTML = "";

    if (realizedList.length === 0) {
      realizedTbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--muted); padding: 20px;">尚無已實現賣出紀錄</td></tr>';
    } else {
      realizedList.forEach(r => {
        sumRealizedTwd += r.pnlTwd;
        const isProfit = r.pnlTwd >= 0;
        const colorClass = isProfit ? "val-up" : "val-down";
        const sign = isProfit ? "+" : "";

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${r.date}</td>
          <td><strong>${r.name || r.symbol}</strong> (${r.symbol})</td>
          <td><span class="badge">${r.market}</span></td>
          <td>$${r.cost.toFixed(2)}</td>
          <td>$${r.sellPrice.toFixed(2)}</td>
          <td>${r.qty}</td>
          <td class="${colorClass}">${sign}$${r.pnlOrig.toFixed(2)}</td>
          <td class="${colorClass}"><strong>${sign}$${Math.round(r.pnlTwd).toLocaleString()}</strong></td>
          <td><button style="background:none; border:none; color:var(--red); cursor:pointer; font-size:12px;" onclick="deleteRealized(${r.id})">刪除</button></td>
        `;
        realizedTbody.appendChild(tr);
      });
    }
  }

  const realizedPnlEl = document.getElementById("totalRealizedPnl");
  if (realizedPnlEl) {
    const realSign = sumRealizedTwd >= 0 ? "+" : "";
    realizedPnlEl.textContent = `${realSign}$${Math.round(sumRealizedTwd).toLocaleString()}`;
    realizedPnlEl.className = `stat-value ${sumRealizedTwd >= 0 ? 'val-up' : 'val-down'}`;
  }

  // 跑馬燈
  const tickerTrackEl = document.getElementById("tickerTrack");
  if (tickerTrackEl) {
    tickerTrackEl.innerHTML = tickerHtml ? (tickerHtml + tickerHtml) : '<span class="ticker-item">尚無持股資料</span>';
  }
}
