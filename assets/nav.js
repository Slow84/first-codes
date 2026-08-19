(function () {
  // apply saved theme immediately (before other setup) to minimize flash
  try {
    var saved = localStorage.getItem('sloworld-theme');
    if (saved === 'dark' || saved === 'light') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {}

  function closeAllMega(except) {
    document.querySelectorAll('.nav-item.open').forEach(function (el) {
      if (el !== except) el.classList.remove('open');
    });
  }

  function setupMegaMenus() {
    document.querySelectorAll('.nav-item').forEach(function (item) {
      var btn = item.querySelector('button');
      if (!btn) return;
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = item.classList.contains('open');
        closeAllMega();
        if (!isOpen) item.classList.add('open');
      });
    });
    document.addEventListener('click', function () { closeAllMega(); });
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function setTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    try { localStorage.setItem('sloworld-theme', mode); } catch (e) {}
  }

  function removeTopNavCta() {
    document.querySelectorAll('.nav-inner .nav-cta').forEach(function (el) {
      el.remove();
    });
  }

  function setupThemeToggles() {
    document.querySelectorAll('.nav-inner').forEach(function (navInner) {
      if (navInner.querySelector('.theme-toggle')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'theme-toggle';
      btn.setAttribute('aria-label', '다크모드 전환');
      btn.innerHTML =
        '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8"/></svg>' +
        '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
      btn.addEventListener('click', function () {
        setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
      });
      navInner.appendChild(btn);
    });
  }

  var MOBILE_LINKS = [
    { href: '/economy/index.html', label: '경제' },
    { href: '/life/index.html', label: '생활' },
    { href: '/etc/lotto.html', label: '기타' }
  ];

  function setupMobileMenu() {
    document.querySelectorAll('.nav-inner').forEach(function (navInner) {
      if (navInner.querySelector('.hamburger-toggle')) return;

      var hamburger = document.createElement('button');
      hamburger.type = 'button';
      hamburger.className = 'hamburger-toggle';
      hamburger.setAttribute('aria-label', '메뉴 열기');
      hamburger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
      navInner.appendChild(hamburger);

      var panel = document.createElement('div');
      panel.className = 'mobile-panel';
      panel.innerHTML = MOBILE_LINKS.map(function (l) {
        return '<a href="' + l.href + '">' + l.label + '</a>';
      }).join('');

      var topbar = navInner.closest('.topbar');
      if (topbar) topbar.appendChild(panel);

      hamburger.addEventListener('click', function (e) {
        e.stopPropagation();
        panel.classList.toggle('open');
      });
      document.addEventListener('click', function (e) {
        if (!panel.contains(e.target) && e.target !== hamburger) {
          panel.classList.remove('open');
        }
      });
    });
  }

  // script is loaded with `defer`, so the DOM is already parsed by the time
  // this runs — call directly instead of waiting on DOMContentLoaded.
  setupMegaMenus();
  removeTopNavCta();
  setupMobileMenu();
  setupThemeToggles();
})();
