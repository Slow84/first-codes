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
        krwRatePromise.then(function (rate) {
          var usdText = rate ? ' <span class="coin-price-usd">(' + fmtUsdPrice(last / rate) + ')</span>' : '';
          priceEl.innerHTML = fmtKrwPrice(last) + usdText + '<span class="chg ' + cls + '">' + sign + chg.toFixed(2) + '%</span>';
        });
      }
    }

    function load(days) {
      activeDays = days;
      if (byRange[days]) { apply(byRange[days]); return; } // already fetched this range before

      queueFetch(cgUrl('/api/v3/coins/' + coinId + '/market_chart?vs_currency=krw&days=' + days))
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

  function pctSpan(pct) {
    var cls = pct >= 0 ? 'up' : 'down';
    var sign = pct >= 0 ? '+' : '';
    return '<span class="rank-change ' + cls + '">' + sign + pct.toFixed(2) + '%</span>';
  }

  // ---- top 5 gainers / losers (CoinGecko) ----
  function renderRankList(id, list, rate) {
    var el = document.getElementById(id);
    if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="loading-note">데이터가 없어요</td></tr>'; return; }
    el.innerHTML = list.map(function (c) {
      var vol = c.total_volume || 0;
      var volText = fmtUsd(vol) + (rate ? ' · ' + fmtKrw(vol * rate) : '');
      var price = c.current_price || 0;
      var priceText = fmtUsdPrice(price) + (rate ? ' · ' + fmtKrwPrice(price * rate) : '');
      return '<tr>' +
        '<td><div class="coin-cell"><strong>' + escapeHtml(c.name) + '</strong><span>' + escapeHtml(c.symbol.toUpperCase()) + '</span></div></td>' +
        '<td>' + priceText + '</td>' +
        '<td>' + pctSpan(c.price_change_percentage_24h) + '</td>' +
        '<td class="cell-muted">' + volText + '</td>' +
        '</tr>';
    }).join('');
  }

  queueFetch(cgUrl('/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h'))
    .then(function (coins) {
      var valid = coins.filter(function (c) { return typeof c.price_change_percentage_24h === 'number'; });
      var gainers = valid.slice().sort(function (a, b) { return b.price_change_percentage_24h - a.price_change_percentage_24h; }).slice(0, 5);
      var losers = valid.slice().sort(function (a, b) { return a.price_change_percentage_24h - b.price_change_percentage_24h; }).slice(0, 5);
      krwRatePromise.then(function (rate) {
        renderRankList('topGainers', gainers, rate);
        renderRankList('topLosers', losers, rate);
      });
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
      krwRatePromise.then(function (rate) {
        var krwText = rate ? ' <span class="stat-sub">(' + fmtKrw(last * rate) + ')</span>' : '';
        document.getElementById('tvlNow').innerHTML = fmtUsd(last) + krwText;
      });
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

  function drawStablecoinChart(coinId, canvasId, statusId) {
    var canvas = document.getElementById(canvasId);
    var statusEl = document.getElementById(statusId);
    if (!canvas) return;
    queueFetch(cgUrl('/api/v3/coins/' + coinId + '/market_chart?vs_currency=usd&days=90'))
      .then(function (data) {
        var caps = (data.market_caps || []);
        if (!caps.length) throw new Error('no data');
        drawCoinChart(canvas, caps, [], fmtUsd);
        if (statusEl) statusEl.textContent = '';
      })
      .catch(function () {
        if (statusEl) statusEl.textContent = '차트를 불러오지 못했어요. 잠시 후 새로고침해주세요.';
      });
  }
  drawStablecoinChart('tether', 'usdtChart', 'usdtChartStatus');
  drawStablecoinChart('usd-coin', 'usdcChart', 'usdcChartStatus');
})();
