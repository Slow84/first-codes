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
      hide_top_toolbar: true,
      hide_legend: true,
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
    // spans over a year (only "전체") repeat the same M/D every year, so
    // prefix a 2-digit year to keep labels unambiguous.
    if (spanMs > 365 * 24 * 60 * 60 * 1000) {
      return (d.getFullYear() % 100) + '.' + (d.getMonth() + 1) + '/' + d.getDate();
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

    function updateAt(clientX) {
      var d = dataFn();
      var prices = d.prices || [];
      if (prices.length < 2) return;
      var rect = canvas.getBoundingClientRect();
      var x = clientX - rect.left;
      var idx = Math.round((x / rect.width) * (prices.length - 1));
      idx = Math.max(0, Math.min(prices.length - 1, idx));
      drawCoinChart(canvas, prices, d.volumes || [], fmtFn, idx);

      var p = prices[idx];
      var dt = new Date(p[0]);
      var span = prices[prices.length - 1][0] - prices[0][0];
      var yearPrefix = span > 365 * 24 * 60 * 60 * 1000 ? (dt.getFullYear() % 100) + '.' : '';
      var dateStr = yearPrefix + (dt.getMonth() + 1) + '/' + dt.getDate() + ' ' + dt.getHours() + '시';
      var sub = secondaryFn ? secondaryFn(p[1]) : '';
      tip.innerHTML = '<div class="chart-tooltip-date">' + dateStr + '</div>' +
        '<div class="chart-tooltip-val">' + fmtFn(p[1]) + '</div>' +
        (sub ? '<div class="chart-tooltip-sub">' + sub + '</div>' : '');
      tip.style.display = 'block';
      var tipX = (idx / (prices.length - 1)) * rect.width;
      tip.style.left = Math.min(Math.max(tipX, 55), rect.width - 55) + 'px';
      tip.style.top = canvas.offsetTop + 6 + 'px';
    }

    canvas.addEventListener('mousemove', function (e) { updateAt(e.clientX); });
    canvas.addEventListener('mouseleave', hide);

    // touch: drag a finger across the chart to move the crosshair, same as
    // mouse hover. preventDefault while dragging so the page doesn't scroll
    // out from under the finger.
    canvas.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      updateAt(e.touches[0].clientX);
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      e.preventDefault();
      updateAt(e.touches[0].clientX);
    }, { passive: false });
    canvas.addEventListener('touchend', hide);
    canvas.addEventListener('touchcancel', hide);
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

  // no per-coin news matching (our RSS pool is only ~40 general items and
  // won't have coverage for most small-cap movers) — link out to a live
  // Google News search instead, which works for literally any coin name.
  function newsSearchUrl(coinName) {
    return 'https://news.google.com/search?q=' + encodeURIComponent(coinName + ' crypto') + '&hl=ko&gl=KR&ceid=KR:ko';
  }

  function renderRankList(tbodyId, list, rate) {
    var el = document.getElementById(tbodyId);
    if (!list.length) { el.innerHTML = '<tr><td colspan="5" class="loading-note">데이터가 없어요</td></tr>'; return; }
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
        '<td><a class="news-link" href="' + newsSearchUrl(c.name) + '" target="_blank" rel="noopener">검색 →</a></td>' +
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
      document.getElementById('topGainers').innerHTML = '<tr><td colspan="5" class="loading-note">불러오지 못했어요</td></tr>';
      document.getElementById('topLosers').innerHTML = '<tr><td colspan="5" class="loading-note">불러오지 못했어요</td></tr>';
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

  // ---- TVL ranking table (DeFiLlama protocols) — CEX reserves excluded, sortable ----
  function tvlRankCellValue(p, key) {
    switch (key) {
      case 'name': return (p.name || '').toLowerCase();
      case 'category': return (p.category || '').toLowerCase();
      case 'tvl': return p.tvl || 0;
      case 'change_1d': return p.change_1d || 0;
      case 'change_7d': return p.change_7d || 0;
      default: return 0;
    }
  }

  // greedy spiral packing: places each circle (already sorted largest-first)
  // as close to center as possible without overlapping ones placed before
  // it — simple, no external layout library, plenty fast for ~20 circles.
  function packCircles(items, cx, cy) {
    var placed = [];
    items.forEach(function (item, i) {
      if (i === 0) { item.x = cx; item.y = cy; placed.push(item); return; }
      var angle = 0, radius = 0, x = cx, y = cy, ok = false, tries = 0;
      while (!ok && tries < 9000) {
        angle += 0.32;
        radius += 0.55;
        x = cx + radius * Math.cos(angle);
        y = cy + radius * Math.sin(angle);
        ok = true;
        for (var j = 0; j < placed.length; j++) {
          var dx = x - placed[j].x, dy = y - placed[j].y;
          if (Math.sqrt(dx * dx + dy * dy) < item.r + placed[j].r + 3) { ok = false; break; }
        }
        tries++;
      }
      item.x = x; item.y = y;
      placed.push(item);
    });
    return items;
  }

  // world-space layout (computed once per data load — "fit everything"
  // view at scale 1) and the current pan/zoom view state applied on top of
  // it at render time. Keeping these separate means panning/zooming never
  // needs to re-run the (somewhat expensive) packing search, just redraw.
  var tvlBubbleItems = [];
  var tvlBubbleCanvasSize = { w: 0, h: 0 };
  var tvlBubbleView = { scale: 1, ox: 0, oy: 0 };
  // computed per data load (see computeTvlBubbleLayout) so the biggest
  // circle can never be zoomed past filling the canvas — a fixed constant
  // here was the actual bug: at a flat 6x, the biggest protocol's circle
  // ballooned to ~550px in a ~340px-tall canvas, swallowing the whole
  // viewport and any neighboring circles with it.
  var tvlBubbleMaxScale = 3.5;
  var tvlBubbleRange = '1d'; // '1d' or '7d' — which change field drives the volatility color
  // "maximally volatile" % change for color purposes — separate caps because
  // day-over-day and week-over-week moves are on completely different
  // scales (checked against real data: change_1d p90 ≈ 8%, change_7d
  // p90 ≈ 28%). Using one shared cap made the daily tab look almost
  // uniformly green since even the biggest daily mover barely crossed it.
  var TVL_BUBBLE_VOL_CAP = { '1d': 9, '7d': 25 };

  // Fisher-Yates — packing in size order always puts the biggest protocol
  // dead center with everything else ranked outward, which reads as
  // "sorted," not "a market." Shuffling the placement order (not the radii,
  // those still come from tvl) scatters big and small circles throughout.
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  // ticker-shaped fallback for protocols with no real token symbol —
  // "Binance staked ETH" -> "BSE", "Coinbase Bridge" -> "CB", a lone
  // single-word name just gets clipped to 4 letters ("Solstice" -> "SOLS").
  function abbreviateName(name) {
    var words = name.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return words.slice(0, 4).map(function (w) { return w[0]; }).join('').toUpperCase();
    }
    return (words[0] || '').slice(0, 4).toUpperCase();
  }

  function computeTvlBubbleLayout(list, w, h) {
    // radius ∝ tvl^POWER. Pure area-proportional (POWER=0.5, i.e. sqrt) is
    // the "honest" bubble-chart standard, but the user found it made
    // mid-size protocols look too similar (e.g. a 2.6x TVL gap only became
    // a 1.6x radius gap) — bumped to 0.65 per their explicit call, trading
    // some of that strict-proportionality honesty for more visible spread
    // between small/mid protocols. The exact scale (k) barely matters
    // since everything gets rescaled to fit the canvas afterward anyway —
    // it just needs to be in the right ballpark so packing doesn't take
    // forever.
    var SIZE_POWER = 0.65;
    var sumPow = list.reduce(function (s, p) { return s + Math.pow(p.tvl || 1, SIZE_POWER * 2); }, 0);
    var k = Math.sqrt((0.5 * w * h) / (Math.PI * sumPow));
    // checked against real data: with 100 protocols, a floor of 10 clamped
    // 44 of them to the exact same radius, erasing real TVL differences
    // among nearly half the dataset. Dropped to just enough to stay a
    // visible, tappable dot — small protocols are *meant* to look tiny at
    // the base view and only grow (and gain a label) once zoomed in.
    var minR = 3;

    // size color (green depth) and volatility color (red mix-in) each need
    // to be relative to the *current dataset*, not an absolute scale, or
    // one whale protocol would make everything else look identically pale.
    // Size uses log scale since TVL spans orders of magnitude ($23B down to
    // a few hundred M) — a linear scale would make everything past the top
    // 2-3 protocols look the same pale shade.
    var tvls = list.map(function (p) { return p.tvl || 1; });
    var logMin = Math.log(Math.min.apply(null, tvls));
    var logMax = Math.log(Math.max.apply(null, tvls));
    var logRange = Math.max(1e-6, logMax - logMin);

    // volatility color depends on which range (일/주) is selected, so it's
    // computed per-frame in renderTvlBubbleFrame instead of baked in here —
    // switching ranges is then just a redraw, not a re-layout.
    var items = list.map(function (p) {
      return {
        name: p.name, tvl: p.tvl, slug: p.slug, symbol: p.symbol, change_1d: p.change_1d, change_7d: p.change_7d,
        r: Math.max(minR, k * Math.pow(p.tvl || 1, SIZE_POWER)),
        sizeT: (Math.log(p.tvl || 1) - logMin) / logRange
      };
    });
    shuffle(items);
    packCircles(items, w / 2, h / 2);

    // packing spreads outward in a roughly circular blob, but the canvas is
    // a wide rectangle — without this, the blob overflows top/bottom (or
    // left/right) and edge circles get cut off. Measure the actual bounding
    // box of what got packed, then uniformly scale + recenter so the whole
    // thing exactly fills [0,w]x[0,h] — this becomes the "zoomed all the
    // way out" baseline that panning/zooming builds on top of.
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    items.forEach(function (it) {
      minX = Math.min(minX, it.x - it.r); maxX = Math.max(maxX, it.x + it.r);
      minY = Math.min(minY, it.y - it.r); maxY = Math.max(maxY, it.y + it.r);
    });
    var padding = 8;
    var fitScale = Math.min((w - padding * 2) / (maxX - minX), (h - padding * 2) / (maxY - minY));
    var bboxCx = (minX + maxX) / 2, bboxCy = (minY + maxY) / 2;
    items.forEach(function (it) {
      it.x = w / 2 + (it.x - bboxCx) * fitScale;
      it.y = h / 2 + (it.y - bboxCy) * fitScale;
      it.r = it.r * fitScale;
    });

    // derive the zoom ceiling from the actual biggest circle instead of a
    // guessed constant — this is what a flat 6x got wrong: it never checked
    // whether the *biggest* protocol's circle would still fit at max zoom,
    // only whether the smallest one became legible. Capping so the biggest
    // circle's diameter can't exceed ~92% of the canvas's short side means
    // it can never swallow the whole viewport (and everything next to it)
    // no matter how the TVL distribution shifts day to day.
    var maxR = Math.max.apply(null, items.map(function (it) { return it.r; }));
    tvlBubbleMaxScale = Math.max(1.5, Math.min(6, (Math.min(w, h) * 0.92) / (2 * maxR)));
    return items;
  }

  function renderTvlBubbleFrame() {
    var canvas = document.getElementById('tvlBubbleChart');
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = tvlBubbleCanvasSize.w, h = tvlBubbleCanvasSize.h;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // compose the device-pixel-ratio transform with the pan/zoom transform
    // in one setTransform call — letting the canvas transform (not manual
    // per-item math) handle the zoom means text scales up right along with
    // the circles, which is exactly what makes zooming in useful here.
    ctx.setTransform(dpr * tvlBubbleView.scale, 0, 0, dpr * tvlBubbleView.scale, dpr * tvlBubbleView.ox, dpr * tvlBubbleView.oy);

    var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (document.documentElement.getAttribute('data-theme') !== 'light' &&
        window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

    // draw big-to-small (not the shuffled placement order) so a large
    // circle drawn after a small one in placement order never paints over
    // and hides it — every circle stays visible regardless of z-order luck.
    var drawOrder = tvlBubbleItems.slice().sort(function (a, b) { return b.r - a.r; });
    drawOrder.forEach(function (it) {
      // hue runs green (150°, calm) -> red (0°, volatile) by how much the
      // protocol's TVL moved recently (일/주 toggle picks which field);
      // lightness runs pale -> deep by how big its TVL is. Two independent
      // signals, one color, decoded at a glance: pale+green = small & calm,
      // deep+red = big & volatile.
      var changeVal = tvlBubbleRange === '7d' ? (it.change_7d || 0) : (it.change_1d || 0);
      var volT = Math.min(1, Math.abs(changeVal) / TVL_BUBBLE_VOL_CAP[tvlBubbleRange]);
      var hue = 150 - 150 * volT;
      var lightness = (isDark ? 62 : 82) - (isDark ? 30 : 45) * it.sizeT;
      var saturation = 35 + 35 * it.sizeT;
      ctx.beginPath();
      ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(' + hue + ',' + saturation + '%,' + lightness + '%,0.7)';
      ctx.fill();
      ctx.lineWidth = 1.5 / tvlBubbleView.scale;
      ctx.strokeStyle = 'hsl(' + hue + ',' + saturation + '%,' + Math.max(18, lightness - 20) + '%)';
      ctx.stroke();

      // gate on the *apparent* (zoomed) size, not the raw world radius —
      // otherwise a circle that's tiny in the base layout stays textless
      // forever even after zooming in far enough to make it huge on screen.
      // Threshold is a bit higher than the old 20 to leave breathing room
      // between adjacent labeled circles once many are visible at once.
      if (it.r * tvlBubbleView.scale < 26) return;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle'; // so fillText's y is each line's own visual center, not its alphabetic baseline — makes symmetric stacking around it.y exact instead of approximate
      ctx.fillStyle = isDark ? '#fff' : '#18181b';
      // no artificial floor — font tracks circle size directly, so a small
      // circle's text starts small too (readable only once zoomed in
      // enough) instead of being forced to a minimum that overflows a
      // circle much smaller than the floor was designed for.
      var nameFont = Math.min(13, it.r / 3.4);
      ctx.font = '700 ' + nameFont + 'px Inter, sans-serif';
      // ticker (e.g. "LDO") instead of full name — much shorter, so it
      // actually fits small circles instead of truncating almost
      // everything to 2-3 letters + "…". ~35% of top protocols have no
      // token of their own (bridges, custody wrappers) and no symbol in
      // DeFiLlama's data — falling back to their full name there looked
      // visually inconsistent next to real tickers, so those get an
      // initials-style abbreviation instead (e.g. "Binance staked ETH" ->
      // "BSE"), keeping every label short and ticker-shaped.
      var label = (it.symbol && it.symbol !== '-') ? it.symbol.toUpperCase() : abbreviateName(it.name);
      // truncate by measured width, not a fixed character count — a wide
      // name like "Binance staked ETH" (used as a fallback above) needs
      // cutting off much sooner than a short ticker does at the same
      // circle size. Kept tighter than the circle's full width so adjacent
      // (touching) circles' labels don't bleed into each other.
      var maxTextWidth = it.r * 1.4;
      if (ctx.measureText(label).width > maxTextWidth) {
        while (label.length > 1 && ctx.measureText(label + '…').width > maxTextWidth) {
          label = label.slice(0, -1);
        }
        label += '…';
      }
      // show the $ amount under the name at any label-worthy size (not just
      // large circles) — sized down with the circle so it still fits.
      var valueFont = Math.min(11, it.r / 4.6);
      // no floor and no arbitrary offset here either — gap is purely each
      // line's own half-height plus a hair of breathing room, so the pair
      // stays tight and perfectly centered on it.y at any circle size.
      var lineGap = nameFont * 0.5 + valueFont * 0.5 + 1;
      ctx.fillText(label, it.x, it.y - lineGap / 2);
      ctx.font = '600 ' + valueFont + 'px Inter, sans-serif';
      ctx.fillStyle = isDark ? 'rgba(244,244,245,0.75)' : 'rgba(24,24,27,0.65)';
      ctx.fillText(fmtUsd(it.tvl), it.x, it.y + lineGap / 2);
    });
  }

  function drawTvlBubbles(list) {
    var canvas = document.getElementById('tvlBubbleChart');
    if (!canvas || !list.length) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    tvlBubbleCanvasSize = { w: w, h: h };
    tvlBubbleItems = computeTvlBubbleLayout(list, w, h);
    tvlBubbleView = { scale: 1, ox: 0, oy: 0 };
    renderTvlBubbleFrame();
  }

  // keeps panning from dragging the content completely off-screen: since
  // the layout exactly fills [0,w]x[0,h] at scale 1, at any scale the
  // valid offset range is just w*(1-scale)..0 (and the same for y).
  function clampTvlBubbleView() {
    var w = tvlBubbleCanvasSize.w, h = tvlBubbleCanvasSize.h;
    var scale = Math.max(1, Math.min(tvlBubbleMaxScale, tvlBubbleView.scale));
    tvlBubbleView.scale = scale;
    if (scale <= 1) { tvlBubbleView.ox = 0; tvlBubbleView.oy = 0; return; }
    tvlBubbleView.ox = Math.min(0, Math.max(w * (1 - scale), tvlBubbleView.ox));
    tvlBubbleView.oy = Math.min(0, Math.max(h * (1 - scale), tvlBubbleView.oy));
  }

  function zoomTvlBubbleAt(screenX, screenY, factor) {
    var newScale = Math.max(1, Math.min(tvlBubbleMaxScale, tvlBubbleView.scale * factor));
    var actualFactor = newScale / tvlBubbleView.scale;
    tvlBubbleView.ox = screenX - (screenX - tvlBubbleView.ox) * actualFactor;
    tvlBubbleView.oy = screenY - (screenY - tvlBubbleView.oy) * actualFactor;
    tvlBubbleView.scale = newScale;
    clampTvlBubbleView();
    renderTvlBubbleFrame();
  }

  function attachBubbleInteraction(canvas, wrapEl) {
    var tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    if (getComputedStyle(wrapEl).position === 'static') wrapEl.style.position = 'relative';
    wrapEl.appendChild(tip);

    function hitTest(screenX, screenY) {
      var wx = (screenX - tvlBubbleView.ox) / tvlBubbleView.scale;
      var wy = (screenY - tvlBubbleView.oy) / tvlBubbleView.scale;
      for (var i = 0; i < tvlBubbleItems.length; i++) {
        var it = tvlBubbleItems[i];
        var dx = wx - it.x, dy = wy - it.y;
        if (Math.sqrt(dx * dx + dy * dy) <= it.r) return it;
      }
      return null;
    }

    function showTip(hit, screenX, screenY, rect) {
      if (!hit) { tip.style.display = 'none'; return; }
      var changeVal = tvlBubbleRange === '7d' ? hit.change_7d : hit.change_1d;
      var changeLabel = tvlBubbleRange === '7d' ? '7일' : '24H';
      tip.innerHTML = '<div class="chart-tooltip-date">' + escapeHtml(hit.name) + '</div>' +
        '<div class="chart-tooltip-val">' + fmtUsd(hit.tvl) + '</div>' +
        '<div class="chart-tooltip-sub">' + pctSpan(changeVal || 0) + ' (' + changeLabel + ')</div>';
      tip.style.display = 'block';
      tip.style.left = Math.min(Math.max(screenX, 55), rect.width - 55) + 'px';
      tip.style.top = Math.max(screenY - 54, 4) + 'px';
    }

    function openProtocolPage(hit) {
      if (hit && hit.slug) window.open('https://defillama.com/protocol/' + hit.slug, '_blank', 'noopener');
    }

    // ---- mouse: wheel to zoom, drag to pan, hover for tooltip, click (no
    // drag) opens the protocol's DeFiLlama page ----
    var mouseDrag = null;
    canvas.addEventListener('mousedown', function (e) {
      mouseDrag = { startX: e.clientX, startY: e.clientY, ox: tvlBubbleView.ox, oy: tvlBubbleView.oy };
      tip.style.display = 'none';
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!mouseDrag) return;
      tvlBubbleView.ox = mouseDrag.ox + (e.clientX - mouseDrag.startX);
      tvlBubbleView.oy = mouseDrag.oy + (e.clientY - mouseDrag.startY);
      clampTvlBubbleView();
      renderTvlBubbleFrame();
    });
    window.addEventListener('mouseup', function (e) {
      if (!mouseDrag) return;
      var moved = Math.abs(e.clientX - mouseDrag.startX) + Math.abs(e.clientY - mouseDrag.startY);
      if (moved < 6) {
        var rect = canvas.getBoundingClientRect();
        openProtocolPage(hitTest(e.clientX - rect.left, e.clientY - rect.top));
      }
      mouseDrag = null;
      canvas.style.cursor = tvlBubbleView.scale > 1 ? 'grab' : 'default';
    });
    canvas.addEventListener('mousemove', function (e) {
      if (mouseDrag) return;
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left, y = e.clientY - rect.top;
      var hit = hitTest(x, y);
      canvas.style.cursor = hit ? 'pointer' : (tvlBubbleView.scale > 1 ? 'grab' : 'default');
      showTip(hit, x, y, rect);
    });
    canvas.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      zoomTvlBubbleAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
      canvas.style.cursor = tvlBubbleView.scale > 1 ? 'grab' : 'default';
    }, { passive: false });

    // ---- touch: one finger pans, two fingers pinch-zoom ----
    var touchState = null;
    function touchDist(t) {
      var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }
    canvas.addEventListener('touchstart', function (e) {
      tip.style.display = 'none';
      if (e.touches.length === 1) {
        touchState = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, ox: tvlBubbleView.ox, oy: tvlBubbleView.oy };
      } else if (e.touches.length === 2) {
        var rect = canvas.getBoundingClientRect();
        touchState = {
          mode: 'pinch', dist: touchDist(e.touches),
          midX: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
          midY: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top,
          scale: tvlBubbleView.scale, ox: tvlBubbleView.ox, oy: tvlBubbleView.oy
        };
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', function (e) {
      if (!touchState) return;
      e.preventDefault();
      if (touchState.mode === 'pan' && e.touches.length === 1) {
        tvlBubbleView.ox = touchState.ox + (e.touches[0].clientX - touchState.x);
        tvlBubbleView.oy = touchState.oy + (e.touches[0].clientY - touchState.y);
        clampTvlBubbleView();
        renderTvlBubbleFrame();
      } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
        var ratio = touchDist(e.touches) / touchState.dist;
        var newScale = Math.max(1, Math.min(tvlBubbleMaxScale, touchState.scale * ratio));
        var actualFactor = newScale / touchState.scale;
        tvlBubbleView.ox = touchState.midX - (touchState.midX - touchState.ox) * actualFactor;
        tvlBubbleView.oy = touchState.midY - (touchState.midY - touchState.oy) * actualFactor;
        tvlBubbleView.scale = newScale;
        clampTvlBubbleView();
        renderTvlBubbleFrame();
      }
    }, { passive: false });
    canvas.addEventListener('touchend', function (e) {
      if (touchState && touchState.mode === 'pan' && e.changedTouches.length === 1) {
        var t = e.changedTouches[0];
        var moved = Math.abs(t.clientX - touchState.x) + Math.abs(t.clientY - touchState.y);
        if (moved < 8) {
          var rect = canvas.getBoundingClientRect();
          openProtocolPage(hitTest(t.clientX - rect.left, t.clientY - rect.top));
        }
      }
      touchState = null;
    });
    canvas.addEventListener('touchcancel', function () { touchState = null; });
  }

  function renderTvlRank(list) {
    var el = document.getElementById('tvlRankBody');
    if (!el) return;
    if (!list.length) { el.innerHTML = '<tr><td colspan="5" class="loading-note">데이터가 없어요</td></tr>'; return; }
    el.innerHTML = list.map(function (p) {
      return '<tr>' +
        '<td><div class="coin-cell"><strong>' + escapeHtml(p.name) + '</strong>' +
          (p.symbol && p.symbol !== '-' ? '<span>' + escapeHtml(p.symbol.toUpperCase()) + '</span>' : '') +
          '</div></td>' +
        '<td class="cell-muted">' + escapeHtml(p.category || '-') + '</td>' +
        '<td>' + fmtUsd(p.tvl) + '</td>' +
        '<td>' + (typeof p.change_1d === 'number' ? pctSpan(p.change_1d) : '-') + '</td>' +
        '<td>' + (typeof p.change_7d === 'number' ? pctSpan(p.change_7d) : '-') + '</td>' +
        '</tr>';
    }).join('');
  }

  var tvlRankList = [];
  fetch('https://api.llama.fi/protocols')
    .then(function (r) { return r.json(); })
    .then(function (protocols) {
      var sortedProtocols = protocols
        .filter(function (p) { return p.category !== 'CEX' && typeof p.tvl === 'number' && p.tvl > 0; })
        .sort(function (a, b) { return b.tvl - a.tvl; });
      // table stays short (top 20) for a quick-glance list; the bubble
      // chart can hold far more since panning/zooming makes 100 usable.
      tvlRankList = sortedProtocols.slice(0, 20);
      renderTvlRank(tvlRankList);

      drawTvlBubbles(sortedProtocols.slice(0, 100));
      var tvlBubbleCanvas = document.getElementById('tvlBubbleChart');
      var tvlBubbleWrap = document.getElementById('tvlBubbleWrap');
      if (tvlBubbleCanvas && tvlBubbleWrap) attachBubbleInteraction(tvlBubbleCanvas, tvlBubbleWrap);

      var tvlBubbleRangeTabs = document.getElementById('tvlBubbleRangeTabs');
      if (tvlBubbleRangeTabs) {
        tvlBubbleRangeTabs.addEventListener('click', function (e) {
          var btn = e.target.closest('.tab-btn');
          if (!btn) return;
          tvlBubbleRangeTabs.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
          btn.classList.add('active');
          tvlBubbleRange = btn.getAttribute('data-bubble-range');
          renderTvlBubbleFrame(); // color only — no re-layout needed
        });
      }

      var tvlRankTable = document.getElementById('tvlRankTable');
      if (!tvlRankTable) return;
      var sortKey = 'tvl', sortDir = -1;
      tvlRankTable.querySelectorAll('th[data-sort]').forEach(function (th) {
        th.addEventListener('click', function () {
          var key = th.getAttribute('data-sort');
          if (sortKey === key) sortDir = -sortDir; else { sortKey = key; sortDir = 1; }
          tvlRankTable.querySelectorAll('th').forEach(function (t) {
            t.classList.toggle('sorted', t === th);
            var a = t.querySelector('.sort-arrow'); if (a) a.remove();
          });
          th.insertAdjacentHTML('beforeend', '<span class="sort-arrow">' + (sortDir === 1 ? '▲' : '▼') + '</span>');
          var sorted = tvlRankList.slice().sort(function (a, b) {
            var av = tvlRankCellValue(a, key), bv = tvlRankCellValue(b, key);
            return av < bv ? -sortDir : av > bv ? sortDir : 0;
          });
          renderTvlRank(sorted);
        });
      });
    })
    .catch(function () {
      var el = document.getElementById('tvlRankBody');
      if (el) el.innerHTML = '<tr><td colspan="5" class="loading-note">불러오지 못했어요</td></tr>';
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
