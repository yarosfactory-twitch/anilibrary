// AniList GraphQL API: ключ не потрібен. Звідси беремо серії, розклад і наступні сезони.
import { CACHE_HOURS } from './config.js';

const API = 'https://graphql.anilist.co';
const PREFIX = 'anilist:';
const SERIES = ['TV', 'TV_SHORT', 'ONA']; // формати, які вважаємо «сезонами»

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
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
export async function matchAnilist(names, year) {
  for (const name of [...new Set(names.filter(Boolean))]) {
    const list = await searchAnilist(name).catch(() => []);
    const series = list.filter((m) => SERIES.includes(m.format));
    const pick = series.find((m) => year && m.year === year) || series[0];
    if (pick) return pick.id;
  }
  return null;
}

export function clearAnilistCache() {
  Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
}
