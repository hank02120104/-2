// 已自動填入你的 Worker URL
const WORKER_URL = "https://stock-proxy.honggu0212.workers.dev";

const urlParams = new URLSearchParams(window.location.search);
let currentAccount = urlParams.get("account") || localStorage.getItem("currentAccount") || "user1";

// 持股資料結構：
// holdings = [{ symbol, name, market, lots: [{ id, cost, qty, date }] }]
let holdings = [];
let realizedList = [];
let usdTwdRate = 32.25;
let liveQuotes = {}; // 最新價
let livePrev = {};   // 前一日收盤價 (算今日漲跌幅用)
let expandedSet = new Set(); // 目前展開「分批成本」的股票

let countdownSeconds = 60;
let timerInterval = null;

// 若上次同步失敗，先重試同步，避免被雲端舊資料覆蓋
let pendingSync = false;

// ---------- 小工具 ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function codeOf(s) {
  return String(s || "").replace(/\.(TWO|TW)$/i, "").toUpperCase();
}

function posQty(h) {
  return h.lots.reduce((s, l) => s + l.qty, 0);
}

function posCostTotal(h) {
  return h.lots.reduce((s, l) => s + l.cost * l.qty, 0);
}

function avgCost(h) {
  const q = posQty(h);
  return q > 0 ? posCostTotal(h) / q : 0;
}

// 台股顯示成「X 張 Y 股」，美股顯示「X 股」
function fmtQty(h, qty) {
  if (h.market === "US") return `${+qty.toFixed(4)} 股`;
  const lots = Math.floor(qty / 1000 + 1e-9);
  const odd = Math.round((qty - lots * 1000) * 10000) / 10000;
  const parts = [];
  if (lots > 0) parts.push(`${lots} 張`);
  if (odd > 0 || lots === 0) parts.push(`${odd} 股`);
  return parts.join(" ");
}

function fmtPct(v) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

// 把舊格式 {symbol,name,market,cost,qty} 轉成新格式，並合併重複代號
function normalizeHoldings(list) {
  const map = new Map();
  (Array.isArray(list) ? list : []).forEach(h => {
    if (!h || !h.symbol) return;

    let lots;
    if (Array.isArray(h.lots)) {
      lots = h.lots
        .filter(l => l && Number(l.qty) > 0)
        .map(l => ({ id: l.id || uid(), cost: Number(l.cost), qty: Number(l.qty), date: l.date || "" }));
    } else {
      lots = Number(h.qty) > 0
        ? [{ id: uid(), cost: Number(h.cost), qty: Number(h.qty), date: "" }]
        : [];
    }

    if (map.has(h.symbol)) {
      map.get(h.symbol).lots.push(...lots);
    } else {
      map.set(h.symbol, { symbol: h.symbol, name: h.name || "", market: h.market || "US", lots });
    }
  });
  return [...map.values()].filter(h => h.lots.length > 0);
}

// ---------- 啟動 ----------
document.addEventListener("DOMContentLoaded", async () => {
  const accountInput = document.getElementById("accountInput");
  if (accountInput) accountInput.value = currentAccount;

  updateAccountTitle();
  updateQtyInputs();
  setupFormEvents();

  // 1. 載入雲端資料
  await loadDataFromRemote();

  // 2. 載入即時報價
  await fetchData();

  // 3. 啟動計時器
  startCountdown();
});

// ---------- 表單：代號 / 名稱自動帶入 ----------
function updateQtyInputs() {
  const market = document.getElementById("market")?.value;
  const lotsEl = document.getElementById("qtyLots");
  const oddEl = document.getElementById("qtyOdd");
  if (!lotsEl || !oddEl) return;

  if (market === "US") {
    lotsEl.style.display = "none";
    lotsEl.value = "";
    oddEl.placeholder = "持有股數";
  } else {
    lotsEl.style.display = "";
    oddEl.placeholder = "零股股數 (可留空)";
  }
}
window.updateQtyInputs = updateQtyInputs;

// 依市場補上 .TW / .TWO 後綴
function buildSymbol(symbol, market) {
  let s = symbol.toUpperCase();
  if (market === "TW" && !s.includes(".")) s += ".TW";
  if (market === "TWO" && !s.includes(".")) s += ".TWO";
  return s;
}

function addLot(symbol, name, market, cost, qty) {
  const lot = { id: uid(), cost, qty, date: new Date().toLocaleDateString("zh-TW") };
  const existing = holdings.find(h => h.symbol === symbol);
  if (existing) {
    existing.lots.push(lot); // 同一檔股票：加一批，成本自動合併計算
    if (!existing.name && name) existing.name = name;
  } else {
    holdings.push({ symbol, name, market, lots: [lot] });
  }
}

function setupFormEvents() {
  const symEl = document.getElementById("symbol");
  const nameEl = document.getElementById("name");
  const marketEl = document.getElementById("market");
  const form = document.getElementById("addForm");

  if (marketEl) marketEl.addEventListener("change", updateQtyInputs);
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const symbolRaw = symEl.value.trim();
    const name = nameEl.value.trim();
    const market = marketEl.value;
    const cost = parseFloat(document.getElementById("cost").value);
    const lotCount = parseFloat(document.getElementById("qtyLots").value) || 0;
    const oddCount = parseFloat(document.getElementById("qtyOdd").value) || 0;
    const qty = market === "US" ? oddCount : lotCount * 1000 + oddCount;

    if (!symbolRaw || !name) {
      alert("請輸入股票代號與名稱");
      return;
    }
    if (isNaN(cost) || cost <= 0) {
      alert("請輸入正確的買入成本");
      return;
    }
    if (!(qty > 0)) {
      alert(market === "US" ? "請輸入持有股數" : "請輸入張數或零股股數");
      return;
    }

    const symbol = buildSymbol(symbolRaw, market);
    addLot(symbol, name, market, cost, qty);
    await saveAndSync();

    form.reset();
    updateQtyInputs();
  });
}

// ---------- 帳號切換 ----------
async function switchAccount() {
  const accountInput = document.getElementById("accountInput");
  const newAccount = accountInput.value.trim().toLowerCase();

  if (!newAccount) {
    alert("請輸入有效的帳號名稱");
    return;
  }

  currentAccount = newAccount;
  pendingSync = false;
  liveQuotes = {};
  livePrev = {};
  expandedSet = new Set();
  localStorage.setItem("currentAccount", currentAccount);
  updateAccountTitle();

  await loadDataFromRemote();
  await fetchData();
}
window.switchAccount = switchAccount;

function updateAccountTitle() {
  document.querySelectorAll(".accountTitle").forEach(el => el.textContent = currentAccount);
}

// ---------- 摺疊 / 分批成本 ----------
function toggleLots(symbol) {
  if (expandedSet.has(symbol)) expandedSet.delete(symbol);
  else expandedSet.add(symbol);
  renderAll();
}
window.toggleLots = toggleLots;

function deleteLot(symbol, lotId) {
  const item = holdings.find(h => h.symbol === symbol);
  if (!item) return;
  if (!confirm("確定刪除這一筆買入紀錄？")) return;

  item.lots = item.lots.filter(l => l.id !== lotId);
  if (item.lots.length === 0) {
    holdings = holdings.filter(h => h.symbol !== symbol);
  }
  saveAndSync();
}
window.deleteLot = deleteLot;

// ---------- 賣出 (先進先出：先賣最早買進的那批) ----------
function sellStock(symbol) {
  const item = holdings.find(h => h.symbol === symbol);
  if (!item) return;

  const totalQty = posQty(item);
  const currentPrice = liveQuotes[symbol] || avgCost(item);
  const unitHint = item.market === "US" ? "" : "（1 張 = 1000 股）";

  const sellQtyStr = prompt(
    `【賣出 ${item.name || item.symbol}】\n目前持有：${fmtQty(item, totalQty)}（共 ${totalQty} 股）\n請輸入賣出股數${unitHint}：`,
    totalQty
  );
  if (sellQtyStr === null) return;

  const sellQty = parseFloat(sellQtyStr);
  if (isNaN(sellQty) || sellQty <= 0 || sellQty > totalQty + 1e-9) {
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

  // 先進先出，逐批扣除
  let remain = sellQty;
  let costSum = 0;
  let pnlOrig = 0;
  const newLots = [];

  for (const lot of item.lots) {
    if (remain <= 1e-9) {
      newLots.push(lot);
      continue;
    }
    const take = Math.min(lot.qty, remain);
    pnlOrig += (sellPrice - lot.cost) * take;
    costSum += lot.cost * take;
    remain -= take;
    if (lot.qty - take > 1e-9) newLots.push({ ...lot, qty: lot.qty - take });
  }

  const rate = item.market === "US" ? usdTwdRate : 1;
  const pnlTwd = pnlOrig * rate;

  realizedList.unshift({
    id: Date.now(),
    date: new Date().toLocaleDateString("zh-TW"),
    symbol: item.symbol,
    name: item.name,
    market: item.market,
    cost: costSum / sellQty, // 被賣出部分的加權平均成本
    sellPrice: sellPrice,
    qty: sellQty,
    pnlOrig: pnlOrig,
    pnlTwd: pnlTwd
  });

  item.lots = newLots;
  if (item.lots.length === 0) {
    holdings = holdings.filter(h => h.symbol !== symbol);
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

// ---------- 雲端資料 ----------
async function loadDataFromRemote() {
  try {
    const res = await fetch(`${WORKER_URL}?action=get_holdings&account=${encodeURIComponent(currentAccount)}&_=${Date.now()}`, { cache: "no-store" });

    if (!res.ok) {
      throw new Error(`Cloudflare Worker HTTP ${res.status}`);
    }

    const data = await res.json();
    const rawHoldings = Array.isArray(data.holdings) ? data.holdings : [];
    const needMigrate = rawHoldings.some(h => !Array.isArray(h.lots));

    holdings = normalizeHoldings(rawHoldings);
    realizedList = Array.isArray(data.realized) ? data.realized : [];

    console.log("☁️ 雲端資料載入成功:", { account: currentAccount, holdings, realized: realizedList });
    renderAll();

    // 舊格式資料：自動轉成新格式並存回雲端，讓每批紀錄的 id 固定
    if (needMigrate && holdings.length > 0) saveAndSync(true);
  } catch (e) {
    console.error("❌ 讀取雲端失敗:", e);
    alert(`無法讀取雲端資料，請檢查網路連線與 Cloudflare Worker。\n錯誤: ${e.message}`);
    renderAll();
  }
}

// 重新整理全部資料 (同步優先 → 讀雲端 → 抓報價)
async function refreshAll() {
  if (pendingSync) {
    await saveAndSync(true);
    return;
  }
  await loadDataFromRemote();
  await fetchData();
}

// 動態倒數計時器
function startCountdown() {
  if (timerInterval) clearInterval(timerInterval);
  countdownSeconds = 60;

  timerInterval = setInterval(async () => {
    countdownSeconds--;
    const countdownEl = document.getElementById("countdownText");
    if (countdownEl) countdownEl.textContent = `${countdownSeconds} 秒後更新`;

    if (countdownSeconds <= 0) {
      countdownSeconds = 60;
      await refreshAll();
    }
  }, 1000);
}

// 手動刷新
async function manualRefresh() {
  const refreshBtn = document.querySelector(".btn-refresh");
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "⏳ 更新中...";
  }

  countdownSeconds = 60;
  await refreshAll();

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = "立即更新";
  }
}
window.manualRefresh = manualRefresh;

// 同步資料至 Cloudflare Worker
async function saveAndSync(silent = false) {
  renderAll();

  const payload = {
    holdings: holdings,
    realized: realizedList
  };

  try {
    const res = await fetch(`${WORKER_URL}?action=sync_holdings&account=${encodeURIComponent(currentAccount)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }

    const result = await res.json();
    pendingSync = false;
    console.log("☁️ 雲端同步成功:", result);
  } catch (e) {
    pendingSync = true;
    console.error("❌ 同步到 Cloudflare 失敗:", e);
    if (!silent) {
      alert(`⚠️ 雲端同步失敗！系統會在下次更新時自動重試。\n錯誤: ${e.message}`);
    }
    return;
  }

  await fetchData();
}

function deleteStock(symbol) {
  if (confirm(`確定刪除未實現持股 ${symbol}？（所有批次都會一起刪除）`)) {
    holdings = holdings.filter(h => h.symbol !== symbol);
    saveAndSync();
  }
}
window.deleteStock = deleteStock;

// ---------- 抓取即時價格 ----------
async function fetchData() {
  if (holdings.length === 0) {
    renderAll();
    return;
  }

  const symbols = holdings.map(h => h.symbol);
  if (!symbols.includes("USDTWD=X")) symbols.push("USDTWD=X");

  try {
    const res = await fetch(
      `${WORKER_URL}?symbols=${encodeURIComponent(symbols.join(","))}&_=${Date.now()}`,
      { cache: "no-store" }
    );
    if (res.ok) {
      const data = await res.json();
      const results = data.quoteResponse?.result || [];
      results.forEach(q => {
        if (q.symbol === "USDTWD=X") {
          usdTwdRate = q.regularMarketPrice || usdTwdRate;
        } else {
          if (!(q.regularMarketPrice > 0)) return; // 價格為 0 或無效時，保留上次的價格
          // 這次沒有真正的成交價 (只有昨收 / 買賣價推算)，而且之前已有價格 → 保留舊的
          // 只有「今天還沒抓過價格」時，才使用推算價或昨收
          if ((q.stale || q.estimated) && liveQuotes[q.symbol] !== undefined) return;
          liveQuotes[q.symbol] = q.regularMarketPrice;
          if (q.regularMarketPreviousClose) livePrev[q.symbol] = q.regularMarketPreviousClose;
          else delete livePrev[q.symbol];
        }
      });

      const missing = holdings.filter(h => liveQuotes[h.symbol] === undefined).map(h => h.symbol);
      if (missing.length) console.warn("抓不到報價:", missing);
    }
  } catch (e) {
    console.error("抓取股價失敗:", e);
  }

  renderAll();
}

// ---------- 畫面渲染 ----------
function renderAll() {
  const rateEl = document.getElementById("usdTwdRate");
  if (rateEl) rateEl.textContent = usdTwdRate.toFixed(3);

  let totalValueTwd = 0;
  let totalCostTwd = 0;
  let tickerHtml = "";

  // 1. 未實現持股
  const grid = document.getElementById("holdingsGrid");
  if (grid) {
    grid.innerHTML = "";

    if (holdings.length === 0) {
      grid.innerHTML = '<div style="color: var(--muted); grid-column: span 3;">尚無未實現持股。</div>';
    }

    holdings.forEach(item => {
      const qty = posQty(item);
      const avg = avgCost(item);
      const hasQuote = liveQuotes[item.symbol] !== undefined;
      const price = hasQuote ? liveQuotes[item.symbol] : avg;
      const rate = item.market === "US" ? usdTwdRate : 1;

      const valTwd = price * qty * rate;
      const costTwd = posCostTotal(item) * rate;
      const pnlTwd = valTwd - costTwd;
      const pnlRate = avg > 0 ? ((price - avg) / avg) * 100 : 0;

      totalValueTwd += valTwd;
      totalCostTwd += costTwd;

      const isProfit = pnlTwd >= 0;
      const colorClass = isProfit ? "val-up" : "val-down";
      const sign = isProfit ? "+" : "";

      // 今日漲跌幅
      const prev = livePrev[item.symbol];
      let chgHtml = '<span class="chg chg-na">今日 --</span>';
      let chgText = "";
      if (hasQuote && prev > 0) {
        const chg = ((price - prev) / prev) * 100;
        const chgClass = chg >= 0 ? "val-up" : "val-down";
        chgText = ` ${fmtPct(chg)}`;
        chgHtml = `<span class="chg ${chgClass}">今日 ${fmtPct(chg)}</span>`;
      }

      // 分批成本
      const expanded = expandedSet.has(item.symbol);
      const lotsRows = item.lots.map(l => {
        const lotPnl = (price - l.cost) * l.qty * rate;
        const lotUp = lotPnl >= 0;
        return `
          <div class="lot-row">
            <span class="lot-date">${esc(l.date || "—")}</span>
            <span>成本 $${l.cost.toFixed(2)}</span>
            <span>${fmtQty(item, l.qty)}</span>
            <span class="${lotUp ? "val-up" : "val-down"}">${lotUp ? "+" : ""}$${Math.round(lotPnl).toLocaleString()}</span>
            <button class="btn-lot-del" onclick="deleteLot('${esc(item.symbol)}','${esc(l.id)}')">✕</button>
          </div>`;
      }).join("");

      const card = document.createElement("div");
      card.className = "stock-card";
      card.innerHTML = `
        <div>
          <div class="stock-header">
            <span class="stock-symbol">${esc(item.name || item.symbol)} (${esc(item.symbol)})</span>
            <span class="badge">${esc(item.market)}</span>
          </div>
          <div class="stock-info">
            <div class="span2">現價: $${price.toFixed(2)} ${chgHtml}</div>
            <div>均成本: $${avg.toFixed(2)}</div>
            <div>持有: ${fmtQty(item, qty)}</div>
            <div class="span2">市值(NT): $${Math.round(valTwd).toLocaleString()}</div>
            <div class="pnl-box ${colorClass}">
              <span>未實現損益:</span>
              <span>${sign}$${Math.round(pnlTwd).toLocaleString()} (${sign}${pnlRate.toFixed(2)}%)</span>
            </div>
          </div>
          <div class="lots-toggle" onclick="toggleLots('${esc(item.symbol)}')">
            ${expanded ? "▼" : "▶"} 分批成本 (${item.lots.length} 筆)
          </div>
          ${expanded ? `<div class="lots-list">${lotsRows}</div>` : ""}
        </div>
        <div class="card-actions">
          <button class="btn-sell" onclick="sellStock('${esc(item.symbol)}')">💰 賣出</button>
          <button class="btn-del" onclick="deleteStock('${esc(item.symbol)}')">刪除</button>
        </div>
      `;
      grid.appendChild(card);

      tickerHtml += `<span class="ticker-item ${colorClass}">${esc(item.symbol)} $${price.toFixed(2)}${chgText} (${sign}$${Math.round(pnlTwd).toLocaleString()})</span>`;
    });
  }

  // 2. 總統計
  const totalPnl = totalValueTwd - totalCostTwd;
  const totalPnlRate = totalCostTwd > 0 ? (totalPnl / totalCostTwd) * 100 : 0;
  const pnlSign = totalPnl >= 0 ? "+" : "";

  document.getElementById("totalMarketValue").textContent = `$${Math.round(totalValueTwd).toLocaleString()}`;

  const pnlEl = document.getElementById("totalPnl");
  if (pnlEl) {
    pnlEl.textContent = `${pnlSign}$${Math.round(totalPnl).toLocaleString()}`;
    pnlEl.className = `stat-value ${totalPnl >= 0 ? "val-up" : "val-down"}`;
  }

  const pnlRateEl = document.getElementById("totalPnlRate");
  if (pnlRateEl) {
    pnlRateEl.textContent = `${pnlSign}${totalPnlRate.toFixed(2)}%`;
    pnlRateEl.className = `stat-sub ${totalPnl >= 0 ? "val-up" : "val-down"}`;
  }

  // 3. 已實現紀錄
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
          <td>${esc(r.date)}</td>
          <td><strong>${esc(r.name || r.symbol)}</strong> (${esc(r.symbol)})</td>
          <td><span class="badge">${esc(r.market)}</span></td>
          <td>$${r.cost.toFixed(2)}</td>
          <td>$${r.sellPrice.toFixed(2)}</td>
          <td>${r.qty}</td>
          <td class="${colorClass}">${sign}$${r.pnlOrig.toFixed(2)}</td>
          <td class="${colorClass}"><strong>${sign}$${Math.round(r.pnlTwd).toLocaleString()}</strong></td>
          <td><button style="background:none; border:none; color:var(--red); cursor:pointer; font-size:12px;" onclick="deleteRealized(${Number(r.id)})">刪除</button></td>
        `;
        realizedTbody.appendChild(tr);
      });
    }
  }

  const realizedPnlEl = document.getElementById("totalRealizedPnl");
  if (realizedPnlEl) {
    const realSign = sumRealizedTwd >= 0 ? "+" : "";
    realizedPnlEl.textContent = `${realSign}$${Math.round(sumRealizedTwd).toLocaleString()}`;
    realizedPnlEl.className = `stat-value ${sumRealizedTwd >= 0 ? "val-up" : "val-down"}`;
  }

  // 跑馬燈
  const tickerTrackEl = document.getElementById("tickerTrack");
  if (tickerTrackEl) {
    tickerTrackEl.innerHTML = tickerHtml ? (tickerHtml + tickerHtml) : '<span class="ticker-item">尚無持股資料</span>';
  }
}
