// AniList GraphQL API: ключ не потрібен. Звідси беремо серії, розклад і наступні сезони.
import { CACHE_HOURS } from './config.js';

const API = 'https://graphql.anilist.co';
const PREFIX = 'anilist:';
const SERIES = ['TV', 'TV_SHORT', 'ONA']; // формати, які вважаємо «сезонами»

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Запити до AniList ідуть по одному з паузою (ліміт AniList ~30 запитів на хвилину).
// Дві черги: запити видимої сторінки йдуть першими, фонові (франшизи) — коли немає інших.
// Після відмови через ліміт уся черга чекає (pauseUntil), а не лише той запит.
const jobs = { high: [], low: [] };
let pumping = false;
let lastRequestAt = 0;
let pauseUntil = 0;

function enqueue(fn, low) {
  return new Promise((resolve, reject) => {
    jobs[low ? 'low' : 'high'].push({ fn, resolve, reject });
    pump();
  });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (jobs.high.length || jobs.low.length) {
    const wait = Math.max(lastRequestAt + 400, pauseUntil) - Date.now();
    if (wait > 0) await sleep(wait);
    const job = jobs.high.shift() || jobs.low.shift(); // пріоритетний міг з'явитися під час паузи
    lastRequestAt = Date.now();
    try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
  }
  pumping = false;
}

async function gql(query, variables, { low = false } = {}, attempt = 0) {
  let res;
  try {
    res = await enqueue(() => fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    }), low);
  } catch {
    // Safari при відмові (зокрема через ліміт) часто дає лише «Load failed» — чекаємо й пробуємо ще
    if (attempt < 2) {
      pauseUntil = Math.max(pauseUntil, Date.now() + (attempt ? 10000 : 4000));
      return gql(query, variables, { low }, attempt + 1);
    }
    throw new Error('Не вдалося зв\'язатися з AniList. Перевірте інтернет або спробуйте за хвилину.');
  }
  // ліміт запитів AniList: чекаємо, скільки просять (не довше 30 с), і пробуємо ще раз
  if (res.status === 429 && attempt < 2) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 10, 30);
    pauseUntil = Math.max(pauseUntil, Date.now() + wait * 1000);
    return gql(query, variables, { low }, attempt + 1);
  }
  if (res.status === 429) throw new Error('AniList тимчасово обмежив кількість запитів. Спробуйте за хвилину.');
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`AniList: ${json.errors?.[0]?.message || `помилка ${res.status}`}`);
  return json.data;
}

const FULL = `id siteUrl episodes status format seasonYear
  title { romaji english }
  startDate { year month day }
  nextAiringEpisode { episode airingAt }
  relations { edges { relationType node { id type format status episodes title { romaji english } startDate { year month day } } } }`;

const SHORT = 'id episodes format seasonYear title { romaji english native } coverImage { medium }';

function slim(m) {
  const seq = (m.relations?.edges || [])
    .filter((e) => e.relationType === 'SEQUEL' && e.node.type === 'ANIME' && SERIES.includes(e.node.format))
    .map((e) => e.node)[0];
  let aired = null; // скільки серій уже вийшло; null — невідомо
  if (m.nextAiringEpisode) aired = m.nextAiringEpisode.episode - 1;
  else if (m.status === 'FINISHED') aired = m.episodes;
  else if (m.status === 'NOT_YET_RELEASED') aired = 0;
  return {
    id: m.id,
    url: m.siteUrl,
    title: m.title.english || m.title.romaji,
    romaji: m.title.romaji,
    format: m.format,
    year: m.seasonYear || m.startDate?.year || null,
    episodes: m.episodes ?? null,
    status: m.status,
    aired,
    next: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt * 1000 } : null,
    sequel: seq ? {
      id: seq.id, title: seq.title.english || seq.title.romaji, status: seq.status, episodes: seq.episodes, start: seq.startDate,
    } : null,
  };
}

function readCache(key) {
  try { return JSON.parse(localStorage.getItem(PREFIX + key)); } catch { return null; }
}
function writeCache(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* переповнено */ }
}

export const peekAnilist = (id) => readCache(id)?.data ?? null;

// Дані для кількох записів одним запитом. Повертає Map id → дані.
export async function getAnilist(ids, { force = false } = {}) {
  const out = new Map();
  const todo = [];
  for (const id of new Set(ids)) {
    const c = readCache(id);
    if (!force && c && Date.now() - c.t < CACHE_HOURS * 3600e3) out.set(id, c.data);
    else todo.push(id);
  }
  for (let i = 0; i < todo.length; i += 50) {
    const data = await gql(`query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) { ${FULL} } } }`,
      { ids: todo.slice(i, i + 50) });
    for (const m of data.Page.media) {
      const s = slim(m);
      out.set(s.id, s);
      writeCache(s.id, { t: Date.now(), data: s });
    }
  }
  return out;
}

// Розклад виходу серій для кількох записів за проміжок часу [from, to) у мс.
// Повертає [{ id, episode, at }], відсортовані за часом.
export async function getAiring(ids, from, to, { force = false } = {}) {
  if (!ids.length) return [];
  const key = `air:${from}`;
  const idsKey = [...ids].sort((a, b) => a - b).join(',');
  const c = readCache(key);
  if (!force && c && c.ids === idsKey && c.to === to && Date.now() - c.t < CACHE_HOURS * 3600e3) return c.data;
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const d = await gql(`query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
      Page(page: $page, perPage: 50) {
        pageInfo { hasNextPage }
        airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) { mediaId episode airingAt }
      } }`, { ids, from: Math.floor(from / 1000) - 1, to: Math.floor(to / 1000), page });
    out.push(...d.Page.airingSchedules.map((s) => ({ id: s.mediaId, episode: s.episode, at: s.airingAt * 1000 })));
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  writeCache(key, { t: Date.now(), ids: idsKey, to, data: out });
  return out;
}

// Рекомендації глядачів AniList для кількох записів. Повертає Map id запису → [рекомендації].
export async function getRecommendations(ids, { force = false } = {}) {
  const out = new Map();
  const todo = [];
  for (const id of new Set(ids)) {
    const c = readCache(`rec:${id}`);
    // c.v — кеш зі старої версії (без японських назв / опису) перезавантажуємо
    if (!force && c?.v === 3 && Date.now() - c.t < CACHE_HOURS * 4 * 3600e3) out.set(id, c.data);
    else todo.push(id);
  }
  // по 10: з вкладеними рекомендаціями більша пачка може перевищити «складність» запиту AniList
  for (let i = 0; i < todo.length; i += 10) {
    const d = await gql(`query ($ids: [Int]) { Page(perPage: 10) { media(id_in: $ids, type: ANIME) { id
      recommendations(sort: RATING_DESC, perPage: 10) { nodes { rating mediaRecommendation {
        id siteUrl format seasonYear episodes status averageScore isAdult genres description(asHtml: false)
        title { romaji english native } coverImage { large }
      } } } } } }`, { ids: todo.slice(i, i + 10) });
    for (const m of d.Page.media) {
      const recs = m.recommendations.nodes
        .filter((n) => n.mediaRecommendation && !n.mediaRecommendation.isAdult && n.rating > 0)
        .map(({ rating, mediaRecommendation: r }) => ({
          id: r.id,
          votes: rating,
          url: r.siteUrl,
          title: r.title.english || r.title.romaji,
          romaji: r.title.romaji,
          native: r.title.native,
          // опис AniList англійською: прибираємо теги й «(Source: …)»
          description: (r.description || '').replace(/<[^>]+>/g, ' ').replace(/\(Source:[^)]*\)/gi, '').replace(/\s+/g, ' ').trim(),
          cover: r.coverImage?.large || '',
          format: r.format,
          year: r.seasonYear,
          episodes: r.episodes,
          status: r.status,
          score: r.averageScore,
          genres: r.genres || [],
        }));
      out.set(m.id, recs);
      writeCache(`rec:${m.id}`, { v: 3, t: Date.now(), data: recs });
    }
  }
  return out;
}

// ---------- франшиза: усі пов'язані записи (сезони, OVA, фільми, спешали)

const EXPAND = ['PREQUEL', 'SEQUEL', 'SIDE_STORY', 'PARENT']; // ідемо по цих зв'язках далі
const LEAF = ['SPIN_OFF', 'SUMMARY']; // показуємо, але їхні зв'язки не розгортаємо (інакше затягне чужі франшизи)

const FR_QUERY = `query ($ids: [Int]) { Page(perPage: 50) { media(id_in: $ids, type: ANIME) {
  id siteUrl format status episodes seasonYear isAdult
  title { romaji english } coverImage { medium } startDate { year month day }
  relations { edges { relationType node { id type format isAdult title { romaji english } startDate { year month day } } } }
} } }`;

const FR_VERSION = 2; // змінюється, коли міняється логіка франшизи, — старий кеш ігноруємо

// дані франшизи зберігаються один раз (fr:<корінь>), а для кожного учасника — вказівник (frp:<id>)
function readFranchise(id) {
  const root = readCache(`frp:${id}`);
  const c = root ? readCache(`fr:${root}`) : null;
  return c?.v === FR_VERSION ? c : null;
}

const normTitle = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const dateKey = (d) => (d?.year || 9999) * 10000 + (d?.month || 12) * 100 + (d?.day || 28);

// AniList інколи пов'язує сезони як OTHER, а не SEQUEL (напр. «Cyberpunk: Edgerunners» → «… 2»).
// Якщо це серіал і назва одного продовжує назву іншого — вважаємо це сусіднім сезоном.
function otherAsSeason(m, node) {
  if (!SERIES.includes(node.format) || !SERIES.includes(m.format)) return null;
  const a = [m.title.english, m.title.romaji].map(normTitle).filter((t) => t.length >= 4);
  const b = [node.title?.english, node.title?.romaji].map(normTitle).filter((t) => t.length >= 4);
  const related = a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)));
  if (!related) return null;
  return dateKey(node.startDate) > dateKey(m.startDate) ? 'SEQUEL' : 'PREQUEL';
}

export const peekFranchise = (id) => readFranchise(id)?.data ?? null;

const frFresh = (id) => {
  const c = readFranchise(id);
  return c && Date.now() - c.t < CACHE_HOURS * 12 * 3600e3 ? c.data : null;
};

const frPending = new Map(); // id → проміс, щоб не вантажити ту саму франшизу двічі паралельно

// Франшиза одного тайтлу (картка тайтлу, додавання) — пріоритетний запит.
export function getFranchise(id) {
  const fresh = frFresh(id);
  if (fresh) return Promise.resolve(fresh);
  if (!frPending.has(id)) {
    frPending.set(id, getFranchises([id]).then(() => frFresh(id) || []).finally(() => frPending.delete(id)));
  }
  return frPending.get(id);
}

// Франшизи багатьох тайтлів одним спільним обходом: кожен рівень зв'язків — пачками по 50
// записів. Для великого списку це десятки запитів замість сотень (окремий обхід на кожен тайтл).
// Потім граф ділимо на зв'язні частини — кожна частина й є франшизою.
export async function getFranchises(ids, { low = false } = {}) {
  const need = [...new Set(ids)].filter((id) => !frFresh(id));
  if (!need.length) return;
  const nodes = new Map();
  const via = new Map(need.map((id) => [id, null])); // яким зв'язком знайшли запис
  let frontier = need;
  for (let depth = 0; frontier.length && depth < 12 && nodes.size < 3000; depth++) {
    const next = [];
    for (let i = 0; i < frontier.length; i += 50) {
      const d = await gql(FR_QUERY, { ids: frontier.slice(i, i + 50) }, { low });
      collect(d.Page.media, next);
    }
    frontier = next;
  }

  // зв'язні частини графа (об'єднання множин)
  const parent = new Map([...nodes.keys()].map((k) => [k, k]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const n of nodes.values()) {
    for (const r of n.rel) if (nodes.has(r.id)) parent.set(find(n.id), find(r.id));
  }
  const groups = new Map();
  for (const n of nodes.values()) {
    const k = find(n.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  const t = Date.now();
  for (const data of groups.values()) {
    const root = Math.min(...data.map((n) => n.id));
    writeCache(`fr:${root}`, { v: FR_VERSION, t, data });
    for (const n of data) writeCache(`frp:${n.id}`, root);
  }

  function collect(media, next) {
    for (const m of media) {
      if (m.isAdult || m.format === 'MUSIC') continue;
      const rel = m.relations.edges
        .filter((e) => e.node.type === 'ANIME' && e.node.format !== 'MUSIC' && !e.node.isAdult)
        .map((e) => ({ type: e.relationType === 'OTHER' ? otherAsSeason(m, e.node) : e.relationType, id: e.node.id }))
        .filter((r) => [...EXPAND, ...LEAF].includes(r.type));
      const v = via.get(m.id) ?? null;
      nodes.set(m.id, {
        id: m.id,
        url: m.siteUrl,
        title: m.title.english || m.title.romaji,
        format: m.format,
        status: m.status,
        episodes: m.episodes,
        year: m.seasonYear || m.startDate?.year || null,
        start: m.startDate,
        cover: m.coverImage?.medium || '',
        via: v,
        rel,
      });
      if (LEAF.includes(v)) continue;
      for (const r of rel) {
        if (via.has(r.id)) continue;
        via.set(r.id, r.type);
        next.push(r.id);
      }
    }
  }
}

const shortOf = (m) => ({
  id: m.id,
  title: m.title.english || m.title.romaji,
  romaji: m.title.romaji,
  native: m.title.native,
  format: m.format,
  year: m.seasonYear,
  episodes: m.episodes,
  cover: m.coverImage?.medium || '',
});

// один запис за id (для вставленого посилання anilist.co/anime/<id>)
export async function getAnilistShort(id) {
  const data = await gql(`query ($id: Int) { Media(id: $id, type: ANIME) { ${SHORT} } }`, { id });
  return data.Media ? shortOf(data.Media) : null;
}

export async function searchAnilist(q) {
  const data = await gql(`query ($q: String) { Page(perPage: 12) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${SHORT} } } }`, { q });
  return data.Page.media.map(shortOf);
}

// Автоматичний підбір запису за назвами з TMDB. Перевага — серіал того ж року (зазвичай 1 сезон).
export async function matchAnilist(names, year, formats = SERIES) {
  // NFKC: «８６―エイティシックス―» → «86―エイティシックス―» (AniList не шукає широкі символи)
  const variants = names.filter(Boolean).flatMap((n) => [n.normalize('NFKC'), n.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()]);
  for (const name of [...new Set(variants)].filter((n) => !/[а-яіїєґ]/i.test(n)).slice(0, 5)) { // кирилицею AniList не шукає
    const list = await searchAnilist(name).catch(() => []);
    const series = list.filter((m) => formats.includes(m.format));
    const pick = series.find((m) => year && m.year === year) || series[0];
    if (pick) return pick.id;
  }
  return null;
}

export function clearAnilistCache() {
  Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
}
