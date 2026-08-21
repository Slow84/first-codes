(function () {
  var grid = document.getElementById('newsGrid');
  if (!grid) return;

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function timeAgo(pubDate) {
    var diffMin = Math.round((Date.now() - new Date(pubDate).getTime()) / 60000);
    if (diffMin < 1) return '방금 전';
    if (diffMin < 60) return diffMin + '분 전';
    var diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return diffHr + '시간 전';
    return Math.round(diffHr / 24) + '일 전';
  }

  function renderNews(items) {
    if (!items || !items.length) {
      grid.innerHTML = '<p class="loading-note">불러올 뉴스가 없어요.</p>';
      return;
    }
    grid.innerHTML = items.map(function (n) {
      var thumb = n.image
        ? '<img class="video-thumb" src="' + escapeHtml(n.image) + '" alt="" loading="lazy">'
        : '<div class="video-thumb"></div>';
      return '<a class="video-card" href="' + escapeHtml(n.link) + '" target="_blank" rel="noopener">' +
        thumb +
        '<div class="video-body">' +
        '<div class="video-title">' + escapeHtml(n.title) + '</div>' +
        '<div class="video-meta">' + escapeHtml(n.source) + ' · ' + timeAgo(n.pubDate) + '</div>' +
        '</div></a>';
    }).join('');
  }

  fetch('/api/news')
    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
    .then(function (res) {
      if (!res.ok) throw new Error(res.data.error || 'failed');
      renderNews(res.data.items || []);
    })
    .catch(function () {
      grid.innerHTML = '<p class="loading-note">불러오지 못했어요. 잠시 후 다시 시도해주세요.</p>';
    });
})();
