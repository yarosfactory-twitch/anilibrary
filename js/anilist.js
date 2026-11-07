// AniList GraphQL API: ключ не потрібен. Звідси беремо серії, розклад і наступні сезони.
import { CACHE_HOURS } from './config.js';

const API = 'https://graphql.anilist.co';
const PREFIX = 'anilist:';
const SERIES = ['TV', 'TV_SHORT', 'ONA']; // формати, які вважаємо «сезонами»

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables, retries = 2) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  // ліміт запитів AniList: чекаємо, скільки просять (не довше 30 с), і пробуємо ще раз
  if (res.status === 429 && retries > 0) {
    const wait = Math.min(Number(res.headers.get('Retry-After')) || 10, 30);
    await sleep(wait * 1000);
    return gql(query, variables, retries - 1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw new Error(`AniList: ${json.errors?.[0]?.message || `помилка ${res.status}`}`);
  return json.data;
}

const FULL = `id siteUrl episodes status format seasonYear
  title { romaji english }
  startDate { year month day }
  nextAiringEpisode { episode airingAt }
  relations { edges { relationType node { id type format status episodes title { romaji english } startDate { year month day } } } }`;

const SHORT = 'id episodes format seasonYear title { romaji english } coverImage { medium }';

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
    if (!force && c && Date.now() - c.t < CACHE_HOURS * 4 * 3600e3) out.set(id, c.data);
    else todo.push(id);
  }
  for (let i = 0; i < todo.length; i += 20) {
    const d = await gql(`query ($ids: [Int]) { Page(perPage: 20) { media(id_in: $ids, type: ANIME) { id
      recommendations(sort: RATING_DESC, perPage: 10) { nodes { rating mediaRecommendation {
        id siteUrl format seasonYear episodes status averageScore isAdult genres title { romaji english } coverImage { large }
      } } } } } }`, { ids: todo.slice(i, i + 20) });
    for (const m of d.Page.media) {
      const recs = m.recommendations.nodes
        .filter((n) => n.mediaRecommendation && !n.mediaRecommendation.isAdult && n.rating > 0)
        .map(({ rating, mediaRecommendation: r }) => ({
          id: r.id,
          votes: rating,
          url: r.siteUrl,
          title: r.title.english || r.title.romaji,
          romaji: r.title.romaji,
          cover: r.coverImage?.large || '',
          format: r.format,
          year: r.seasonYear,
          episodes: r.episodes,
          status: r.status,
          score: r.averageScore,
          genres: r.genres || [],
        }));
      out.set(m.id, recs);
      writeCache(`rec:${m.id}`, { t: Date.now(), data: recs });
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
  relations { edges { relationType node { id type format isAdult } } }
} } }`;

// дані франшизи зберігаються один раз (fr:<корінь>), а для кожного учасника — вказівник (frp:<id>)
function readFranchise(id) {
  const root = readCache(`frp:${id}`);
  return root ? readCache(`fr:${root}`) : null;
}

export const peekFranchise = (id) => readFranchise(id)?.data ?? null;

const frPending = new Map(); // id → проміс, щоб не вантажити ту саму франшизу двічі паралельно

export function getFranchise(id, { force = false } = {}) {
  const c = readFranchise(id);
  if (!force && c && Date.now() - c.t < CACHE_HOURS * 12 * 3600e3) return Promise.resolve(c.data);
  if (!frPending.has(id)) frPending.set(id, loadFranchise(id).finally(() => frPending.delete(id)));
  return frPending.get(id);
}

async function loadFranchise(id) {
  const nodes = new Map();
  const via = new Map([[id, null]]); // яким зв'язком знайшли запис
  let frontier = [id];
  for (let depth = 0; frontier.length && depth < 10 && nodes.size < 80; depth++) {
    const d = await gql(FR_QUERY, { ids: frontier.slice(0, 50) });
    const next = [];
    for (const m of d.Page.media) {
      if (m.isAdult || m.format === 'MUSIC') continue;
      const rel = m.relations.edges
        .filter((e) => [...EXPAND, ...LEAF].includes(e.relationType)
          && e.node.type === 'ANIME' && e.node.format !== 'MUSIC' && !e.node.isAdult)
        .map((e) => ({ type: e.relationType, id: e.node.id }));
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
    frontier = next;
  }
  const data = [...nodes.values()];
  if (!data.length) return data;
  const root = Math.min(...nodes.keys());
  writeCache(`fr:${root}`, { t: Date.now(), data });
  for (const k of nodes.keys()) writeCache(`frp:${k}`, root);
  return data;
}

export async function searchAnilist(q) {
  const data = await gql(`query ($q: String) { Page(perPage: 12) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${SHORT} } } }`, { q });
  return data.Page.media.map((m) => ({
    id: m.id,
    title: m.title.english || m.title.romaji,
    romaji: m.title.romaji,
    format: m.format,
    year: m.seasonYear,
    episodes: m.episodes,
    cover: m.coverImage?.medium || '',
  }));
}

// Автоматичний підбір запису за назвами з TMDB. Перевага — серіал того ж року (зазвичай 1 сезон).
export async function matchAnilist(names, year, formats = SERIES) {
  for (const name of [...new Set(names.filter(Boolean))]) {
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
