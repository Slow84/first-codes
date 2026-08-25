(function () {
  var grid = document.getElementById('newsGrid');
  if (!grid) return;

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  // same demo key as crypto-market.js/crypto-scouting.js — meant for
  // client-side use (CoinGecko's own model for the free Demo tier), it
  // only raises our own request quota, not a billing credential.
  var CG_DEMO_KEY = 'CG-FMfLVSBE5qcpYQ2R9RYTVogy';
  function cgUrl(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return 'https://api.coingecko.com' + path + sep + 'x_cg_demo_api_key=' + CG_DEMO_KEY;
  }

  // for a single unit price (not an aggregate like market cap) — same as crypto-market.js
  function fmtUsdPrice(n) {
    var digits = n < 1 ? 4 : 2;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  function pctSpan(pct) {
    var cls = pct >= 0 ? 'up' : 'down';
    var sign = pct >= 0 ? '+' : '';
    return '<span class="rank-change ' + cls + '">' + sign + pct.toFixed(2) + '%</span>';
  }

  function timeAgo(pubDate) {
    var diffMin = Math.round((Date.now() - new Date(pubDate).getTime()) / 60000);
    if (diffMin < 1) return '방금 전';
    if (diffMin < 60) return diffMin + '분 전';
    var diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return diffHr + '시간 전';
    return Math.round(diffHr / 24) + '일 전';
  }

  // ---- top 10 gainers / losers (same data source as crypto-market.js's
  // top5 table) ----
  function newsSearchUrl(coinName) {
    return 'https://news.google.com/search?q=' + encodeURIComponent(coinName + ' crypto') + '&hl=ko&gl=KR&ceid=KR:ko';
  }

  function renderRankList(tbodyId, list) {
    var el = document.getElementById(tbodyId);
    if (!el) return;
    if (!list.length) { el.innerHTML = '<tr><td colspan="4" class="loading-note">데이터가 없어요</td></tr>'; return; }
    el.innerHTML = list.map(function (c) {
      return '<tr>' +
        '<td><div class="coin-cell"><strong>' + escapeHtml(c.name) + '</strong><span>' + escapeHtml(c.symbol.toUpperCase()) + '</span></div></td>' +
        '<td>' + fmtUsdPrice(c.current_price || 0) + '</td>' +
        '<td>' + pctSpan(c.price_change_percentage_24h || 0) + '</td>' +
        '<td><a class="news-link" href="' + newsSearchUrl(c.name) + '" target="_blank" rel="noopener">검색 →</a></td>' +
        '</tr>';
    }).join('');
  }

  // ---- coin-mention matching (best-effort, not exhaustive) ----
  // Only matched against the top MATCH_POOL_SIZE coins by market cap —
  // small/mid-cap coin *names* are often generic English words ("Movement",
  // "Render") and would false-positive constantly on general prose; top
  // coins are what general crypto-news headlines overwhelmingly discuss
  // anyway (verified against real headlines before building this).
  var MATCH_POOL_SIZE = 60;
  // headlines usually use a coin's prose name/brand, not its ticker
  // ("Bitcoin hits $80,000", not "BTC hits $80,000") — this covers the
  // handful of major coins whose common prose name differs from CoinGecko's
  // official `name` field.
  var ALIASES = {
    bitcoin: ['bitcoin'],
    ethereum: ['ethereum', 'ether'],
    ripple: ['ripple', 'xrp'],
    dogecoin: ['dogecoin'],
    solana: ['solana'],
    cardano: ['cardano'],
    tron: ['tron'],
    binancecoin: ['bnb', 'binance coin'],
    'avalanche-2': ['avalanche'],
    polkadot: ['polkadot'],
    litecoin: ['litecoin'],
    chainlink: ['chainlink'],
    'shiba-inu': ['shiba inu'],
    stellar: ['stellar lumens', 'stellar (xlm)'],
    monero: ['monero'],
    uniswap: ['uniswap'],
    aave: ['aave'],
    'usd-coin': ['usdc', 'circle'],
    tether: ['tether', 'usdt']
  };
  // common short acronyms that would otherwise collide with real coin
  // tickers (US, ETF, SEC show up constantly in crypto-regulation news)
  var TICKER_BLOCKLIST = ['US', 'USA', 'USD', 'ETF', 'ETFS', 'CEO', 'CFO', 'CFTC', 'SEC', 'API', 'ATH',
    'NFT', 'DEX', 'CEX', 'ICO', 'IPO', 'GDP', 'LLC', 'INC', 'FBI', 'DOJ', 'IRS', 'ASST'];

  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function matchCoin(title, coins) {
    var pool = coins.slice(0, MATCH_POOL_SIZE);
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      var names = ALIASES[c.id] || [c.name.toLowerCase()];
      for (var j = 0; j < names.length; j++) {
        var re = new RegExp('\\b' + escapeRegex(names[j]) + '\\b', 'i');
        if (re.test(title)) return c;
      }
    }
    // fallback: an ALL-CAPS ticker as its own word (case-sensitive, so a
    // lowercase/mixed-case coincidence like "One" the pronoun doesn't match)
    for (var i = 0; i < pool.length; i++) {
      var c = pool[i];
      var sym = (c.symbol || '').toUpperCase();
      if (sym.length < 3 || TICKER_BLOCKLIST.indexOf(sym) !== -1) continue;
      var re = new RegExp('\\b' + escapeRegex(sym) + '\\b');
      if (re.test(title)) return c;
    }
    return null;
  }

  // price at the moment the article was published, so we can show how the
  // coin has moved *since* — CoinGecko's demo key returns 5min-granularity
  // history for short windows (verified before building this), so the
  // first point in this range is a close-enough anchor.
  function fetchAnchorPrice(coinId, pubDateMs) {
    var from = Math.floor(pubDateMs / 1000);
    var to = Math.floor(Date.now() / 1000);
    if (to - from < 300) return Promise.resolve(null); // too fresh to show meaningful movement yet
    return fetch(cgUrl('/api/v3/coins/' + coinId + '/market_chart/range?vs_currency=usd&from=' + from + '&to=' + to))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var prices = data && data.prices;
        return prices && prices.length ? prices[0][1] : null;
      })
      .catch(function () { return null; });
  }

  function coinBadgeHtml(coin, sincePublishPct) {
    var html = '<div class="news-coin-badge">' +
      '<span class="coin-tag">' + escapeHtml(coin.symbol.toUpperCase()) + '</span>' +
      '<span>' + fmtUsdPrice(coin.current_price || 0) + '</span>' +
      pctSpan(coin.price_change_percentage_24h || 0) +
      '<span class="badge-label">24H</span>';
    if (sincePublishPct != null) {
      html += '<span class="badge-sep">·</span>' + pctSpan(sincePublishPct) + '<span class="badge-label">게시 후</span>';
    }
    html += '</div>';
    return html;
  }

  function renderNews(items, coins) {
    if (!items || !items.length) {
      grid.innerHTML = '<p class="loading-note">불러올 뉴스가 없어요.</p>';
      return;
    }
    grid.innerHTML = items.map(function (n, i) {
      var thumb = n.image
        ? '<img class="video-thumb" src="' + escapeHtml(n.image) + '" alt="" loading="lazy">'
        : '<div class="video-thumb"></div>';
      var matched = coins && coins.length ? matchCoin(n.title, coins) : null;
      return '<a class="video-card" href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' +
        thumb +
        '<div class="video-body">' +
        '<div class="video-title">' + escapeHtml(n.title) + '</div>' +
        '<div class="video-meta">' + escapeHtml(n.source) + ' · ' + timeAgo(n.pubDate) + '</div>' +
        '<div data-badge-slot="' + i + '"' + (matched ? ' data-coin-id="' + escapeHtml(matched.id) + '"' : '') + '>' +
        (matched ? coinBadgeHtml(matched, null) : '') +
        '</div>' +
        '</div></a>';
    }).join('');

    // fill in "게시 후" badges once each matched coin's anchor price
    // resolves — done as a second pass so the page shows current-price
    // badges immediately instead of waiting on ~15 historical-price calls.
    if (!coins || !coins.length) return;
    items.forEach(function (n, i) {
      var slot = grid.querySelector('[data-badge-slot="' + i + '"][data-coin-id]');
      if (!slot) return;
      var coinId = slot.getAttribute('data-coin-id');
      var coin = coins.find(function (c) { return c.id === coinId; });
      if (!coin) return;
      fetchAnchorPrice(coinId, new Date(n.pubDate).getTime()).then(function (anchor) {
        if (anchor == null || !coin.current_price) return;
        var sincePct = (coin.current_price - anchor) / anchor * 100;
        slot.innerHTML = coinBadgeHtml(coin, sincePct);
      });
    });
  }

  var newsPromise = fetch('/api/news')
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.data.error || 'failed');
      return res.data.items || [];
    });

  var coinsPromise = fetch(cgUrl('/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=24h'))
    .then(function (r) { return r.ok ? r.json() : []; })
    .catch(function () { return []; });

  coinsPromise.then(function (coins) {
    var valid = coins.filter(function (c) { return typeof c.price_change_percentage_24h === 'number'; });
    var gainers = valid.slice().sort(function (a, b) { return b.price_change_percentage_24h - a.price_change_percentage_24h; }).slice(0, 10);
    var losers = valid.slice().sort(function (a, b) { return a.price_change_percentage_24h - b.price_change_percentage_24h; }).slice(0, 10);
    renderRankList('newsTopGainers', gainers);
    renderRankList('newsTopLosers', losers);
  });

  Promise.all([newsPromise, coinsPromise])
    .then(function (results) { renderNews(results[0], results[1]); })
    .catch(function () {
      grid.innerHTML = '<p class="loading-note">불러오지 못했어요. 잠시 후 다시 시도해주세요.</p>';
    });
})();
