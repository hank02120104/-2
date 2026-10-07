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

    form.addEventListener("submit", async (e) => {

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


      if (
        !symbol ||
        !name ||
        !Number.isFinite(cost) ||
        !Number.isFinite(qty) ||
        cost <= 0 ||
        qty <= 0
      ) {

        alert(
          "請填寫正確的股票代號、名稱、成本與股數"
        );

        return;
      }


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


      const index =
        holdings.findIndex(
          h => h.symbol === symbol
        );


      const stock = {
        symbol,
        name,
        market,
        cost,
        qty
      };


      if (index >= 0) {

        holdings[index] = stock;

      } else {

        holdings.push(stock);

      }


      const success =
        await saveAndSync();


      if (success) {

        form.reset();

        alert(
          "持股已儲存到雲端"
        );

        await fetchData();

      }

    });

  }

});


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


  currentAccount =
    newAccount;


  localStorage.setItem(
    "currentAccount",
    currentAccount
  );


  const newUrl =
    `${window.location.pathname}?account=${encodeURIComponent(currentAccount)}`;


  window.history.replaceState(
    {},
    "",
    newUrl
  );


  updateAccountTitle();


  holdings = [];
  realizedList = [];
  liveQuotes = {};


  renderAll();


  await loadDataFromRemote();

  await fetchData();

}


window.switchAccount =
  switchAccount;



function updateAccountTitle() {

  document
    .querySelectorAll(".accountTitle")
    .forEach(el => {

      el.textContent =
        currentAccount;

    });

}



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
    liveQuotes[symbol] ??
    item.cost;


  const sellQtyString =
    prompt(
      `【賣出 ${item.name || item.symbol}】
目前持有股數：${item.qty}
請輸入賣出股數：`,
      item.qty
    );


  if (sellQtyString === null) {
    return;
  }


  const sellQty =
    parseFloat(
      sellQtyString
    );


  if (
    !Number.isFinite(sellQty) ||
    sellQty <= 0 ||
    sellQty > item.qty
  ) {

    alert(
      "請輸入有效的賣出股數！"
    );

    return;
  }


  const sellPriceString =
    prompt(
      "請輸入賣出單價 (原幣)：",
      currentPrice
    );


  if (sellPriceString === null) {
    return;
  }


  const sellPrice =
    parseFloat(
      sellPriceString
    );


  if (
    !Number.isFinite(sellPrice) ||
    sellPrice <= 0
  ) {

    alert(
      "請輸入有效的賣出單價！"
    );

    return;
  }


  const rate =
    item.market === "US"
      ? usdTwdRate
      : 1;


  const pnlOrig =
    (sellPrice - item.cost) *
    sellQty;


  const pnlTwd =
    pnlOrig * rate;


  realizedList.unshift({

    id: Date.now(),

    date:
      new Date().toLocaleDateString(
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


  const success =
    await saveAndSync();


  if (success) {

    alert(
      "賣出紀錄已同步到雲端"
    );

    await fetchData();

  }

}


window.sellStock =
  sellStock;



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



async function loadDataFromRemote() {

  try {

    const requestUrl =
      `${WORKER_URL}?action=get_holdings&account=${encodeURIComponent(currentAccount)}`;


    console.log(
      "讀取雲端資料:",
      requestUrl
    );


    const response =
      await fetch(
        requestUrl,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!response.ok) {

      const errorText =
        await response.text();

      throw new Error(
        `Worker HTTP ${response.status}: ${errorText}`
      );

    }


    const data =
      await response.json();


    holdings =
      Array.isArray(
        data.holdings
      )
        ? data.holdings
        : [];


    realizedList =
      Array.isArray(
        data.realized
      )
        ? data.realized
        : [];


    console.log(
      "雲端資料載入成功",
      data
    );


    renderAll();

    return true;


  } catch (error) {

    console.error(
      "讀取雲端失敗:",
      error
    );


    holdings = [];

    realizedList = [];


    renderAll();


    return false;

  }

}



async function saveAndSync() {

  renderAll();


  try {

    const requestUrl =
      `${WORKER_URL}?action=sync_holdings&account=${encodeURIComponent(currentAccount)}`;


    const response =
      await fetch(
        requestUrl,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body:
            JSON.stringify({
              holdings:
                holdings,

              realized:
                realizedList
            })
        }
      );


    if (!response.ok) {

      const errorText =
        await response.text();

      throw new Error(
        `Worker HTTP ${response.status}: ${errorText}`
      );

    }


    const result =
      await response.json();


    console.log(
      "雲端同步成功:",
      result
    );


    return true;


  } catch (error) {

    console.error(
      "雲端同步失敗:",
      error
    );


    alert(
      "雲端同步失敗！\n\n" +
      error.message
    );


    return false;

  }

}



function startCountdown() {

  if (timerInterval) {

    clearInterval(
      timerInterval
    );

  }


  countdownSeconds = 60;

  updateCountdown();


  timerInterval =
    setInterval(
      async () => {

        countdownSeconds--;

        updateCountdown();


        if (
          countdownSeconds <= 0
        ) {

          countdownSeconds = 60;

          await loadDataFromRemote();

          await fetchData();

        }

      },
      1000
    );

}



function updateCountdown() {

  const element =
    document.getElementById(
      "countdownText"
    );


  if (element) {

    element.textContent =
      `${countdownSeconds} 秒後更新`;

  }

}



async function manualRefresh() {

  const button =
    document.querySelector(
      ".btn-refresh"
    );


  if (button) {

    button.disabled =
      true;

    button.textContent =
      "更新中...";

  }


  countdownSeconds = 60;

  updateCountdown();


  await loadDataFromRemote();

  await fetchData();


  if (button) {

    button.disabled =
      false;

    button.textContent =
      "立即更新";

  }

}


window.manualRefresh =
  manualRefresh;



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

  await fetchData();

}


window.deleteStock =
  deleteStock;



async function fetchData() {

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
      "更新即時報價:",
      symbols
    );


    const response =
      await fetch(
        requestUrl,
        {
          method: "GET",
          cache: "no-store"
        }
      );


    if (!response.ok) {

      const errorText =
        await response.text();

      throw new Error(
        `Worker HTTP ${response.status}: ${errorText}`
      );

    }


    const data =
      await response.json();


    const results =
      data?.quoteResponse?.result ||
      [];


    results.forEach(
      quote => {

        if (
          quote.symbol ===
          "USDTWD=X"
        ) {

          if (
            Number.isFinite(
              Number(
                quote.regularMarketPrice
              )
            )
          ) {

            usdTwdRate =
              Number(
                quote.regularMarketPrice
              );

          }

        } else {

          if (
            Number.isFinite(
              Number(
                quote.regularMarketPrice
              )
            )
          ) {

            liveQuotes[
              quote.symbol
            ] =
              Number(
                quote.regularMarketPrice
              );

          }

        }

      }
    );


  } catch (error) {

    console.error(
      "抓取股價失敗:",
      error
    );

  }


  renderAll();

}



function renderAll() {

  const rateElement =
    document.getElementById(
      "usdTwdRate"
    );


  if (rateElement) {

    rateElement.textContent =
      Number(usdTwdRate).toFixed(3);

  }


  let totalValueTwd = 0;

  let totalCostTwd = 0;

  let tickerHtml = "";


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
        `<div class="empty-message">
          尚無未實現持股。
        </div>`;

    }


    holdings.forEach(
      item => {

        const price =
          liveQuotes[item.symbol] !== undefined
            ? liveQuotes[item.symbol]
            : Number(item.cost);


        const rate =
          item.market === "US"
            ? usdTwdRate
            : 1;


        const valueTwd =
          price *
          Number(item.qty) *
          rate;


        const costTwd =
          Number(item.cost) *
          Number(item.qty) *
          rate;


        const pnlTwd =
          valueTwd -
          costTwd;


        const pnlRate =
          Number(item.cost) > 0
            ? (
                (price -
                  Number(item.cost)) /
                Number(item.cost)
              ) *
              100
            : 0;


        totalValueTwd +=
          valueTwd;


        totalCostTwd +=
          costTwd;


        const profit =
          pnlTwd >= 0;


        const colorClass =
          profit
            ? "val-up"
            : "val-down";


        const sign =
          profit
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
                現價：
                $${Number(price).toFixed(2)}
              </div>

              <div>
                成本：
                $${Number(item.cost).toFixed(2)}
              </div>

              <div>
                股數：
                ${Number(item.qty)}
              </div>

              <div>
                市值(NT)：
                $${Math.round(
                  valueTwd
                ).toLocaleString()}
              </div>


              <div
                class="pnl-box ${colorClass}"
              >

                <span>
                  未實現損益：
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
              賣出
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


        tickerHtml += `

          <span class="ticker-item ${colorClass}">

            ${escapeHtml(
              item.symbol
            )}

            $${Number(price).toFixed(2)}

            (${sign}$${Math.round(
              pnlTwd
            ).toLocaleString()})

          </span>

        `;

      }
    );

  }


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


  const totalPnlSign =
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


  const pnlElement =
    document.getElementById(
      "totalPnl"
    );


  if (pnlElement) {

    pnlElement.textContent =
      `${totalPnlSign}$${Math.round(
        totalPnl
      ).toLocaleString()}`;


    pnlElement.className =
      `stat-value ${
        totalPnl >= 0
          ? "val-up"
          : "val-down"
      }`;

  }


  const pnlRateElement =
    document.getElementById(
      "totalPnlRate"
    );


  if (pnlRateElement) {

    pnlRateElement.textContent =
      `${totalPnlSign}${totalPnlRate.toFixed(2)}%`;


    pnlRateElement.className =
      `stat-sub ${
        totalPnl >= 0
          ? "val-up"
          : "val-down"
      }`;

  }


  let realizedTotal = 0;


  const realizedBody =
    document.getElementById(
      "realizedTableBody"
    );


  if (realizedBody) {

    realizedBody.innerHTML = "";


    if (
      realizedList.length === 0
    ) {

      realizedBody.innerHTML =
        `
        <tr>
          <td
            colspan="9"
            class="empty-table"
          >
            尚無已實現賣出紀錄
          </td>
        </tr>
        `;

    } else {

      realizedList.forEach(
        record => {

          realizedTotal +=
            Number(record.pnlTwd) ||
            0;


          const profit =
            Number(record.pnlTwd) >= 0;


          const colorClass =
            profit
              ? "val-up"
              : "val-down";


          const sign =
            profit
              ? "+"
              : "";


          const row =
            document.createElement(
              "tr"
            );


          row.innerHTML = `

            <td>
              ${escapeHtml(
                record.date
              )}
            </td>

            <td>

              <strong>
                ${escapeHtml(
                  record.name ||
                  record.symbol
                )}
              </strong>

              (${escapeHtml(
                record.symbol
              )})

            </td>

            <td>

              <span class="badge">
                ${escapeHtml(
                  record.market
                )}
              </span>

            </td>

            <td>
              $${Number(
                record.cost
              ).toFixed(2)}
            </td>

            <td>
              $${Number(
                record.sellPrice
              ).toFixed(2)}
            </td>

            <td>
              ${Number(
                record.qty
              )}
            </td>

            <td class="${colorClass}">
              ${sign}$
              ${Number(
                record.pnlOrig
              ).toFixed(2)}
            </td>

            <td class="${colorClass}">

              <strong>

                ${sign}$
                ${Math.round(
                  Number(
                    record.pnlTwd
                  )
                ).toLocaleString()}

              </strong>

            </td>

            <td>

              <button
                class="delete-realized"
                onclick="deleteRealized(${Number(record.id)})"
              >
                刪除
              </button>

            </td>

          `;


          realizedBody.appendChild(
            row
          );

        }
      );

    }

  }


  const realizedElement =
    document.getElementById(
      "totalRealizedPnl"
    );


  if (realizedElement) {

    const sign =
      realizedTotal >= 0
        ? "+"
        : "";


    realizedElement.textContent =
      `${sign}$${Math.round(
        realizedTotal
      ).toLocaleString()}`;


    realizedElement.className =
      `stat-value ${
        realizedTotal >= 0
          ? "val-up"
          : "val-down"
      }`;

  }


  const ticker =
    document.getElementById(
      "tickerTrack"
    );


  if (ticker) {

    ticker.innerHTML =
      tickerHtml
        ? tickerHtml + tickerHtml
        : `
          <span class="ticker-item">
            尚無持股資料
          </span>
        `;

  }

}



function escapeHtml(value) {

  return String(
    value ?? ""
  )
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
