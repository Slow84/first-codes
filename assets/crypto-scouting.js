(function () {
  var MAX_CANDIDATES = 15;
  var DETAIL_DELAY_MS = 2500; // stay well under CoinGecko's free rate limit

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

  function fmtUsd(n) {
    if (n == null) return '-';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    return '$' + n.toLocaleString();
  }

  function shellCard(c) {
    var note = INVESTOR_NOTES[c.id];
    return '<div class="coin-card" id="coin-' + c.id + '">' +
      '<div class="coin-card-head">' +
      '<img src="' + c.image + '" alt="" loading="lazy">' +
      '<strong>' + escapeHtml(c.name) + '</strong>' +
      '<span class="rank-sym">' + escapeHtml(c.symbol.toUpperCase()) + '</span>' +
      '</div>' +
      '<div class="coin-ath">최고점 대비 ' + c.ath_change_percentage.toFixed(1) + '% · 현재가 ' + fmtUsd(c.current_price) + ' · 시총 순위 #' + c.market_cap_rank + '</div>' +
      '<div class="coin-meta-grid" data-detail="' + c.id + '"><div class="loading-note">개발·커뮤니티 지표 불러오는 중...</div></div>' +
      '<div class="investor-note">주요 투자자·재단 재무건전성: ' + (note ? escapeHtml(note) : '아직 조사 전') + '</div>' +
      '<div class="coin-links"><a href="https://www.coingecko.com/en/coins/' + c.id + '" target="_blank" rel="noopener">CoinGecko에서 자세히 보기 →</a></div>' +
      '</div>';
  }

  function fillDetail(id, detail) {
    var el = document.querySelector('[data-detail="' + id + '"]');
    if (!el) return;
    var dev = detail.developer_data || {};
    var com = detail.community_data || {};
    var items = [
      ['깃허브 스타', fmtNum(dev.stars)],
      ['최근 4주 커밋', fmtNum(dev.commit_count_4_weeks)],
      ['트위터 팔로워', fmtNum(com.twitter_followers)],
      ['텔레그램 유저', fmtNum(com.telegram_channel_user_count)],
      ['레딧 구독자', fmtNum(com.reddit_subscribers)]
    ];
    el.innerHTML = items.map(function (it) {
      return '<div class="coin-meta-item"><span class="coin-meta-label">' + it[0] + '</span><span class="coin-meta-value">' + it[1] + '</span></div>';
    }).join('');
  }

  function failDetail(id) {
    var el = document.querySelector('[data-detail="' + id + '"]');
    if (el) el.innerHTML = '<div class="loading-note">개발·커뮤니티 지표를 불러오지 못했어요</div>';
  }

  function fetchDetailsSequentially(list, i) {
    if (i >= list.length) return;
    fetch('https://api.coingecko.com/api/v3/coins/' + list[i].id + '?localization=false&tickers=false&market_data=false&community_data=true&developer_data=true&sparkline=false')
      .then(function (r) { return r.json(); })
      .then(function (detail) { fillDetail(list[i].id, detail); })
      .catch(function () { failDetail(list[i].id); })
      .finally(function () { setTimeout(function () { fetchDetailsSequentially(list, i + 1); }, DETAIL_DELAY_MS); });
  }

  fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false')
    .then(function (r) { return r.json(); })
    .then(function (coins) {
      var candidates = coins
        .filter(function (c) { return typeof c.ath_change_percentage === 'number' && c.ath_change_percentage <= -90; })
        .slice(0, MAX_CANDIDATES);

      document.getElementById('loadingMsg').remove();
      var listEl = document.getElementById('candidateList');
      if (!candidates.length) {
        listEl.innerHTML = '<p class="loading-note">지금은 조건에 맞는 코인이 없어요.</p>';
        return;
      }
      listEl.innerHTML = candidates.map(shellCard).join('');
      fetchDetailsSequentially(candidates, 0);
    })
    .catch(function () {
      document.getElementById('loadingMsg').textContent = '데이터를 불러오지 못했어요. 잠시 후 새로고침해주세요.';
    });
})();
