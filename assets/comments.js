(function () {
  var API = '/api/comments';
  var PAGE = document.body.getAttribute('data-comment-page') || 'home';
  var ADMIN_KEY_STORAGE = 'sw_admin_key';

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

  function getAdminKey() {
    try { return localStorage.getItem(ADMIN_KEY_STORAGE) || ''; } catch (e) { return ''; }
  }
  function setAdminKey(key) {
    try { localStorage.setItem(ADMIN_KEY_STORAGE, key); } catch (e) {}
  }
  function clearAdminKey() {
    try { localStorage.removeItem(ADMIN_KEY_STORAGE); } catch (e) {}
  }

  // ---- reply threading ----
  // groups a flat list into { top-level comment -> its replies }, oldest
  // top-level comment shown first vs last is controlled by the caller;
  // replies within a thread always show oldest-first (reads like a
  // conversation, newest-first would read backwards).
  function buildThreads(list) {
    var byParent = {};
    list.forEach(function (c) {
      var key = c.parentId || 'root';
      if (!byParent[key]) byParent[key] = [];
      byParent[key].push(c);
    });
    var roots = (byParent.root || []).slice().reverse();
    return roots.map(function (root) {
      return { root: root, replies: (byParent[root.id] || []).slice() };
    });
  }

  function commentRowHtml(c, isReply) {
    var deletedNote = c.deleted ? '<span class="comment-deleted-tag">삭제됨</span>' : '';
    return '<div class="comment-item' + (isReply ? ' comment-reply' : '') + (c.deleted ? ' comment-item-deleted' : '') + '" data-comment-id="' + escapeHtml(c.id) + '">' +
      '<div class="comment-item-head">' +
      '<span>' + escapeHtml(c.name) + deletedNote + '</span>' +
      '<span class="comment-item-time">' + fmtTime(c.time) + '</span>' +
      '</div>' +
      '<div class="comment-item-body">' + escapeHtml(c.text) + '</div>' +
      '<div class="comment-item-actions">' +
      (isReply || c.deleted ? '' : '<button type="button" class="comment-action-btn" data-action="reply">답글</button>') +
      (c.deleted ? '' : '<button type="button" class="comment-action-btn" data-action="delete">삭제</button>') +
      '</div>' +
      '<div class="comment-reply-form-slot"></div>' +
      '</div>';
  }

  function renderList(list) {
    var el = document.getElementById('commentList');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<p class="comment-empty">아직 댓글이 없어요. 첫 댓글을 남겨보세요!</p>';
      return;
    }
    var threads = buildThreads(list);
    el.innerHTML = threads.map(function (t) {
      return commentRowHtml(t.root, false) +
        t.replies.map(function (r) { return commentRowHtml(r, true); }).join('');
    }).join('');
  }

  function loadComments() {
    var admin = getAdminKey();
    var url = API + '?page=' + encodeURIComponent(PAGE) + (admin ? '&admin=' + encodeURIComponent(admin) : '');
    fetch(url)
      .then(function (r) { return r.json(); })
      .then(renderList)
      .catch(function () {
        var el = document.getElementById('commentList');
        if (el) el.innerHTML = '<p style="color:var(--text-muted); font-size:13.5px;">댓글을 불러오지 못했어요.</p>';
      });
  }

  // ---- posting (top-level form and inline reply forms share this) ----
  function postComment(fields, onDone) {
    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: PAGE,
        name: fields.name,
        text: fields.text,
        website: fields.website || '',
        parentId: fields.parentId || null
      })
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) { onDone(res.ok ? null : (res.data.error || '등록에 실패했어요.')); })
      .catch(function () { onDone('네트워크 오류가 발생했어요.'); });
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
      postComment({ name: nameEl.value, text: textEl.value, website: websiteEl ? websiteEl.value : '' }, function (err) {
        if (err) { msg.textContent = err; return; }
        msg.textContent = '';
        textEl.value = '';
        loadComments();
      });
    });
  }

  // ---- delete (admin-only, soft delete server-side) ----
  function handleDelete(commentEl) {
    var id = commentEl.getAttribute('data-comment-id');
    var key = getAdminKey();
    if (!key) {
      key = window.prompt('관리자 비밀번호를 입력하세요');
      if (!key) return;
    }
    if (!window.confirm('이 댓글을 삭제할까요?')) return;

    fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: PAGE, id: id, admin: key })
    })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, status: r.status, data: data }; }); })
      .then(function (res) {
        if (res.status === 403) {
          clearAdminKey();
          window.alert('비밀번호가 틀렸어요.');
          return;
        }
        if (!res.ok) { window.alert(res.data.error || '삭제에 실패했어요.'); return; }
        setAdminKey(key); // only remembered once a delete actually succeeds with it
        loadComments();
      })
      .catch(function () { window.alert('네트워크 오류가 발생했어요.'); });
  }

  // ---- inline reply form ----
  function replyFormHtml() {
    return '<form class="comment-reply-form">' +
      '<input type="text" class="comment-field comment-reply-name" placeholder="닉네임" maxlength="40" required>' +
      '<textarea class="comment-field comment-reply-text" placeholder="답글을 남겨주세요" maxlength="1000" rows="2" required></textarea>' +
      '<div class="comment-foot">' +
      '<span class="comment-msg comment-reply-msg"></span>' +
      '<button type="submit" class="pill-btn accent" style="padding:7px 16px; font-size:13px;">답글 등록</button>' +
      '</div>' +
      '</form>';
  }

  function toggleReplyForm(commentEl) {
    var slot = commentEl.querySelector('.comment-reply-form-slot');
    if (!slot) return;
    if (slot.innerHTML) { slot.innerHTML = ''; return; }
    slot.innerHTML = replyFormHtml();
    var form = slot.querySelector('.comment-reply-form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var msg = form.querySelector('.comment-reply-msg');
      var nameEl = form.querySelector('.comment-reply-name');
      var textEl = form.querySelector('.comment-reply-text');
      msg.textContent = '등록 중...';
      postComment({ name: nameEl.value, text: textEl.value, parentId: commentEl.getAttribute('data-comment-id') }, function (err) {
        if (err) { msg.textContent = err; return; }
        loadComments();
      });
    });
  }

  function setupListActions() {
    var list = document.getElementById('commentList');
    if (!list) return;
    list.addEventListener('click', function (e) {
      var btn = e.target.closest('.comment-action-btn');
      if (!btn) return;
      var commentEl = btn.closest('.comment-item');
      if (!commentEl) return;
      if (btn.getAttribute('data-action') === 'delete') handleDelete(commentEl);
      if (btn.getAttribute('data-action') === 'reply') toggleReplyForm(commentEl);
    });
  }

  // ---- emoji picker ----
  // a small curated set, not a full emoji library — this is a comment box
  // on a personal blog, not a chat app, so a big picker would be overkill.
  var EMOJI_SET = ['😀', '😂', '😍', '🥲', '😢', '😡', '👍', '👎', '🙏', '👏', '🎉', '❤️', '🔥', '💡', '✅', '❓'];

  function insertAtCursor(textarea, text) {
    var start = textarea.selectionStart || 0;
    var end = textarea.selectionEnd || 0;
    var before = textarea.value.slice(0, start);
    var after = textarea.value.slice(end);
    textarea.value = before + text + after;
    var pos = start + text.length;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
  }

  function setupEmojiPicker() {
    var textarea = document.getElementById('commentText');
    if (!textarea || textarea.dataset.emojiReady) return;
    textarea.dataset.emojiReady = '1';

    var wrap = document.createElement('div');
    wrap.className = 'comment-emoji-wrap';
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'comment-emoji-toggle';
    toggle.textContent = '😊 이모지';
    var panel = document.createElement('div');
    panel.className = 'comment-emoji-panel';
    panel.hidden = true;
    panel.innerHTML = EMOJI_SET.map(function (em) {
      return '<button type="button" class="comment-emoji-item">' + em + '</button>';
    }).join('');

    panel.addEventListener('click', function (e) {
      var item = e.target.closest('.comment-emoji-item');
      if (!item) return;
      insertAtCursor(textarea, item.textContent);
      panel.hidden = true;
    });
    toggle.addEventListener('click', function () { panel.hidden = !panel.hidden; });
    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) panel.hidden = true;
    });

    wrap.appendChild(toggle);
    wrap.appendChild(panel);
    textarea.insertAdjacentElement('afterend', wrap);
  }

  loadComments();
  setupForm();
  setupListActions();
  setupEmojiPicker();
})();
