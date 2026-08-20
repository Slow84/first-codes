(function () {
  var el = document.getElementById('visitorStats');
  if (!el) return;

  function render(data) {
    el.innerHTML =
      '<span>Today <strong>' + data.today.toLocaleString() + '</strong></span>' +
      '<span class="visitor-sep">·</span>' +
      '<span>This week <strong>' + data.week.toLocaleString() + '</strong></span>';
  }

  function load() {
    fetch('/api/visit')
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { el.style.display = 'none'; });
  }

  // count this browser once per calendar day, then just display the totals
  var today = new Date().toISOString().slice(0, 10);
  var flagKey = 'sloworld-visited-' + today;
  var alreadyCounted = false;
  try { alreadyCounted = localStorage.getItem(flagKey) === '1'; } catch (e) {}

  if (!alreadyCounted) {
    fetch('/api/visit', { method: 'POST' })
      .then(function () {
        try { localStorage.setItem(flagKey, '1'); } catch (e) {}
        load();
      })
      .catch(load);
  } else {
    load();
  }
})();
