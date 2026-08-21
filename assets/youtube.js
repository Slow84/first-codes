(function () {
  var grid = document.getElementById('videoGrid');
  var regionTabsEl = document.getElementById('regionTabs');
  var rangeTabsEl = document.getElementById('rangeTabs');
  var categoryTabsEl = document.getElementById('categoryTabs');
  if (!grid || !rangeTabsEl) return;

  // KR gets a narrower set — sports/gaming/comedy/education were tried and
  // dropped after testing found almost no genuinely Korean content in those
  // categories (see worker.js CATEGORY_IDS comment). Global doesn't have
  // that data-scarcity problem, so it keeps the full set.
  var CATEGORY_SETS = {
    KR: [['all', '전체'], ['news', '뉴스/시사'], ['music', '음악'], ['entertainment', '엔터테인먼트']],
    US: [['all', '전체'], ['news', '뉴스/시사'], ['sports', '스포츠'], ['gaming', '게임'], ['music', '음악'], ['entertainment', '엔터테인먼트'], ['comedy', '코미디'], ['education', '교육']]
  };

  var cache = {}; // "region:range:category" -> videos
  var currentRegion = 'KR';
  var currentRange = 'today';
  var currentCategory = 'all';

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function fmtViews(n) {
    n = Number(n);
    if (!n) return '-';
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '억';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '만';
    return n.toLocaleString();
  }

  function renderVideos(videos) {
    if (!videos || !videos.length) {
      grid.innerHTML = '<p class="loading-note">불러올 영상이 없어요.</p>';
      return;
    }
    grid.innerHTML = videos.map(function (v, i) {
      return '<a class="video-card" href="https://www.youtube.com/watch?v=' + encodeURIComponent(v.id) + '" target="_blank" rel="noopener">' +
        '<img class="video-thumb" src="' + escapeHtml(v.thumbnail) + '" alt="" loading="lazy">' +
        '<div class="video-body">' +
        '<div class="video-rank">#' + (i + 1) + '</div>' +
        '<div class="video-title">' + escapeHtml(v.title) + '</div>' +
        '<div class="video-meta">' + escapeHtml(v.channel) + ' · 조회수 ' + fmtViews(v.views) + '</div>' +
        '</div></a>';
    }).join('');
  }

  function load() {
    var key = currentRegion + ':' + currentRange + ':' + currentCategory;
    if (cache[key]) { renderVideos(cache[key]); return; }
    grid.innerHTML = '<p class="loading-note">불러오는 중...</p>';
    fetch('/api/yt?region=' + encodeURIComponent(currentRegion) + '&range=' + encodeURIComponent(currentRange) + '&category=' + encodeURIComponent(currentCategory))
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.data.error || 'failed');
        cache[key] = res.data.videos || [];
        renderVideos(cache[key]);
      })
      .catch(function () {
        grid.innerHTML = '<p class="loading-note">불러오지 못했어요. 잠시 후 다시 시도해주세요.</p>';
      });
  }

  function renderCategoryTabs() {
    if (!categoryTabsEl) return;
    categoryTabsEl.innerHTML = CATEGORY_SETS[currentRegion].map(function (c, i) {
      return '<button type="button" class="tab-btn' + (i === 0 ? ' active' : '') + '" data-category="' + c[0] + '">' + c[1] + '</button>';
    }).join('');
  }

  if (regionTabsEl) {
    regionTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn) return;
      regionTabsEl.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentRegion = btn.getAttribute('data-region');
      currentCategory = 'all';
      renderCategoryTabs();
      load();
    });
  }

  rangeTabsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.tab-btn');
    if (!btn) return;
    rangeTabsEl.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    currentRange = btn.getAttribute('data-range');
    load();
  });

  if (categoryTabsEl) {
    categoryTabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.tab-btn');
      if (!btn) return;
      categoryTabsEl.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentCategory = btn.getAttribute('data-category');
      load();
    });
  }

  renderCategoryTabs();
  load();
})();
