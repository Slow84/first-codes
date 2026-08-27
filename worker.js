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
// admin key has no length/complexity enforcement, so brute-forcing a short
// key would otherwise be unthrottled — lock an IP out after too many wrong
// guesses instead of checking the key itself.
const MAX_ADMIN_ATTEMPTS = 5;
const ADMIN_LOCKOUT_SECONDS = 15 * 60;
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

// older comments (posted before ids existed) get a stable id synthesized
// from their position in the array — deterministic as long as entries are
// only ever appended or edited in place, never reordered.
function commentId(c, idx) {
  return c.id || ('legacy-' + c.time + '-' + idx);
}

function isAdmin(env, key) {
  return !!env.ADMIN_KEY && key === env.ADMIN_KEY;
}

async function isAdminLocked(env, ip) {
  const count = Number(await env.DATA.get('adminfail:' + ip)) || 0;
  return count >= MAX_ADMIN_ATTEMPTS;
}

async function recordAdminFailure(env, ip) {
  const key = 'adminfail:' + ip;
  const count = (Number(await env.DATA.get(key)) || 0) + 1;
  await env.DATA.put(key, String(count), { expirationTtl: ADMIN_LOCKOUT_SECONDS });
}

async function clearAdminFailures(env, ip) {
  await env.DATA.delete('adminfail:' + ip);
}

async function handleCommentsGet(request, env, url) {
  const page = (url.searchParams.get('page') || 'home').slice(0, 60);
  const adminKey = url.searchParams.get('admin') || '';
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  // a wrong ?admin= just falls back to the public view rather than erroring,
  // so a locked-out or mistyped attempt doesn't break the page for a reader
  let admin = false;
  if (adminKey) {
    if (await isAdminLocked(env, ip)) {
      admin = false;
    } else if (isAdmin(env, adminKey)) {
      admin = true;
      await clearAdminFailures(env, ip);
    } else {
      await recordAdminFailure(env, ip);
    }
  }
  const raw = await env.DATA.get('page:' + page);
  const list = raw ? JSON.parse(raw) : [];
  const withIds = list.map(function (c, idx) { return Object.assign({}, c, { id: commentId(c, idx) }); });
  // deleted comments stay in the response (redacted for non-admins) rather
  // than being dropped outright — dropping them would also orphan any
  // still-visible replies underneath, since the client builds reply
  // threads by looking up each reply's parent id in this same list.
  const visible = admin ? withIds : withIds.map(function (c) {
    if (!c.deleted) return c;
    return { id: c.id, parentId: c.parentId, time: c.time, name: '[삭제됨]', text: '삭제된 댓글이에요.', deleted: true };
  });
  return json(visible);
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
  // top-level comment when omitted; a reply otherwise. Not verified against
  // the parent existing — this is a low-traffic personal-blog comment
  // section, not worth an extra KV read to guard against a malformed id
  // that only a determined bad actor would ever send.
  const parentId = body.parentId ? String(body.parentId).slice(0, 80) : null;

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
  const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  list.push({ id: id, name: name, text: text, time: Date.now(), parentId: parentId });
  if (list.length > MAX_COMMENTS_PER_PAGE) list.splice(0, list.length - MAX_COMMENTS_PER_PAGE);

  await env.DATA.put(key, JSON.stringify(list));
  await env.DATA.put(rateKey, String(Date.now()), { expirationTtl: 60 }); // KV requires expirationTtl >= 60s; the 30s rate-limit check above is enforced in code, this is just cleanup

  return json({ ok: true });
}

// soft-delete only — sets deleted:true instead of removing the entry, so
// the admin view (handleCommentsGet with a valid ?admin= key) can still
// see what was removed and why, e.g. to double-check a moderation call.
async function handleCommentsDelete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '잘못된 요청이에요.' }, 400);
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (await isAdminLocked(env, ip)) {
    return json({ error: '너무 많이 틀렸어요. 잠시 후 다시 시도해주세요.' }, 429);
  }
  if (!isAdmin(env, (body.admin || '').toString())) {
    await recordAdminFailure(env, ip);
    return json({ error: '권한이 없어요.' }, 403);
  }
  await clearAdminFailures(env, ip);
  const page = (body.page || 'home').toString().slice(0, 60);
  const id = (body.id || '').toString();
  if (!id) return json({ error: '삭제할 댓글을 찾지 못했어요.' }, 400);

  const key = 'page:' + page;
  const raw = await env.DATA.get(key);
  const list = raw ? JSON.parse(raw) : [];
  var found = false;
  list.forEach(function (c, idx) {
    if (commentId(c, idx) === id) { c.deleted = true; c.deletedAt = Date.now(); found = true; }
  });
  if (!found) return json({ error: '삭제할 댓글을 찾지 못했어요.' }, 404);

  await env.DATA.put(key, JSON.stringify(list));
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

// Real-estate dashboard yearly indicators — pulls raw CSV straight from
// FRED (Federal Reserve Economic Data), which requires no API key/signup
// for this endpoint (verified: fredgraph.csv works unauthenticated).
// FRED itself has no CORS header, so a browser fetch would be blocked —
// proxied here like the RSS feeds. Reduced to one value per year (the
// last observation in that year) since the point is "what was this
// indicator around year X," not a full daily series.
const RE_INDICATOR_SERIES = [
  { id: 'DEXKOUS', key: 'usdkrw', label: '원/달러 환율' },
  { id: 'DFF', key: 'fedRate', label: '미국 기준금리' },
  { id: 'DGS10', key: 'us10y', label: '미국 10년물 국채금리' },
  { id: 'M2SL', key: 'm2', label: '미국 M2 통화량(십억달러)' }
  // 한국 주택가격지수는 예전엔 BIS(FRED 경유, 분기·8개월 지연)를 썼는데
  // 너무 느리다는 피드백을 받고 아래 fetchRoneApartmentIndex()의 한국부동산원
  // R-ONE Open API(월별, 1~2개월 지연)로 교체했음 — series/labels에 별도로 병합.
];

// 한국 아파트 매매가격지수 — 한국부동산원 R-ONE Open API. data.go.kr(공공데이터
// 포털)엔 이 통계의 자체 발급 버튼이 없고("제공처 바로가기"만 있음), 실제
// 인증키는 reb.or.kr/r-one에 별도 가입해서 발급받아야 함(ECOS/KOSIS와 같은
// "직접 가입 필요" 패턴). STATBL_ID=A_2024_00045 = "(월) 매매가격지수_아파트",
// CLS_ID=500001 = 전국, ITM_ID=100001 = 지수 — 전부 R-ONE의 통계표 목록
// API(SttsApiTbl.do)로 직접 조회해서 확인한 값. 이 API도 CORS를 지원하지
// 않아 서버에서 대신 호출.
const RONE_API_URL = 'https://www.reb.or.kr/r-one/openapi/SttsApiTblData.do';

// 공용 R-ONE 조회 함수 — STATBL_ID(통계표)/CLS_ID(지역)/ITM_ID(항목)만 바꿔서
// 여러 R-ONE 통계에 재사용. 전부 SttsApiTbl.do(통계표 목록 API)로 직접 조회해서
// 확인한 값 (아파트 매매가격지수=A_2024_00045/500001/100001, 주택 매매심리지수
// (국토연구원 조사, R-ONE 경유 배포)=T232543129897499/50004/10001, 둘 다
// CLS_ID는 "전국" 항목).
async function fetchRoneSeries(env, statblId, clsId, itmId) {
  if (!env.RONE_API_KEY) return null; // 키 없으면 이 열만 조용히 비움 — 나머지 지표는 정상 표시
  try {
    const endYear = new Date().getFullYear() + 1;
    const params = new URLSearchParams({
      KEY: env.RONE_API_KEY,
      STATBL_ID: statblId,
      DTACYCLE_CD: 'MM',
      CLS_ID: clsId,
      ITM_ID: itmId,
      START_WRTTIME: '200301',
      END_WRTTIME: endYear + '12',
      Type: 'json',
      pSize: '1000' // 기본 페이지 크기로는 전체 이력이 안 잘려서 잘림 — 실측으로 273행 전체가 한 번에 오는 걸 확인함
    });
    const r = await fetch(RONE_API_URL + '?' + params.toString());
    const data = await r.json();
    const rows = data.SttsApiTblData && data.SttsApiTblData[1] && data.SttsApiTblData[1].row;
    if (!rows) return null;
    const byYear = {};
    rows.forEach(function (row) {
      const wt = String(row.WRTTIME_IDTFR_ID || '');
      const year = wt.slice(0, 4);
      const value = parseFloat(row.DTA_VAL);
      if (year.length === 4 && !isNaN(value)) byYear[year] = value; // 같은 해 안에서는 더 늦은 달이 이전 값을 덮어씀 -> 그 해의 마지막 관측치
    });
    return byYear;
  } catch (e) {
    return null;
  }
}

// 한국 M2 통화량 — 한국은행 ECOS Open API. STAT_CODE=161Y006(M2 상품별 구성
// 내역, 평잔·원계열)의 ITEM_CODE1=BBHA00 항목이 M2 총량 자체임 — 둘 다
// StatisticTableList/StatisticSearch API로 직접 조회해서 확인한 값
// (BBHA01~ 이후 코드들은 현금통화·요구불예금 등 M2를 구성하는 하위 항목이라
// 총량이 아님). 응답 단위가 "십억원"이라 표에서 쓰는 "조원" 단위로 맞추려면
// 1000으로 나눠야 함. ECOS도 R-ONE과 마찬가지로 reb.or.kr이 아니라
// ecos.bok.or.kr에 별도 가입해서 키를 받아야 하고, CORS도 지원 안 해서
// 서버에서 대신 호출.
const ECOS_API_URL = 'https://ecos.bok.or.kr/api/StatisticSearch';

async function fetchEcosM2(env) {
  if (!env.ECOS_API_KEY) return null; // 키 없으면 이 열만 조용히 비움(수동입력값으로 대체됨) — 나머지 지표는 정상 표시
  try {
    const endYear = new Date().getFullYear() + 1;
    const url = ECOS_API_URL + '/' + env.ECOS_API_KEY + '/json/kr/1/1000/161Y006/M/199001/' + endYear + '12/BBHA00/';
    const r = await fetch(url);
    const data = await r.json();
    const rows = data.StatisticSearch && data.StatisticSearch.row;
    if (!rows) return null;
    const byYear = {};
    rows.forEach(function (row) {
      const time = String(row.TIME || '');
      const year = time.slice(0, 4);
      const value = parseFloat(row.DATA_VALUE);
      if (year.length === 4 && !isNaN(value)) byYear[year] = value / 1000; // 십억원 -> 조원, 같은 해 안 마지막 관측치가 이전 값을 덮어씀
    });
    return byYear;
  } catch (e) {
    return null;
  }
}

// 주택담보대출 금리 — ECOS STAT_CODE=121Y006(예금은행 대출금리, 신규취급액
// 기준)의 ITEM_CODE1=BECBLA0302 항목이 "주택담보대출" — StatisticItemList
// API로 직접 조회해서 확인한 값. 단위가 이미 "연리%"라 별도 변환 불필요.
async function fetchEcosMortgageRate(env) {
  if (!env.ECOS_API_KEY) return null;
  try {
    const endYear = new Date().getFullYear() + 1;
    const url = ECOS_API_URL + '/' + env.ECOS_API_KEY + '/json/kr/1/1000/121Y006/M/199001/' + endYear + '12/BECBLA0302/';
    const r = await fetch(url);
    const data = await r.json();
    const rows = data.StatisticSearch && data.StatisticSearch.row;
    if (!rows) return null;
    const byYear = {};
    rows.forEach(function (row) {
      const time = String(row.TIME || '');
      const year = time.slice(0, 4);
      const value = parseFloat(row.DATA_VALUE);
      if (year.length === 4 && !isNaN(value)) byYear[year] = value;
    });
    return byYear;
  } catch (e) {
    return null;
  }
}

// 가계부채(가계신용) — ECOS STAT_CODE=151Y001(가계신용, 업권별, 분기)의
// ITEM_CODE1=1000000 항목이 가계신용 총액 — StatisticItemList API로 직접
// 조회해서 확인한 값. 분기 시리즈라 시점 형식이 "YYYYQ#"이고(월별과 다름),
// 응답 단위가 "십억원"이라 "조원"으로 맞추려면 1000으로 나눠야 함.
async function fetchEcosHouseholdCredit(env) {
  if (!env.ECOS_API_KEY) return null;
  try {
    const endYear = new Date().getFullYear() + 1;
    const url = ECOS_API_URL + '/' + env.ECOS_API_KEY + '/json/kr/1/1000/151Y001/Q/2002Q1/' + endYear + 'Q4/1000000/';
    const r = await fetch(url);
    const data = await r.json();
    const rows = data.StatisticSearch && data.StatisticSearch.row;
    if (!rows) return null;
    const byYear = {};
    rows.forEach(function (row) {
      const time = String(row.TIME || '');
      const year = time.slice(0, 4);
      const value = parseFloat(row.DATA_VALUE);
      if (year.length === 4 && !isNaN(value)) byYear[year] = value / 1000; // 십억원 -> 조원, 같은 해 안 마지막 분기가 이전 분기를 덮어씀
    });
    return byYear;
  } catch (e) {
    return null;
  }
}

function yearlyFromCsv(csvText) {
  const lines = csvText.trim().split('\n').slice(1); // drop header row
  const byYear = {};
  lines.forEach(function (line) {
    const comma = line.indexOf(',');
    if (comma === -1) return;
    const date = line.slice(0, comma);
    const raw = line.slice(comma + 1).trim();
    const value = parseFloat(raw);
    if (isNaN(value)) return; // FRED uses "." for missing observations
    const year = date.slice(0, 4);
    byYear[year] = value; // later rows overwrite earlier ones within the same year -> last observation wins
  });
  return byYear;
}

const RE_INDICATORS_CACHE_KEY = 're-indicators:v1';
const RE_MANUAL_KR_M2_KEY = 're-manual:krM2';

async function handleRealEstateIndicators(env) {
  const cached = await env.DATA.get(RE_INDICATORS_CACHE_KEY);
  if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  const results = await Promise.allSettled(RE_INDICATOR_SERIES.map(function (s) {
    return fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + s.id)
      .then(function (r) { return r.text(); })
      .then(function (csv) { return { key: s.key, label: s.label, byYear: yearlyFromCsv(csv) }; });
  }));

  const series = {};
  const labels = {};
  results.forEach(function (res, i) {
    if (res.status === 'fulfilled') {
      series[res.value.key] = res.value.byYear;
      labels[res.value.key] = res.value.label;
    }
  });
  if (!Object.keys(series).length) return json({ error: '지표 데이터를 가져오지 못했어요.' }, 502);

  const roneHousing = await fetchRoneSeries(env, 'A_2024_00045', '500001', '100001');
  if (roneHousing && Object.keys(roneHousing).length) {
    series.krHousing = roneHousing;
    labels.krHousing = '한국 아파트 매매가격지수(한국부동산원)';
  }

  const sentiment = await fetchRoneSeries(env, 'T232543129897499', '50004', '10001');
  if (sentiment && Object.keys(sentiment).length) {
    series.sentiment = sentiment;
    labels.sentiment = '주택 매매심리지수(국토연구원, 전국)';
  }

  const mortgageRate = await fetchEcosMortgageRate(env);
  if (mortgageRate && Object.keys(mortgageRate).length) {
    series.mortgageRate = mortgageRate;
    labels.mortgageRate = '주택담보대출 금리(신규취급, %)';
  }

  const householdCredit = await fetchEcosHouseholdCredit(env);
  if (householdCredit && Object.keys(householdCredit).length) {
    series.householdCredit = householdCredit;
    labels.householdCredit = '가계신용(한국은행, 조원)';
  }

  // 한국 M2 — 처음엔 무료 자동갱신 소스를 못 찾아서(ECOS는 자체 키 필요,
  // FRED의 대체 시리즈는 2017년에 멈춤) 관리자가 손으로 입력하는 방식으로
  // 시작했는데, 이후 ECOS도 R-ONE처럼 직접 가입하면 키를 받을 수 있는 걸
  // 확인해서 자동조회로 교체함. 키가 없거나 조회가 실패하면 그동안 입력해둔
  // 수동값으로 자동 대체(fallback)됨 — 완전히 끊기진 않게.
  const ecosM2 = await fetchEcosM2(env);
  if (ecosM2 && Object.keys(ecosM2).length) {
    series.krM2 = ecosM2;
    labels.krM2 = '한국 M2 통화량(한국은행 ECOS, 조원)';
  } else {
    const manualRaw = await env.DATA.get(RE_MANUAL_KR_M2_KEY);
    if (manualRaw) {
      series.krM2 = JSON.parse(manualRaw);
      labels.krM2 = '한국 M2 통화량(수동입력, 조원)';
    }
  }

  const allYears = new Set();
  Object.values(series).forEach(function (byYear) { Object.keys(byYear).forEach(function (y) { allYears.add(y); }); });
  const years = Array.from(allYears).sort().reverse(); // most recent year first

  const text = JSON.stringify({
    years: years,
    labels: labels,
    series: series,
    citation: 'DEXKOUS/DFF/DGS10/M2SL: Federal Reserve Bank of St. Louis (FRED), public domain U.S. government data. 한국 아파트 매매가격지수·주택 매매심리지수: 한국부동산원 R-ONE Open API(매매심리지수 원자료는 국토연구원 「부동산시장 소비자심리조사」). 한국 M2·주택담보대출 금리·가계신용: 한국은행 ECOS Open API — M2는 자동조회 실패 시에만 관리자가 직접 입력한 수치로 대체됨.'
  });
  await env.DATA.put(RE_INDICATORS_CACHE_KEY, text, { expirationTtl: 60 * 60 * 24 }); // 24h — these are mostly monthly/quarterly series, no need to refetch more often
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// admin-only: set/update one year's Korea M2 figure by hand (see comment
// above). Body: { admin, year, value }. Clears the combined-response cache
// so the new number shows up on the next page load instead of waiting out
// the 24h TTL.
async function handleRealEstateManualSet(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '잘못된 요청이에요.' }, 400);
  }
  if (!isAdmin(env, (body.admin || '').toString())) {
    return json({ error: '권한이 없어요.' }, 403);
  }
  const year = (body.year || '').toString().slice(0, 4);
  const value = parseFloat(body.value);
  if (!/^[0-9]{4}$/.test(year) || isNaN(value)) {
    return json({ error: 'year(4자리)와 value(숫자)를 정확히 보내주세요.' }, 400);
  }

  const raw = await env.DATA.get(RE_MANUAL_KR_M2_KEY);
  const byYear = raw ? JSON.parse(raw) : {};
  byYear[year] = value;
  await env.DATA.put(RE_MANUAL_KR_M2_KEY, JSON.stringify(byYear));
  await env.DATA.delete(RE_INDICATORS_CACHE_KEY); // force a fresh merge on next GET

  return json({ ok: true, year: year, value: value });
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

// MyMemory (mymemory.translated.net) — free, no signup/API key needed for
// this volume (anonymous tier: 5000 words/day). Chosen over Google
// Translate (needs a paid Cloud account + billing) and Brave Search API
// (checked — it has no translation endpoint at all, only search/news/
// image/local). Each title is cached indefinitely by article link, so a
// given headline only ever gets machine-translated once no matter how
// many 20-minute cache cycles it survives — keeps real usage far under
// the free quota even though up to 40 items get checked per cycle.
async function translateTitle(env, link, title) {
  const cacheKey = 'newstr2:' + link; // v2 prefix — v1 entries may be poisoned with a cached quota-warning string from before the fix above
  const cached = await env.DATA.get(cacheKey);
  if (cached) return cached;
  try {
    const res = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(title) + '&langpair=en|ko', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sloworldbot/1.0)' }
    });
    const data = await res.json();
    // MyMemory's own JSON is inconsistent about numeric vs string fields
    // (confirmed by inspecting real responses — e.g. `quality` comes back
    // as a number in some match entries and a string in others), so a
    // strict `=== 200` check on responseStatus was silently treating good
    // translations as failures whenever it came back as the string "200"
    // instead of the number 200. The presence of translatedText itself is
    // the reliable success signal — this was the actual reason 0/40
    // articles ever got translated after deploying.
    const ko = data && data.responseData && data.responseData.translatedText;
    // MyMemory returns HTTP 200 with translatedText set to this literal
    // warning string once the free daily quota (5000 words, anonymous
    // tier) is used up — that's exactly what happened today from this
    // session's own repeated manual testing. Caught the hard way: the
    // previous version of this check didn't catch it, so it briefly got
    // cached as if it were a real translation. Must check for this
    // explicitly since it's still a "successful" HTTP response.
    if (!ko || /^MYMEMORY WARNING/i.test(ko)) return null;
    await env.DATA.put(cacheKey, ko, { expirationTtl: 60 * 60 * 24 * 14 }); // 2 weeks — well past when an article stops showing up in the feed anyway
    return ko;
  } catch (e) {
    return null; // translation failure just means the card falls back to the English title
  }
}

async function handleNews(env) {
  const cacheKey = 'news:v6'; // bumped for the new titleKo field
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

  await Promise.all(items.map(async function (it) {
    it.titleKo = await translateTitle(env, it.link, it.title);
  }));

  const text = JSON.stringify({ items: items });
  await env.DATA.put(cacheKey, text, { expirationTtl: 60 * 20 }); // 20 min — RSS itself updates hourly
  return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

// ---- 긍정/부정 뉴스 발생수 로그 ----
// This is a metric sloworld computes itself (which matched-coin headlines
// moved >= threshold since publish) — unlike the TVL/price charts, there's
// no external API with years of history for it already. So this starts a
// log from scratch: an hourly Cron Trigger (see wrangler.toml + the
// `scheduled` export below) calls this once an hour, counts how many
// currently-matched articles are meaningfully positive/negative right now,
// and appends one point. 일(오늘) becomes meaningful almost immediately;
// 주/월/년/최대 fill in for real as weeks/months actually pass — no
// backfilled or fabricated history.
const NEWS_STAT_COIN_POOL = 1000; // ticker-match pool, mirrors crypto-news.js
const NEWS_STAT_NAME_POOL = 100; // name-match pool, mirrors crypto-news.js
const NEWS_STAT_ALIASES = {
  bitcoin: ['bitcoin'], ethereum: ['ethereum', 'ether'], ripple: ['ripple', 'xrp'],
  dogecoin: ['dogecoin'], solana: ['solana'], cardano: ['cardano'], tron: ['tron'],
  binancecoin: ['bnb', 'binance coin'], 'avalanche-2': ['avalanche'], polkadot: ['polkadot'],
  litecoin: ['litecoin'], chainlink: ['chainlink'], 'shiba-inu': ['shiba inu'],
  stellar: ['stellar lumens', 'stellar (xlm)'], monero: ['monero'], uniswap: ['uniswap'],
  aave: ['aave'], 'usd-coin': ['usdc', 'circle'], tether: ['tether', 'usdt']
};
const NEWS_STAT_TICKER_BLOCKLIST = ['US', 'USA', 'USD', 'ETF', 'ETFS', 'CEO', 'CFO', 'CFTC', 'SEC', 'API', 'ATH',
  'NFT', 'DEX', 'CEX', 'ICO', 'IPO', 'GDP', 'LLC', 'INC', 'FBI', 'DOJ', 'IRS', 'ASST'];
const NEWS_STAT_MIN_ABS_PCT = 0.5; // same "meaningful move" floor as the highlights panel

function escapeRegexForNews(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function matchCoinForStats(title, coins) {
  const namePool = coins.slice(0, NEWS_STAT_NAME_POOL);
  for (const c of namePool) {
    const names = NEWS_STAT_ALIASES[c.id] || [c.name.toLowerCase()];
    for (const name of names) {
      if (new RegExp('\\b' + escapeRegexForNews(name) + '\\b', 'i').test(title)) return c;
    }
  }
  const tickerPool = coins.slice(0, NEWS_STAT_COIN_POOL);
  for (const c of tickerPool) {
    const sym = (c.symbol || '').toUpperCase();
    if (sym.length < 3 || NEWS_STAT_TICKER_BLOCKLIST.includes(sym)) continue;
    if (new RegExp('\\b' + escapeRegexForNews(sym) + '\\b').test(title)) return c;
  }
  return null;
}

async function fetchAnchorPriceForStats(coinId, pubDateMs) {
  const from = Math.floor(pubDateMs / 1000);
  const to = Math.floor(Date.now() / 1000);
  if (to - from < 300) return null;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/coins/' + coinId + '/market_chart/range?vs_currency=usd&from=' + from + '&to=' + to + '&x_cg_demo_api_key=CG-FMfLVSBE5qcpYQ2R9RYTVogy');
    if (!r.ok) return null;
    const data = await r.json();
    const prices = data && data.prices;
    return prices && prices.length ? prices[0][1] : null;
  } catch (e) {
    return null;
  }
}

async function computeNewsStatPoint(env) {
  const newsRaw = await env.DATA.get('news:v6');
  const items = newsRaw ? (JSON.parse(newsRaw).items || []) : [];
  if (!items.length) return null;

  const pages = await Promise.all([1, 2, 3, 4].map(function (page) {
    return fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=' + page + '&price_change_percentage=24h&x_cg_demo_api_key=CG-FMfLVSBE5qcpYQ2R9RYTVogy')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }));
  const coins = [].concat(...pages);
  if (!coins.length) return null;

  const matched = items
    .map(function (n) { return { item: n, coin: matchCoinForStats(n.title, coins) }; })
    .filter(function (x) { return x.coin; });

  let pos = 0, neg = 0;
  await Promise.all(matched.map(async function (m) {
    const anchor = await fetchAnchorPriceForStats(m.coin.id, new Date(m.item.pubDate).getTime());
    if (anchor == null || !m.coin.current_price) return;
    const pct = (m.coin.current_price - anchor) / anchor * 100;
    if (pct >= NEWS_STAT_MIN_ABS_PCT) pos++;
    else if (pct <= -NEWS_STAT_MIN_ABS_PCT) neg++;
  }));

  return { t: Date.now(), pos: pos, neg: neg };
}

const NEWS_STAT_LOG_KEY = 'newsstat:log';
const NEWS_STAT_MAX_POINTS = 24 * 400; // ~400 days of hourly points, plenty of runway before this needs revisiting

async function logNewsStatPoint(env) {
  const point = await computeNewsStatPoint(env);
  if (!point) return;
  const raw = await env.DATA.get(NEWS_STAT_LOG_KEY);
  const log = raw ? JSON.parse(raw) : [];
  // guard against double-logging if this is ever invoked more than once in
  // the same window (manual test call right after a real cron fire, or a
  // rare double-fire) — skip if the last point is under 50 minutes old.
  if (log.length && point.t - log[log.length - 1].t < 50 * 60 * 1000) return;
  log.push(point);
  if (log.length > NEWS_STAT_MAX_POINTS) log.splice(0, log.length - NEWS_STAT_MAX_POINTS);
  await env.DATA.put(NEWS_STAT_LOG_KEY, JSON.stringify(log));
}

async function handleNewsStats(url, env) {
  const raw = await env.DATA.get(NEWS_STAT_LOG_KEY);
  const log = raw ? JSON.parse(raw) : [];
  const range = url.searchParams.get('range') || 'max';
  let points = log;
  if (range !== 'max') {
    const days = parseInt(range, 10);
    if (days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      points = log.filter(function (p) { return p.t >= cutoff; });
    }
  }
  return json({ points: points });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/comments') {
      if (request.method === 'GET') return handleCommentsGet(request, env, url);
      if (request.method === 'POST') return handleCommentsPost(request, env);
      if (request.method === 'DELETE') return handleCommentsDelete(request, env);
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

    if (url.pathname === '/api/real-estate-indicators') {
      if (request.method === 'GET') return handleRealEstateIndicators(env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/real-estate-indicators-manual') {
      if (request.method === 'POST') return handleRealEstateManualSet(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/news-stats') {
      if (request.method === 'GET') return handleNewsStats(url, env);
      return new Response('Method not allowed', { status: 405 });
    }

    // manual trigger for the same hourly job the Cron Trigger runs —
    // exists so the logging pipeline can be verified without waiting for
    // the real schedule; the 50-minute double-log guard in
    // logNewsStatPoint makes repeat hits harmless either way.
    if (url.pathname === '/api/news-stats-tick') {
      await logNewsStatPoint(env);
      return handleNewsStats(url, env);
    }

    return env.ASSETS.fetch(request);
  },

  // Cron Trigger — see wrangler.toml `[triggers]`. Runs hourly to log one
  // 긍정/부정 뉴스 발생수 point (see computeNewsStatPoint above).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(logNewsStatPoint(env));
  }
};
