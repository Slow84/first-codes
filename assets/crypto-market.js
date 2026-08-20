(function () {
  // ---- TradingView mini chart widgets ----
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelectorAll('[data-tv-symbol]').forEach(function (el) {
    var container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    var inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    container.appendChild(inner);
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-mini-symbol-overview.js';
    script.async = true;
    script.text = JSON.stringify({
      symbol: el.getAttribute('data-tv-symbol'),
      width: '100%',
      height: 220,
      locale: 'kr',
      dateRange: '1M',
      colorTheme: isDark ? 'dark' : 'light',
      isTransparent: true
    });
    container.appendChild(script);
    el.appendChild(container);
  });

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function fmtUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + n.toLocaleString();
  }

  function pctSpan(pct) {
    var cls = pct >= 0 ? 'up' : 'down';
    var sign = pct >= 0 ? '+' : '';
    return '<span class="rank-change ' + cls + '">' + sign + pct.toFixed(2) + '%</span>';
  }

  // ---- top 5 gainers / losers (CoinGecko) ----
  function renderRankList(id, list) {
    var el = document.getElementById(id);
    if (!list.length) { el.innerHTML = '<li class="loading-note">데이터가 없어요</li>'; return; }
    el.innerHTML = list.map(function (c) {
      return '<li class="rank-item"><span class="rank-name">' + escapeHtml(c.name) +
        '<span class="rank-sym">' + escapeHtml(c.symbol.toUpperCase()) + '</span></span>' +
        pctSpan(c.price_change_percentage_24h) + '</li>';
    }).join('');
  }

  fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h')
    .then(function (r) { return r.json(); })
    .then(function (coins) {
      var valid = coins.filter(function (c) { return typeof c.price_change_percentage_24h === 'number'; });
      var gainers = valid.slice().sort(function (a, b) { return b.price_change_percentage_24h - a.price_change_percentage_24h; }).slice(0, 5);
      var losers = valid.slice().sort(function (a, b) { return a.price_change_percentage_24h - b.price_change_percentage_24h; }).slice(0, 5);
      renderRankList('topGainers', gainers);
      renderRankList('topLosers', losers);
    })
    .catch(function () {
      document.getElementById('topGainers').innerHTML = '<li class="loading-note">불러오지 못했어요</li>';
      document.getElementById('topLosers').innerHTML = '<li class="loading-note">불러오지 못했어요</li>';
    });

  // ---- DeFi TVL (DeFiLlama) ----
  fetch('https://api.llama.fi/v2/historicalChainTvl')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var n = data.length;
      var last = data[n - 1].tvl;
      var day = data[n - 2] ? data[n - 2].tvl : last;
      var week = data[n - 8] ? data[n - 8].tvl : last;
      document.getElementById('tvlNow').textContent = fmtUsd(last);
      document.getElementById('tvl24h').innerHTML = pctSpan(((last - day) / day) * 100);
      document.getElementById('tvl7d').innerHTML = pctSpan(((last - week) / week) * 100);
    })
    .catch(function () {
      ['tvlNow', 'tvl24h', 'tvl7d'].forEach(function (id) { document.getElementById(id).textContent = '불러오지 못함'; });
    });

  // ---- stablecoin market caps (proxy for USDT/USDC flow) ----
  fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin')
    .then(function (r) { return r.json(); })
    .then(function (coins) {
      coins.forEach(function (c) {
        if (c.id === 'tether') {
          document.getElementById('usdtCap').textContent = fmtUsd(c.market_cap);
          document.getElementById('usdtChg').innerHTML = pctSpan(c.market_cap_change_percentage_24h || 0) + ' (24h)';
        }
        if (c.id === 'usd-coin') {
          document.getElementById('usdcCap').textContent = fmtUsd(c.market_cap);
          document.getElementById('usdcChg').innerHTML = pctSpan(c.market_cap_change_percentage_24h || 0) + ' (24h)';
        }
      });
    })
    .catch(function () {
      document.getElementById('usdtCap').textContent = '불러오지 못함';
      document.getElementById('usdcCap').textContent = '불러오지 못함';
    });
})();
