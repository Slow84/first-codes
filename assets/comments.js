(function () {
  var API = '/api/comments';
  var PAGE = document.body.getAttribute('data-comment-page') || 'home';

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function pad(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
  }

  function renderList(list) {
    var el = document.getElementById('commentList');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="comment-empty">아직 댓글이 없어요. 첫 댓글을 남겨보세요!</p>';
      return;
    }
    el.innerHTML = list.slice().reverse().map(function (c) {
      return '<div class="comment-item">' +
        '<div class="comment-item-head">' +
        '<span>' + escapeHtml(c.name) + '</span>' +
        '<span class="comment-item-time">' + fmtTime(c.time) + '</span>' +
        '</div>' +
        '<div class="comment-item-body">' + escapeHtml(c.text) + '</div>' +
        '</div>';
    }).join('');
  }

  function loadComments() {
    fetch(API + '?page=' + encodeURIComponent(PAGE))
      .then(function (r) { return r.json(); })
      .then(renderList)
      .catch(function () {
        var el = document.getElementById('commentList');
        if (el) el.innerHTML = '<p style="color:var(--text-muted); font-size:13.5px;">댓글을 불러오지 못했어요.</p>';
      });
  }

  function setupForm() {
    var form = document.getElementById('commentForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = document.getElementById('commentMsg');
      var nameEl = document.getElementById('commentName');
      var textEl = document.getElementById('commentText');
      var websiteEl = document.getElementById('commentWebsite');
      msg.textContent = '등록 중...';

      fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page: PAGE,
          name: nameEl.value,
          text: textEl.value,
          website: websiteEl ? websiteEl.value : ''
        })
      })
        .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
        .then(function (res) {
          if (!res.ok) {
            msg.textContent = res.data.error || '등록에 실패했어요.';
            return;
          }
          msg.textContent = '';
          textEl.value = '';
          loadComments();
        })
        .catch(function () { msg.textContent = '네트워크 오류가 발생했어요.'; });
    });
  }

  loadComments();
  setupForm();
})();
