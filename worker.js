// sloworld's Worker: serves the static site, and adds two small JSON APIs
// backed by a single KV namespace (env.DATA) — comments and a visitor
// counter. Keys are prefixed by purpose so they can share one namespace:
//   page:<id>          -> JSON array of comments for that page
//   rate:<ip>           -> last comment timestamp, for per-IP rate limiting
//   visits:<YYYY-MM-DD> -> integer count of visits that day

const MAX_NAME = 40;
const MAX_TEXT = 1000;
const RATE_LIMIT_SECONDS = 30;
const MAX_COMMENTS_PER_PAGE = 500;
// starter list — add words here if spam gets through; matched case-insensitively
const BLOCKED_WORDS = ['viagra', 'casino'];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function todayKey(date) {
  const d = date || new Date();
  return 'visits:' + d.toISOString().slice(0, 10);
}

async function handleCommentsGet(env, url) {
  const page = (url.searchParams.get('page') || 'home').slice(0, 60);
  const raw = await env.DATA.get('page:' + page);
  return json(raw ? JSON.parse(raw) : []);
}

async function handleCommentsPost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '잘못된 요청이에요.' }, 400);
  }

  const page = (body.page || 'home').toString().slice(0, 60);
  const name = (body.name || '').toString().trim().slice(0, MAX_NAME) || '익명';
  const text = (body.text || '').toString().trim().slice(0, MAX_TEXT);
  const honeypot = (body.website || '').toString();

  if (!text) return json({ error: '내용을 입력해주세요.' }, 400);
  if (honeypot) return json({ ok: true }); // looks fine to a bot, but silently ignored

  const lower = text.toLowerCase();
  if (BLOCKED_WORDS.some(function (w) { return lower.includes(w); })) {
    return json({ error: '등록할 수 없는 내용이 포함되어 있어요.' }, 400);
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rateKey = 'rate:' + ip;
  const lastPost = await env.DATA.get(rateKey);
  if (lastPost && Date.now() - Number(lastPost) < RATE_LIMIT_SECONDS * 1000) {
    return json({ error: '너무 빨리 다시 작성했어요. 잠시 후 다시 시도해주세요.' }, 429);
  }

  const key = 'page:' + page;
  const raw = await env.DATA.get(key);
  const list = raw ? JSON.parse(raw) : [];
  list.push({ name: name, text: text, time: Date.now() });
  if (list.length > MAX_COMMENTS_PER_PAGE) list.splice(0, list.length - MAX_COMMENTS_PER_PAGE);

  await env.DATA.put(key, JSON.stringify(list));
  await env.DATA.put(rateKey, String(Date.now()), { expirationTtl: 60 }); // KV requires expirationTtl >= 60s; the 30s rate-limit check above is enforced in code, this is just cleanup

  return json({ ok: true });
}

async function handleVisitGet(env) {
  const today = new Date();
  const todayCount = Number((await env.DATA.get(todayKey(today))) || '0');

  let weekTotal = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    weekTotal += Number((await env.DATA.get(todayKey(d))) || '0');
  }

  return json({ today: todayCount, week: weekTotal });
}

async function handleVisitPost(env) {
  const key = todayKey();
  const current = Number((await env.DATA.get(key)) || '0');
  await env.DATA.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 14 }); // auto-clean after 2 weeks
  return json({ ok: true });
}

// YouTube trending videos, keyed by region + range. The API key is read
// from env.YOUTUBE_API_KEY (a Cloudflare secret, never committed to git).
// "today" uses YouTube's own trending chart; "week"/"month" don't have an
// official chart, so we approximate with "most-viewed videos published in
// that window" (search.list, then a second call to videos.list for the
// view counts search doesn't include).
function mapVideoItem(item) {
  const thumbs = (item.snippet && item.snippet.thumbnails) || {};
  const thumb = thumbs.medium || thumbs.default || {};
  return {
    id: item.id,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    description: (item.snippet.description || '').slice(0, 200),
    thumbnail: thumb.url || '',
    views: item.statistics ? item.statistics.viewCount : null,
    publishedAt: item.snippet.publishedAt
  };
}

// regionCode on search.list only means "viewable in that country," not
// "popular there" — nearly everything is viewable everywhere, so on its own
// it barely filters at all (confirmed: KR and US returned almost the same
// globally-viral clips). relevanceLanguage is a much stronger signal since
// it biases ranking toward that language's content, but it's still only a
// ranking hint, not a hard filter — confirmed on 2026-08-21 that KR category
// tabs (sports/gaming/comedy/education especially) still leaked mostly
// non-Korean results even with relevanceLanguage=ko.
const REGION_LANGUAGE = { KR: 'ko', US: 'en' };

// For regions where a script is a reliable proxy for "actually in this
// region's language," hard-filter on it instead of trusting relevanceLanguage
// alone — confirmed via direct API test this reliably keeps only genuine
// Korean content. No such easy proxy for English (Latin script isn't
// English-specific), so US/global still relies on relevanceLanguage only.
const REGION_SCRIPT_FILTER = { KR: /[가-힣]/ };

// YouTube's fixed videoCategoryId list — only the IDs actually offered as
// tabs on the site. Started with 7 (news/sports/gaming/music/entertainment/
// comedy/education) but sports/gaming/comedy/education were dropped after
// testing: even with the Hangul filter, top-50-by-viewcount for those
// categories in KR had ~1 genuinely Korean video, not enough to fill a
// page. There's also no "Kids" category in YouTube's own list (that's an
// age flag, not a topic).
const CATEGORY_IDS = { news: '25', music: '10', entertainment: '24' };

async function fetchRecentPopular(region, days, key, category) {
  const publishedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // YouTube's search.list quietly returns zero results when there's no q=
  // term at all, even with other filters set — q=%20 (a blank space) works
  // around this without actually biasing results toward a real keyword.
  const relevanceLanguage = REGION_LANGUAGE[region];
  const categoryId = CATEGORY_IDS[category];
  const scriptFilter = REGION_SCRIPT_FILTER[region];
  // Shorts go hyper-viral the same way in every country regardless of
  // language/region, which is what was drowning out real per-country
  // differences when there was no hard filter. Now that regions with a
  // script filter get one, Shorts can stay in the pool — they matter for
  // e.g. K-pop/reaction content — and get filtered for real instead. Regions
  // without a script filter (US) still need videoDuration=medium since
  // there's nothing else keeping global-viral Shorts out.
  const maxResults = scriptFilter ? 50 : 10;
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&q=%20' +
    (scriptFilter ? '' : '&videoDuration=medium') + '&regionCode=' +
    region + (relevanceLanguage ? '&relevanceLanguage=' + relevanceLanguage : '') +
    (categoryId ? '&videoCategoryId=' + categoryId : '') +
    '&publishedAfter=' + publishedAfter + '&maxResults=' + maxResults + '&key=' + key;
  const sr = await fetch(searchUrl);
  const sdata = await sr.json();
  if (!sdata.items) throw new Error(sdata.error ? sdata.error.message : 'no items');
  let items = sdata.items;
  if (scriptFilter) {
    items = items.filter(function (it) {
      return scriptFilter.test(it.snippet.title) || scriptFilter.test(it.snippet.channelTitle);
    }).slice(0, 10);
  }
  const ids = items.map(function (it) { return it.id.videoId; }).filter(Boolean).join(',');
  if (!ids) return [];

  const videosUrl = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=' + ids + '&key=' + key;
  const vr = await fetch(videosUrl);
  const vdata = await vr.json();
  if (!vdata.items) throw new Error(vdata.error ? vdata.error.message : 'no items');
  return vdata.items.map(mapVideoItem);
}

async function handleYoutube(env, url) {
  if (!env.YOUTUBE_API_KEY) return json({ error: 'YouTube API 키가 아직 설정되지 않았어요.' }, 501);

  const region = (url.searchParams.get('region') || 'KR').toUpperCase().slice(0, 2);
  const range = url.searchParams.get('range') || 'today';
  const category = url.searchParams.get('category') || 'all';
  const cacheKey = 'yt:v6:' + region + ':' + range + ':' + category; // v6: Hangul hard-filter for KR, dropped weak categories

  const cached = await env.DATA.get(cacheKey);
  if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  // "today" used to be YouTube's own chart=mostPopular (its curated trending
  // list), but that barely changes hour to hour, let alone day to day. A
  // strict last-24h window ranked by view count was tested and was too
  // noisy (too few candidates, so odd/off-region videos won by default) —
  // 2 days struck the right balance in testing: still moves daily as new
  // videos accumulate views, but has enough candidates to rank meaningfully.
  const RANGE_DAYS = { today: 2, week: 7, month: 30 };
  let videos;
  try {
    videos = await fetchRecentPopular(region, RANGE_DAYS[range] || 7, env.YOUTUBE_API_KEY, category);
  } catch (e) {
    return json({ error: '유튜브 데이터를 가져오지 못했어요.' }, 502);
  }

  const text = JSON.stringify({ videos: videos });
  await env.DATA.put(cacheKey, text, { expirationTtl: 60 * 30 }); // 30 min — trending doesn't change that fast
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// Crypto news — pulls RSS server-side from several outlets (all require no
// API key, but a browser fetch would hit CORS, so it's proxied here). RSS
// is simple enough that a small regex parser is easier than shipping an
// XML library into a Worker.
// Started with just CoinDesk + Cointelegraph, but at a 2-hour freshness
// window (see crypto-news.js) those two alone only produced ~1 fresh
// article at any given moment (verified against live feeds) — added 5
// more reputable, no-paywall outlets to raise that. Each URL was checked
// live (HTTP 200, real <item> entries) before adding; picked for
// reputation/coverage over pure volume (skipped lower-tier aggregators).
const NEWS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' },
  { url: 'https://www.theblock.co/rss.xml', source: 'The Block' },
  { url: 'https://decrypt.co/feed', source: 'Decrypt' },
  { url: 'https://cryptoslate.com/feed/', source: 'CryptoSlate' },
  { url: 'https://crypto.news/feed/', source: 'crypto.news' },
  { url: 'https://u.today/rss', source: 'U.Today' }
];

function xmlTag(block, tag) {
  const m = block.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>'));
  return m ? m[1] : '';
}

function xmlAttr(block, tag, attr) {
  const m = block.match(new RegExp('<' + tag + '[^>]*\\s' + attr + '="([^"]*)"'));
  return m ? m[1] : null;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
}

function cleanXmlText(s) {
  const cdata = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  let out = cdata ? cdata[1] : s;
  out = out.replace(/<[^>]+>/g, '').trim();
  return decodeXmlEntities(out);
}

function parseRss(xml, source) {
  const items = [];
  const itemRe = /<item[\s\S]*?<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[0];
    const title = cleanXmlText(xmlTag(block, 'title'));
    const link = cleanXmlText(xmlTag(block, 'link')).split('?')[0];
    const pubDate = xmlTag(block, 'pubDate').trim();
    if (!title || !link || !pubDate) continue;
    let image = xmlAttr(block, 'media:content', 'url') || xmlAttr(block, 'enclosure', 'url');
    if (!image) {
      const desc = xmlTag(block, 'description');
      const imgMatch = desc.match(/<img[^>]+src="([^"]+)"/);
      if (imgMatch) image = imgMatch[1];
    }
    items.push({ title: title, link: link, pubDate: pubDate, source: source, image: image ? decodeXmlEntities(image) : null });
  }
  return items;
}

async function handleNews(env) {
  const cacheKey = 'news:v2'; // bumped so the new 7-source list takes effect immediately instead of waiting out the old cache entry's TTL
  const cached = await env.DATA.get(cacheKey);
  if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  const results = await Promise.allSettled(NEWS_FEEDS.map(function (feed) {
    return fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sloworldbot/1.0)' } })
      .then(function (r) { return r.text(); })
      .then(function (xml) { return parseRss(xml, feed.source); });
  }));

  let items = [];
  results.forEach(function (res) {
    if (res.status === 'fulfilled') items = items.concat(res.value);
  });
  if (!items.length) return json({ error: '뉴스를 가져오지 못했어요.' }, 502);

  items.sort(function (a, b) { return new Date(b.pubDate) - new Date(a.pubDate); });
  items = items.slice(0, 40);

  const text = JSON.stringify({ items: items });
  await env.DATA.put(cacheKey, text, { expirationTtl: 60 * 20 }); // 20 min — RSS itself updates hourly
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/comments') {
      if (request.method === 'GET') return handleCommentsGet(env, url);
      if (request.method === 'POST') return handleCommentsPost(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/visit') {
      if (request.method === 'GET') return handleVisitGet(env);
      if (request.method === 'POST') return handleVisitPost(env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/yt') {
      if (request.method === 'GET') return handleYoutube(env, url);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/news') {
      if (request.method === 'GET') return handleNews(env);
      return new Response('Method not allowed', { status: 405 });
    }

    return env.ASSETS.fetch(request);
  }
};
