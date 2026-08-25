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

  // "얼마나 조용한 노이즈까지 걸러낼지" — 0에 가까운 등락까지 하이라이트에
  // 올라오면 "급등락"이라는 말이 무색해져서, 최소한의 바닥선만 둠. 그 위로는
  // 있는 만큼(적으면 적은 대로) 등락폭 큰 순서로만 보여줌 — 고정된 기준치로
  // "떴다 안 떴다" 하는 것보다 항상 지금 가장 크게 움직인 것부터 보여주는
  // 게 "빨리 알고 대응하기"라는 원래 목적에 더 맞음.
  var HIGHLIGHT_MIN_ABS_PCT = 0.5;
  var HIGHLIGHT_COUNT = 8;

  function renderHighlights(scored) {
    var panel = document.getElementById('newsHighlights');
    if (!panel) return;
    var picked = scored
      .filter(function (s) { return Math.abs(s.pct) >= HIGHLIGHT_MIN_ABS_PCT; })
      .sort(function (a, b) { return Math.abs(b.pct) - Math.abs(a.pct); })
      .slice(0, HIGHLIGHT_COUNT);
    if (!picked.length) {
      panel.innerHTML = '<p class="loading-note">지금은 뉴스 게시 이후 뚜렷하게 움직인 코인이 없어요.</p>';
      return;
    }
    panel.innerHTML = picked.map(function (s) {
      return '<a class="highlight-row" href="' + escapeHtml(s.item.link) + '" target="_blank" rel="noopener">' +
        '<span class="coin-tag">' + escapeHtml(s.coin.symbol.toUpperCase()) + '</span>' +
        pctSpan(s.pct) +
        '<span class="highlight-title">' + escapeHtml(s.item.title) + '</span>' +
        '<span class="highlight-time">게시 ' + timeAgo(s.item.pubDate) + '</span>' +
        '</a>';
    }).join('');
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

    var highlightsPanel = document.getElementById('newsHighlights');
    if (!coins || !coins.length) {
      if (highlightsPanel) highlightsPanel.innerHTML = '<p class="loading-note">시세 정보를 못 가져와서 계산할 수 없어요.</p>';
      return;
    }

    // fill in "게시 후" badges once each matched coin's anchor price
    // resolves, AND collect the same results to rank the highlights panel
    // above — one fetch pass feeds both, so switching tabs/scrolling
    // doesn't trigger it twice.
    var matchedEntries = [];
    items.forEach(function (n, i) {
      var slot = grid.querySelector('[data-badge-slot="' + i + '"][data-coin-id]');
      if (!slot) return;
      var coinId = slot.getAttribute('data-coin-id');
      var coin = coins.find(function (c) { return c.id === coinId; });
      if (!coin) return;
      matchedEntries.push({ item: n, coin: coin, slot: slot });
    });

    if (!matchedEntries.length) { renderHighlights([]); return; }

    var pending = matchedEntries.map(function (entry) {
      return fetchAnchorPrice(entry.coin.id, new Date(entry.item.pubDate).getTime()).then(function (anchor) {
        if (anchor == null || !entry.coin.current_price) return null;
        var pct = (entry.coin.current_price - anchor) / anchor * 100;
        entry.slot.innerHTML = coinBadgeHtml(entry.coin, pct);
        return { item: entry.item, coin: entry.coin, pct: pct };
      });
    });

    Promise.all(pending).then(function (results) {
      renderHighlights(results.filter(Boolean));
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

  Promise.all([newsPromise, coinsPromise])
    .then(function (results) { renderNews(results[0], results[1]); })
    .catch(function () {
      grid.innerHTML = '<p class="loading-note">불러오지 못했어요. 잠시 후 다시 시도해주세요.</p>';
      var highlightsPanel = document.getElementById('newsHighlights');
      if (highlightsPanel) highlightsPanel.innerHTML = '<p class="loading-note">불러오지 못했어요.</p>';
    });
})();
