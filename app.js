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
let liveStale = {};  // true = 目前顯示的不是即時成交價 (昨收 / 延遲價)
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
  if (h.market === "FUT") return `${+qty.toFixed(4)} 口`;
  if (h.market === "US") return `${+qty.toFixed(4)} 股`;
  const lots = Math.floor(qty / 1000 + 1e-9);
  const odd = Math.round((qty - lots * 1000) * 10000) / 10000;
  const parts = [];
  if (lots > 0) parts.push(`${lots} 張`);
  if (odd > 0 || lots === 0) parts.push(`${odd} 股`);
  return parts.join(" ");
}

// ---------- 期貨小工具 ----------
// mult = 每點價值 (台指期是 NT$/點；個股期貨是每口股數，價格就是股價)
const FUT_PRODUCTS = {
  TXF:  { name: "大台",       cid: "TXF", mult: 200 },
  MXF:  { name: "小台",       cid: "MXF", mult: 50 },
  TMF:  { name: "微台",       cid: "TMF", mult: 10 },
  STK:  { name: "個股期貨",   custom: true, mult: 2000 },
  STKM: { name: "小型個股期貨", custom: true, mult: 100 },
};
const isFut = h => h.market === "FUT";
const dirOf = h => (h.side === "S" ? -1 : 1);                 // 多 +1 / 空 -1
const multOf = h => (isFut(h) ? (Number(h.mult) || 1) : 1);
const qsymOf = h => h.qsym || h.symbol; // 空單的 symbol 帶 #S，查報價要用原本的代號
const marketLabel = h =>
  isFut(h) ? `期貨·${h.side === "S" ? "空" : "多"}` : h.side === "S" ? `${h.market}·空` : h.market;

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
      const extra = h.market === "FUT"
        ? { fkey: h.fkey, side: h.side === "S" ? "S" : "L", mult: Number(h.mult) || 1 }
        : h.side === "S"
        ? { side: "S", qsym: h.qsym || String(h.symbol).split("#")[0] }
        : {};
      map.set(h.symbol, { symbol: h.symbol, name: h.name || "", market: h.market || "US", lots, ...extra });
    }
  });
  return [...map.values()].filter(h => h.lots.length > 0);
}

// ---------- 記住今天最後一次的成交價 (存在瀏覽器，換頁/重開也還在) ----------
function todayStr() {
  return new Date().toLocaleDateString("zh-TW");
}

function loadSavedQuotes() {
  try {
    const saved = JSON.parse(localStorage.getItem("savedQuotes") || "{}");
    const today = todayStr();
    for (const [sym, v] of Object.entries(saved)) {
      if (v && v.d === today && v.p > 0) {
        liveQuotes[sym] = v.p;
        if (v.prev > 0) livePrev[sym] = v.prev;
        liveStale[sym] = false;
      }
    }
  } catch (e) {}
}

function saveQuote(symbol, price, prev) {
  try {
    const saved = JSON.parse(localStorage.getItem("savedQuotes") || "{}");
    saved[symbol] = { p: price, prev: prev || null, d: todayStr() };
    localStorage.setItem("savedQuotes", JSON.stringify(saved));
  } catch (e) {}
}

// ---------- 啟動 ----------
document.addEventListener("DOMContentLoaded", async () => {
  const accountInput = document.getElementById("accountInput");
  if (accountInput) accountInput.value = currentAccount;

  updateAccountTitle();
  loadSavedQuotes();
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
  const symEl = document.getElementById("symbol");
  const costEl = document.getElementById("cost");
  const futBox = document.getElementById("futFields");
  const sideEl = document.getElementById("stockSide");
  if (!lotsEl || !oddEl) return;

  const fut = market === "FUT";
  const short = !fut && sideEl?.value === "S";
  if (sideEl) sideEl.style.display = fut ? "none" : "";
  if (futBox) futBox.style.display = fut ? "contents" : "none";
  if (symEl) {
    symEl.style.display = fut ? "none" : "";
    symEl.required = !fut; // 隱藏的必填欄位會讓瀏覽器擋住送出
  }

  lotsEl.style.display = (market === "US" || fut) ? "none" : "";
  if (market === "US" || fut) lotsEl.value = "";
  oddEl.style.display = fut ? "none" : "";
  if (fut) oddEl.value = "";
  oddEl.placeholder = market === "US" ? "持有股數" : "零股股數 (可留空)";
  if (costEl) costEl.placeholder = fut ? "進場價 (點數；個股期貨填股價)" : short ? "放空價 (每股)" : "買入成本 (每股)";

  if (fut) {
    updateFutFields();
    setHint("📈 期貨損益 = 價差 × 每點價值 × 口數 (做空反向)，未計手續費與期交稅。");
  } else if (short) {
    setHint("🔻 放空損益 = (放空價 − 現價) × 股數；未計借券費/融券利息、保證金、手續費與證交稅。");
  } else if (typeof DEFAULT_HINT !== "undefined") {
    setHint(DEFAULT_HINT);
  }
}

// 選商品時：帶入每點價值、個股期貨才顯示代號欄、月份預設當月
function updateFutFields() {
  const p = FUT_PRODUCTS[document.getElementById("futProduct")?.value];
  if (!p) return;
  const cidEl = document.getElementById("futCid");
  if (cidEl) cidEl.style.display = p.custom ? "" : "none";
  const multEl = document.getElementById("futMult");
  if (multEl) multEl.value = p.mult;
  const monthEl = document.getElementById("futMonth");
  if (monthEl && !monthEl.value) {
    const d = new Date();
    monthEl.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

function addLot(symbol, name, market, cost, qty, extra = {}) {
  const lot = { id: uid(), cost, qty, date: new Date().toLocaleDateString("zh-TW") };
  const existing = holdings.find(h => h.symbol === symbol);
  if (existing) {
    existing.lots.push(lot); // 同一檔股票：加一批，成本自動合併計算
    if (!existing.name && name) existing.name = name;
  } else {
    holdings.push({ symbol, name, market, lots: [lot], ...extra });
  }
}

// ---------- 新增期貨部位 ----------
async function submitFuture(form) {
  const prodKey = document.getElementById("futProduct").value;
  const p = FUT_PRODUCTS[prodKey];
  const cid = p.custom
    ? document.getElementById("futCid").value.trim().toUpperCase()
    : p.cid;
  const ym = document.getElementById("futMonth").value.replace(/\D/g, ""); // 2026-11 -> 202611
  const side = document.getElementById("futSide").value === "S" ? "S" : "L";
  const mult = parseFloat(document.getElementById("futMult").value);
  const qty = parseFloat(document.getElementById("futQty").value);
  const cost = parseFloat(document.getElementById("cost").value);

  if (!cid) { alert("請輸入個股期貨代號 (例如 CDF)"); return; }
  if (!/^\d{6}$/.test(ym)) { alert("請選擇到期月份"); return; }
  if (isNaN(cost) || cost <= 0) { alert("請輸入正確的進場價"); return; }
  if (!(qty > 0)) { alert("請輸入口數"); return; }
  if (!(mult > 0)) { alert("請輸入每點價值"); return; }

  const fkey = `${cid}:${ym}`;
  const symbol = `${fkey}:${side}`; // 同合約的多單、空單分開記
  const userName = document.getElementById("name").value.trim();
  const name = userName || `${p.custom ? cid : p.name} ${ym.slice(0, 4)}/${ym.slice(4)}`;

  addLot(symbol, name, "FUT", cost, qty, { fkey, side, mult });
  await saveAndSync();

  form.reset();
  autoFilledName = false;
  updateQtyInputs();
}

// ---------- 台股代號 → 名稱 自動帶入 ----------
// 這只是「輔助」：查不到、太慢、失敗都不會擋住任何操作，名稱隨時可以自己打
const DEFAULT_HINT = "💡 台股輸入代號後會自動帶出名稱；查不到時請自行輸入。";
let autoFilledName = false; // 名稱欄目前的內容是系統自動填的
let lookupSeq = 0;          // 用來丟棄過期的查詢結果
let lookupTimer = null;

function setHint(text) {
  const el = document.getElementById("lookupHint");
  if (el) el.textContent = text;
}

// 最多等 4 秒，逾時就當作查不到
async function lookupTwName(code) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${WORKER_URL}?action=lookup&q=${encodeURIComponent(code)}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const matches = Array.isArray(data.matches) ? data.matches : [];
    return matches.find(m =>
      (m.market === "TW" || m.market === "TWO") &&
      String(m.symbol).split(".")[0].toUpperCase() === code
    ) || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function autoFillName() {
  const symEl = document.getElementById("symbol");
  const nameEl = document.getElementById("name");
  const marketEl = document.getElementById("market");

  const code = symEl.value.trim().toUpperCase().replace(/\.(TWO|TW)$/, "");
  if (!/^\d{4,6}[A-Z]?$/.test(code)) return; // 不是台股代號格式 (例如美股)，不查

  // 使用者自己打了名稱，就不要覆蓋
  if (nameEl.value.trim() && !autoFilledName) return;

  const seq = ++lookupSeq;
  setHint("🔍 查詢名稱中... (查不到也可以自己輸入)");

  const hit = await lookupTwName(code);
  if (seq !== lookupSeq) return; // 這次查詢已過期 (使用者又改了代號 / 自己打了名稱 / 已送出)

  if (hit) {
    nameEl.value = hit.name;
    autoFilledName = true;
    marketEl.value = hit.market; // 順便自動選對上市 / 上櫃
    updateQtyInputs();
    setHint(`✅ 已自動帶入：${hit.name}（可自行修改）`);
  } else {
    if (autoFilledName) { nameEl.value = ""; autoFilledName = false; }
    setHint("⚠️ 查不到名稱，請自行輸入");
  }
}

function setupFormEvents() {
  const symEl = document.getElementById("symbol");
  const nameEl = document.getElementById("name");
  const marketEl = document.getElementById("market");
  const form = document.getElementById("addForm");

  if (marketEl) marketEl.addEventListener("change", updateQtyInputs);
  const futProductEl = document.getElementById("futProduct");
  if (futProductEl) futProductEl.addEventListener("change", updateFutFields);
  const stockSideEl = document.getElementById("stockSide");
  if (stockSideEl) stockSideEl.addEventListener("change", updateQtyInputs);

  if (symEl) {
    // 打字停下 0.6 秒後自動查；離開欄位時立刻查
    symEl.addEventListener("input", () => {
      clearTimeout(lookupTimer);
      lookupTimer = setTimeout(autoFillName, 600);
    });
    symEl.addEventListener("change", () => {
      clearTimeout(lookupTimer);
      autoFillName();
    });
  }

  if (nameEl) {
    // 使用者自己動手改名稱 → 取消進行中的查詢，之後不再覆蓋
    nameEl.addEventListener("input", () => {
      autoFilledName = false;
      lookupSeq++;
    });
  }

  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // 送出時：取消所有進行中的查詢，絕不等待查詢結果
    clearTimeout(lookupTimer);
    lookupSeq++;

    if (marketEl.value === "FUT") {
      await submitFuture(form);
      return;
    }

    const symbolRaw = symEl.value.trim();
    const market = marketEl.value;
    const cost = parseFloat(document.getElementById("cost").value);
    const lotCount = parseFloat(document.getElementById("qtyLots").value) || 0;
    const oddCount = parseFloat(document.getElementById("qtyOdd").value) || 0;
    const qty = market === "US" ? oddCount : lotCount * 1000 + oddCount;

    if (!symbolRaw) {
      alert("請輸入股票代號");
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

    // 名稱沒填 (查不到又沒自己打) 就先用代號當名稱，不擋住使用者
    const name = nameEl.value.trim() || symbolRaw.toUpperCase();
    const symbol = buildSymbol(symbolRaw, market);

    const isShort = document.getElementById("stockSide")?.value === "S";
    // 空單另立一筆 (symbol 加 #S)，不會跟同檔的多單混在一起
    addLot(isShort ? `${symbol}#S` : symbol, name, market, cost, qty, isShort ? { side: "S", qsym: symbol } : {});
    await saveAndSync();

    form.reset();
    autoFilledName = false;
    setHint(DEFAULT_HINT);
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
  liveStale = {};
  expandedSet = new Set();
  loadSavedQuotes();
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
  const fut = isFut(item);
  const short = !fut && dirOf(item) < 0;
  const verb = fut ? "平倉" : short ? "回補" : "賣出";
  const unitHint = fut ? "（口）" : item.market === "US" ? "" : "（1 張 = 1000 股）";

  const sellQtyStr = prompt(
    fut
      ? `【平倉 ${item.name || item.symbol}】\n目前持有：${fmtQty(item, totalQty)}（${item.side === "S" ? "空單" : "多單"}）\n請輸入平倉口數${unitHint}：`
      : `【${verb} ${item.name || qsymOf(item)}】\n目前${short ? "空單" : "持有"}：${fmtQty(item, totalQty)}（共 ${totalQty} 股）\n請輸入${verb}股數${unitHint}：`,
    totalQty
  );
  if (sellQtyStr === null) return;

  const sellQty = parseFloat(sellQtyStr);
  if (isNaN(sellQty) || sellQty <= 0 || sellQty > totalQty + 1e-9) {
    alert("請輸入有效的賣出股數！");
    return;
  }

  const sellPriceStr = prompt(fut ? `請輸入平倉價格 (點)：` : short ? `請輸入回補價格 (原幣)：` : `請輸入賣出單價 (原幣)：`, currentPrice);
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
    pnlOrig += dirOf(item) * (sellPrice - lot.cost) * take * multOf(item);
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
    side: item.side || "",
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
function applyQuote(symbol, price, prev, stale) {
  if (!(price > 0)) return; // 價格為 0 或無效時，保留上次的價格
  // 這次沒有真正的成交價 (只有昨收 / 參考價)，而且之前已有價格 → 保留舊的
  if (stale && liveQuotes[symbol] !== undefined) return;
  liveQuotes[symbol] = price;
  liveStale[symbol] = !!stale;
  if (prev) livePrev[symbol] = prev;
  else delete livePrev[symbol];
  if (!stale) saveQuote(symbol, price, prev);
}

async function fetchData() {
  if (holdings.length === 0) {
    renderAll();
    return;
  }

  const symbols = [...new Set(holdings.filter(h => !isFut(h)).map(qsymOf))];
  if (!symbols.includes("USDTWD=X")) symbols.push("USDTWD=X");
  const futKeys = [...new Set(holdings.filter(isFut).map(h => h.fkey))];

  // 股票 + 匯率
  const stockTask = (async () => {
    try {
      const res = await fetch(
        `${WORKER_URL}?symbols=${encodeURIComponent(symbols.join(","))}&_=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = await res.json();
      (data.quoteResponse?.result || []).forEach(q => {
        if (q.symbol === "USDTWD=X") {
          usdTwdRate = q.regularMarketPrice || usdTwdRate;
        } else {
          // 同一檔的多單、空單共用同一個報價
          holdings.filter(h => !isFut(h) && qsymOf(h) === q.symbol)
            .forEach(h => applyQuote(h.symbol, q.regularMarketPrice, q.regularMarketPreviousClose, q.stale || q.estimated));
        }
      });
    } catch (e) {
      console.error("抓取股價失敗:", e);
    }
  })();

  // 期貨 (一個合約的多單、空單共用同一個報價)
  const futTask = (async () => {
    if (!futKeys.length) return;
    try {
      const res = await fetch(
        `${WORKER_URL}?futures=${encodeURIComponent(futKeys.join(","))}&_=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = await res.json();
      (data.futuresResult || []).forEach(q => {
        holdings.filter(h => isFut(h) && h.fkey === q.key)
          .forEach(h => applyQuote(h.symbol, q.price, q.prev, q.stale));
      });
    } catch (e) {
      console.error("抓取期貨報價失敗:", e);
    }
  })();

  await Promise.all([stockTask, futTask]);

  const missing = holdings.filter(h => liveQuotes[h.symbol] === undefined).map(h => h.symbol);
  if (missing.length) console.warn("抓不到報價:", missing);

  renderAll();
}

// ---------- 畫面渲染 ----------
function renderAll() {
  const rateEl = document.getElementById("usdTwdRate");
  if (rateEl) rateEl.textContent = usdTwdRate.toFixed(3);

  let totalValueTwd = 0;
  let totalCostTwd = 0;
  let totalFutPnl = 0;
  let totalStockPnl = 0;
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
      const fut = isFut(item);
      const mult = multOf(item);
      const dir = dirOf(item);
      const short = !fut && dir < 0;

      // 期貨：valTwd 是名目價值；損益依多空方向計算
      const valTwd = price * qty * rate * mult;
      const costTwd = posCostTotal(item) * rate * mult;
      const pnlTwd = dir * (valTwd - costTwd);
      const pnlRate = avg > 0 ? dir * ((price - avg) / avg) * 100 : 0;
      const pnlExtra = fut
        ? `${pnlTwd >= 0 ? "+" : ""}${(dir * (price - avg)).toFixed(1)} 點`
        : `${pnlTwd >= 0 ? "+" : ""}${pnlRate.toFixed(2)}%`;

      if (fut) {
        totalFutPnl += pnlTwd; // 期貨不計入「總市值」，只計損益
      } else {
        if (!short) totalValueTwd += valTwd; // 空單不計入總市值，只計損益
        totalStockPnl += pnlTwd;
        totalCostTwd += costTwd;             // 損益率的分母 = 多空部位的總成本
      }

      const isProfit = pnlTwd >= 0;
      const colorClass = isProfit ? "val-up" : "val-down";
      const sign = isProfit ? "+" : "";

      // 今日漲跌幅
      const prev = livePrev[item.symbol];
      let chgHtml = '<span class="chg chg-na">今日 --</span>';
      let chgText = "";
      if (hasQuote && prev > 0) {
        const chg = ((price - prev) / prev) * 100; // 今日漲跌看商品本身，不受多空影響
        const chgClass = chg >= 0 ? "val-up" : "val-down";
        chgText = ` ${fmtPct(chg)}`;
        chgHtml = `<span class="chg ${chgClass}">今日 ${fmtPct(chg)}</span>`;
      }

      // 分批成本
      const expanded = expandedSet.has(item.symbol);
      const lotsRows = item.lots.map(l => {
        const lotPnl = dir * (price - l.cost) * l.qty * rate * mult;
        const lotUp = lotPnl >= 0;
        return `
          <div class="lot-row">
            <span class="lot-date">${esc(l.date || "—")}</span>
            <span>${short ? "放空" : "成本"} $${l.cost.toFixed(2)}</span>
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
            <span class="stock-symbol">${esc(item.name || item.symbol)}${fut ? "" : ` (${esc(qsymOf(item))})`}</span>
            <span class="badge">${esc(marketLabel(item))}</span>
          </div>
          <div class="stock-info">
            <div class="span2">現價: $${price.toFixed(2)} ${chgHtml}${liveStale[item.symbol] ? ' <span class="chg chg-na">(非即時)</span>' : ""}</div>
            <div>${fut ? "均價" : short ? "均放空價" : "均成本"}: $${avg.toFixed(2)}</div>
            <div>${fut ? (item.side === "S" ? "空單" : "多單") : short ? "空單" : "持有"}: ${fmtQty(item, qty)}</div>
            <div class="span2">${fut ? "名目價值" : short ? "空單市值" : "市值"}(NT): $${Math.round(valTwd).toLocaleString()}${fut ? ` <span class="chg chg-na">每點 ${mult}</span>` : ""}</div>
            <div class="pnl-box ${colorClass}">
              <span>未實現損益:</span>
              <span>${sign}$${Math.round(pnlTwd).toLocaleString()} (${pnlExtra})</span>
            </div>
          </div>
          <div class="lots-toggle" onclick="toggleLots('${esc(item.symbol)}')">
            ${expanded ? "▼" : "▶"} 分批成本 (${item.lots.length} 筆)
          </div>
          ${expanded ? `<div class="lots-list">${lotsRows}</div>` : ""}
        </div>
        <div class="card-actions">
          <button class="btn-sell" onclick="sellStock('${esc(item.symbol)}')">${fut ? "💰 平倉" : short ? "🔄 回補" : "💰 賣出"}</button>
          <button class="btn-del" onclick="deleteStock('${esc(item.symbol)}')">刪除</button>
        </div>
      `;
      grid.appendChild(card);

      tickerHtml += `<span class="ticker-item ${colorClass}">${esc(fut ? item.name : qsymOf(item))}${short ? "(空)" : ""} $${price.toFixed(2)}${chgText} (${sign}$${Math.round(pnlTwd).toLocaleString()})</span>`;
    });
  }

  // 2. 總統計
  const totalPnl = totalStockPnl; // 股票多單 + 空單的未實現損益
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

  const futPnlEl = document.getElementById("futuresPnl");
  if (futPnlEl) {
    const fs = totalFutPnl >= 0 ? "+" : "";
    futPnlEl.textContent = `${fs}$${Math.round(totalFutPnl).toLocaleString()}`;
    futPnlEl.className = `stat-value ${totalFutPnl >= 0 ? "val-up" : "val-down"}`;
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
          <td><strong>${esc(r.name || r.symbol)}</strong>${r.market === "FUT" ? "" : ` (${esc(String(r.symbol).split("#")[0])})`}</td>
          <td><span class="badge">${esc(marketLabel(r))}</span></td>
          <td>$${r.cost.toFixed(2)}</td>
          <td>$${r.sellPrice.toFixed(2)}</td>
          <td>${r.qty}${r.market === "FUT" ? " 口" : ""}</td>
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
