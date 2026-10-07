// ============================================================
// Cloudflare Worker 網址
// ============================================================
//
// ⚠️ 這裡一定要改成你自己的 Worker 網址
//
// 例如：
// const WORKER_URL = "https://stock-proxy.honggu0212.workers.dev";
//
// ============================================================

const WORKER_URL = "請放你的Cloudflare Worker網址";


// ============================================================
// 帳號設定
// ============================================================

const urlParams =
  new URLSearchParams(
    window.location.search
  );

// 優先順序：
// 1. 網址 ?account=xxx
// 2. 本機 LocalStorage
// 3. 預設 user1

let currentAccount =
  urlParams.get("account") ||
  localStorage.getItem("currentAccount") ||
  "user1";


// ============================================================
// 全域資料
// ============================================================

let holdings = [];

let realizedList = [];

let usdTwdRate = 32.25;

let liveQuotes = {};

let countdownSeconds = 60;

let timerInterval = null;


// ============================================================
// 頁面載入
// ============================================================

document.addEventListener(
  "DOMContentLoaded",
  async () => {

    console.log(
      "===================================="
    );

    console.log(
      "📊 投資組合系統啟動"
    );

    console.log(
      "目前帳號:",
      currentAccount
    );

    console.log(
      "Worker:",
      WORKER_URL
    );

    console.log(
      "===================================="
    );


    // ------------------------------------------
    // 顯示帳號
    // ------------------------------------------

    const accountInput =
      document.getElementById(
        "accountInput"
      );

    if (accountInput) {
      accountInput.value =
        currentAccount;
    }

    updateAccountTitle();


    // ------------------------------------------
    // 1. 從 Cloudflare KV 載入資料
    // ------------------------------------------

    await loadDataFromRemote();


    // ------------------------------------------
    // 2. 載入股票價格
    // ------------------------------------------

    await fetchData();


    // ------------------------------------------
    // 3. 啟動自動更新
    // ------------------------------------------

    startCountdown();


    // ------------------------------------------
    // 4. 綁定新增股票表單
    // ------------------------------------------

    const form =
      document.getElementById(
        "addForm"
      );

    if (form) {

      form.addEventListener(
        "submit",
        async (e) => {

          e.preventDefault();


          let symbol =
            document
              .getElementById("symbol")
              .value
              .trim()
              .toUpperCase();

          const name =
            document
              .getElementById("name")
              .value
              .trim();

          const market =
            document
              .getElementById("market")
              .value;

          const cost =
            parseFloat(
              document
                .getElementById("cost")
                .value
            );

          const qty =
            parseFloat(
              document
                .getElementById("qty")
                .value
            );


          // ------------------------------------------
          // 檢查資料
          // ------------------------------------------

          if (
            !symbol ||
            !name ||
            isNaN(cost) ||
            isNaN(qty) ||
            cost <= 0 ||
            qty <= 0
          ) {

            alert(
              "請填寫正確的股票代號、名稱、成本與股數"
            );

            return;
          }


          // ------------------------------------------
          // 自動補台股市場
          // ------------------------------------------

          if (
            market === "TW" &&
            !symbol.includes(".")
          ) {

            symbol += ".TW";
          }

          if (
            market === "TWO" &&
            !symbol.includes(".")
          ) {

            symbol += ".TWO";
          }


          // ------------------------------------------
          // 新增或修改
          // ------------------------------------------

          const idx =
            holdings.findIndex(
              h =>
                h.symbol === symbol
            );


          if (idx >= 0) {

            holdings[idx] = {
              symbol,
              name,
              market,
              cost,
              qty
            };

          } else {

            holdings.push({
              symbol,
              name,
              market,
              cost,
              qty
            });
          }


          // ------------------------------------------
          // 儲存到 Cloudflare
          // ------------------------------------------

          const success =
            await saveAndSync();


          if (success) {

            form.reset();

            alert(
              "✅ 持股已儲存到雲端"
            );
          }

        }
      );
    }
  }
);


// ============================================================
// 切換帳號
// ============================================================

async function switchAccount() {

  const accountInput =
    document.getElementById(
      "accountInput"
    );

  if (!accountInput) {
    return;
  }


  const newAccount =
    accountInput.value
      .trim()
      .toLowerCase();


  if (!newAccount) {

    alert(
      "請輸入有效的帳號名稱"
    );

    return;
  }


  // 更新目前帳號

  currentAccount =
    newAccount;


  // 存在本機

  localStorage.setItem(
    "currentAccount",
    currentAccount
  );


  // 更新網址
  // 例如：
  // ?account=user1

  const newUrl =
    `${window.location.pathname}?account=${encodeURIComponent(currentAccount)}`;

  window.history.replaceState(
    {},
    "",
    newUrl
  );


  updateAccountTitle();


  // 清除目前畫面的舊資料
  // 避免切換帳號時短暫看到上一個帳號

  holdings = [];

  realizedList = [];

  liveQuotes = {};


  renderAll();


  // 從 Cloudflare 載入新帳號

  await loadDataFromRemote();

  await fetchData();
}


window.switchAccount =
  switchAccount;


// ============================================================
// 更新帳號名稱
// ============================================================

function updateAccountTitle() {

  document
    .querySelectorAll(
      ".accountTitle"
    )
    .forEach(
      el =>
        el.textContent =
          currentAccount
    );
}


// ============================================================
// 賣出股票
// ============================================================

async function sellStock(symbol) {

  const item =
    holdings.find(
      h =>
        h.symbol === symbol
    );

  if (!item) {
    return;
  }


  const currentPrice =
    liveQuotes[symbol] ||
    item.cost;


  const sellQtyStr =
    prompt(
      `【賣出 ${item.name || item.symbol}】\n目前持有股數：${item.qty}\n請輸入賣出股數：`,
      item.qty
    );


  if (sellQtyStr === null) {
    return;
  }


  const sellQty =
    parseFloat(
      sellQtyStr
    );


  if (
    isNaN(sellQty) ||
    sellQty <= 0 ||
    sellQty > item.qty
  ) {

    alert(
      "請輸入有效的賣出股數！"
    );

    return;
  }


  const sellPriceStr =
    prompt(
      "請輸入賣出單價 (原幣)：",
      currentPrice
    );


  if (sellPriceStr === null) {
    return;
  }


  const sellPrice =
    parseFloat(
      sellPriceStr
    );


  if (
    isNaN(sellPrice) ||
    sellPrice <= 0
  ) {

    alert(
      "請輸入有效的賣出單價！"
    );

    return;
  }


  // ------------------------------------------
  // 計算損益
  // ------------------------------------------

  const rate =
    item.market === "US"
      ? usdTwdRate
      : 1;

  const pnlOrig =
    (sellPrice - item.cost) *
    sellQty;

  const pnlTwd =
    pnlOrig * rate;


  // ------------------------------------------
  // 新增已實現紀錄
  // ------------------------------------------

  realizedList.unshift({

    id: Date.now(),

    date:
      new Date()
        .toLocaleDateString(
          "zh-TW"
        ),

    symbol:
      item.symbol,

    name:
      item.name,

    market:
      item.market,

    cost:
      item.cost,

    sellPrice:
      sellPrice,

    qty:
      sellQty,

    pnlOrig:
      pnlOrig,

    pnlTwd:
      pnlTwd
  });


  // ------------------------------------------
  // 扣掉持股
  // ------------------------------------------

  if (
    sellQty === item.qty
  ) {

    holdings =
      holdings.filter(
        h =>
          h.symbol !== symbol
      );

  } else {

    item.qty -= sellQty;
  }


  // ------------------------------------------
  // 儲存雲端
  // ------------------------------------------

  const success =
    await saveAndSync();


  if (success) {

    alert(
      "✅ 賣出紀錄已同步到雲端"
    );
  }
}


window.sellStock =
  sellStock;


// ============================================================
// 刪除已實現紀錄
// ============================================================

async function deleteRealized(id) {

  if (
    !confirm(
      "確定刪除這筆賣出紀錄？"
    )
  ) {
    return;
  }


  realizedList =
    realizedList.filter(
      r =>
        r.id !== id
    );


  await saveAndSync();
}


window.deleteRealized =
  deleteRealized;


// ============================================================
// 從 Cloudflare Worker 載入資料
// ============================================================

async function loadDataFromRemote() {

  try {

    if (
      !WORKER_URL ||
      WORKER_URL.includes(
        "請放你的"
      )
    ) {

      throw new Error(
        "尚未設定 WORKER_URL"
      );
    }


    const requestUrl =
      `${WORKER_URL}?action=get_holdings&account=${encodeURIComponent(currentAccount)}`;


    console.log(
      "☁️ 正在讀取雲端資料:",
      requestUrl
    );


    const res =
      await fetch(
        requestUrl,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!res.ok) {

      const errorText =
        await res.text();

      throw new Error(
        `Worker HTTP ${res.status}: ${errorText}`
      );
    }


    const data =
      await res.json();


    // ------------------------------------------
    // 取得持股
    // ------------------------------------------

    holdings =
      Array.isArray(
        data.holdings
      )
        ? data.holdings
        : [];


    // ------------------------------------------
    // 取得已實現紀錄
    // ------------------------------------------

    realizedList =
      Array.isArray(
        data.realized
      )
        ? data.realized
        : [];


    console.log(
      "✅ 雲端資料載入成功"
    );

    console.log(
      "帳號:",
      currentAccount
    );

    console.log(
      "持股:",
      holdings
    );

    console.log(
      "已實現:",
      realizedList
    );


    renderAll();

    return true;

  } catch (e) {

    console.error(
      "❌ 讀取雲端失敗:",
      e
    );


    // 發生錯誤時不要把舊資料亂存回去
    holdings = [];

    realizedList = [];


    renderAll();


    return false;
  }
}


// ============================================================
// 儲存資料到 Cloudflare Worker
// ============================================================

async function saveAndSync() {

  renderAll();


  const payload = {

    holdings:
      holdings,

    realized:
      realizedList
  };


  try {

    if (
      !WORKER_URL ||
      WORKER_URL.includes(
        "請放你的"
      )
    ) {

      throw new Error(
        "尚未設定 WORKER_URL"
      );
    }


    const requestUrl =
      `${WORKER_URL}?action=sync_holdings&account=${encodeURIComponent(currentAccount)}`;


    console.log(
      "☁️ 正在同步資料:",
      requestUrl
    );


    console.log(
      "要儲存的資料:",
      payload
    );


    const res =
      await fetch(
        requestUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify(
              payload
            )
        }
      );


    if (!res.ok) {

      const errorText =
        await res.text();

      throw new Error(
        `Worker HTTP ${res.status}: ${errorText}`
      );
    }


    const result =
      await res.json();


    console.log(
      "✅ 雲端同步成功:",
      result
    );


    return true;

  } catch (e) {

    console.error(
      "❌ 雲端同步失敗:",
      e
    );


    alert(
      "❌ 雲端同步失敗！\n\n" +
      "請檢查 Cloudflare Worker 網址與網路連線。\n\n" +
      e.message
    );


    return false;
  }
}


// ============================================================
// 自動倒數更新
// ============================================================

function startCountdown() {

  if (timerInterval) {

    clearInterval(
      timerInterval
    );
  }


  countdownSeconds = 60;


  timerInterval =
    setInterval(
      async () => {

        countdownSeconds--;


        const countdownEl =
          document.getElementById(
            "countdownText"
          );


        if (countdownEl) {

          countdownEl.textContent =
            `${countdownSeconds} 秒後更新`;
        }


        if (
          countdownSeconds <= 0
        ) {

          countdownSeconds = 60;


          // 重新從雲端抓一次
          await loadDataFromRemote();


          // 更新股價
          await fetchData();
        }

      },
      1000
    );
}


// ============================================================
// 手動刷新
// ============================================================

async function manualRefresh() {

  const refreshBtn =
    document.querySelector(
      ".btn-refresh"
    );


  if (refreshBtn) {

    refreshBtn.disabled =
      true;

    refreshBtn.textContent =
      "⏳ 更新中...";
  }


  countdownSeconds = 60;


  // 先重新取得雲端資料

  await loadDataFromRemote();


  // 再抓股票價格

  await fetchData();


  if (refreshBtn) {

    refreshBtn.disabled =
      false;

    refreshBtn.textContent =
      "立即更新";
  }
}


window.manualRefresh =
  manualRefresh;


// ============================================================
// 刪除持股
// ============================================================

async function deleteStock(symbol) {

  if (
    !confirm(
      `確定刪除未實現持股 ${symbol}？`
    )
  ) {

    return;
  }


  holdings =
    holdings.filter(
      h =>
        h.symbol !== symbol
    );


  await saveAndSync();
}


window.deleteStock =
  deleteStock;


// ============================================================
// 抓取即時價格
// ============================================================

async function fetchData() {

  // 沒有持股
  if (
    holdings.length === 0
  ) {

    renderAll();

    return;
  }


  const symbols =
    holdings.map(
      h =>
        h.symbol
    );


  // 加入 USD/TWD

  if (
    !symbols.includes(
      "USDTWD=X"
    )
  ) {

    symbols.push(
      "USDTWD=X"
    );
  }


  try {

    const requestUrl =
      `${WORKER_URL}?symbols=${encodeURIComponent(symbols.join(","))}`;


    console.log(
      "📈 更新即時報價:",
      symbols
    );


    const res =
      await fetch(
        requestUrl,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!res.ok) {

      throw new Error(
        `Worker HTTP ${res.status}`
      );
    }


    const data =
      await res.json();


    const results =
      data
        .quoteResponse
        ?.result || [];


    results.forEach(
      q => {

        if (
          q.symbol ===
          "USDTWD=X"
        ) {

          usdTwdRate =
            q.regularMarketPrice ||
            usdTwdRate;

        } else {

          liveQuotes[
            q.symbol
          ] =
            q.regularMarketPrice;
        }

      }
    );


  } catch (e) {

    console.error(
      "❌ 抓取股價失敗:",
      e
    );
  }


  renderAll();
}


// ============================================================
// 畫面渲染
// ============================================================

function renderAll() {

  // ------------------------------------------
  // USD/TWD
  // ------------------------------------------

  const rateEl =
    document.getElementById(
      "usdTwdRate"
    );


  if (rateEl) {

    rateEl.textContent =
      usdTwdRate.toFixed(3);
  }


  // ------------------------------------------
  // 總市值
  // ------------------------------------------

  let totalValueTwd = 0;

  let totalCostTwd = 0;

  let tickerHtml = "";


  // ------------------------------------------
  // 持股卡片
  // ------------------------------------------

  const grid =
    document.getElementById(
      "holdingsGrid"
    );


  if (grid) {

    grid.innerHTML = "";


    if (
      holdings.length === 0
    ) {

      grid.innerHTML =
        '<div style="color: var(--muted); grid-column: span 3;">尚無未實現持股。</div>';
    }


    holdings.forEach(
      item => {

        const price =
          liveQuotes[
            item.symbol
          ] !== undefined
            ? liveQuotes[
                item.symbol
              ]
            : item.cost;


        const rate =
          item.market === "US"
            ? usdTwdRate
            : 1;


        const valTwd =
          price *
          item.qty *
          rate;


        const costTwd =
          item.cost *
          item.qty *
          rate;


        const pnlTwd =
          valTwd -
          costTwd;


        const pnlRate =
          item.cost > 0
            ? (
                (
                  price -
                  item.cost
                ) /
                item.cost
              ) *
              100
            : 0;


        totalValueTwd +=
          valTwd;


        totalCostTwd +=
          costTwd;


        const isProfit =
          pnlTwd >= 0;


        const colorClass =
          isProfit
            ? "val-up"
            : "val-down";


        const sign =
          isProfit
            ? "+"
            : "";


        const card =
          document.createElement(
            "div"
          );


        card.className =
          "stock-card";


        card.innerHTML = `

          <div>

            <div class="stock-header">

              <span class="stock-symbol">
                ${escapeHtml(
                  item.name ||
                  item.symbol
                )}
                (${escapeHtml(
                  item.symbol
                )})
              </span>

              <span class="badge">
                ${escapeHtml(
                  item.market
                )}
              </span>

            </div>


            <div class="stock-info">

              <div>
                現價:
                $${Number(price).toFixed(2)}
              </div>

              <div>
                成本:
                $${Number(item.cost).toFixed(2)}
              </div>

              <div>
                股數:
                ${Number(item.qty)}
              </div>

              <div>
                市值(NT):
                $${Math.round(
                  valTwd
                ).toLocaleString()}
              </div>


              <div
                class="pnl-box ${colorClass}"
              >

                <span>
                  未實現損益:
                </span>

                <span>
                  ${sign}$
                  ${Math.round(
                    pnlTwd
                  ).toLocaleString()}
                  (${sign}${pnlRate.toFixed(2)}%)
                </span>

              </div>

            </div>

          </div>


          <div class="card-actions">

            <button
              class="btn-sell"
              onclick="sellStock('${escapeHtml(item.symbol)}')"
            >
              💰 賣出
            </button>

            <button
              class="btn-del"
              onclick="deleteStock('${escapeHtml(item.symbol)}')"
            >
              刪除
            </button>

          </div>

        `;


        grid.appendChild(
          card
        );


        tickerHtml +=
          `<span class="ticker-item ${colorClass}">
            ${escapeHtml(item.symbol)}
            $${Number(price).toFixed(2)}
            (${sign}$${Math.round(
              pnlTwd
            ).toLocaleString()})
          </span>`;
      }
    );
  }


  // ------------------------------------------
  // 未實現總損益
  // ------------------------------------------

  const totalPnl =
    totalValueTwd -
    totalCostTwd;


  const totalPnlRate =
    totalCostTwd > 0
      ? (
          totalPnl /
          totalCostTwd
        ) *
        100
      : 0;


  const pnlSign =
    totalPnl >= 0
      ? "+"
      : "";


  const totalMarketValue =
    document.getElementById(
      "totalMarketValue"
    );


  if (totalMarketValue) {

    totalMarketValue.textContent =
      `$${Math.round(
        totalValueTwd
      ).toLocaleString()}`;
  }


  const pnlEl =
    document.getElementById(
      "totalPnl"
    );


  if (pnlEl) {

    pnlEl.textContent =
      `${pnlSign}$${Math.round(
        totalPnl
      ).toLocaleString()}`;


    pnlEl.className =
      `stat-value ${
        totalPnl >= 0
          ? "val-up"
          : "val-down"
      }`;
  }


  const pnlRateEl =
    document.getElementById(
      "totalPnlRate"
    );


  if (pnlRateEl) {

    pnlRateEl.textContent =
      `${pnlSign}${totalPnlRate.toFixed(2)}%`;


    pnlRateEl.className =
      `stat-sub ${
        totalPnl >= 0
          ? "val-up"
          : "val-down"
      }`;
  }


  // ------------------------------------------
  // 已實現損益
  // ------------------------------------------

  let sumRealizedTwd = 0;


  const realizedTbody =
    document.getElementById(
      "realizedTableBody"
    );


  if (realizedTbody) {

    realizedTbody.innerHTML =
      "";


    if (
      realizedList.length === 0
    ) {

      realizedTbody.innerHTML =
        '<tr><td colspan="9" style="text-align: center; color: var(--muted); padding: 20px;">尚無已實現賣出紀錄</td></tr>';

    } else {

      realizedList.forEach(
        r => {

          sumRealizedTwd +=
            Number(r.pnlTwd) || 0;


          const isProfit =
            r.pnlTwd >= 0;


          const colorClass =
            isProfit
              ? "val-up"
              : "val-down";


          const sign =
            isProfit
              ? "+"
              : "";


          const tr =
            document.createElement(
              "tr"
            );


          tr.innerHTML = `

            <td>
              ${escapeHtml(
                r.date
              )}
            </td>

            <td>
              <strong>
                ${escapeHtml(
                  r.name ||
                  r.symbol
                )}
              </strong>
              (${escapeHtml(
                r.symbol
              )})
            </td>

            <td>
              <span class="badge">
                ${escapeHtml(
                  r.market
                )}
              </span>
            </td>

            <td>
              $${Number(
                r.cost
              ).toFixed(2)}
            </td>

            <td>
              $${Number(
                r.sellPrice
              ).toFixed(2)}
            </td>

            <td>
              ${Number(
                r.qty
              )}
            </td>

            <td class="${colorClass}">
              ${sign}$
              ${Number(
                r.pnlOrig
              ).toFixed(2)}
            </td>

            <td class="${colorClass}">
              <strong>
                ${sign}$
                ${Math.round(
                  r.pnlTwd
                ).toLocaleString()}
              </strong>
            </td>

            <td>
              <button
                style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;"
                onclick="deleteRealized(${Number(r.id)})"
              >
                刪除
              </button>
            </td>

          `;


          realizedTbody.appendChild(
            tr
          );
        }
      );
    }
  }


  // ------------------------------------------
  // 已實現總損益
  // ------------------------------------------

  const realizedPnlEl =
    document.getElementById(
      "totalRealizedPnl"
    );


  if (realizedPnlEl) {

    const realSign =
      sumRealizedTwd >= 0
        ? "+"
        : "";


    realizedPnlEl.textContent =
      `${realSign}$${Math.round(
        sumRealizedTwd
      ).toLocaleString()}`;


    realizedPnlEl.className =
      `stat-value ${
        sumRealizedTwd >= 0
          ? "val-up"
          : "val-down"
      }`;
  }


  // ------------------------------------------
  // 跑馬燈
  // ------------------------------------------

  const tickerTrackEl =
    document.getElementById(
      "tickerTrack"
    );


  if (tickerTrackEl) {

    tickerTrackEl.innerHTML =
      tickerHtml
        ? tickerHtml +
          tickerHtml
        : '<span class="ticker-item">尚無持股資料</span>';
  }
}


// ============================================================
// HTML 安全處理
// ============================================================

function escapeHtml(value) {

  return String(value ?? "")
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}
