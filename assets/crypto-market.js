(function () {
  // TradingView widget loader moved to assets/tv-widget.js (shared, since
  // it was never actually crypto-specific — crypto/market.html now loads
  // that file directly instead of this one containing its own copy).

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
    // was only ever exercised with large aggregates (market caps, TVL
    // totals) before, so the "else" branch below 1M never got a K tier
    // and just printed the raw number — harmless until the bubble
    // chart's $-delta feature started feeding it small day-over-day
    // amounts (e.g. -$71,775.787, decimals and all).
    if (n >= 1e9) s = (n / 1e9).toFixed(2) + 'B';
    else if (n >= 1e6) s = (n / 1e6).toFixed(1) + 'M';
    else if (n >= 1e3) s = (n / 1e3).toFixed(1) + 'K';
    else s = Math.round(n).toLocaleString();
    return (neg ? '-$' : '$') + s;
  }

  // same as fmtUsd but always shows a sign — for a delta amount, "$120M"
  // reads ambiguous (grew or shrank by that much?) while "+$120M" doesn't.
  function fmtUsdSigned(n) {
    return (n >= 0 ? '+' : '') + fmtUsd(n);
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
    div.textContent = s == null ? '' : String(s);
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
  // Places each circle by walking outward from the center, radius growing
  // a little every attempt, testing a FRESH random angle at every step —
  // not a fixed angle increment. That distinction matters: an earlier
  // version incremented angle by the same fixed step for every item,
  // starting every item's search from angle=0 — which meant every circle's
  // final position was, by construction, a point sampled off one single
  // shared spiral curve (verified directly: 0.000 rad average deviation
  // from that curve, i.e. literally every circle sat exactly on it). Small,
  // similarly-sized circles filled that curve densely enough to read as an
  // obvious visible spiral/vortex — most noticeable on a quiet 1d tab,
  // where most circles are near-identical tiny sizes. Randomizing the
  // angle on every attempt (radius still grows each try so the search
  // still terminates outward) means there's no shared curve left for
  // circles to line up on — re-verified the same way: average deviation
  // from the old curve jumped to ~1.6 rad, indistinguishable from random.
  function packCircles(items, cx, cy) {
    var placed = [];
    items.forEach(function (item, i) {
      if (i === 0) { item.x = cx; item.y = cy; placed.push(item); return; }
      var radius = 0, x = cx, y = cy, ok = false, tries = 0;
      while (!ok && tries < 9000) {
        radius += 0.35;
        var angle = Math.random() * Math.PI * 2;
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
  var tvlBubbleFullList = []; // the raw (un-laid-out) protocol list, so a range-tab click can re-layout without refetching
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

  // radius ∝ |Δamount|^SIZE_POWER. Pure area-proportional (0.5, i.e. sqrt)
  // is the "honest" bubble-chart standard, but the user found the earlier
  // TVL-sized version made mid-size protocols look too similar — bumped to
  // 0.65 per their explicit call, trading some strict-proportionality
  // honesty for more visible spread between small/mid movers.
  var SIZE_POWER = 0.65;

  // one shared scale factor for BOTH ranges, computed once from whichever
  // of 일/주 has the larger total |Δamount| (weekly moves are usually
  // bigger in aggregate, but this doesn't assume that). Without this, each
  // tab independently rescaled itself to fill ~50% of the canvas — so even
  // though 주 amounts were routinely 3-6x bigger than 일 in dollar terms,
  // the *relative* proportions between circles stayed similar and the
  // whole chart looked barely different, which is exactly what was
  // reported. Using one shared k means the smaller-magnitude range's
  // circles come out systematically smaller (not restretched to fill the
  // canvas), so switching tabs visibly shows "less happened today."
  var tvlBubbleSharedK = 1;
  function computeTvlBubbleSharedK(list, w, h) {
    var sums = ['1d', '7d'].map(function (range) {
      return list.reduce(function (s, p) {
        var changeVal = range === '7d' ? (p.change_7d || 0) : (p.change_1d || 0);
        var deltaAmount = changeVal ? p.tvl * changeVal / (100 + changeVal) : 0;
        return s + Math.pow(Math.abs(deltaAmount) || 1, SIZE_POWER * 2);
      }, 0);
    });
    // calibrate against the LARGER-magnitude range so *it* ends up filling
    // the canvas (minimal shrink needed) — verified via simulation that
    // picking the smaller one backwards (an earlier mistake here) instead
    // over-shrinks the bigger range to match the smaller one, the exact
    // opposite of the intended effect. With this direction the range with
    // bigger $ moves that day genuinely fills more of the canvas than the
    // other — re-verified 2026-08-24 against live data (that day: 7d 77%
    // filled vs 1d 19% filled). Exact numbers move with the market day to
    // day; what matters is the two ranges stay visibly different sizes
    // instead of both re-normalizing to look similar.
    var refSumPow = Math.max.apply(null, sums);
    tvlBubbleSharedK = Math.sqrt((0.5 * w * h) / (Math.PI * refSumPow));
  }

  function computeTvlBubbleLayout(list, w, h, range) {
    // circle size is how much TVL actually *moved* over the selected
    // period (일/주), not the static current total — so switching tabs
    // re-ranks who's big (today's/this week's biggest movers), not just
    // recolors the same TVL-leaderboard sizes. Needs a full re-layout
    // (not just a redraw) since every radius depends on which range is
    // active — this function re-runs on every tab click, not just once.
    var withDelta = list.map(function (p) {
      var changeVal = range === '7d' ? (p.change_7d || 0) : (p.change_1d || 0);
      var deltaAmount = changeVal ? p.tvl * changeVal / (100 + changeVal) : 0;
      return { p: p, changeVal: changeVal, deltaAmount: deltaAmount };
    });

    var k = tvlBubbleSharedK;
    // radius floor added *in quadrature* (√(r²+floor²)), not a hard
    // Math.max clamp — a hard clamp was tried twice (once pre-fit, once
    // post-fit) and both times collapsed every circle already under the
    // floor to the exact same size, recreating the "everything looks the
    // same" complaint each time. Quadrature guarantees the same minimum
    // at r=0 while staying strictly monotonic, so differently-sized small
    // movers still come out differently sized. Applied *before* packing
    // (not after fitting, which was also tried) so the packer itself
    // reserves the right amount of space for the boosted sizes — applying
    // it after packing caused real overlaps, since neighbors' gaps had
    // only been sized for their smaller pre-floor radii.
    // lowered from 10 to 2 per feedback: at 10, two genuinely different
    // small movers (e.g. $135M vs $39M, a real 3.5x gap) came out looking
    // like near-identical circles, because the floor term dominated the
    // quadrature sum for anything with a small raw radius. At 2, small
    // circles stay small (down to near-invisible dots for the tiniest
    // movers) and real differences between them show through — the
    // tradeoff is those tiniest circles need much more zoom to read,
    // which is the explicitly requested direction (no upper zoom limit
    // was wanted either — see tvlBubbleMaxScale below).
    var SOFT_MIN_R = 2;

    var items = withDelta.map(function (d) {
      var p = d.p;
      var raw = k * Math.pow(Math.abs(d.deltaAmount) || 1, SIZE_POWER);
      return {
        name: p.name, tvl: p.tvl, slug: p.slug, symbol: p.symbol,
        changeVal: d.changeVal, deltaAmount: d.deltaAmount,
        r: Math.sqrt(raw * raw + SOFT_MIN_R * SOFT_MIN_R)
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
    // capped at 1 (never grow, only ever shrink to avoid overflow) — this
    // is what makes the shared-k scale above actually mean something: the
    // smaller-magnitude range's packed cluster is legitimately smaller
    // than the canvas, and should stay that way (visible empty margin)
    // instead of being stretched back up to fill it, which would erase
    // the whole point of sharing one scale between the two ranges.
    var fitScale = Math.min(1, (w - padding * 2) / (maxX - minX), (h - padding * 2) / (maxY - minY));
    var bboxCx = (minX + maxX) / 2, bboxCy = (minY + maxY) / 2;
    items.forEach(function (it) {
      it.x = w / 2 + (it.x - bboxCx) * fitScale;
      it.y = h / 2 + (it.y - bboxCy) * fitScale;
      it.r = it.r * fitScale;
    });

    // zoom ceiling: how far to zoom so the *actual smallest circle in this
    // layout* becomes comfortably legible (~32px apparent). Derived from
    // the real post-fit minimum rather than a fixed assumption. No tight
    // upper limit per feedback (small circles should stay reachable even
    // if that takes real zoom, not be capped early) — 60x is just a
    // sanity ceiling against a degenerate near-zero minFinalR, not a
    // target. Zooming in on the biggest circle at this ceiling can exceed
    // the viewport if panned onto it — expected "zoomed into one map
    // feature" behavior once the user deliberately zooms that far.
    var minFinalR = Math.min.apply(null, items.map(function (it) { return it.r; }));
    tvlBubbleMaxScale = Math.max(2, Math.min(60, 32 / minFinalR));
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
      // color is entirely about the period's change — direction picks the
      // hue family (green = grew, red = shrank), magnitude picks how
      // deep/saturated it is (barely moved = pale, swung hard = vivid).
      // it.changeVal/it.deltaAmount were computed once per layout (for
      // whichever range was active when the layout was built), not
      // recomputed here, since size itself now depends on the range too —
      // switching tabs re-lays-out, it doesn't just redraw.
      var changeVal = it.changeVal;
      var magT = Math.min(1, Math.abs(changeVal) / TVL_BUBBLE_VOL_CAP[tvlBubbleRange]);
      var hue = changeVal >= 0 ? 150 : 5;
      var lightness = (isDark ? 68 : 88) - (isDark ? 33 : 48) * magT;
      var saturation = 30 + 50 * magT;
      ctx.beginPath();
      ctx.arc(it.x, it.y, it.r, 0, Math.PI * 2);
      ctx.fillStyle = 'hsla(' + hue + ',' + saturation + '%,' + lightness + '%,0.7)';
      ctx.fill();
      ctx.lineWidth = 1.5 / tvlBubbleView.scale;
      ctx.strokeStyle = 'hsl(' + hue + ',' + saturation + '%,' + Math.max(18, lightness - 20) + '%)';
      ctx.stroke();
    });

    // text is drawn in a *second pass, in screen space* (transform reset
    // to just the device-pixel-ratio) instead of inside the zoomed
    // transform above. Drawing it inside the zoomed transform (the first
    // version of this) meant the text-width budget was always exactly
    // proportional to the circle's *world* radius — zooming in scaled the
    // circle and its text budget by the same factor, so the ratio between
    // them never changed and a circle stuck showing "L…" kept showing
    // "L…" no matter how far in you zoomed. Computing each circle's
    // on-screen (apparent) position/size here and sizing the font/width
    // budget from *that* instead means zooming in genuinely grows the
    // available text budget, revealing more of the ticker as you zoom —
    // which is the whole point of being able to zoom into a small circle.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var scale = tvlBubbleView.scale, ox = tvlBubbleView.ox, oy = tvlBubbleView.oy;
    // 26px is the normal "comfortably legible without zooming" gate, but on
    // a quiet day the 일 tab's biggest mover can be well under that (e.g.
    // 18.5px when the day's biggest swing is modest) — a flat 26px cutoff
    // then hides EVERY label, including the single biggest circle, which
    // reads as broken rather than "nothing moved much today." drawOrder is
    // sorted biggest-first, so drawOrder[0].r is this layout's own max —
    // scale the gate down to 90% of that (never above 26) so the biggest
    // circle in whichever tab is active always gets a label by default.
    var layoutMaxApparentR = (drawOrder.length ? drawOrder[0].r : 0) * scale;
    var textGate = Math.min(26, layoutMaxApparentR * 0.9);
    drawOrder.forEach(function (it) {
      var apparentR = it.r * scale;
      if (apparentR < textGate) return;
      var screenX = it.x * scale + ox;
      var screenY = it.y * scale + oy;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle'; // so fillText's y is each line's own visual center, not its alphabetic baseline — makes symmetric stacking around it.y exact instead of approximate
      ctx.fillStyle = isDark ? '#fff' : '#18181b';
      var nameFont = Math.max(9, Math.min(34, apparentR / 3.4));
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
      // circle size. Budget is now in screen pixels (apparentR-based), so
      // it actually grows as you zoom in, instead of staying a fixed
      // fraction of a radius that scales in lockstep with the circle.
      var maxTextWidth = apparentR * 1.4;
      if (ctx.measureText(label).width > maxTextWidth) {
        while (label.length > 1 && ctx.measureText(label + '…').width > maxTextWidth) {
          label = label.slice(0, -1);
        }
        label += '…';
      }
      // how much TVL actually moved over the selected period — also
      // precomputed in the layout step now that it drives circle size too.
      var deltaAmount = it.deltaAmount;
      var valueFont = Math.max(7.5, Math.min(28, apparentR / 4.6));
      var lineGap = nameFont * 0.5 + valueFont * 0.5 + 1;
      ctx.fillText(label, screenX, screenY - lineGap / 2);
      ctx.font = '600 ' + valueFont + 'px Inter, sans-serif';
      // direction (grew/shrank) shown via text color here, separate from
      // the circle's own hue (which encodes |change| magnitude, not sign)
      ctx.fillStyle = deltaAmount >= 0 ? (cssVar('--good') || '#1F7A4C') : (cssVar('--warn') || '#B23A2E');
      ctx.fillText(fmtUsdSigned(deltaAmount), screenX, screenY + lineGap / 2);
    });
  }

  function drawTvlBubbles(list) {
    var canvas = document.getElementById('tvlBubbleChart');
    if (!canvas || !list.length) return;
    // a range-tab click re-calls this with the exact same cached array
    // (see the click handler below) — only a genuinely new dataset should
    // recalibrate the shared scale, not every tab switch.
    var isNewData = list !== tvlBubbleFullList;
    tvlBubbleFullList = list;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    tvlBubbleCanvasSize = { w: w, h: h };
    if (isNewData) computeTvlBubbleSharedK(list, w, h);
    tvlBubbleItems = computeTvlBubbleLayout(list, w, h, tvlBubbleRange);
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
      var changeLabel = tvlBubbleRange === '7d' ? '7일' : '24H';
      tip.innerHTML = '<div class="chart-tooltip-date">' + escapeHtml(hit.name) + '</div>' +
        '<div class="chart-tooltip-val">' + fmtUsd(hit.tvl) + '</div>' +
        '<div class="chart-tooltip-sub">' + pctSpan(hit.changeVal || 0) + ' (' + changeLabel + ')</div>';
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
          drawTvlBubbles(tvlBubbleFullList); // full re-layout — circle size itself depends on the range now, not just color
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
