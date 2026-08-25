(function () {
  // ---- TradingView Advanced Chart widgets (has its own built-in range
  // selector, 1D through ALL — free to embed, no TradingView account needed) ----
  // Shared across any page: drop <div data-tv-symbol="EXCHANGE:SYMBOL"></div>
  // and this fills it in. Was previously duplicated inline inside
  // crypto-market.js — pulled out since it's genuinely generic, not
  // crypto-specific (first non-crypto use: the real-estate macro dashboard).
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  document.querySelectorAll('[data-tv-symbol]').forEach(function (el) {
    var container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.height = '600px';
    var inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    container.appendChild(inner);
    var script = document.createElement('script');
    script.type = 'text/javascript';
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.text = JSON.stringify({
      symbol: el.getAttribute('data-tv-symbol'),
      width: '100%',
      height: '100%',
      locale: 'kr',
      range: el.getAttribute('data-tv-range') || '3M',
      theme: isDark ? 'dark' : 'light',
      style: '3',
      timezone: 'Asia/Seoul',
      withdateranges: true,
      hide_side_toolbar: true,
      hide_top_toolbar: true,
      hide_legend: true,
      allow_symbol_change: false
    });
    container.appendChild(script);
    el.appendChild(container);
  });
})();
