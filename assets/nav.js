(function () {
  function closeAll(except) {
    document.querySelectorAll('.nav-item.open').forEach(function (el) {
      if (el !== except) el.classList.remove('open');
    });
  }

  document.querySelectorAll('.nav-item').forEach(function (item) {
    var btn = item.querySelector('button');
    if (!btn) return;
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = item.classList.contains('open');
      closeAll();
      if (!isOpen) item.classList.add('open');
    });
  });

  document.addEventListener('click', function () { closeAll(); });
})();
