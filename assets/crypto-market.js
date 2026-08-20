(function () {
  // ---- TradingView Advanced Chart widgets (has its own built-in range
  // selector, 1D through ALL — free to embed, no TradingView account needed) ----
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelectorAll('[data-tv-symbol]').forEach(function (el) {
    var container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '600px';
    var inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    container.appendChild(inner);
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.text = JSON.stringify({
      symbol: el.getAttribute('data-tv-symbol'),
      width: '100%',
      height: '100%',
      locale: 'kr',
      range: '3M',
      theme: isDark ? 'dark' : 'light',
      style: '3',
      timezone: 'Asia/Seoul',
      withdateranges: true,
      hide_side_toolbar: true,
      allow_symbol_change: false
    });
    container.appendChild(script);
    el.appendChild(container);
  });

  // ---- interactive per-coin price charts with clickable time ranges ----
  // CoinGecko's free tier (even with a demo key) 401s on days=max, so this
  // set (no "전체") is used for CoinGecko-sourced charts (stablecoins).
  var RANGES = [
    { label: '24시간', days: '1' },
    { label: '7일', days: '7' },
    { label: '30일', days: '30' },
    { label: '3개월', days: '90' },
    { label: '1년', days: '365' }
  ];
  // Binance's public klines API has no such block, so the BTC/ETH/SOL/BNB
  // charts and TVL (DeFiLlama, also unrestricted) get a real "전체" option.
  var RANGES_WITH_MAX = RANGES.concat([{ label: '전체', days: 'max' }]);

  // calls CoinGecko directly from the browser. a Worker-side proxy was
  // tried instead, but CoinGecko returns 403 to requests coming from
  // Cloudflare's own IPs (common with free APIs blocking datacenter/server
  // traffic), so the proxy made things worse, not better. the request
  // queue + per-range cache below still do the real work of avoiding
  // rate-limit trouble from one visitor clicking around quickly.
  //
  // the demo API key below is meant to be used client-side (CoinGecko's
  // own model for the free Demo tier) — it only raises our own request
  // quota, it isn't a billing credential, so it's fine to ship in public JS.
  var CG_DEMO_KEY = 'CG-FMfLVSBE5qcpYQ2R9RYTVogy';
  function cgUrl(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return 'https://api.coingecko.com' + path + sep + 'x_cg_demo_api_key=' + CG_DEMO_KEY;
  }

  function fmtKrw(v) {
    var neg = v < 0; v = Math.abs(v);
    var s;
    if (v >= 1e12) s = (v / 1e12).toFixed(2) + '조';
    else if (v >= 1e8) s = (v / 1e8).toFixed(2) + '억';
    else if (v >= 1e4) s = Math.round(v / 1e4).toLocaleString() + '만';
    else s = Math.round(v).toLocaleString();
    return (neg ? '-₩' : '₩') + s;
  }

  function fmtUsd(n) {
    var neg = n < 0; n = Math.abs(n);
    var s;
    if (n >= 1e9) s = (n / 1e9).toFixed(2) + 'B';
    else if (n >= 1e6) s = (n / 1e6).toFixed(1) + 'M';
    else s = n.toLocaleString();
    return (neg ? '-$' : '$') + s;
  }

  // for a single unit price (not an aggregate like market cap), not B/M-abbreviated
  function fmtUsdPrice(n) {
    var digits = n < 1 ? 4 : 2;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function fmtKrwPrice(n) {
    return '₩' + Math.round(n).toLocaleString();
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function fmtDateLabel(ts, spanMs) {
    var d = new Date(ts);
    if (spanMs <= 2 * 24 * 60 * 60 * 1000) {
      return d.getHours() + '시';
    }
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function drawCoinChart(canvas, prices, volumes, fmtFn, hoverIndex) {
    fmtFn = fmtFn || fmtKrw;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!prices.length) return;

    var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (document.documentElement.getAttribute('data-theme') !== 'light' &&
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var accent = isDark ? (cssVar('--good') || '#4ADE94') : (cssVar('--accent') || '#4338CA');
    var border = cssVar('--border') || '#E7E7E4';
    var muted = cssVar('--text-muted') || '#6B6D70';

    var xAxisH = 18;
    var priceH = (h - xAxisH) * 0.72;
    var volTop = priceH + 10;
    var volH = (h - xAxisH) - volTop;

    var vals = prices.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var pad = (max - min) * 0.1 || max * 0.02;
    var yMin = min - pad, yMax = max + pad;

    function xAt(i) { return prices.length > 1 ? (i / (prices.length - 1)) * w : 0; }
    function yAt(v) { return priceH - ((v - yMin) / (yMax - yMin)) * priceH; }

    // horizontal gridlines + price labels
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.font = '10.5px Inter, sans-serif';
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    for (var g = 0; g <= 3; g++) {
      var v = yMin + (yMax - yMin) * (g / 3);
      var y = yAt(v);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(fmtFn(v), w - 4, y - 4);
    }

    // area fill
    var grad = ctx.createLinearGradient(0, 0, 0, priceH);
    grad.addColorStop(0, accent + '59');
    grad.addColorStop(1, accent + '00');
    ctx.beginPath();
    prices.forEach(function (p, i) {
      var x = xAt(i), y = yAt(p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.lineTo(w, priceH); ctx.lineTo(0, priceH); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();

    // line
    ctx.beginPath();
    prices.forEach(function (p, i) {
      var x = xAt(i), y = yAt(p[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // volume bars
    if (volumes && volumes.length) {
      var volVals = volumes.map(function (v) { return v[1]; });
      var volMax = Math.max.apply(null, volVals) || 1;
      ctx.fillStyle = accent + '33';
      var bw = Math.max(1, (w / volumes.length) * 0.7);
      volumes.forEach(function (v, i) {
        var x = prices.length > 1 ? (i / (volumes.length - 1)) * w : 0;
        var bh = (v[1] / volMax) * volH;
        ctx.fillRect(x - bw / 2, volTop + (volH - bh), bw, bh);
      });
    }

    // x-axis date labels
    if (prices.length > 1) {
      var span = prices[prices.length - 1][0] - prices[0][0];
      var labelCount = Math.min(5, prices.length);
      ctx.textAlign = 'center';
      ctx.fillStyle = muted;
      for (var li = 0; li < labelCount; li++) {
        var idx = Math.round((li / (labelCount - 1)) * (prices.length - 1));
        var lx = xAt(idx);
        lx = Math.min(Math.max(lx, 22), w - 22);
        ctx.fillText(fmtDateLabel(prices[idx][0], span), lx, h - 3);
      }
    }

    // crosshair: a vertical guide line + highlighted dot at the hovered point
    if (hoverIndex != null && prices[hoverIndex]) {
      var hx = xAt(hoverIndex);
      var hp = prices[hoverIndex];
      var hy = yAt(hp[1]);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, priceH); ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = cssVar('--bg') || '#fff';
      ctx.stroke();
    }
  }

  // wires a mouse-following crosshair + tooltip onto a chart. dataFn must
  // return the currently-drawn { prices, volumes } (volumes optional) at
  // call time, since the active range can change after a tab click.
  // secondaryFn(rawValue), if given, adds a second currency line (e.g. KRW
  // under a USD-denominated chart) — return '' to skip it for a given point.
  function attachCrosshair(canvas, wrapEl, dataFn, fmtFn, secondaryFn) {
    var tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    if (getComputedStyle(wrapEl).position === 'static') wrapEl.style.position = 'relative';
    wrapEl.appendChild(tip);

    function hide() {
      var d = dataFn();
      drawCoinChart(canvas, d.prices || [], d.volumes || [], fmtFn);
      tip.style.display = 'none';
    }

    canvas.addEventListener('mousemove', function (e) {
      var d = dataFn();
      var prices = d.prices || [];
      if (prices.length < 2) return;
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var idx = Math.round((x / rect.width) * (prices.length - 1));
      idx = Math.max(0, Math.min(prices.length - 1, idx));
      drawCoinChart(canvas, prices, d.volumes || [], fmtFn, idx);

      var p = prices[idx];
      var dt = new Date(p[0]);
      var dateStr = (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.getHours() + '시';
      var sub = secondaryFn ? secondaryFn(p[1]) : '';
      tip.innerHTML = '<div class="chart-tooltip-date">' + dateStr + '</div>' +
        '<div class="chart-tooltip-val">' + fmtFn(p[1]) + '</div>' +
        (sub ? '<div class="chart-tooltip-sub">' + sub + '</div>' : '');
      tip.style.display = 'block';
      var tipX = (idx / (prices.length - 1)) * rect.width;
      tip.style.left = Math.min(Math.max(tipX, 55), rect.width - 55) + 'px';
      tip.style.top = canvas.offsetTop + 6 + 'px';
    });
    canvas.addEventListener('mouseleave', hide);
  }

  // CoinGecko's free tier blocks bursts of requests — this queue sends one
  // request at a time, with a gap between them, no matter how many charts
  // or tab-clicks ask for data at once.
  var fetchQueue = [];
  var fetchBusy = false;
  function queueFetch(url) {
    return new Promise(function (resolve, reject) {
      fetchQueue.push({ url: url, resolve: resolve, reject: reject });
      pumpQueue();
    });
  }
  // like queueFetch, but the URL is built lazily at send-time (used for the
  // exchange-rate call, which is enqueued before its own function exists yet)
  function queueFetchLater(urlFn) {
    return new Promise(function (resolve, reject) {
      fetchQueue.push({ urlFn: urlFn, resolve: resolve, reject: reject });
      pumpQueue();
    });
  }
  function pumpQueue() {
    if (fetchBusy || !fetchQueue.length) return;
    fetchBusy = true;
    var job = fetchQueue.shift();
    var url = job.urlFn ? job.urlFn() : job.url;
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(job.resolve)
      .catch(job.reject)
      .finally(function () { setTimeout(function () { fetchBusy = false; pumpQueue(); }, 350); });
  }

  // one shared USD->KRW rate for the whole page, approximated from USDC's
  // KRW price (USDC tracks $1 closely). every chart reuses this instead of
  // fetching each currency separately. must be defined after queueFetchLater
  // above it — calling it before fetchQueue/pumpQueue exist throws, and the
  // rejection was silently swallowed, which is why USD amounts never showed.
  var krwRatePromise = queueFetchLater(function () {
    return cgUrl('/api/v3/simple/price?ids=usd-coin&vs_currencies=krw');
  }).then(function (data) {
    return (data['usd-coin'] && data['usd-coin'].krw) || null;
  }).catch(function () { return null; });
  // cached synchronously once resolved, so things like the crosshair (which
  // needs a value on every mousemove, not just once) don't need to re-await
  var resolvedKrwRate = null;
  krwRatePromise.then(function (r) { resolvedKrwRate = r; });
  function krwParen(usdValue, fmt) {
    return resolvedKrwRate ? ' (' + fmt(usdValue * resolvedKrwRate) + ')' : '';
  }

  // BTC/ETH/SOL/BNB price charts: our own design (KRW parens, crosshair,
  // hi/lo), but sourced from Binance's free public klines API instead of
  // CoinGecko — Binance has no rate-limit key requirement and no block on
  // long history, so "전체" genuinely works here, unlike the CoinGecko-backed
  // charts elsewhere on this page.
  var BINANCE_RANGE = {
    '1': { interval: '15m', limit: 96 },
    '7': { interval: '1h', limit: 168 },
    '30': { interval: '4h', limit: 180 },
    '90': { interval: '1d', limit: 90 },
    '365': { interval: '1d', limit: 365 },
    'max': { interval: '1w', limit: 1000 }
  };

  function fetchBinanceKlines(symbol, days) {
    var cfg = BINANCE_RANGE[days] || BINANCE_RANGE['90'];
    var url = 'https://api.binance.com/api/v3/klines?symbol=' + symbol +
      '&interval=' + cfg.interval + '&limit=' + cfg.limit;
    return fetch(url).then(function (r) { return r.json(); }).then(function (rows) {
      if (!Array.isArray(rows)) throw new Error('no data');
      return {
        prices: rows.map(function (k) { return [k[0], parseFloat(k[4])]; }), // [openTime, close]
        volumes: rows.map(function (k) { return [k[0], parseFloat(k[7])]; }) // quote (USDT) volume
      };
    });
  }

  function buildCoinChart(card, symbol) {
    var tabsHtml = RANGES_WITH_MAX.map(function (r, i) {
      return '<button type="button" class="range-tab' + (i === 0 ? ' active' : '') + '" data-days="' + r.days + '">' + r.label + '</button>';
    }).join('');
    card.insertAdjacentHTML('beforeend',
      '<div class="range-tabs">' + tabsHtml + '</div>' +
      '<div class="coin-price-now">불러오는 중...</div>' +
      '<div class="coin-range-stat"></div>' +
      '<canvas class="price-canvas"></canvas>'
    );

    var tabsEl = card.querySelector('.range-tabs');
    var priceEl = card.querySelector('.coin-price-now');
    var hiloEl = card.querySelector('.coin-range-stat');
    var canvas = card.querySelector('.price-canvas');
    var cache = { prices: [], volumes: [] };
    var byRange = {};
    var activeDays = null;

    function redraw() { drawCoinChart(canvas, cache.prices, cache.volumes, fmtUsdPrice); }
    attachCrosshair(canvas, card, function () { return cache; }, fmtUsdPrice, function (usd) {
      return krwParen(usd, fmtKrwPrice).replace(/^ \(/, '').replace(/\)$/, '');
    });

    function apply(data) {
      cache.prices = data.prices || [];
      cache.volumes = data.volumes || [];
      redraw();
      if (cache.prices.length) {
        var vals = cache.prices.map(function (p) { return p[1]; });
        var last = vals[vals.length - 1];
        var first = vals[0];
        var hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
        var chg = ((last - first) / first) * 100;
        var cls = chg >= 0 ? 'up' : 'down';
        var sign = chg >= 0 ? '+' : '';
        priceEl.innerHTML = fmtUsdPrice(last) + krwParen(last, fmtKrwPrice) + '<span class="chg ' + cls + '">' + sign + chg.toFixed(2) + '%</span>';
        hiloEl.textContent = '이 기간 최고 ' + fmtUsdPrice(hi) + ' · 최저 ' + fmtUsdPrice(lo);
      }
    }

    function load(days) {
      activeDays = days;
      if (byRange[days]) { apply(byRange[days]); return; }
      fetchBinanceKlines(symbol, days)
        .then(function (data) {
          byRange[days] = data;
          if (activeDays === days) apply(data);
        })
        .catch(function () {
          if (activeDays === days) priceEl.textContent = '불러오지 못했어요. 잠시 후 다시 눌러주세요.';
        });
    }

    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.range-tab');
      if (!btn) return;
      tabsEl.querySelectorAll('.range-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      load(btn.getAttribute('data-days'));
    });

    load(RANGES_WITH_MAX[0].days);

    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(redraw, 150);
    });
  }

  document.querySelectorAll('[data-coin-card]').forEach(function (card) {
    buildCoinChart(card, card.getAttribute('data-coin-card'));
  });

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function pctSpan(pct) {
    var cls = pct >= 0 ? 'up' : 'down';
    var sign = pct >= 0 ? '+' : '';
    return '<span class="rank-change ' + cls + '">' + sign + pct.toFixed(2) + '%</span>';
  }

  // ---- top 5 gainers / losers (CoinGecko), sortable by clicking a header ----
  function rankCellValue(c, key) {
    switch (key) {
      case 'name': return (c.name || '').toLowerCase();
      case 'current_price': return c.current_price || 0;
      case 'price_change_percentage_24h': return c.price_change_percentage_24h || 0;
      case 'total_volume': return c.total_volume || 0;
      default: return 0;
    }
  }

  function renderRankList(tbodyId, list, rate) {
    var el = document.getElementById(tbodyId);
    if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="loading-note">데이터가 없어요</td></tr>'; return; }
    el.innerHTML = list.map(function (c) {
      var vol = c.total_volume || 0;
      var volText = fmtUsd(vol) + krwParen(vol, fmtKrw);
      var price = c.current_price || 0;
      var priceText = fmtUsdPrice(price) + krwParen(price, fmtKrwPrice);
      return '<tr>' +
        '<td><div class="coin-cell"><strong>' + escapeHtml(c.name) + '</strong><span>' + escapeHtml(c.symbol.toUpperCase()) + '</span></div></td>' +
        '<td>' + priceText + '</td>' +
        '<td>' + pctSpan(c.price_change_percentage_24h) + '</td>' +
        '<td class="cell-muted">' + volText + '</td>' +
        '</tr>';
    }).join('');
  }

  function setupRankSort(tableEl, getList, rateGetter, tbodyId) {
    if (!tableEl) return;
    var sortKey = null, sortDir = 1;
    tableEl.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
        tableEl.querySelectorAll('th').forEach(function (t) {
          t.classList.toggle('sorted', t === th);
          var a = t.querySelector('.sort-arrow'); if (a) a.remove();
        });
        th.insertAdjacentHTML('beforeend', '<span class="sort-arrow">' + (sortDir === 1 ? '▲' : '▼') + '</span>');
        var sorted = getList().slice().sort(function (a, b) {
          var av = rankCellValue(a, key), bv = rankCellValue(b, key);
          return av < bv ? -sortDir : av > bv ? sortDir : 0;
        });
        renderRankList(tbodyId, sorted, rateGetter());
      });
    });
  }

  var gainersList = [], losersList = [];
  queueFetch(cgUrl('/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h'))
    .then(function (coins) {
      var valid = coins.filter(function (c) { return typeof c.price_change_percentage_24h === 'number'; });
      gainersList = valid.slice().sort(function (a, b) { return b.price_change_percentage_24h - a.price_change_percentage_24h; }).slice(0, 5);
      losersList = valid.slice().sort(function (a, b) { return a.price_change_percentage_24h - b.price_change_percentage_24h; }).slice(0, 5);
      krwRatePromise.then(function (rate) {
        renderRankList('topGainers', gainersList, rate);
        renderRankList('topLosers', losersList, rate);
      });
      setupRankSort(document.getElementById('topGainers').closest('table'), function () { return gainersList; }, function () { return resolvedKrwRate; }, 'topGainers');
      setupRankSort(document.getElementById('topLosers').closest('table'), function () { return losersList; }, function () { return resolvedKrwRate; }, 'topLosers');
    })
    .catch(function () {
      document.getElementById('topGainers').innerHTML = '<tr><td colspan="4" class="loading-note">불러오지 못했어요</td></tr>';
      document.getElementById('topLosers').innerHTML = '<tr><td colspan="4" class="loading-note">불러오지 못했어요</td></tr>';
    });

  // builds a range-tab row inside an existing container and wires clicks
  // to onSelect(days) — shared by the coin, TVL, and stablecoin charts.
  function buildRangeTabs(container, onSelect, ranges) {
    if (!container) return null;
    container.innerHTML = (ranges || RANGES).map(function (r, i) {
      return '<button type="button" class="range-tab' + (i === 0 ? ' active' : '') + '" data-days="' + r.days + '">' + r.label + '</button>';
    }).join('');
    container.addEventListener('click', function (e) {
      var btn = e.target.closest('.range-tab');
      if (!btn) return;
      container.querySelectorAll('.range-tab').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      onSelect(btn.getAttribute('data-days'));
    });
    return container;
  }

  // ---- DeFi TVL (DeFiLlama) — stat tiles + trend chart with range tabs ----
  // DeFiLlama's endpoint returns the full history in one call, so switching
  // ranges just re-slices data already in memory — no re-fetching needed.
  var DAYS_PER_RANGE = { '1': 2, '7': 7, '30': 30, '90': 90, '365': 365 };
  fetch('https://api.llama.fi/v2/historicalChainTvl')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var n = data.length;
      var last = data[n - 1].tvl;
      var day = data[n - 2] ? data[n - 2].tvl : last;
      var week = data[n - 8] ? data[n - 8].tvl : last;
      krwRatePromise.then(function (rate) {
        var krwText = rate ? ' <span class="stat-sub">(' + fmtKrw(last * rate) + ')</span>' : '';
        document.getElementById('tvlNow').innerHTML = fmtUsd(last) + krwText;
      });
      document.getElementById('tvl24h').innerHTML = pctSpan(((last - day) / day) * 100);
      document.getElementById('tvl7d').innerHTML = pctSpan(((last - week) / week) * 100);

      var tvlCanvas = document.getElementById('tvlChart');
      var tvlCurrent = [];
      function drawRange(days) {
        var n2 = days === 'max' ? data.length : (DAYS_PER_RANGE[days] || 90);
        tvlCurrent = data.slice(-n2).map(function (d) { return [d.date * 1000, d.tvl]; });
        if (tvlCanvas) drawCoinChart(tvlCanvas, tvlCurrent, [], fmtUsd);
      }
      buildRangeTabs(document.getElementById('tvlTabs'), drawRange, RANGES_WITH_MAX);
      drawRange('90');
      if (tvlCanvas) attachCrosshair(tvlCanvas, document.getElementById('tvlChartWrap'), function () { return { prices: tvlCurrent }; }, fmtUsd);
    })
    .catch(function () {
      ['tvlNow', 'tvl24h', 'tvl7d'].forEach(function (id) { document.getElementById(id).textContent = '불러오지 못함'; });
    });

  // ---- stablecoin market caps (proxy for USDT/USDC flow) — stats + chart with range tabs ----
  queueFetch(cgUrl('/api/v3/coins/markets?vs_currency=usd&ids=tether,usd-coin'))
    .then(function (coins) {
      krwRatePromise.then(function (rate) {
        coins.forEach(function (c) {
          var capId = c.id === 'tether' ? 'usdtCap' : c.id === 'usd-coin' ? 'usdcCap' : null;
          var chgId = c.id === 'tether' ? 'usdtChg' : c.id === 'usd-coin' ? 'usdcChg' : null;
          if (!capId) return;
          var krwText = rate ? ' <span class="stat-sub">(' + fmtKrw(c.market_cap * rate) + ')</span>' : '';
          document.getElementById(capId).innerHTML = fmtUsd(c.market_cap) + krwText;
          document.getElementById(chgId).innerHTML = pctSpan(c.market_cap_change_percentage_24h || 0) + ' (24h)';
        });
      });
    })
    .catch(function () {
      document.getElementById('usdtCap').textContent = '불러오지 못함';
      document.getElementById('usdcCap').textContent = '불러오지 못함';
    });

  function buildStablecoinChart(coinId, canvasId, statusId, tabsId) {
    var canvas = document.getElementById(canvasId);
    var statusEl = document.getElementById(statusId);
    if (!canvas) return;
    var byRange = {};
    var current = [];

    function load(days) {
      if (byRange[days]) { current = byRange[days]; drawCoinChart(canvas, current, [], fmtUsd); if (statusEl) statusEl.textContent = ''; return; }
      queueFetch(cgUrl('/api/v3/coins/' + coinId + '/market_chart?vs_currency=usd&days=' + days))
        .then(function (data) {
          var caps = (data.market_caps || []);
          if (!caps.length) throw new Error('no data');
          byRange[days] = caps;
          current = caps;
          drawCoinChart(canvas, caps, [], fmtUsd);
          if (statusEl) statusEl.textContent = '';
        })
        .catch(function () {
          if (statusEl) statusEl.textContent = '차트를 불러오지 못했어요. 잠시 후 다시 눌러주세요.';
        });
    }
    buildRangeTabs(document.getElementById(tabsId), load);
    load(RANGES[0].days);
    attachCrosshair(canvas, canvas.parentElement, function () { return { prices: current }; }, fmtUsd);
  }
  buildStablecoinChart('tether', 'usdtChart', 'usdtChartStatus', 'usdtTabs');
  buildStablecoinChart('usd-coin', 'usdcChart', 'usdcChartStatus', 'usdcTabs');
})();
