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
// aggregate: 'last'(기본) = 그 해 마지막 달 값(지수·금리·재고 같은 "특정 시점
// 스냅샷" 지표에 맞음), 'sum' = 그 해 12개월 합계(분양세대수처럼 "그 달에
// 새로 생긴 양"을 더해야 "연간 물량"이 되는 지표에 맞음 — 12월 값만 쓰면 그
// 해 마지막 달 한 달치만 보여주는 셈이라 틀린 숫자가 됨).
async function fetchRoneSeries(env, statblId, clsId, itmId, aggregate) {
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
    const monthCount = {}; // 'sum' 모드에서만 채워짐 — 올해처럼 아직 12개월이 다 안 쌓인 해를 구분하기 위한 값
    rows.forEach(function (row) {
      const wt = String(row.WRTTIME_IDTFR_ID || '');
      const year = wt.slice(0, 4);
      const value = parseFloat(row.DTA_VAL);
      if (year.length !== 4 || isNaN(value)) return;
      if (aggregate === 'sum') {
        byYear[year] = (byYear[year] || 0) + value;
        monthCount[year] = (monthCount[year] || 0) + 1;
      } else {
        byYear[year] = value; // 같은 해 안에서는 더 늦은 달이 이전 값을 덮어씀 -> 그 해의 마지막 관측치
      }
    });
    return aggregate === 'sum' ? { byYear: byYear, monthCount: monthCount } : byYear;
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

  // 신규 분양세대수 — 이 통계표는 드물게 전국 합계 행(CLS_ID=50001)이 이미
  // 있어서 지역 합산이 필요 없음. 'sum'으로 넘기는 이유는 "분양물량"은
  // 12월 한 달치 스냅샷이 아니라 그 해에 새로 분양된 세대를 다 더한
  // 연간 누계라서 — last를 쓰면 12월 한 달치만 보여주는 잘못된 숫자가 됨.
  // 올해(진행 중인 해)는 아직 12개월치가 다 안 쌓였으므로, 지금까지의
  // 월평균 × 12로 "연말까지 예상되는 물량"을 따로 계산해서 newSupplyProjection
  // 으로 같이 내려줌 — series.newSupply 자체는 그대로 "지금까지의 실측 합계".
  const newSupplyResult = await fetchRoneSeries(env, 'T244633134461863', '50001', '10001', 'sum');
  let newSupplyProjection = null;
  if (newSupplyResult && Object.keys(newSupplyResult.byYear).length) {
    series.newSupply = newSupplyResult.byYear;
    labels.newSupply = '신규 분양세대수(한국부동산원, 연간 합계)';
    const curYear = String(new Date().getFullYear());
    const monthsSoFar = newSupplyResult.monthCount[curYear];
    const sumSoFar = newSupplyResult.byYear[curYear];
    if (monthsSoFar && monthsSoFar < 12 && sumSoFar != null) {
      newSupplyProjection = { year: curYear, monthsUsed: monthsSoFar, estimate: Math.round(sumSoFar / monthsSoFar * 12) };
    }
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
    newSupplyProjection: newSupplyProjection,
    citation: 'DEXKOUS/DFF/DGS10/M2SL: Federal Reserve Bank of St. Louis (FRED), public domain U.S. government data. 한국 아파트 매매가격지수·주택 매매심리지수·신규 분양세대수: 한국부동산원 R-ONE Open API(매매심리지수 원자료는 국토연구원 「부동산시장 소비자심리조사」). 한국 M2·주택담보대출 금리·가계신용: 한국은행 ECOS Open API — M2는 자동조회 실패 시에만 관리자가 직접 입력한 수치로 대체됨.'
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

// "어디로 갈아타면 좋을까" — 국토교통부 아파트 매매 실거래가 API(RTMSDataSvcAptTrade).
// data.go.kr에 자체 활용신청(활용신청 버튼)이 있는 진짜 오픈API라 R-ONE/ECOS처럼
// 별도 사이트 가입은 필요 없었음. 응답이 JSON이 아니라 XML이라, 이미 크립토
// 뉴스 RSS 파싱에 쓰던 xmlTag()를 그대로 재사용. CORS 미지원이라 서버에서 대신 호출.
const MOLIT_API_URL = 'http://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade';

function parseAptTradeXml(xml) {
  const items = [];
  const itemRe = /<item>[\s\S]*?<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[0];
    const name = xmlTag(block, 'aptNm').trim();
    const dealAmountRaw = xmlTag(block, 'dealAmount').trim().replace(/,/g, '');
    const dealAmount = parseInt(dealAmountRaw, 10); // 만원 단위
    const year = xmlTag(block, 'dealYear').trim();
    const month = xmlTag(block, 'dealMonth').trim();
    const day = xmlTag(block, 'dealDay').trim();
    const dong = xmlTag(block, 'umdNm').trim();
    const jibun = xmlTag(block, 'jibun').trim();
    const area = parseFloat(xmlTag(block, 'excluUseAr').trim());
    const floor = xmlTag(block, 'floor').trim();
    const buildYear = xmlTag(block, 'buildYear').trim();
    if (!name || isNaN(dealAmount)) continue;
    items.push({ name: name, dong: dong, jibun: jibun, dealAmount: dealAmount, area: area, floor: floor, buildYear: buildYear, dealDate: year + '.' + month + '.' + day });
  }
  return items;
}

// 한 달만 조회하면 그 지역에 그 달 거래가 아예 없을 수 있어서(실제로 확인한
// 사례: 부천시 2025년 7월) 최근 3개월치를 합쳐서 조회함.
function recentYearMonths(count) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < count; i++) {
    const y = d.getFullYear();
    const mo = d.getMonth() + 1;
    out.push(y + String(mo).padStart(2, '0'));
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

// 역세권 판정용 — 서울교통공사 1~8호선 역 좌표(data.go.kr 파일데이터,
// "서울교통공사_1_8호선 역사 좌표(위경도) 정보", 인증키 불필요, 239개 역
// 중복제거). 경기/타 도시 지하철·GTX·신분당선 등은 아직 미포함이라, 서울
// 외 지역은 subway 값이 항상 null(정보없음)로 나감 — 나중에 확장 예정.
const SEOUL_SUBWAY_STATIONS = [["서울",37.55315,126.972533],["시청",37.56359,126.975407],["종각",37.570203,126.983116],["종로3가",37.570429,126.992095],["종로5가",37.570971,127.0019],["동대문",37.57179,127.011383],["동묘앞",37.573265,127.016459],["신설동",37.576117,127.02471],["제기동",37.578116,127.034902],["청량리",37.580148,127.045063],["을지로입구",37.565998,126.982569],["을지로3가",37.566292,126.991773],["을지로4가",37.566611,126.998122],["동대문역사문화공원",37.565597,127.009113],["신당",37.565681,127.019488],["상왕십리",37.564504,127.028872],["왕십리",37.561159,127.035505],["한양대",37.55658,127.043504],["뚝섬",37.54718,127.047413],["성수",37.544628,127.055983],["건대입구",37.540408,127.069231],["구의",37.536857,127.085024],["강변",37.535161,127.094684],["잠실나루",37.520688,127.103836],["잠실",37.513305,127.100129],["잠실새내",37.520731,127.103738],["종합운동장",37.511008,127.073641],["삼성",37.508827,127.063203],["선릉",37.504257,127.048174],["역삼",37.500658,127.03643],["강남",37.497958,127.027539],["교대",37.493957,127.014631],["서초",37.49191,127.007945],["방배",37.481469,126.997627],["사당",37.476536,126.981631],["낙성대",37.47693,126.963783],["서울대입구",37.481233,126.952745],["봉천",37.482416,126.941896],["신림",37.484216,126.929573],["신대방",37.487534,126.913279],["구로디지털단지",37.485005,126.902626],["대림",37.492426,126.895293],["신도림",37.508815,126.891222],["문래",37.517993,126.894766],["영등포구청",37.525766,126.896627],["당산",37.533877,126.902011],["합정",37.550025,126.914557],["홍대입구",37.556748,126.923643],["신촌",37.555153,126.93689],["이대",37.556734,126.945897],["아현",37.557407,126.956079],["충정로",37.559742,126.964455],["용두",37.574012,127.03811],["신답",37.56147,127.056348],["용답",37.566412,126.977863],["도림천",37.514759,126.882586],["양천구청",37.512194,126.865193],["신정네거리",37.520218,126.852849],["까치산",37.53181,126.846706],["지축",37.648281,126.912551],["구파발",37.636612,126.918827],["연신내",37.618855,126.920859],["불광",37.610554,126.929843],["녹번",37.600882,126.935758],["홍제",37.588851,126.944092],["무악재",37.582658,126.950131],["독립문",37.574534,126.957902],["경복궁",37.575844,126.973576],["안국",37.576562,126.98547],["충무로",37.561302,126.995473],["동대입구",37.55816,127.005273],["약수",37.554674,127.010628],["금호",37.548269,127.015785],["옥수",37.541653,127.017303],["압구정",37.526169,127.028502],["신사",37.516438,127.020247],["잠원",37.512989,127.011613],["고속터미널",37.504953,127.004916],["남부터미널",37.48494,127.016289],["양재",37.48466,127.03513],["매봉",37.487114,127.046907],["도곡",37.491129,127.055694],["대치",37.494601,127.063449],["학여울",37.496757,127.070541],["대청",37.493607,127.079526],["일원",37.48389,127.08416],["수서",37.487507,127.101324],["가락시장",37.492368,127.118101],["경찰병원",37.495754,127.124198],["오금",37.502288,127.128344],["당고개",37.66956,127.078404],["상계",37.660576,127.073199],["노원",37.656274,127.063183],["창동",37.652993,127.046746],["쌍문",37.648274,127.034381],["수유",37.637127,127.024731],["미아",37.626435,127.026151],["미아사거리",37.613276,127.030083],["길음",37.604087,127.025353],["성신여대입구",37.592782,127.017338],["한성대입구",37.58838,127.006751],["혜화",37.582116,127.001759],["명동",37.561055,126.988271],["회현",37.559698,126.979565],["숙대입구",37.545124,126.971952],["삼각지",37.535057,126.973354],["신용산",37.52919,126.96858],["이촌",37.522525,126.97335],["동작",37.503567,126.980171],["총신대입구",37.487521,126.982309],["남태령",37.464339,126.989081],["방화",37.577669,126.812822],["개화산",37.572458,126.806838],["김포공항",37.56217,126.801273],["송정",37.561411,126.812052],["마곡",37.562182,126.82693],["발산",37.562182,126.82693],["우장산",37.548864,126.83633],["화곡",37.541585,126.840436],["신정",37.525001,126.856176],["목동",37.526088,126.864296],["오목교",37.524557,126.875049],["양평",37.525614,126.886177],["영등포시장",37.52276,126.905143],["신길",37.51763,126.914886],["여의도",37.521578,126.924318],["여의나루",37.527145,126.932807],["마포",37.539718,126.946043],["공덕",37.544005,126.951058],["애오개",37.553592,126.956733],["서대문",37.565812,126.966639],["광화문",37.570545,126.976568],["청구",37.560237,127.01379],["신금호",37.554504,127.020403],["행당",37.557297,127.029482],["마장",37.566066,127.042921],["답십리",37.566833,127.05266],["장한평",37.561438,127.064601],["군자",37.557102,127.079559],["아차산",37.552005,127.089609],["광나루",37.545301,127.103478],["천호",37.538566,127.123539],["강동",37.53581,127.13249],["길동",37.538022,127.140085],["굽은다리",37.545442,127.142844],["명일",37.551317,127.144002],["고덕",37.555002,127.154214],["상일동",37.556714,127.166381],["둔촌동",37.527787,127.136219],["올림픽공원",37.516217,127.130957],["방이",37.508752,127.126054],["개롱",37.498097,127.134817],["거여",37.493208,127.143983],["마천",37.494972,127.152784],["강일",37.557521,127.176018],["미사",37.56329,127.192954],["하남풍산",37.552201,127.203897],["하남시청",37.541723,127.206901],["하남검단산",37.539729,127.223427],["응암",37.59859,126.915583],["역촌",37.60605,126.922764],["독바위",37.618413,126.933035],["구산",37.611223,126.917246],["새절",37.591148,126.913613],["증산",37.583989,126.909785],["디지털미디어시티",37.577005,126.898643],["월드컵경기장",37.569439,126.899077],["마포구청",37.563535,126.903326],["망원",37.556031,126.910129],["상수",37.547704,126.92292],["광흥창",37.547464,126.931971],["대흥",37.547732,126.942214],["효창공원앞",37.539279,126.961348],["녹사평",37.53469,126.98665],["이태원",37.534485,126.994369],["한강진",37.53956,127.001729],["버티고개",37.547933,127.006948],["창신",37.579772,127.015246],["보문",37.585293,127.019377],["안암",37.586261,127.02903],["고려대",37.59034,127.03626],["월곡",37.60192,127.041492],["상월곡",37.606392,127.048509],["돌곶이",37.610522,127.056419],["석계",37.614937,127.065922],["태릉입구",37.617319,127.074741],["화랑대",37.619875,127.084106],["봉화산",37.617293,127.091375],["신내",37.612571,127.104326],["장암",37.70015,127.053126],["도봉산",37.689131,127.046548],["수락산",37.677804,127.055314],["마들",37.664985,127.057701],["중계",37.645052,127.064084],["하계",37.636363,127.067999],["공릉",37.625642,127.072969],["먹골",37.610638,127.077719],["중화",37.602604,127.079254],["상봉",37.595673,127.085708],["면목",37.588671,127.087503],["사가정",37.580912,127.088502],["용마산",37.573752,127.086802],["중곡",37.565877,127.084291],["어린이대공원",37.547962,127.07465],["뚝섬유원지",37.531558,127.066714],["청담",37.519097,127.051851],["강남구청",37.517185,127.04122],["학동",37.514262,127.031738],["논현",37.511108,127.021385],["반포",37.508171,127.011717],["내방",37.48764,126.993541],["남성",37.484688,126.971108],["숭실대입구",37.496258,126.953649],["상도",37.50279,126.947949],["장승배기",37.504845,126.939025],["신대방삼거리",37.499717,126.928218],["보라매",37.499916,126.920112],["신풍",37.500107,126.909806],["남구로",37.486181,126.887372],["가산디지털단지",37.480376,126.882704],["철산",37.47616,126.868217],["광명사거리",37.47927,126.854854],["천왕",37.486699,126.838684],["온수",37.492059,126.823294],["암사",37.550127,127.127521],["강동구청",37.530348,127.120461],["몽촌토성",37.517692,127.11274],["석촌",37.505396,127.106995],["송파",37.49978,127.11212],["문정",37.485931,127.122473],["장지",37.478609,127.126229],["복정",37.471016,127.126746],["남위례",37.462839,127.139047],["산성",37.456886,127.149927],["남한산성입구",37.451568,127.159845],["단대오거리",37.445057,127.156735],["신흥",37.440952,127.14759],["수진",37.437575,127.140936],["모란",37.433888,127.129921]];

function haversineDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 지구 반지름(m)
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestSubway(lat, lng) {
  let best = null;
  SEOUL_SUBWAY_STATIONS.forEach(function (s) {
    const d = haversineDistanceM(lat, lng, s[1], s[2]);
    if (!best || d < best.distanceM) best = { name: s[0], distanceM: Math.round(d) };
  });
  if (!best) return null;
  const tier = best.distanceM <= 500 ? '초역세권' : best.distanceM <= 1000 ? '역세권' : '비역세권';
  return { station: best.name, distanceM: best.distanceM, tier: tier };
}

// LAWD_CD 앞 2자리 -> 시도명. VWorld 지오코딩에 "서울특별시 강남구 역삼동 789"
// 처럼 시도까지 붙여야 "중구"(서울/부산/대구/인천/대전에 전부 있음) 같은
// 이름이 겹치는 동명 지역과 헷갈리지 않음.
const SIDO_BY_CODE_PREFIX = { '11': '서울특별시', '26': '부산광역시', '27': '대구광역시', '28': '인천광역시', '29': '광주광역시', '30': '대전광역시', '31': '울산광역시', '36': '세종특별자치시', '41': '경기도' };

const VWORLD_API_URL = 'https://api.vworld.kr/req/address';

// 지오코딩 결과는 주소가 안 바뀌는 한 계속 같은 값이라, 검색 예산이 바뀌어도
// 재사용할 수 있게 주소별로 30일 캐시(re-search 캐시와는 별도, 훨씬 긴 TTL).
async function fetchVworldCoord(env, address) {
  if (!env.VWORLD_API_KEY) return null;
  const cacheKey = 're-geo:' + address;
  const cached = await env.DATA.get(cacheKey);
  if (cached) return cached === 'null' ? null : JSON.parse(cached);
  try {
    const params = new URLSearchParams({ service: 'address', request: 'getcoord', address: address, type: 'parcel', key: env.VWORLD_API_KEY });
    const r = await fetch(VWORLD_API_URL + '?' + params.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' }
    });
    const data = await r.json();
    const point = data.response && data.response.result && data.response.result.point;
    const coord = point ? { lat: parseFloat(point.y), lng: parseFloat(point.x) } : null;
    await env.DATA.put(cacheKey, coord ? JSON.stringify(coord) : 'null', { expirationTtl: 60 * 60 * 24 * 30 });
    return coord;
  } catch (e) {
    // 2026-08-27 확인: VWorld는 curl(일반 네트워크)에서는 100% 성공하는데
    // Cloudflare Worker에서 호출하면 502/520으로 계속 실패함(https, 순차
    // 호출, User-Agent 추가까지 다 시도했지만 동일) — Cloudflare가 앞단에
    // 있는 VWorld 쪽에서 Cloudflare Worker발 트래픽을 걸러내는 것으로 보임.
    // 같은 Worker에서 다른 정부 API(R-ONE/ECOS/국토부)는 정상 동작하는 걸
    // 확인했으므로 Worker 자체 네트워크 문제는 아님 — VWorld 특정 이슈.
    return null;
  }
}

// 세대수 — 국토교통부_공동주택 단지 목록제공 서비스(AptListService4) +
// 공동주택 기본 정보제공 서비스(AptBasisInfoServiceV5), 둘 다 실거래가 API와
// 같은 apis.data.go.kr/1613000 계열이라 같은 서비스키를 그대로 재사용함.
// 목록 API는 "시군구코드로 바로 검색"하는 getSigunguAptList4가 계속
// APPLICATION_ERROR를 내서(정부 API 자체 버그로 추정 — sidoCode/bjdCode
// 버전도 같은 증상), 대신 전체 목록(getTotalAptList4, 22,288건)을 미리
// 통째로 받아서 지역별로 쪼개 캐시해두는 방식으로 우회함. 이 전체 목록은
// /api/real-estate-apt-list-refresh(관리자 전용)를 한 번 실행해야 채워지고,
// 검색 요청 중에는 절대 새로 안 받아옴 — 검색 속도에 영향 없게 하기 위해서.
const KAPT_LIST_URL = 'https://apis.data.go.kr/1613000/AptListService4/getTotalAptList4';
const KAPT_BASIS_URL = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5';
// 2026-08-28 확인: 같은 서비스의 "상세정보"(getAphusDtlInfoV5)에 지하철역·
// 도보시간·인근 학교·편의시설이 이미 통째로 들어있음 — 그래서 VWorld
// 지오코딩(막힘)이나 K-APT 목록 재매칭 없이, 세대수랑 똑같은 kaptCode로
// 이 엔드포인트만 하나 더 부르면 역세권/초품아/상권이 한 번에 해결됨.
const KAPT_DETAIL_URL = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusDtlInfoV5';
const KAPT_REGION_PREFIX = 're-kapt-region:';

async function handleRealEstateAptListRefresh(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: '잘못된 요청이에요.' }, 400); }
  if (!isAdmin(env, (body.admin || '').toString())) return json({ error: '권한이 없어요.' }, 403);
  if (!env.MOLIT_API_KEY) return json({ error: '서비스키가 설정되지 않았어요.' }, 502);

  const molitKey = env.MOLIT_API_KEY.indexOf('%') !== -1 ? decodeURIComponent(env.MOLIT_API_KEY) : env.MOLIT_API_KEY;
  const byRegion = {}; // lawdCd(5자리) -> [[kaptName, kaptCode], ...]
  let page = 1;
  let total = Infinity;
  let fetched = 0;
  try {
    while (fetched < total && page <= 30) { // 안전장치: 30페이지(3만건) 넘으면 중단
      const params = new URLSearchParams({ serviceKey: molitKey, numOfRows: '1000', pageNo: String(page) });
      const r = await fetch(KAPT_LIST_URL + '?' + params.toString());
      const data = await r.json();
      const items = data.response && data.response.body && data.response.body.items;
      if (!items || !items.length) break;
      total = data.response.body.totalCount || items.length;
      items.forEach(function (it) {
        if (!it.bjdCode || !it.kaptCode || !it.kaptName) return;
        const lawdCd = it.bjdCode.slice(0, 5);
        if (!byRegion[lawdCd]) byRegion[lawdCd] = [];
        byRegion[lawdCd].push([it.kaptName, it.kaptCode]);
      });
      fetched += items.length;
      page++;
    }
    const regionCodes = Object.keys(byRegion);
    await Promise.all(regionCodes.map(function (code) {
      return env.DATA.put(KAPT_REGION_PREFIX + code, JSON.stringify(byRegion[code]), { expirationTtl: 60 * 60 * 24 * 60 }); // 60일 — 새 단지가 자주 생기는 데이터는 아님
    }));
    return json({ ok: true, totalFetched: fetched, regions: regionCodes.length });
  } catch (e) {
    return json({ error: '단지 목록을 가져오지 못했어요.', detail: fetched }, 502);
  }
}

// 단지코드로 세대수 등 기본정보 조회 — kaptCode별로 오래 캐시(세대수는 거의
// 안 바뀜).
async function fetchKaptBasis(env, molitKey, kaptCode) {
  const cacheKey = 're-kapt-basis:' + kaptCode;
  const cached = await env.DATA.get(cacheKey);
  if (cached) return cached === 'null' ? null : JSON.parse(cached);
  try {
    const params = new URLSearchParams({ serviceKey: molitKey, kaptCode: kaptCode });
    const r = await fetch(KAPT_BASIS_URL + '?' + params.toString());
    const data = await r.json();
    const item = data.response && data.response.body && data.response.body.item;
    const households = item && item.kaptdaCnt ? parseInt(item.kaptdaCnt, 10) : null;
    await env.DATA.put(cacheKey, households != null ? String(households) : 'null', { expirationTtl: 60 * 60 * 24 * 60 });
    return households;
  } catch (e) {
    return null;
  }
}

// 단지코드로 지하철역·도보시간·인근 학교·편의시설 조회 — 이것도 거의 안
// 바뀌는 값이라 오래 캐시.
async function fetchKaptDetail(env, molitKey, kaptCode) {
  const cacheKey = 're-kapt-detail:' + kaptCode;
  const cached = await env.DATA.get(cacheKey);
  if (cached) return cached === 'null' ? null : JSON.parse(cached);
  try {
    const params = new URLSearchParams({ serviceKey: molitKey, kaptCode: kaptCode });
    const r = await fetch(KAPT_DETAIL_URL + '?' + params.toString());
    const data = await r.json();
    const item = data.response && data.response.body && data.response.body.item;
    const detail = item ? {
      subwayLine: item.subwayLine || null,
      subwayStation: item.subwayStation || null,
      subwayWalkTime: item.kaptdWtimesub || null,
      schools: item.educationFacility || null,
      facilities: item.convenientFacility || null
    } : null;
    await env.DATA.put(cacheKey, detail ? JSON.stringify(detail) : 'null', { expirationTtl: 60 * 60 * 24 * 60 });
    return detail;
  } catch (e) {
    return null;
  }
}

async function handleRealEstateSearch(url, env) {
  if (!env.MOLIT_API_KEY) return json({ error: '실거래가 조회 기능이 아직 설정되지 않았어요.' }, 502);
  const lawdCd = (url.searchParams.get('lawdCd') || '').trim();
  const budget = parseFloat(url.searchParams.get('budget')); // 억원 단위
  if (!/^[0-9]{5}$/.test(lawdCd) || isNaN(budget) || budget <= 0) {
    return json({ error: 'lawdCd(5자리)와 budget(억원, 양수)을 정확히 보내주세요.' }, 400);
  }
  const budgetManwon = budget * 10000;
  const cacheKey = 're-search:' + lawdCd + ':' + budget;
  const cached = await env.DATA.get(cacheKey);
  if (cached) return new Response(cached, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  try {
    // data.go.kr 서비스키는 "인코딩"판(이미 %2F, %3D 등이 들어있음)과 "디코딩"판
    // 둘 다 발급되는데, 어느 쪽을 시크릿에 저장했는지 여기서는 알 수 없음.
    // 이미 인코딩된 값을 URLSearchParams에 그대로 넣으면 한 번 더 인코딩돼서
    // (%2F -> %252F) 키가 깨지므로, %가 섞여있으면 먼저 디코딩해서 원본으로
    // 되돌린 뒤 URLSearchParams가 인코딩을 한 번만 하게 함.
    const molitKey = env.MOLIT_API_KEY.indexOf('%') !== -1 ? decodeURIComponent(env.MOLIT_API_KEY) : env.MOLIT_API_KEY;
    const months = recentYearMonths(3);
    const results = await Promise.allSettled(months.map(function (ym) {
      const params = new URLSearchParams({ serviceKey: molitKey, LAWD_CD: lawdCd, DEAL_YMD: ym, numOfRows: '1000' });
      return fetch(MOLIT_API_URL + '?' + params.toString()).then(function (r) { return r.text(); }).then(parseAptTradeXml);
    }));
    let items = [];
    results.forEach(function (res) { if (res.status === 'fulfilled') items = items.concat(res.value); });
    items = items.filter(function (it) { return it.dealAmount <= budgetManwon; });
    items.sort(function (a, b) { return b.dealAmount - a.dealAmount; }); // 예산 안에서 가장 비싼(=좋은) 순
    items = items.slice(0, 50);

    // 역세권 판정 — 프론트에서 넘겨준 지역명(regionName, 드롭다운에 보이는 그
    // 이름 그대로)으로 주소를 만들어 VWorld로 좌표를 구하고, 가장 가까운
    // 서울 지하철역까지 거리를 계산함. regionName을 서버에서 다시 만들지
    // 않고 프론트가 이미 갖고 있는 값을 그대로 받는 이유는, 지역 목록을
    // 프론트/백엔드 두 군데에 따로 중복 저장하지 않기 위해서(같은 정보가
    // 여러 파일에 흩어져 있으면 한쪽만 고치는 실수가 나기 쉬움).
    const sido = SIDO_BY_CODE_PREFIX[lawdCd.slice(0, 2)] || '';
    const regionNameRaw = (url.searchParams.get('regionName') || '').trim();
    const regionName = regionNameRaw.replace(/\([^)]*\)/g, '').trim(); // "중구(서울)" -> "중구"
    // Cloudflare Worker는 한 번의 요청 처리에서 fetch() 호출을 최대 50번까지만
    // 허용함("Too many subrequests" 에러로 확인됨) — 위에서 이미 실거래가
    // 조회로 3번(최근 3개월치) 썼으니, 좌표변환은 상위 25건까지만 돌려서
    // 합계가 한도 안에 들어오게 함. 나머지 항목은 subway가 null로 남음
    // (역세권 아님이 아니라 "아직 안 알아봄"이라는 뜻).
    // 2026-08-27: VWorld가 이 Worker에서 호출하면 100% 실패(502/520)하는 걸
    // 확인했는데(IP 제한 의심, 원인 조사 중), 실패해도 매 호출마다 왕복
    // 시간이 들어서 25번 순차 호출하면 검색 자체가 느려짐 — 원인 해결 전까지는
    // 아예 시도하지 않도록 꺼둠(GEOCODE_ENABLED). 해결되면 이 값만 true로.
    const GEOCODE_ENABLED = false;
    const GEOCODE_LIMIT = 25;
    if (GEOCODE_ENABLED && env.VWORLD_API_KEY && sido) {
      for (const it of items.slice(0, GEOCODE_LIMIT)) {
        if (!it.jibun) { it.subway = null; continue; }
        const address = [sido, regionName, it.dong, it.jibun].filter(Boolean).join(' ');
        const coord = await fetchVworldCoord(env, address);
        it.subway = coord ? nearestSubway(coord.lat, coord.lng) : null;
      }
    }

    // 세대수 + 역세권/초품아/상권 — /api/real-estate-apt-list-refresh로 미리
    // 채워둔 지역별 단지 목록(KV, 검색 중엔 새로 안 받아옴)에서 이름으로
    // 매칭해서 단지코드를 찾고, 그 코드로 기본정보(세대수)와 상세정보
    // (지하철역·도보시간·인근학교·편의시설)를 같이 조회함 — 둘 다 같은
    // kaptCode를 쓰므로 한 번만 매칭하면 됨. 목록 캐시가 아직 없는 지역이면
    // 그냥 조용히 건너뜀(모든 값 null) — 검색 자체가 실패하면 안 되니까.
    const KAPT_LOOKUP_LIMIT = 20; // MOLIT 3건 + (기본정보+상세정보) 2*20=40 <= 50 (Cloudflare Worker 요청당 subrequest 한도)
    const kaptListRaw = await env.DATA.get(KAPT_REGION_PREFIX + lawdCd);
    if (kaptListRaw && env.MOLIT_API_KEY) {
      const kaptList = JSON.parse(kaptListRaw); // [[kaptName, kaptCode], ...]
      const kaptByName = {};
      const kaptByNameNoSpace = {}; // 국토부 실거래가 이름과 K-APT 등록명 사이에 띄어쓰기 차이가 있는
      // 경우가 많아서("래미안 개포 루체하임" vs "래미안개포루체하임") 공백 제거
      // 버전으로도 한 번 더 매칭 시도함.
      kaptList.forEach(function (pair) {
        if (!(pair[0] in kaptByName)) kaptByName[pair[0]] = pair[1];
        const noSpace = pair[0].replace(/\s+/g, '');
        if (!(noSpace in kaptByNameNoSpace)) kaptByNameNoSpace[noSpace] = pair[1];
      });
      const molitKeyForKapt = env.MOLIT_API_KEY.indexOf('%') !== -1 ? decodeURIComponent(env.MOLIT_API_KEY) : env.MOLIT_API_KEY;
      await Promise.all(items.slice(0, KAPT_LOOKUP_LIMIT).map(async function (it) {
        const cleanName = it.name.replace(/\s*\([^)]*\)\s*/g, '').trim();
        const kaptCode = kaptByName[cleanName] || kaptByName[it.name] || kaptByNameNoSpace[cleanName.replace(/\s+/g, '')];
        if (!kaptCode) { it.households = null; it.kaptInfo = null; return; }
        const [households, detail] = await Promise.all([
          fetchKaptBasis(env, molitKeyForKapt, kaptCode),
          fetchKaptDetail(env, molitKeyForKapt, kaptCode)
        ]);
        it.households = households;
        it.kaptInfo = detail;
      }));
    }

    const text = JSON.stringify({ items: items, months: months });
    await env.DATA.put(cacheKey, text, { expirationTtl: 60 * 60 * 6 }); // 6h — 실거래가 신고는 실시간이 아니라 하루 몇 번만 갱신돼도 충분
    return new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  } catch (e) {
    return json({ error: '실거래가 데이터를 가져오지 못했어요.' }, 502);
  }
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

    if (url.pathname === '/api/real-estate-search') {
      if (request.method === 'GET') return handleRealEstateSearch(url, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/real-estate-apt-list-refresh') {
      if (request.method === 'POST') return handleRealEstateAptListRefresh(request, env);
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
