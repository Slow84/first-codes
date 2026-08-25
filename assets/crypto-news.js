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
  // "급등락" attention threshold — direction doesn't matter here (a -5%
  // plunge needs just as fast a reaction as a +5% pump), so both get the
  // same red-border treatment rather than color-coding by up/down.
  var SPIKE_THRESHOLD_PCT = 5;

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
      var spike = Math.abs(s.pct) >= SPIKE_THRESHOLD_PCT ? ' price-spike' : '';
      return '<a class="highlight-row' + spike + '" href="' + escapeHtml(s.item.link) + '" target="_blank" rel="noopener">' +
        '<span class="coin-tag">' + escapeHtml(s.coin.symbol.toUpperCase()) + '</span>' +
        pctSpan(s.pct) +
        '<span class="highlight-title">' + escapeHtml(s.item.title) + '</span>' +
        '<span class="highlight-time">게시 ' + timeAgo(s.item.pubDate) + '</span>' +
        '</a>';
    }).join('');
  }

  // grid focuses on "현황판" — what's happening right now — so only very
  // fresh articles get a full card; anything older moves to the archive
  // table at the bottom instead of cluttering the main view.
  var FRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

  function renderArchive(items) {
    var el = document.getElementById('newsArchive');
    if (!el) return;
    // RSS gives us no popularity/view-count signal at all (CoinDesk/
    // Cointelegraph don't publish one) — so this is ordered by recency,
    // not "많이 본" — flagged to the user rather than faking a view count.
    var top10 = items.slice(0, 10);
    if (!top10.length) { el.innerHTML = '<tr><td colspan="3" class="loading-note">더 지난 뉴스가 없어요</td></tr>'; return; }
    el.innerHTML = top10.map(function (n) {
      return '<tr>' +
        '<td><a class="archive-title-link" href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' + escapeHtml(n.title) + '</a></td>' +
        '<td class="cell-muted">' + escapeHtml(n.source) + '</td>' +
        '<td class="cell-muted">' + timeAgo(n.pubDate) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderNews(items, coins) {
    if (!items || !items.length) {
      grid.innerHTML = '<p class="loading-note">불러올 뉴스가 없어요.</p>';
      return;
    }
    var now = Date.now();
    var freshItems = items.filter(function (n) { return now - new Date(n.pubDate).getTime() <= FRESH_WINDOW_MS; });
    var olderItems = items.filter(function (n) { return now - new Date(n.pubDate).getTime() > FRESH_WINDOW_MS; });

    if (!freshItems.length) {
      grid.innerHTML = '<p class="loading-note">최근 2시간 이내 올라온 뉴스가 없어요. 아래 표에서 그 이전 뉴스를 볼 수 있어요.</p>';
    } else {
      grid.innerHTML = freshItems.map(function (n) {
        var thumb = n.image
          ? '<img class="video-thumb" src="' + escapeHtml(n.image) + '" alt="" loading="lazy">'
          : '<div class="video-thumb"></div>';
        var matched = coins && coins.length ? matchCoin(n.title, coins) : null;
        // keyed by link (not array index) so it still resolves correctly
        // after this array is filtered down from the full 40-item list.
        return '<a class="video-card" href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' +
          thumb +
          '<div class="video-body">' +
          '<div class="video-title">' + escapeHtml(n.title) + '</div>' +
          '<div class="video-meta">' + escapeHtml(n.source) + ' · ' + timeAgo(n.pubDate) + '</div>' +
          '<div data-badge-link="' + escapeHtml(n.link) + '"' + (matched ? ' data-coin-id="' + escapeHtml(matched.id) + '"' : '') + '>' +
          (matched ? coinBadgeHtml(matched, null) : '') +
          '</div>' +
          '</div></a>';
      }).join('');
    }

    renderArchive(olderItems);

    var highlightsPanel = document.getElementById('newsHighlights');
    if (!coins || !coins.length) {
      if (highlightsPanel) highlightsPanel.innerHTML = '<p class="loading-note">시세 정보를 못 가져와서 계산할 수 없어요.</p>';
      return;
    }

    // highlight ranking still considers the FULL article pool (not just
    // the 2-hour-fresh grid) — a real move can take longer than 2 hours to
    // fully play out, so narrowing this too would hide genuinely relevant
    // signals. Only the card grid above is scoped to "right now."
    var slotByLink = {};
    grid.querySelectorAll('[data-badge-link][data-coin-id]').forEach(function (el) {
      slotByLink[el.getAttribute('data-badge-link')] = el;
    });

    var matchedEntries = [];
    items.forEach(function (n) {
      var matched = matchCoin(n.title, coins);
      if (!matched) return;
      matchedEntries.push({ item: n, coin: matched, slot: slotByLink[n.link] || null });
    });

    if (!matchedEntries.length) { renderHighlights([]); return; }

    var pending = matchedEntries.map(function (entry) {
      return fetchAnchorPrice(entry.coin.id, new Date(entry.item.pubDate).getTime()).then(function (anchor) {
        if (anchor == null || !entry.coin.current_price) return null;
        var pct = (entry.coin.current_price - anchor) / anchor * 100;
        if (entry.slot) {
          entry.slot.innerHTML = coinBadgeHtml(entry.coin, pct);
          if (Math.abs(pct) >= SPIKE_THRESHOLD_PCT) {
            var card = entry.slot.closest('.video-card');
            if (card) card.classList.add('price-spike');
          }
        }
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
