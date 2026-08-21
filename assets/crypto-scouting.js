(function () {
  var MAX_CANDIDATES = 15;
  var POOL_CONCURRENCY = 4; // confirmed via direct testing the demo key handles 14-15 concurrent calls fine; keeping some headroom since the key is shared across all visitors

  // runs worker(item) over items with up to `concurrency` in flight at once,
  // calling onEach after every settled item and onDone once all are done
  function runPool(items, concurrency, worker, onEach, onDone) {
    var idx = 0, active = 0, doneCount = 0;
    if (!items.length) { onDone(); return; }
    function next() {
      if (idx >= items.length) {
        if (active === 0) onDone();
        return;
      }
      var item = items[idx++];
      active++;
      worker(item).catch(function () {}).then(function () {
        active--;
        doneCount++;
        if (onEach) onEach(doneCount, items.length);
        next();
      });
    }
    for (var c = 0; c < concurrency && c < items.length; c++) next();
  }

  // calls CoinGecko directly — see assets/crypto-market.js for why a
  // Worker-side proxy doesn't work here (CoinGecko 403s Cloudflare's IPs).
  // demo key is fine to ship client-side — see assets/crypto-market.js.
  var CG_DEMO_KEY = 'CG-FMfLVSBE5qcpYQ2R9RYTVogy';
  function cgUrl(path) {
    var sep = path.indexOf('?') === -1 ? '?' : '&';
    return 'https://api.coingecko.com' + path + sep + 'x_cg_demo_api_key=' + CG_DEMO_KEY;
  }

  // 직접 조사해서 채워넣는 수동 메모입니다. coingecko 코인 id를 key로 쓰세요.
  // 예: 'ethereum': '2014년 ICO, a16z 등 다수 VC 투자. 재단 재무 매우 안정적.'
  var INVESTOR_NOTES = {
    // 'some-coin-id': '메모 내용'
  };

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function fmtNum(n) {
    if (n == null) return '-';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtUsdAgg(n) {
    if (n == null) return '-';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + n.toLocaleString();
  }

  function fmtUsdPrice(n) {
    if (n == null) return '-';
    var digits = n < 1 ? 4 : 2;
    return '$' + n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  var table = document.getElementById('candidateTable');
  var tbody = document.getElementById('candidateBody');
  var loadingMsg = document.getElementById('loadingMsg');
  if (!table || !tbody) return;

  var candidates = [];
  var sortKey = 'market_cap_rank';
  var sortDir = 1; // 1 = ascending, -1 = descending

  function cellValue(c, key) {
    switch (key) {
      case 'name': return (c.name || '').toLowerCase();
      case 'current_price': return c.current_price || 0;
      case 'market_cap': return c.market_cap || 0;
      case 'market_cap_rank': return c.market_cap_rank || 0;
      case 'ath_change_percentage': return c.ath_change_percentage || 0;
      case 'total_volume': return c.total_volume || 0;
      case 'exchanges': return c.exchanges == null ? -1 : c.exchanges;
      case 'devScore': return c.devScore == null ? -1 : c.devScore;
      case 'communityScore': return c.communityScore == null ? -1 : c.communityScore;
      default: return 0;
    }
  }

  function renderRow(c) {
    return '<tr>' +
      '<td><a class="coin-cell coin-link" href="https://www.coingecko.com/en/coins/' + c.id + '" target="_blank" rel="noopener">' +
        '<img src="' + c.image + '" alt="" loading="lazy">' +
        '<strong>' + escapeHtml(c.name) + '</strong><span>' + escapeHtml(c.symbol.toUpperCase()) + '</span>' +
      '</a></td>' +
      '<td>' + fmtUsdPrice(c.current_price) + '</td>' +
      '<td>' + fmtUsdAgg(c.market_cap) + '</td>' +
      '<td>#' + (c.market_cap_rank || '-') + '</td>' +
      '<td class="cell-warn">' + (c.ath_change_percentage != null ? c.ath_change_percentage.toFixed(1) + '%' : '-') + '</td>' +
      '<td>' + fmtUsdAgg(c.total_volume) + '</td>' +
      '<td class="cell-muted">' + (c.exchanges != null ? c.exchanges : '준비중') + '</td>' +
      '<td>' + (c.devScore != null ? fmtNum(c.devScore) : '<span class="cell-muted">불러오는 중</span>') + '</td>' +
      '<td>' + (c.communityScore != null ? fmtNum(c.communityScore) : '<span class="cell-muted">불러오는 중</span>') + '</td>' +
      '</tr>';
  }

  function render() {
    var sorted = candidates.slice().sort(function (a, b) {
      var av = cellValue(a, sortKey), bv = cellValue(b, sortKey);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });
    tbody.innerHTML = sorted.map(renderRow).join('');

    table.querySelectorAll('th').forEach(function (th) {
      var key = th.getAttribute('data-sort');
      th.classList.toggle('sorted', key === sortKey);
      var arrow = th.querySelector('.sort-arrow');
      if (arrow) arrow.remove();
      if (key === sortKey) {
        th.insertAdjacentHTML('beforeend', '<span class="sort-arrow">' + (sortDir === 1 ? '▲' : '▼') + '</span>');
      }
    });
  }

  table.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-sort');
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = 1; }
      render();
    });
  });

  function fetchDetails() {
    runPool(candidates, POOL_CONCURRENCY, function (c) {
      return fetch(cgUrl('/api/v3/coins/' + c.id + '?localization=false&tickers=false&market_data=false&community_data=true&developer_data=true&sparkline=false'))
        .then(function (r) { return r.json(); })
        .then(function (detail) {
          var dev = detail.developer_data || {};
          var com = detail.community_data || {};
          c.devScore = dev.stars != null ? dev.stars : 0;
          c.communityScore = (com.twitter_followers || 0) + (com.telegram_channel_user_count || 0) + (com.reddit_subscribers || 0);
        })
        .catch(function () { c.devScore = 0; c.communityScore = 0; });
    }, function () { render(); }, function () {});
  }

  // scan market-cap rank 500-4000 instead of the top 250 — coins that
  // famous already aren't really "hidden gems." 250-per-page, so that's
  // pages 3 through 16 (rank 501-4000).
  var START_PAGE = 3, END_PAGE = 16;
  var allCoins = [];

  function fetchPages() {
    var pages = [];
    for (var p = START_PAGE; p <= END_PAGE; p++) pages.push(p);
    runPool(pages, POOL_CONCURRENCY, function (page) {
      return fetch(cgUrl('/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=' + page + '&sparkline=false'))
        .then(function (r) { return r.json(); })
        .then(function (coins) {
          if (Array.isArray(coins)) allCoins = allCoins.concat(coins);
        })
        .catch(function () {});
    }, function (done, total) {
      if (loadingMsg) loadingMsg.textContent = '시가총액 500~4000위 코인을 불러오는 중... (' + done + '/' + total + ')';
    }, finishLoading);
  }

  function finishLoading() {
    candidates = allCoins
      .filter(function (c) { return typeof c.ath_change_percentage === 'number' && c.ath_change_percentage <= -90; })
      .slice(0, MAX_CANDIDATES)
      .map(function (c) {
        c.exchanges = null;
        c.devScore = null;
        c.communityScore = null;
        return c;
      });

    if (loadingMsg) loadingMsg.remove();
    if (!candidates.length) {
      table.insertAdjacentHTML('afterend', '<p class="loading-note">지금은 조건에 맞는 코인이 없어요.</p>');
      return;
    }
    table.style.display = '';
    render();
    fetchDetails();
  }

  fetchPages();
})();
