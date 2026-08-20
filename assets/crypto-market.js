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

  // ---- interactive per-coin price charts with clickable time ranges ----
  var RANGES = [
    { label: '24시간', days: '1' },
    { label: '7일', days: '7' },
    { label: '30일', days: '30' },
    { label: '3개월', days: '90' },
    { label: '1년', days: '365' },
    { label: '전체', days: 'max' }
  ];

  function fmtKrw(v) {
    if (v >= 1e8) return '₩' + (v / 1e8).toFixed(2) + '억';
    if (v >= 1e4) return '₩' + Math.round(v / 1e4).toLocaleString() + '만';
    return '₩' + Math.round(v).toLocaleString();
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function drawCoinChart(canvas, prices, volumes, fmtFn) {
    fmtFn = fmtFn || fmtKrw;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!prices.length) return;

    var accent = cssVar('--accent') || '#4338CA';
    var border = cssVar('--border') || '#E7E7E4';
    var muted = cssVar('--text-muted') || '#6B6D70';

    var priceH = h * 0.76;
    var volTop = priceH + 12;
    var volH = h - volTop;

    var vals = prices.map(function (p) { return p[1]; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var pad = (max - min) * 0.1 || max * 0.02;
    var yMin = min - pad, yMax = max + pad;

    function xAt(i) { return prices.length > 1 ? (i / (prices.length - 1)) * w : 0; }
    function yAt(v) { return priceH - ((v - yMin) / (yMax - yMin)) * priceH; }

    // gridlines + price labels
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
  function pumpQueue() {
    if (fetchBusy || !fetchQueue.length) return;
    fetchBusy = true;
    var job = fetchQueue.shift();
    fetch(job.url)
      .then(function (r) { return r.json(); })
      .then(job.resolve)
      .catch(job.reject)
      .finally(function () { setTimeout(function () { fetchBusy = false; pumpQueue(); }, 700); });
  }

  function buildCoinChart(card, coinId) {
    var tabsHtml = RANGES.map(function (r, i) {
      return '<button type="button" class="range-tab' + (i === 0 ? ' active' : '') + '" data-days="' + r.days + '">' + r.label + '</button>';
    }).join('');
    card.insertAdjacentHTML('beforeend',
      '<div class="range-tabs">' + tabsHtml + '</div>' +
      '<div class="coin-price-now">불러오는 중...</div>' +
      '<canvas class="price-canvas"></canvas>'
    );

    var tabsEl = card.querySelector('.range-tabs');
    var priceEl = card.querySelector('.coin-price-now');
    var canvas = card.querySelector('.price-canvas');
    var cache = { prices: [], volumes: [] }; // currently-drawn data, for resize redraws
    var byRange = {}; // days -> { prices, volumes }, so revisiting a range never re-fetches
    var activeDays = null;

    function redraw() { drawCoinChart(canvas, cache.prices, cache.volumes); }

    function apply(data) {
      cache.prices = data.prices || [];
      cache.volumes = data.total_volumes || [];
      redraw();
      if (cache.prices.length) {
        var last = cache.prices[cache.prices.length - 1][1];
        var first = cache.prices[0][1];
        var chg = ((last - first) / first) * 100;
        var cls = chg >= 0 ? 'up' : 'down';
        var sign = chg >= 0 ? '+' : '';
        priceEl.innerHTML = fmtKrw(last) + '<span class="chg ' + cls + '">' + sign + chg.toFixed(2) + '%</span>';
      }
    }

    function load(days) {
      activeDays = days;
      if (byRange[days]) { apply(byRange[days]); return; } // already fetched this range before

      queueFetch('https://api.coingecko.com/api/v3/coins/' + coinId + '/market_chart?vs_currency=krw&days=' + days)
        .then(function (data) {
          if (!data || !data.prices) throw new Error('no data');
          byRange[days] = data;
          if (activeDays === days) apply(data); // ignore if the user already switched tabs
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

    load(RANGES[0].days);

    // redraw from cached data on resize — refetching per resize tick would spam the API
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

  // ---- DeFi TVL (DeFiLlama) — stat tiles + 90-day trend chart ----
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

      var recent = data.slice(-90).map(function (d) { return [d.date * 1000, d.tvl]; });
      var tvlCanvas = document.getElementById('tvlChart');
      if (tvlCanvas) drawCoinChart(tvlCanvas, recent, [], fmtUsd);
    })
    .catch(function () {
      ['tvlNow', 'tvl24h', 'tvl7d'].forEach(function (id) { document.getElementById(id).textContent = '불러오지 못함'; });
    });

  // ---- stablecoin market caps (proxy for USDT/USDC flow) — stats + 90-day chart ----
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

  function drawStablecoinChart(coinId, canvasId) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    queueFetch('https://api.coingecko.com/api/v3/coins/' + coinId + '/market_chart?vs_currency=usd&days=90')
      .then(function (data) {
        var caps = (data.market_caps || []);
        drawCoinChart(canvas, caps, [], fmtUsd);
      })
      .catch(function () {});
  }
  drawStablecoinChart('tether', 'usdtChart');
  drawStablecoinChart('usd-coin', 'usdcChart');
})();
