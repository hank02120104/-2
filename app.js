const WORKER_URL = "https://stock-proxy.honggu0212.workers.dev";

const urlParams = new URLSearchParams(window.location.search);
let currentAccount =
  urlParams.get("account") ||
  localStorage.getItem("currentAccount") ||
  "user1";

let holdings = [];
let realizedList = [];
let usdTwdRate = 32.25;
let liveQuotes = {};

let countdownSeconds = 60;
let timerInterval = null;
let isRefreshing = false;

document.addEventListener("DOMContentLoaded", async () => {
  const accountInput = document.getElementById("accountInput");

  if (accountInput) {
    accountInput.value = currentAccount;
  }

  updateAccountTitle();

  await loadDataFromRemote();
  await fetchData();
  startCountdown();

  const form = document.getElementById("addForm");

  if (form) {
    form.addEventListener("submit", async e => {
      e.preventDefault();

      let symbol = document
        .getElementById("symbol")
        .value
        .trim()
        .toUpperCase();

      const name = document
        .getElementById("name")
        .value
        .trim();

      const market = document.getElementById("market").value;
      const cost = parseFloat(
        document.getElementById("cost").value
      );
      const qty = parseFloat(
        document.getElementById("qty").value
      );

      if (
        !symbol ||
        !name ||
        !Number.isFinite(cost) ||
        !Number.isFinite(qty) ||
        cost <= 0 ||
        qty <= 0
      ) {
        alert("請填寫正確的股票代號、名稱、成本與股數");
        return;
      }

      if (market === "TW" && !symbol.includes(".")) {
        symbol += ".TW";
      }

      if (market === "TWO" && !symbol.includes(".")) {
        symbol += ".TWO";
      }

      const idx = holdings.findIndex(
        h => h.symbol === symbol
      );

      if (idx >= 0) {
        holdings[idx] = {
          ...holdings[idx],
          symbol,
          name,
          market,
          cost,
          qty,
        };
      } else {
        holdings.push({
          symbol,
          name,
          market,
          cost,
          qty,
        });
      }

      const saved = await saveAndSync();

      if (saved) {
        form.reset();
        await fetchData();
      }
    });
  }
});

async function switchAccount() {
  const accountInput = document.getElementById("accountInput");

  const newAccount = accountInput.value
    .trim()
    .toLowerCase();

  if (!newAccount) {
    alert("請輸入有效的帳號名稱");
    return;
  }

  currentAccount = newAccount;

  localStorage.setItem("currentAccount", currentAccount);

  updateAccountTitle();

  holdings = [];
  realizedList = [];
  liveQuotes = {};

  renderAll();

  const loaded = await loadDataFromRemote();

  if (loaded) {
    await fetchData();
  }
}

window.switchAccount = switchAccount;

function updateAccountTitle() {
  document.querySelectorAll(".accountTitle").forEach(el => {
    el.textContent = currentAccount;
  });
}

function sellStock(symbol) {
  const item = holdings.find(h => h.symbol === symbol);

  if (!item) return;

  const currentPrice =
    liveQuotes[symbol] !== undefined
      ? liveQuotes[symbol]
      : item.cost;

  const sellQtyStr = prompt(
    `【賣出 ${item.name || item.symbol}】\n目前持有股數：${item.qty}\n請輸入賣出股數：`,
    item.qty
  );

  if (sellQtyStr === null) return;

  const sellQty = parseFloat(sellQtyStr);

  if (
    !Number.isFinite(sellQty) ||
    sellQty <= 0 ||
    sellQty > item.qty
  ) {
    alert("請輸入有效的賣出股數！");
    return;
  }

  const sellPriceStr = prompt(
    "請輸入賣出單價（原幣）：",
    currentPrice
  );

  if (sellPriceStr === null) return;

  const sellPrice = parseFloat(sellPriceStr);

  if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
    alert("請輸入有效的賣出單價！");
    return;
  }

  const rate = item.market === "US" ? usdTwdRate : 1;
  const pnlOrig = (sellPrice - item.cost) * sellQty;
  const pnlTwd = pnlOrig * rate;

  realizedList.unshift({
    id: Date.now(),
    date: new Date().toLocaleDateString("zh-TW"),
    symbol: item.symbol,
    name: item.name,
    market: item.market,
    cost: item.cost,
    sellPrice,
    qty: sellQty,
    pnlOrig,
    pnlTwd,
  });

  if (sellQty === item.qty) {
    holdings = holdings.filter(h => h.symbol !== symbol);
  } else {
    item.qty -= sellQty;
  }

  saveAndSync();
}

window.sellStock = sellStock;

function deleteRealized(id) {
  if (!confirm("確定刪除這筆賣出紀錄？")) {
    return;
  }

  realizedList = realizedList.filter(
    r => String(r.id) !== String(id)
  );

  saveAndSync();
}

window.deleteRealized = deleteRealized;

async function loadDataFromRemote() {
  try {
    const response = await fetch(
      `${WORKER_URL}/?action=get_holdings&account=${encodeURIComponent(currentAccount)}&_=${Date.now()}`,
      {
        method: "GET",
        cache: "no-store",
      }
    );

    if (!response.ok) {
      throw new Error(
        `Cloudflare Worker HTTP ${response.status}`
      );
    }

    const data = await response.json();

    holdings = Array.isArray(data.holdings)
      ? data.holdings
      : [];

    realizedList = Array.isArray(data.realized)
      ? data.realized
      : [];

    console.log("雲端資料載入成功", {
      account: currentAccount,
      holdings,
      realized: realizedList,
    });

    renderAll();

    return true;
  } catch (e) {
    console.error("讀取雲端失敗:", e);

    alert(
      `無法讀取雲端資料，請檢查網路連線與 Cloudflare Worker。\n錯誤：${e.message}`
    );

    renderAll();

    return false;
  }
}

function startCountdown() {
  if (timerInterval) {
    clearInterval(timerInterval);
  }

  countdownSeconds = 60;

  timerInterval = setInterval(async () => {
    countdownSeconds--;

    const countdownEl =
      document.getElementById("countdownText");

    if (countdownEl) {
      countdownEl.textContent =
        `${countdownSeconds} 秒後更新`;
    }

    if (countdownSeconds <= 0) {
      countdownSeconds = 60;
      await manualRefresh();
    }
  }, 1000);
}

async function manualRefresh() {
  if (isRefreshing) return;

  isRefreshing = true;

  const refreshBtn = document.querySelector(".btn-refresh");

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "更新中...";
  }

  countdownSeconds = 60;

  const countdownEl =
    document.getElementById("countdownText");

  if (countdownEl) {
    countdownEl.textContent = "正在更新...";
  }

  try {
    const loaded = await loadDataFromRemote();

    if (loaded) {
      await fetchData();
    }
  } finally {
    isRefreshing = false;

    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = "立即更新";
    }

    if (countdownEl) {
      countdownEl.textContent = "60 秒後更新";
    }
  }
}

window.manualRefresh = manualRefresh;

async function saveAndSync() {
  renderAll();

  const payload = {
    holdings,
    realized: realizedList,
  };

  try {
    const response = await fetch(
      `${WORKER_URL}/?action=sync_holdings&account=${encodeURIComponent(currentAccount)}`,
      {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const responseText = await response.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Worker 回傳非 JSON：${responseText.slice(0, 200)}`
      );
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}：${result.error || responseText}`
