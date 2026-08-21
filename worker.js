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

async function fetchTrending(region, key) {
  const u = 'https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=' +
    region + '&maxResults=10&key=' + key;
  const r = await fetch(u);
  const data = await r.json();
  if (!data.items) throw new Error(data.error ? data.error.message : 'no items');
  return data.items.map(mapVideoItem);
}

// regionCode on search.list only means "viewable in that country," not
// "popular there" — nearly everything is viewable everywhere, so on its own
// it barely filters at all (confirmed: KR and US returned almost the same
// globally-viral clips). relevanceLanguage is a much stronger signal since
// it biases ranking toward that language's content; mapped per-region here
// so only regions we have a language guess for get the extra bias.
const REGION_LANGUAGE = { KR: 'ko', US: 'en' };

async function fetchRecentPopular(region, days, key) {
  const publishedAfter = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  // YouTube's search.list quietly returns zero results when there's no q=
  // term at all, even with other filters set — q=%20 (a blank space) works
  // around this without actually biasing results toward a real keyword.
  const relevanceLanguage = REGION_LANGUAGE[region];
  // Shorts go hyper-viral the same way in every country regardless of
  // language/region, which is what was drowning out real per-country
  // differences (KR and US were returning nearly identical clips).
  // videoDuration=medium (4-20 min) excludes Shorts and gets genuinely
  // distinct, region-appropriate results — confirmed via direct API test.
  const searchUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&q=%20&videoDuration=medium&regionCode=' +
    region + (relevanceLanguage ? '&relevanceLanguage=' + relevanceLanguage : '') +
    '&publishedAfter=' + publishedAfter + '&maxResults=10&key=' + key;
  const sr = await fetch(searchUrl);
  const sdata = await sr.json();
  if (!sdata.items) throw new Error(sdata.error ? sdata.error.message : 'no items');
  const ids = sdata.items.map(function (it) { return it.id.videoId; }).filter(Boolean).join(',');
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
  const cacheKey = 'yt:v3:' + region + ':' + range; // v3: exclude Shorts (videoDuration=medium) invalidates old cached results

  const cached = await env.DATA.get(cacheKey);
  if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  let videos;
  try {
    if (range === 'today') videos = await fetchTrending(region, env.YOUTUBE_API_KEY);
    else videos = await fetchRecentPopular(region, range === 'week' ? 7 : 30, env.YOUTUBE_API_KEY);
  } catch (e) {
    return json({ error: '유튜브 데이터를 가져오지 못했어요.' }, 502);
  }

  const text = JSON.stringify({ videos: videos });
  await env.DATA.put(cacheKey, text, { expirationTtl: 60 * 30 }); // 30 min — trending doesn't change that fast
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// Crypto news — pulls RSS from CoinDesk and Cointelegraph server-side (both
// require no API key, but a browser fetch would hit CORS, so it's proxied
// here). RSS is simple enough that a small regex parser is easier than
// shipping an XML library into a Worker.
const NEWS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' }
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
  const cacheKey = 'news:v1';
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
