import { TMDB_API_KEY, CACHE_HOURS } from './config.js';

const API = 'https://api.themoviedb.org/3';
const PREFIX = 'tmdb:tv:';

async function get(path, params = {}) {
  if (!TMDB_API_KEY) throw new Error('Не вказано TMDB_API_KEY у js/config.js');
  const url = new URL(API + path);
  url.search = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB відповів помилкою ${res.status}`);
  return res.json();
}

export const posterUrl = (path, size = 'w342') => (path ? `https://image.tmdb.org/t/p/${size}${path}` : '');

export async function searchTv(query) {
  const data = await get('/search/tv', { query, language: 'uk-UA', include_adult: 'false' });
  return data.results || [];
}

// Спецвипуски (сезон 0) ігноруємо: вони ламають порівняння прогресу.
const ep = (e) => (e && e.season_number > 0
  ? { season: e.season_number, episode: e.episode_number, airDate: e.air_date || null }
  : null);

export function peekTv(id) {
  try { return JSON.parse(localStorage.getItem(PREFIX + id))?.data ?? null; } catch { return null; }
}

export async function getTv(id, { force = false } = {}) {
  if (!force) {
    try {
      const c = JSON.parse(localStorage.getItem(PREFIX + id));
      // 'firstYear' in ... — кеш зі старої версії без років вважаємо застарілим
      if (c && Date.now() - c.t < CACHE_HOURS * 3600e3 && 'firstYear' in c.data) return c.data;
    } catch { /* немає кешу */ }
  }
  const d = await get(`/tv/${id}`, { language: 'uk-UA' });
  let { name, overview } = d;
  // Без українського перекладу TMDB віддає оригінальну назву (часто японською); тоді беремо англійську.
  if (!overview || name === d.original_name) {
    try {
      const en = await get(`/tv/${id}`, { language: 'en-US' });
      overview ||= en.overview;
      if (name === d.original_name && en.name) name = en.name;
    } catch { /* лишаємо як є */ }
  }
  const data = {
    id: d.id,
    name,
    originalName: d.original_name,
    overview: overview || '',
    poster: d.poster_path || null,
    status: d.status,
    firstYear: Number((d.first_air_date || '').slice(0, 4)) || null,
    lastYear: Number((d.last_air_date || '').slice(0, 4)) || null,
    last: ep(d.last_episode_to_air),
    next: ep(d.next_episode_to_air),
    seasons: (d.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ season: s.season_number, episodes: s.episode_count || 0 })),
  };
  try { localStorage.setItem(PREFIX + id, JSON.stringify({ t: Date.now(), data })); } catch { /* переповнено */ }
  return data;
}

export function clearTvCache() {
  Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k));
}

// Прогрес порівнюємо як пару (сезон, серія), а не як загальний номер серії.
export const cmpEp = (a, b) => (a.season - b.season) || (a.episode - b.episode);

// Наступна серія: якщо поточний сезон на TMDB закінчився, переходимо на 1 серію наступного.
export function nextEp(p, tv) {
  const cur = tv?.seasons?.find((s) => s.season === p.season);
  if (cur?.episodes && p.episode >= cur.episodes) {
    const nxt = tv.seasons.filter((s) => s.season > p.season).sort((a, b) => a.season - b.season)[0];
    if (nxt) return { season: nxt.season, episode: 1 };
  }
  return { season: p.season, episode: p.episode + 1 };
}

// Скільки вийшло серій понад переглянуте.
export function countNew(p, tv) {
  const last = tv?.last;
  if (!last || cmpEp(last, p) <= 0) return 0;
  if (last.season === p.season) return last.episode - p.episode;
  let n = last.episode;
  for (const s of tv.seasons) {
    if (s.season === p.season) n += Math.max(0, s.episodes - p.episode);
    else if (s.season > p.season && s.season < last.season) n += s.episodes;
  }
  return n;
}
