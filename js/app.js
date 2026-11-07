import * as cfg from './config.js';
import {
  searchMulti, getTv, getMovie, peekTv, clearTvCache, posterUrl, cmpEp, nextEp, countNew,
} from './tmdb.js';
import {
  getAnilist, peekAnilist, searchAnilist, matchAnilist, clearAnilistCache, getAiring, getRecommendations,
  getFranchise, peekFranchise, getAnilistShort,
} from './anilist.js';

const STATUSES = {
  watching: 'Дивлюсь',
  waiting: 'Чекаю сезон',
  planned: 'Заплановано',
  completed: 'Переглянуто',
  dropped: 'Кинуто',
  later: 'Пізніше',
};
const STATUS_KEYS = Object.keys(STATUSES);
// «Пізніше» має окрему сторінку, тож у вкладках «Списків» його немає
const LIST_KEYS = STATUS_KEYS.filter((s) => s !== 'later');
const ACTIVE = ['watching', 'waiting'];
const AL_STATUS = {
  FINISHED: 'завершено', RELEASING: 'виходить', NOT_YET_RELEASED: 'анонсовано', CANCELLED: 'скасовано', HIATUS: 'перерва',
};
// статус поточного сезону (AniList) і серіалу загалом (TMDB) для значків на картці
const AL_SEASON = {
  RELEASING: ['сезон виходить', 'live'], FINISHED: ['сезон завершено', 'done'], NOT_YET_RELEASED: ['сезон анонсовано', 'soon'],
  HIATUS: ['сезон на паузі', 'soon'], CANCELLED: ['сезон скасовано', 'dead'],
};
const TV_STATUS = {
  'Returning Series': ['серіал продовжується', 'live'], Ended: ['серіал завершено', 'done'], Canceled: ['серіал скасовано', 'dead'],
  'In Production': ['у виробництві', 'soon'], Planned: ['заплановано', 'soon'], Pilot: ['пілот', 'soon'],
};
const GENRES_UK = {
  Action: 'Бойовик', Adventure: 'Пригоди', Comedy: 'Комедія', Drama: 'Драма', Ecchi: 'Еччі', Fantasy: 'Фентезі',
  Horror: 'Жахи', 'Mahou Shoujo': 'Махо-сьодзьо', Mecha: 'Меха', Music: 'Музика', Mystery: 'Детектив',
  Psychological: 'Психологічне', Romance: 'Романтика', 'Sci-Fi': 'Фантастика', 'Slice of Life': 'Повсякденність',
  Sports: 'Спорт', Supernatural: 'Надприродне', Thriller: 'Трилер',
};

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
const $mode = document.getElementById('mode');

const state = {
  user: null,
  canEdit: false,
  loaded: false,
  items: new Map(), // id документа → тайтл
  tv: new Map(), // tmdbId → дані TMDB
  al: new Map(), // anilistId → дані AniList
  fr: new Map(), // anilistId → список записів франшизи
  listStatus: 'watching',
  listQuery: '',
  addQuery: '',
  addResults: null,
  addStatus: 'watching',
  addPrivate: false,
  calMonth: null, // перше число місяця, що показує календар
  calDay: null, // вибраний день 'РРРР-ММ-ДД'
};
let view = null; // поточний екран: { name, update? }
let db = null;
let unsubscribe = null;

// ---------- утиліти

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const fmtEp = (p) => (p && p.episode > 0 ? `S${p.season}E${p.episode}` : 'нічого');

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const dayMs = (iso) => (iso ? new Date(iso + 'T00:00:00').getTime() : null);

// at — мітка часу в мс; dateOnly — коли відома лише дата (TMDB), без часу (AniList дає точний час)
function fmtWhen(at, dateOnly) {
  if (!at) return 'дата невідома';
  const d = new Date(at);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((day - today) / 864e5);
  // рік показуємо, якщо дата не в поточному році: «19 липня 2025»
  const year = d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined;
  let s = d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year }).replace(/\s*р\.$/, '');
  if (!dateOnly) s += `, ${d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`;
  const rel = days === 0 ? 'сьогодні' : days === 1 ? 'завтра' : days > 1 ? `через ${days} ${plural(days, 'день', 'дні', 'днів')}` : '';
  return rel ? `${s} (${rel})` : s;
}

// дата старту з AniList буває неповною: { year, month, day }
const startMs = (d) => (d?.year && d.month && d.day ? new Date(d.year, d.month - 1, d.day).getTime() : null);
function fmtStart(d) {
  if (startMs(d)) return fmtWhen(startMs(d), true);
  if (d?.year && d.month) return new Date(d.year, d.month - 1).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
  if (d?.year) return `${d.year} рік`;
  return 'дата невідома';
}

const posterImg = (url) => `<div class="poster">${url
  ? `<img src="${esc(url)}" alt="" loading="lazy">`
  : '<div class="no-poster">?</div>'}</div>`;

const watchBtn = (a) => (safeUrl(a.watchUrl)
  ? `<a class="btn primary" href="${esc(a.watchUrl)}" target="_blank" rel="noopener">Дивитись</a>`
  : `<a class="btn" href="#/anime/${esc(a.id)}">${state.canEdit ? 'Додати посилання' : 'Без посилання'}</a>`);

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2500);
}
function fail(e) {
  console.error(e);
  toast(e?.code === 'permission-denied' ? 'Немає прав на цю дію' : `Помилка: ${e?.message || e}`);
}

const items = () => [...state.items.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const isMovie = (a) => a.type === 'movie';
// тайтли, для яких стежимо за серіями (фільми сюди не входять)
const activeItems = () => items().filter((a) => !isMovie(a) && ACTIVE.includes(a.status));
const patch = (id, data) => db.patchAnime(id, data).catch(fail);

// змінюємо локально одразу (щоб інтерфейс не чекав відповіді) і пишемо в Firestore
function localPatch(id, data) {
  const a = state.items.get(id);
  if (a) Object.assign(a, data, { updatedAt: Date.now() });
  return patch(id, data);
}

function cached(map, id, peek) {
  if (!map.has(id)) {
    const c = peek(id); // навіть застарілий кеш годиться для першого рендеру
    if (c) map.set(id, c);
  }
  return map.get(id);
}
const tvFor = (id) => cached(state.tv, id, peekTv);
const alFor = (id) => cached(state.al, id, peekAnilist);

// ---------- розклад серій (гібрид)
// Є прив'язка до AniList: серії рахуються в межах цього запису, сезон = progress.season.
// Немає: дані TMDB, прогрес порівнюється як пара (сезон, серія).

function scheduleFor(a, progress = a.progress) {
  if (isMovie(a)) return null;
  if (a.anilistId) {
    const al = alFor(a.anilistId);
    if (!al) return null;
    const s = progress.season;
    const last = al.aired > 0 ? { season: s, episode: al.aired } : null;
    return {
      source: 'anilist',
      al,
      last,
      lastAt: null,
      fresh: last ? Math.max(0, last.episode - progress.episode) : 0,
      next: al.next ? { season: s, episode: al.next.episode, at: al.next.at } : null,
      sequel: nextSeasonOf(a),
    };
  }
  const tv = tvFor(a.tmdbId);
  if (!tv) return null;
  return {
    source: 'tmdb',
    tv,
    last: tv.last,
    lastAt: dayMs(tv.last?.airDate),
    fresh: countNew(progress, tv),
    next: tv.next ? { ...tv.next, at: dayMs(tv.next.airDate), dateOnly: true } : null,
  };
}

// наступний сезон з AniList, якщо поточний повністю вийшов і переглянутий
const sequelOf = (sch) => (sch?.source === 'anilist' && sch.fresh === 0 && sch.al.status === 'FINISHED' ? sch.sequel : null);

// ---------- франшиза
// Основна лінія сезонів іде по зв'язках PREQUEL / SEQUEL між серіалами (зокрема через фільм між сезонами).
// Усе інше (OVA, фільми, спешали, побічні історії) — доповнення, їх можна позначати переглянутими.

const SERIES_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
const FORMAT_UK = { TV: 'серіал', TV_SHORT: 'короткий серіал', ONA: 'ONA', OVA: 'OVA', MOVIE: 'фільм', SPECIAL: 'спешл' };
const sortKey = (d) => (d?.year ? new Date(d.year, (d.month || 12) - 1, d.day || 28).getTime() : Infinity);

function setFranchise(data) {
  data.forEach((n) => state.fr.set(n.id, data));
}

function franchiseOf(a) {
  if (!a.anilistId || isMovie(a)) return null;
  const list = cached(state.fr, a.anilistId, peekFranchise);
  const byId = new Map((list || []).map((n) => [n.id, n]));
  const cur = byId.get(a.anilistId);
  if (!cur) return null;
  const seen = new Set([cur.id]);
  // найближчий серіал у напрямку type; через проміжні фільми / OVA до 3 кроків
  const step = (node, type) => {
    let layer = [node];
    for (let hop = 0; hop < 3 && layer.length; hop++) {
      const nextLayer = [];
      for (const x of layer) {
        for (const r of x.rel) {
          const y = r.type === type && byId.get(r.id);
          if (!y || seen.has(y.id)) continue;
          if (SERIES_FORMATS.includes(y.format)) { seen.add(y.id); return y; }
          nextLayer.push(y);
        }
      }
      layer = nextLayer;
    }
    return null;
  };
  const chain = [cur];
  for (let n = cur; (n = step(n, 'PREQUEL'));) chain.unshift(n);
  for (let n = cur; (n = step(n, 'SEQUEL'));) chain.push(n);
  const all = [...byId.values()].sort((x, y) => sortKey(x.start) - sortKey(y.start));
  return { chain, curIdx: chain.indexOf(cur), all, mainIds: new Set(chain.map((n) => n.id)) };
}

function nextSeasonOf(a) {
  if (!a.anilistId || isMovie(a)) return null;
  const f = franchiseOf(a);
  return f?.chain[f.curIdx + 1] || alFor(a.anilistId)?.sequel || null;
}

// непереглянуті OVA / фільми / спешали, що вийшли поблизу вашого сезону (між попереднім і наступним сезоном)
function pendingExtras(a) {
  const f = franchiseOf(a);
  if (!f) return [];
  const watched = new Set(a.watchedExtras || []);
  const prev = f.chain[f.curIdx - 1];
  const next = f.chain[f.curIdx + 1];
  const from = prev ? sortKey(prev.start) : -Infinity;
  const to = next?.start?.year ? sortKey(next.start) : Infinity;
  return f.all.filter((n) => !f.mainIds.has(n.id) && !watched.has(n.id) && FORMAT_UK[n.format]
    && n.via !== 'SPIN_OFF' && n.via !== 'SUMMARY'
    && (n.status === 'FINISHED' || n.status === 'RELEASING')
    && sortKey(n.start) >= from && sortKey(n.start) < to);
}

// фоново підтягуємо франшизи для списку (по одній, щоб не впертися в ліміт AniList)
let frRunning = false;
// all: усі тайтли з AniList (потрібно порадам, щоб відкидати франшизи зі списку), інакше лише активні
let frAgainAll = false;
async function ensureFranchises(all = false) {
  if (frRunning) { frAgainAll ||= all; return; } // повний прохід запустимо після поточного
  frRunning = true;
  const list = items().filter((a) => a.anilistId
    && (all || (!isMovie(a) && ['watching', 'waiting', 'completed'].includes(a.status))));
  for (const a of list) {
    if (state.fr.has(a.anilistId) && all) continue; // франшиза вже відома (інший тайтл з неї)
    try { setFranchise(await getFranchise(a.anilistId)); } catch (e) { console.warn('franchise:', e); break; }
  }
  frRunning = false;
  if (frAgainAll) { frAgainAll = false; return ensureFranchises(true); }
  view?.update?.();
}
const isOut = (seq) => seq && (seq.status === 'RELEASING' || seq.status === 'FINISHED');

const hasNew = (a) => ACTIVE.includes(a.status) && scheduleFor(a)?.fresh > 0;

// роки виходу серіалу з TMDB: «2005–2008», «2012–…» (ще виходить) або «2019»
function yearsOf(a) {
  if (isMovie(a)) return a.year ? String(a.year) : '';
  const tv = tvFor(a.tmdbId);
  if (!tv?.firstYear) return '';
  if (tv.status === 'Returning Series' || tv.status === 'In Production') return `${tv.firstYear}–…`;
  return tv.lastYear && tv.lastYear !== tv.firstYear ? `${tv.firstYear}–${tv.lastYear}` : String(tv.firstYear);
}

// фоново підтягуємо дані TMDB (роки) для тайтлів, яких ще немає в кеші
const metaTried = new Set();
function ensureTvMeta(list) {
  const ids = list.filter((a) => !isMovie(a)).map((a) => a.tmdbId)
    .filter((id) => !metaTried.has(id) && !tvFor(id)?.firstYear);
  if (!ids.length) return;
  ids.forEach((id) => metaTried.add(id));
  Promise.allSettled(ids.map((id) => getTv(id).then((tv) => state.tv.set(id, tv))))
    .then(() => view?.update?.());
}

// Межі прогресу за відомими даними: не можна переглянути більше серій, ніж є в сезоні.
// null — межа невідома (немає даних або AniList ще не знає кількості серій).
// Для тайтлів з AniList сезон = позиція запису в лінії сезонів франшизи (1, 2, 3…),
// тож сезонів не більше, ніж у франшизі. Поки франшиза не завантажена, сезон не змінюємо.
function limits(a, season) {
  if (a.anilistId) {
    const f = franchiseOf(a);
    if (!f) {
      const s = a.progress.season;
      return { minSeason: s, maxSeason: s, maxEpisode: alFor(a.anilistId)?.episodes || null };
    }
    const node = f.chain[season - 1];
    const episodes = node?.id === a.anilistId ? alFor(a.anilistId)?.episodes || node.episodes : node?.episodes;
    return { minSeason: 1, maxSeason: f.chain.length, maxEpisode: episodes || null };
  }
  const seasons = tvFor(a.tmdbId)?.seasons;
  if (!seasons?.length) return { minSeason: 1, maxSeason: null, maxEpisode: null };
  return {
    minSeason: 1,
    maxSeason: Math.max(...seasons.map((s) => s.season)),
    maxEpisode: seasons.find((s) => s.season === season)?.episodes || null,
  };
}

function clampProg(a, p) {
  let season = p.season | 0;
  let episode = Math.max(0, p.episode | 0);
  const { minSeason, maxSeason } = limits(a, season);
  season = Math.max(minSeason || 1, season);
  if (maxSeason && season > maxSeason) season = maxSeason;
  const { maxEpisode } = limits(a, season);
  if (maxEpisode && episode > maxEpisode) episode = maxEpisode;
  return { season, episode };
}

// наступна серія з урахуванням меж; null — далі серій немає
function stepEp(a, p) {
  const next = clampProg(a, a.anilistId ? { ...p, episode: p.episode + 1 } : nextEp(p, tvFor(a.tmdbId)));
  return cmpEp(next, p) > 0 ? next : null;
}

// Статус після перегляду останньої серії: «Переглянуто», якщо продовження немає,
// або «Чекаю сезон», якщо його анонсовано / серіал продовжується. null — статус не міняємо.
function autoStatus(a, p) {
  if (!['watching', 'planned', 'waiting'].includes(a.status)) return null;
  let more;
  if (a.anilistId) {
    const al = alFor(a.anilistId);
    if (!al || al.status !== 'FINISHED' || !al.episodes || p.episode < al.episodes) return null;
    const seq = nextSeasonOf(a);
    if (isOut(seq)) return null; // наступний сезон уже виходить — дивимось далі
    const tvStatus = tvFor(a.tmdbId)?.status;
    more = !!seq || tvStatus === 'Returning Series' || tvStatus === 'In Production';
  } else {
    const tv = tvFor(a.tmdbId);
    if (!tv?.seasons?.length || tv.next) return null;
    const last = tv.seasons.reduce((x, y) => (y.season > x.season ? y : x));
    if (p.season < last.season || p.episode < last.episodes) return null;
    more = tv.status === 'Returning Series' || tv.status === 'In Production';
  }
  const status = more ? 'waiting' : 'completed';
  return status === a.status ? null : status;
}

const autoStatusMessage = (s) => (s === 'completed'
  ? 'Останню серію переглянуто: тайтл у «Переглянуто»'
  : 'Сезон переглянуто: тайтл у «Чекаю сезон»');

const endMessage = (a) => (nextSeasonOf(a)
  ? 'Сезон переглянуто: можна перейти на наступний'
  : 'Це остання серія, що є');

function startNextSeason(a, season = a.progress.season) {
  const seq = nextSeasonOf(a);
  if (!seq) return;
  localPatch(a.id, { anilistId: seq.id, progress: { season: season + 1, episode: 0 }, status: 'watching' });
  toast(`Сезон ${season + 1}: прогрес з початку`);
}

// ---------- завантаження даних TMDB / AniList

const tried = new Set();
let busy = 0;
let loadError = '';

function ensureData(list, force = false) {
  const tvIds = [], alIds = [];
  for (const a of list) {
    const key = a.anilistId ? `al:${a.anilistId}` : `tv:${a.tmdbId}`;
    if (!force && tried.has(key)) continue;
    tried.add(key);
    if (a.anilistId) alIds.push(a.anilistId); else tvIds.push(a.tmdbId);
  }
  if (!tvIds.length && !alIds.length) return;
  busy++;
  const jobs = tvIds.map((id) => getTv(id, { force }).then((tv) => state.tv.set(id, tv)));
  if (alIds.length) jobs.push(getAnilist(alIds, { force }).then((m) => m.forEach((v, k) => state.al.set(k, v))));
  Promise.allSettled(jobs).then((results) => {
    busy--;
    const bad = results.find((r) => r.status === 'rejected');
    loadError = bad ? `Не вдалося оновити дані: ${bad.reason?.message || bad.reason}` : '';
    view?.update?.();
  });
}

// ---------- запуск і авторизація

function screen(title, html, withLogout = false) {
  $nav.hidden = true;
  $app.innerHTML = `<div class="center-screen"><h1>${esc(title)}</h1>${html}
    ${withLogout ? '<button class="btn" id="s-logout">Вийти</button>' : ''}</div>`;
  if (withLogout) $app.querySelector('#s-logout').onclick = () => db.logout();
}

if (!cfg.firebaseConfig?.apiKey) {
  screen('Потрібне налаштування', '<p class="muted">Заповніть <code>js/config.js</code>. Інструкція є в README.md.</p>');
} else {
  try {
    db = await import('./db.js');
    db.watchAuth(onUser);
  } catch (e) {
    console.error(e);
    screen('Помилка запуску', `<p class="muted">${esc(e.message)}</p>`);
  }
}

function onUser(user) {
  unsubscribe?.();
  unsubscribe = null;
  Object.assign(state, { user, loaded: false, items: new Map() });
  view = null;
  $nav.hidden = true;
  $mode.hidden = true;
  if (!user) return showLogin();

  const isOwner = !!cfg.OWNER_UID && user.uid === cfg.OWNER_UID;
  const isReader = !!cfg.READER_UID && user.uid === cfg.READER_UID;
  if (!isOwner && !isReader) return showNoAccess(user);

  state.canEdit = isOwner;
  $mode.hidden = isOwner;
  $nav.querySelector('[data-route="add"]').hidden = !isOwner;
  $app.innerHTML = '<div class="loader"></div>';

  unsubscribe = db.subscribeAnime((docs) => {
    state.items = new Map(docs.map((d) => [d.id, { ...d, progress: d.progress || { season: 1, episode: 0 } }]));
    if (!state.loaded) {
      state.loaded = true;
      $nav.hidden = false;
      route();
      ensureData(activeItems());
      ensureFranchises();
      // одноразово: старим тайтлам без поля private ставимо «видно глядачу»
      if (isOwner) {
        const old = docs.filter((d) => typeof d.private !== 'boolean').map((d) => d.id);
        if (old.length) db.markPublic(old).catch(fail);
      }
    } else {
      view?.update?.();
    }
  }, (err) => {
    console.error(err);
    screen('Немає доступу', err.code === 'permission-denied'
      ? '<p class="muted">Firestore відхилив запит. Перевірте uid у <code>config.js</code> та в правилах Firestore.</p>'
      : `<p class="muted">${esc(err.message)}</p>`, true);
  }, { publicOnly: !isOwner });
}

// Вбудовані браузери застосунків (Telegram, Instagram, Facebook…) часто не дають увійти через Google
const IN_APP_BROWSER = /Telegram|Instagram|FBAN|FBAV|Line\/|; wv\)|TikTok|Snapchat/i.test(navigator.userAgent);

function loginError(e) {
  switch (e?.code) {
    case 'auth/popup-blocked':
      return 'Браузер заблокував вікно входу. Дозвольте спливаючі вікна для цього сайту (iPhone: Параметри → Safari → вимкніть «Блокувати спливні вікна») і натисніть «Увійти» ще раз.';
    case 'auth/operation-not-supported-in-environment':
    case 'auth/web-storage-unsupported':
      return 'У цьому браузері вхід не працює. Відкрийте сайт у Safari або Chrome.';
    case 'auth/unauthorized-domain':
      return 'Цей домен не додано у Firebase → Authentication → Settings → Authorized domains.';
    case 'auth/network-request-failed':
      return 'Немає з\'єднання з інтернетом. Спробуйте ще раз.';
    default:
      return `Не вдалося увійти: ${e?.message || e}`;
  }
}

function showLogin() {
  $app.innerHTML = `<div class="center-screen">
    <img src="icons/icon.svg" class="logo" alt="">
    <h1>Anilibrary</h1>
    <p class="muted">Особистий трекер аніме</p>
    ${IN_APP_BROWSER ? `<p class="notice">Схоже, сайт відкрито всередині застосунку (Telegram, Instagram тощо).
      Там вхід через Google часто не працює. Відкрийте сайт у Safari або Chrome: меню ⋯ → «Відкрити в браузері».</p>` : ''}
    <button class="btn primary" id="login">Увійти через Google</button>
    <p class="notice" id="login-err" hidden></p>
    <p class="hint">Відкриється вікно Google. Якщо нічого не сталося, дозвольте спливаючі вікна для сайту.</p>
  </div>`;
  const btn = $app.querySelector('#login');
  const $err = $app.querySelector('#login-err');
  btn.onclick = async () => {
    btn.disabled = true;
    $err.hidden = true;
    try {
      await db.login();
    } catch (e) {
      console.error(e);
      $err.textContent = loginError(e);
      $err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  };
}

function showNoAccess(user) {
  screen('Немає доступу', `
    <p class="muted">Ви увійшли як ${esc(user.email || user.displayName || 'невідомий користувач')}, але цей акаунт не має доступу.</p>
    <p class="small muted">Ваш uid:</p>
    <code class="uid">${esc(user.uid)}</code>
    <button class="btn" id="copy-uid">Копіювати uid</button>`, true);
  $app.querySelector('#copy-uid').onclick = () =>
    navigator.clipboard.writeText(user.uid).then(() => toast('uid скопійовано'), fail);
}

// ---------- роутинг

const VIEWS = {
  '': home, list: listView, later: laterView, calendar: calendarView, recs: recsView, anime: detail, add: addView, more: moreView,
};
const NAV_OF = {
  home: 'home', list: 'list', later: 'later', calendar: 'calendar', recs: 'recs', anime: 'list', add: 'add', more: 'more',
};
const scrollPos = {};

function route() {
  if (!state.loaded) return;
  const [name = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
  let fn = VIEWS[name] || home;
  if (fn === addView && !state.canEdit) fn = home;
  view = fn(arg && decodeURIComponent(arg));
  $nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.route === NAV_OF[view.name]));
  window.scrollTo(0, scrollPos[location.hash] || 0);
}

// перемалювати поточний екран, не змінюючи прокрутки
function rerender() {
  const y = window.scrollY;
  route();
  window.scrollTo(0, y);
}

window.addEventListener('hashchange', (e) => {
  scrollPos[new URL(e.oldURL).hash] = window.scrollY;
  route();
});

// кнопки на картках головної
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn || !state.canEdit) return;
  const a = state.items.get(btn.dataset.id);
  if (!a) return;
  if (btn.dataset.act === 'plus1') {
    const progress = stepEp(a, a.progress);
    if (!progress) return toast(endMessage(a));
    const status = autoStatus(a, progress);
    localPatch(a.id, status ? { progress, status } : { progress });
    toast(status ? autoStatusMessage(status) : `Переглянуто ${fmtEp(progress)}`);
  } else if (btn.dataset.act === 'next-season') {
    startNextSeason(a);
  }
  view?.update?.();
});

// ---------- головна

function home() {
  const self = { name: 'home', update: render };

  const newCard = ({ a, sch }) => `<article class="ep-card">
    <a href="#/anime/${esc(a.id)}" class="ep-poster">${posterImg(a.poster)}</a>
    <div class="ep-body">
      <a href="#/anime/${esc(a.id)}" class="ep-title">${esc(a.title)}</a>
      <div>переглянуто <b>${fmtEp(a.progress)}</b> → вийшла <b class="accent">${fmtEp(sch.last)}</b></div>
      <div class="muted small">${sch.fresh} ${plural(sch.fresh, 'нова серія', 'нові серії', 'нових серій')}${
        sch.next ? ` · наступна ${fmtEp(sch.next)}: ${fmtWhen(sch.next.at, sch.next.dateOnly)}` : ''}</div>
      <div class="ep-actions">
        ${watchBtn(a)}
        ${state.canEdit ? `<button class="btn" data-act="plus1" data-id="${esc(a.id)}">+1 серія</button>` : ''}
      </div>
    </div>
  </article>`;

  const seasonCard = ({ a, seq }) => {
    const s = a.progress.season;
    return `<article class="ep-card">
      <a href="#/anime/${esc(a.id)}" class="ep-poster">${posterImg(a.poster)}</a>
      <div class="ep-body">
        <a href="#/anime/${esc(a.id)}" class="ep-title">${esc(a.title)}</a>
        <div>сезон ${s} переглянуто → вийшов <b class="accent">сезон ${s + 1}</b></div>
        <div class="muted small">${esc(seq.title)}${seq.episodes ? ` · ${seq.episodes} сер.` : ''} · ${AL_STATUS[seq.status]}</div>
        <div class="ep-actions">
          ${watchBtn(a)}
          ${state.canEdit ? `<button class="btn" data-act="next-season" data-id="${esc(a.id)}">Почати сезон ${s + 1}</button>` : ''}
        </div>
      </div>
    </article>`;
  };

  const upRow = ({ a, label, when }) => `<a class="row-item" href="#/anime/${esc(a.id)}">
    ${posterImg(a.poster)}
    <div><div class="row-title">${esc(a.title)}</div>
    <div class="muted small">${label} · ${when}</div></div>
  </a>`;

  function render() {
    const fresh = [], seasons = [], upcoming = [], missing = [];
    for (const a of activeItems()) {
      const sch = scheduleFor(a);
      if (!sch) { missing.push(a); continue; }
      const seq = sequelOf(sch);
      if (sch.fresh > 0) fresh.push({ a, sch });
      else if (isOut(seq)) seasons.push({ a, seq });
      else if (sch.next) upcoming.push({ a, label: fmtEp(sch.next), when: fmtWhen(sch.next.at, sch.next.dateOnly), at: sch.next.at });
      else if (seq) upcoming.push({ a, label: `Сезон ${a.progress.season + 1}`, when: fmtStart(seq.start), at: startMs(seq.start) });
    }
    ensureData(missing);
    upcoming.sort((x, y) => (x.at ?? Infinity) - (y.at ?? Infinity));

    // OVA / фільми / спешали поблизу вашого сезону, які ще не переглянуті
    const extras = items()
      .filter((a) => a.anilistId && !isMovie(a) && ['watching', 'waiting', 'completed'].includes(a.status))
      .flatMap((a) => pendingExtras(a).map((n) => ({ a, n })))
      .slice(0, 12);
    const extraRow = ({ a, n }) => `<a class="row-item" href="#/anime/${esc(a.id)}">
      ${posterImg(n.cover)}
      <div class="grow"><div class="row-title">${esc(n.title)}</div>
        <div class="muted small">${esc([FORMAT_UK[n.format], n.year, n.episodes > 1 ? `${n.episodes} сер.` : ''].filter(Boolean).join(' · '))} · до «${esc(a.title)}»</div></div>
    </a>`;

    const empty = state.items.size
      ? 'Нових серій немає: усе переглянуто.'
      : `Список порожній. ${state.canEdit ? '<a href="#/add">Додайте перше аніме</a>' : ''}`;

    $app.innerHTML = `
      <h1 class="page-title">Є нові серії</h1>
      ${busy ? '<p class="muted small">Оновлюю дані…</p>' : ''}
      ${loadError ? `<p class="notice">${esc(loadError)}</p>` : ''}
      ${fresh.length ? `<div class="ep-list">${fresh.map(newCard).join('')}</div>` : `<p class="empty">${empty}</p>`}
      ${seasons.length ? `<h2 class="section-title">Вийшов новий сезон</h2><div class="ep-list">${seasons.map(seasonCard).join('')}</div>` : ''}
      ${upcoming.length ? `<h2 class="section-title">Скоро вийде</h2><div class="rows">${upcoming.map(upRow).join('')}</div>` : ''}
      ${extras.length ? `<h2 class="section-title">Доповнення франшизи</h2>
        <p class="muted small" style="margin:-6px 0 10px">OVA, фільми та спешали поряд із вашим сезоном. Позначити переглянутими можна на картці тайтлу.</p>
        <div class="rows">${extras.map(extraRow).join('')}</div>` : ''}`;
  }

  render();
  return self;
}

// ---------- списки

function listView(arg) {
  if (arg === 'all' || LIST_KEYS.includes(arg)) state.listStatus = arg;
  const self = { name: 'list', update };

  $app.innerHTML = `
    <input type="search" class="input" id="l-q" placeholder="Пошук за назвою" autocomplete="off" value="${esc(state.listQuery)}">
    <div class="tabs" id="l-tabs"></div>
    <div class="grid" id="l-grid"></div>`;
  const $q = $app.querySelector('#l-q');
  const $tabs = $app.querySelector('#l-tabs');
  const $grid = $app.querySelector('#l-grid');

  $q.oninput = () => { state.listQuery = $q.value; update(); };
  $tabs.onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    state.listStatus = b.dataset.tab;
    history.replaceState(null, '', `#/list/${b.dataset.tab}`);
    update();
  };

  function card(a) {
    const meta = [
      isMovie(a) ? 'фільм' : '',
      yearsOf(a),
      state.listStatus === 'all' ? STATUSES[a.status] : '',
      a.progress.episode > 0 ? fmtEp(a.progress) : '',
    ].filter(Boolean).join(' · ');
    return `<a class="card" href="#/anime/${esc(a.id)}">
      <div class="card-poster">${posterImg(a.poster)}${hasNew(a) ? '<span class="dot-new">нові</span>' : ''}</div>
      <div class="card-title">${a.private ? '🔒 ' : ''}${esc(a.title)}</div>
      ${meta ? `<div class="card-meta">${meta}</div>` : ''}
    </a>`;
  }

  function update() {
    const q = state.listQuery.trim().toLowerCase();
    const all = items().filter((a) => a.status !== 'later'
      && (!q || `${a.title} ${a.originalTitle || ''}`.toLowerCase().includes(q)));
    const inTab = (s) => all.filter((a) => s === 'all' || a.status === s);
    $tabs.innerHTML = ['all', ...LIST_KEYS].map((s) => `<button class="tab${s === state.listStatus ? ' on' : ''}" data-tab="${s}">
      ${s === 'all' ? 'Усі' : STATUSES[s]} <span>${inTab(s).length}</span></button>`).join('');
    const shown = inTab(state.listStatus);
    ensureTvMeta(shown);
    $grid.innerHTML = shown.length
      ? shown.map(card).join('')
      : `<p class="empty">${q ? 'Нічого не знайдено.' : 'Тут поки порожньо.'}</p>`;
  }

  update();
  return self;
}

// ---------- «Переглянути пізніше»

function laterView() {
  const self = { name: 'later', update: render };

  const row = (a) => {
    const added = a.addedAt ? `додано ${fmtWhen(a.addedAt, true).replace(/\s*\(.*\)$/, '')}` : '';
    const meta = [isMovie(a) ? 'фільм' : 'серіал', yearsOf(a), added].filter(Boolean).join(' · ');
    return `<div class="row-item later-row">
      <a class="later-link" href="#/anime/${esc(a.id)}">
        ${posterImg(a.poster)}
        <div class="grow"><div class="row-title">${a.private ? '🔒 ' : ''}${esc(a.title)}</div>
          <div class="muted small">${esc(meta)}</div></div>
      </a>
      ${state.canEdit ? `<div class="fr-act">
        <button class="btn sm primary" data-start="${esc(a.id)}">Почати</button>
        <button class="btn sm" data-remove="${esc(a.id)}" aria-label="Прибрати зі списку">✕</button>
      </div>` : ''}
    </div>`;
  };

  function render() {
    const list = items().filter((a) => a.status === 'later').sort((x, y) => (y.addedAt || 0) - (x.addedAt || 0));
    ensureTvMeta(list);
    $app.innerHTML = `<div class="cal-head"><h1 class="page-title">Переглянути пізніше</h1>
        ${state.canEdit ? '<button class="btn primary sm" id="l-add">+ Додати</button>' : ''}</div>
      ${list.length
        ? `<div class="rows one">${list.map(row).join('')}</div>`
        : `<p class="empty">Тут поки порожньо.${state.canEdit ? ' Додавайте тайтли кнопкою «+ Пізніше» в пошуку чи порадах.' : ''}</p>`}`;
    if (!state.canEdit) return;

    $app.querySelector('#l-add').onclick = () => {
      state.addStatus = 'later';
      location.hash = '#/add';
    };
    $app.querySelector('.rows')?.addEventListener('click', (e) => {
      const start = e.target.closest('[data-start]')?.dataset.start;
      const remove = e.target.closest('[data-remove]')?.dataset.remove;
      const a = state.items.get(start || remove);
      if (!a) return;
      if (start) {
        localPatch(a.id, { status: 'watching' });
        toast(`«${a.title}» у «Дивлюсь»`);
      } else {
        if (!confirm(`Прибрати «${a.title}» зі списку?`)) return;
        db.removeAnime(a.id).catch(fail);
        state.items.delete(a.id);
      }
      render();
    });
  }

  render();
  return self;
}

// ---------- календар

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const keyDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];
const KIND_LABEL = { new: 'не переглянуто', watched: 'переглянуто', future: '', season: 'новий сезон' };

function calendarView() {
  const self = { name: 'calendar', update: render };
  const todayKey = dayKey(new Date());
  if (!state.calMonth) {
    const t = new Date();
    state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
    state.calDay = todayKey;
  }
  let airing = null; // розклад AniList для видимих тижнів; null — ще вантажиться
  let airError = '';
  let loadSeq = 0;

  // тижні, які видно в сітці: з понеділка першого тижня до неділі останнього
  function range() {
    const m = state.calMonth;
    const lead = (m.getDay() + 6) % 7;
    const start = new Date(m.getFullYear(), m.getMonth(), 1 - lead);
    const lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 7 - (lastDay.getDay() + 6) % 7);
    return { start, end };
  }

  async function load(force = false) {
    const seq = ++loadSeq;
    airing = null;
    airError = '';
    const { start, end } = range();
    const ids = [...new Set(activeItems().filter((a) => a.anilistId).map((a) => a.anilistId))];
    try {
      const data = await getAiring(ids, +start, +end, { force });
      if (seq === loadSeq) airing = data;
    } catch (e) {
      if (seq === loadSeq) { airing = []; airError = e.message; }
    }
    if (seq === loadSeq && view === self) render();
  }

  // події по днях: Map 'РРРР-ММ-ДД' → [{ a, label, time, kind, at }]
  function events() {
    const map = new Map();
    const now = Date.now();
    const add = (at, ev) => {
      const k = dayKey(new Date(at));
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ at, ...ev });
    };
    const missing = [];
    const byAl = new Map();
    for (const a of activeItems()) {
      if (a.anilistId) {
        byAl.set(a.anilistId, a);
        const seq = nextSeasonOf(a);
        if (seq?.status === 'NOT_YET_RELEASED' && startMs(seq.start)) {
          add(startMs(seq.start), { a, label: `Старт сезону ${a.progress.season + 1}`, time: '', kind: 'season' });
        }
        continue;
      }
      const tv = tvFor(a.tmdbId);
      if (!tv) { missing.push(a); continue; }
      for (const e of [tv.last, tv.next]) {
        if (!e?.airDate) continue;
        const at = dayMs(e.airDate);
        const watched = e.season < a.progress.season || (e.season === a.progress.season && e.episode <= a.progress.episode);
        add(at, { a, label: fmtEp(e), time: '', kind: at > now ? 'future' : watched ? 'watched' : 'new' });
      }
    }
    ensureData(missing);
    for (const s of airing || []) {
      const a = byAl.get(s.id);
      if (!a) continue;
      const kind = s.at > now ? 'future' : s.episode <= a.progress.episode ? 'watched' : 'new';
      add(s.at, {
        a,
        label: fmtEp({ season: a.progress.season, episode: s.episode }),
        time: new Date(s.at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }),
        kind,
      });
    }
    map.forEach((list) => list.sort((x, y) => x.at - y.at));
    return map;
  }

  function render() {
    const ev = events();
    const { start, end } = range();
    const month = state.calMonth.getMonth();
    const cells = [];
    for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      const list = ev.get(k) || [];
      const cls = ['cal-day', d.getMonth() !== month && 'out', k === todayKey && 'today', k === state.calDay && 'sel'].filter(Boolean).join(' ');
      cells.push(`<button class="${cls}" data-day="${k}"><span>${d.getDate()}</span>
        <span class="dots">${list.slice(0, 3).map((e) => `<i class="${e.kind}"></i>`).join('')}</span></button>`);
    }
    const title = state.calMonth.toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }).replace(/\s*р\.$/, '');
    const sel = state.calDay ? keyDate(state.calDay) : null;
    const selTitle = sel
      ? (state.calDay === todayKey ? 'Сьогодні, ' : '') + sel.toLocaleDateString('uk-UA', { weekday: state.calDay === todayKey ? undefined : 'long', day: 'numeric', month: 'long' })
      : '';
    const dayList = (state.calDay && ev.get(state.calDay)) || [];
    const inThisMonth = state.calMonth.getMonth() === new Date().getMonth() && state.calMonth.getFullYear() === new Date().getFullYear();

    $app.innerHTML = `<div class="cal-layout">
      <div>
        <div class="cal-head">
          <button class="btn icon" data-cal="-1" aria-label="Попередній місяць">‹</button>
          <h1 class="cal-title">${esc(title)}</h1>
          <button class="btn icon" data-cal="1" aria-label="Наступний місяць">›</button>
        </div>
        <div class="cal-grid">
          ${WEEKDAYS.map((w) => `<div class="cal-wd">${w}</div>`).join('')}
          ${cells.join('')}
        </div>
        <div class="cal-legend small muted">
          <span><i class="new"></i>не переглянуто</span><span><i class="future"></i>вийде</span>
          <span><i class="watched"></i>переглянуто</span><span><i class="season"></i>новий сезон</span>
        </div>
        ${inThisMonth ? '' : '<button class="btn sm mt" data-cal="today">До сьогодні</button>'}
        ${airing === null ? '<p class="muted small mt">Завантажую розклад…</p>' : ''}
        ${airError ? `<p class="notice mt">${esc(airError)}</p>` : ''}
      </div>
      <div>
        <h2 class="section-title cal-day-title">${esc(selTitle)}</h2>
        ${dayList.length ? `<div class="rows one">${dayList.map((e) => `<a class="row-item" href="#/anime/${esc(e.a.id)}">
            ${posterImg(e.a.poster)}
            <div class="grow"><div class="row-title">${esc(e.a.title)}</div>
              <div class="muted small">${esc([e.label, e.time].filter(Boolean).join(' · '))}</div></div>
            ${KIND_LABEL[e.kind] ? `<span class="tag ${e.kind}">${KIND_LABEL[e.kind]}</span>` : ''}
          </a>`).join('')}</div>`
          : '<p class="empty">Цього дня нічого не виходить.</p>'}
      </div>
    </div>`;

    $app.querySelector('.cal-layout').onclick = (e) => {
      const day = e.target.closest('[data-day]')?.dataset.day;
      const step = e.target.closest('[data-cal]')?.dataset.cal;
      if (day) {
        state.calDay = day;
        const d = keyDate(day);
        if (d.getMonth() !== state.calMonth.getMonth()) { state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1); load(); }
        render();
      } else if (step) {
        const t = new Date();
        if (step === 'today') {
          state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
          state.calDay = todayKey;
        } else {
          const m = state.calMonth;
          state.calMonth = new Date(m.getFullYear(), m.getMonth() + Number(step), 1);
          const isNow = state.calMonth.getMonth() === t.getMonth() && state.calMonth.getFullYear() === t.getFullYear();
          state.calDay = isNow ? todayKey : dayKey(state.calMonth);
        }
        load();
      }
    };
  }

  load();
  return self;
}

// ---------- рекомендації

function recsView() {
  const self = { name: 'recs', update };
  let recs = null; // Map anilistId → рекомендації; null — ще вантажиться
  let error = '';
  let loading = false;

  // на що спираємось: переглянуте та те, що дивимось, з прив'язкою до AniList
  const seeds = () => items().filter((a) => a.anilistId && ['completed', 'watching', 'waiting'].includes(a.status));

  async function load(force = false) {
    loading = true;
    try {
      const data = await getRecommendations(seeds().map((a) => a.anilistId), { force });
      recs = force || !recs ? data : new Map([...recs, ...data]);
      error = '';
    } catch (e) {
      error = e.message;
      recs ||= new Map();
    }
    loading = false;
    if (view === self) render();
  }

  function update() {
    if (!loading && recs && seeds().some((a) => !recs.has(a.anilistId))) load();
    else render();
  }

  // «NARUTO -ナルト- 疾風伝» → «naruto ナルト 疾風伝»: без регістру, розділових знаків і широких символів
  const normName = (s) => (s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  // однакові назви або одна продовжує іншу («naruto» → «naruto shippuden»)
  const relatedName = (x, y) => x === y || (x.length >= 4 && y.length >= 4 && (x.startsWith(`${y} `) || y.startsWith(`${x} `)));
  const recNames = (r) => [r.title, r.romaji, r.native].map(normName).filter(Boolean);

  // що вже є у списку: записи AniList разом з усією їхньою франшизою, і назви
  function ownSets() {
    const ids = new Set();
    const names = new Set();
    for (const a of items()) {
      [a.title, a.originalTitle].forEach((n) => names.add(normName(n)));
      if (!a.anilistId) continue;
      ids.add(a.anilistId);
      const al = alFor(a.anilistId);
      if (al) [al.title, al.romaji].forEach((n) => names.add(normName(n)));
      for (const n of cached(state.fr, a.anilistId, peekFranchise) || []) {
        ids.add(n.id);
        names.add(normName(n.title));
      }
    }
    names.delete('');
    return { ids, names: [...names] };
  }

  function compute() {
    const own = ownSets();
    const isOwn = (r) => own.ids.has(r.id) || recNames(r).some((n) => own.names.some((o) => relatedName(n, o)));
    const agg = new Map();
    for (const a of seeds()) {
      for (const r of recs.get(a.anilistId) || []) {
        if (isOwn(r)) continue;
        const e = agg.get(r.id) || { ...r, points: 0, because: [] };
        // що частіше тайтл радять до різних ваших тайтлів і що більше голосів, то вище
        e.points += Math.log2(2 + r.votes);
        if (!e.because.includes(a.title)) e.because.push(a.title);
        agg.set(r.id, e);
      }
    }
    // з однієї франшизи («86» і «86 Part 2») лишаємо одну картку — ту, що вище
    const kept = [];
    for (const r of [...agg.values()].sort((x, y) => y.points - x.points)) {
      const twin = kept.find((k) => recNames(r).some((n) => recNames(k).some((m) => relatedName(n, m))));
      if (twin) { twin.because = [...new Set([...twin.because, ...r.because])]; continue; }
      kept.push(r);
      if (kept.length >= 40) break;
    }
    return kept;
  }

  const card = (r) => {
    const meta = [r.format, r.year, r.episodes ? `${r.episodes} сер.` : '', r.score ? `${r.score}%` : '',
      r.status === 'RELEASING' ? 'виходить' : r.status === 'NOT_YET_RELEASED' ? 'анонс' : ''].filter(Boolean).join(' · ');
    const because = r.because.slice(0, 2).join(', ') + (r.because.length > 2 ? ` і ще ${r.because.length - 2}` : '');
    const genres = r.genres.map((g) => GENRES_UK[g]).filter(Boolean).slice(0, 3);
    return `<article class="result">
      ${posterImg(r.cover)}
      <div class="result-body">
        <div class="result-title">${esc(r.title)}</div>
        <div class="muted small">${esc(meta)}</div>
        ${genres.length ? `<div class="chips">${genres.map((g) => `<span class="chip">${g}</span>`).join('')}</div>` : ''}
        <p class="small muted because">Бо ви дивились: ${esc(because)}</p>
        <div class="row">
          ${state.canEdit ? `<button class="btn primary sm" data-rec-add="${esc(r.title)}">Додати</button>
            <button class="btn sm" data-rec-later="${r.id}">+ Пізніше</button>` : ''}
          <a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">AniList</a>
        </div>
      </div>
    </article>`;
  };

  function render() {
    const head = `<div class="cal-head"><h1 class="page-title">Що подивитись</h1>
      ${recs ? '<button class="btn sm" id="r-refresh">Оновити</button>' : ''}</div>`;
    if (!recs) {
      $app.innerHTML = `${head}<div class="loader"></div>`;
      return;
    }
    const list = compute();
    const n = seeds().length;
    $app.innerHTML = `${head}
      ${error ? `<p class="notice">${esc(error)}</p>` : ''}
      ${!n ? `<p class="empty">Порад поки немає. Позначте тайтли як «Переглянуто» або «Дивлюсь»
          (з прив'язкою до AniList), і тут з'являться схожі.</p>`
        : `<p class="muted small">На основі ${n} ${plural(n, 'тайтлу', 'тайтлів', 'тайтлів')} з вашого списку й рекомендацій глядачів AniList.</p>
          ${list.length ? `<div class="results mt">${list.map(card).join('')}</div>` : '<p class="empty">Нічого нового: усе схоже вже у списку.</p>'}`}`;

    $app.querySelector('#r-refresh').onclick = () => { recs = null; render(); load(true); };
    $app.querySelector('.results')?.addEventListener('click', async (e) => {
      const later = e.target.closest('[data-rec-later]');
      if (later) {
        const r = list.find((x) => String(x.id) === later.dataset.recLater);
        later.disabled = true;
        later.textContent = 'Додаю…';
        try {
          await addFromAnilist(r, 'later', false);
          later.textContent = '✓ У «Пізніше»';
          toast('Додано в «Переглянути пізніше»');
        } catch (err) {
          toast(err.message);
          later.disabled = false;
          later.textContent = '+ Пізніше';
        }
        return;
      }
      const b = e.target.closest('[data-rec-add]');
      if (!b) return;
      // назву шукаємо на TMDB, щоб тайтл мав українську назву й опис
      state.addQuery = b.dataset.recAdd;
      state.addResults = null;
      state.addAutoSearch = true;
      state.addStatus = 'planned';
      location.hash = '#/add';
    });
  }

  render();
  load();
  ensureFranchises(true); // щоб відкидати і продовження / фільми тайтлів зі списку
  return self;
}

// ---------- картка тайтлу

function detail(id) {
  const self = { name: 'anime' };
  const a0 = state.items.get(id);
  if (!a0) {
    $app.innerHTML = '<p class="empty">Тайтл не знайдено. <a href="#/list">До списків</a></p>';
    return self;
  }
  if (isMovie(a0)) return movieDetail(id);
  const item = () => state.items.get(id) || a0;
  const ro = !state.canEdit;
  let prog = { ...a0.progress };
  let status = a0.status;
  let tvErr = '', alErr = '', frErr = '';
  const hasOrig = !!a0.originalTitle && a0.originalTitle !== a0.title;
  const yearsLabel = () => { const y = yearsOf(item()); return y ? (hasOrig ? ` · ${y}` : y) : ''; };

  const stepper = (key, label) => `<div>
    <span class="stepper-label">${label}</span>
    <div class="stepper-row">
      <button class="btn icon" data-step="${key}" data-d="-1" aria-label="${label}: менше">−</button>
      <input class="input" type="number" inputmode="numeric" min="0" id="p-${key}" value="${prog[key]}">
      <button class="btn icon" data-step="${key}" data-d="1" aria-label="${label}: більше">+</button>
    </div></div>`;


  $app.innerHTML = `<div class="detail">
    <div class="detail-head">
      ${posterImg(a0.poster)}
      <div class="detail-info">
        <h1>${esc(a0.title)}</h1>
        <div class="muted">${hasOrig ? esc(a0.originalTitle) : ''}<span id="d-years">${yearsLabel()}</span></div>
        <div class="badges"><span class="badge" id="d-badge">${STATUSES[status] || status}</span>
          <span class="badge priv" id="d-priv"${a0.private ? '' : ' hidden'}>🔒 тільки для мене</span>
          <span class="badges-air" id="d-air"></span></div>
        <div id="d-watch"></div>
      </div>
    </div>

    <section class="panel">
      <h2>Прогрес</h2>
      ${ro ? `<p class="big">Переглянуто: <b>${fmtEp(prog)}</b></p>` : `
        <div class="progress-edit">${stepper('season', 'Сезон')}${stepper('episode', 'Серія')}</div>
        <button class="btn primary wide" id="d-plus1">+1 серія</button>
        <p class="hint" id="d-hint"></p>`}
      <div class="tv-info muted" id="d-sched"></div>
    </section>

    <section class="panel"><h2>AniList</h2><div id="d-al"></div></section>

    <section class="panel" id="d-fr-panel" hidden><h2>Франшиза</h2><div id="d-fr"></div></section>

    ${ro ? '' : `<section class="panel"><h2>Статус</h2><div class="seg" id="d-status">${STATUS_KEYS.map((s) =>
      `<button class="tab${s === status ? ' on' : ''}" data-s="${s}">${STATUSES[s]}</button>`).join('')}</div></section>`}

    ${ro ? '' : `<section class="panel"><h2>Де дивлюсь</h2>
      <input class="input" type="url" id="d-url" placeholder="https://…" value="${esc(a0.watchUrl)}"></section>`}

    ${ro ? '' : `<section class="panel"><h2>Видимість</h2>
      <label class="check"><input type="checkbox" id="d-private"${a0.private ? ' checked' : ''}> 🔒 Тільки для мене</label>
      <p class="hint">Прихований тайтл не видно в режимі перегляду: база не віддає його іншому акаунту.</p></section>`}

    <section class="panel"><h2>Опис</h2><p class="overview">${esc(a0.overview) || 'Опису немає.'}</p></section>

    ${ro ? '' : '<button class="btn danger wide" id="d-delete">Видалити тайтл</button>'}
  </div>`;

  const $ = (sel) => $app.querySelector(sel);

  function renderWatch(url) {
    $('#d-watch').innerHTML = safeUrl(url)
      ? `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">▶ Дивитись</a>` : '';
  }

  // вимикаємо «+» / «−», коли досягнуто меж
  function renderSteppers() {
    if (ro) return;
    const { minSeason, maxSeason, maxEpisode } = limits(item(), prog.season);
    const btn = (key, d) => $app.querySelector(`[data-step="${key}"][data-d="${d}"]`);
    btn('season', '-1').disabled = prog.season <= (minSeason || 1);
    btn('season', '1').disabled = !!maxSeason && prog.season >= maxSeason;
    btn('episode', '-1').disabled = prog.episode <= 0;
    btn('episode', '1').disabled = !!maxEpisode && prog.episode >= maxEpisode;
    $('#p-season').max = maxSeason || '';
    $('#p-episode').max = maxEpisode || '';
  }

  // після свіжих даних TMDB / AniList виправляємо прогрес, що виходить за межі (напр. S3E25 при 21 серії)
  function fixProg() {
    if (ro || view !== self) return;
    const a = item();
    let fixed = clampProg(a, prog);
    // для AniList номер сезону має відповідати прив'язаному запису у франшизі
    const f = a.anilistId && franchiseOf(a);
    if (f && fixed.season !== f.curIdx + 1) fixed = clampProg(a, { season: f.curIdx + 1, episode: prog.episode });
    if (cmpEp(fixed, prog) !== 0) {
      setProg(fixed);
      toast(`Прогрес виправлено на ${fmtEp(fixed)}`);
    }
  }

  function renderAir() {
    const a = item();
    const al = a.anilistId && alFor(a.anilistId);
    const tv = tvFor(a.tmdbId);
    $('#d-years').textContent = yearsLabel();
    $('#d-air').innerHTML = [al && AL_SEASON[al.status], tv && TV_STATUS[tv.status]]
      .filter(Boolean).map(([text, cls]) => `<span class="badge air-${cls}">${text}</span>`).join('');
  }

  function renderSched() {
    if (view !== self) return;
    const a = item();
    renderSteppers();
    renderAir();
    const sch = scheduleFor(a, prog);
    if ($('#d-hint')) {
      $('#d-hint').textContent = a.anilistId
        ? 'Остання переглянута серія. Серії рахуються як у прив\'язаному записі AniList.'
        : 'Остання переглянута серія. Нумерація як на TMDB (сезони нижче).';
    }
    if (!sch) {
      $('#d-sched').textContent = (a.anilistId ? alErr : tvErr) || 'Завантаження…';
      return;
    }
    const lines = [
      sch.last
        ? `Вийшла: <b>${fmtEp(sch.last)}</b>${sch.lastAt ? ` · ${fmtWhen(sch.lastAt, true)}` : ''}${sch.fresh > 0 ? ` <span class="new">+${sch.fresh}</span>` : ''}`
        : (sch.next ? 'Ще не вийшло жодної серії' : ''),
      sch.next ? `Наступна: <b>${fmtEp(sch.next)}</b> · ${fmtWhen(sch.next.at, sch.next.dateOnly)}` : '',
      sch.source === 'anilist' && sch.al.episodes ? `Усього в сезоні: ${sch.al.episodes} ${plural(sch.al.episodes, 'серія', 'серії', 'серій')}` : '',
      sch.source === 'tmdb' && !sch.next && sch.tv.status === 'Ended' ? 'Серіал завершено' : '',
      sch.source === 'tmdb' && sch.tv.seasons.length ? `<div class="chips">${sch.tv.seasons.map((s) =>
        `<span class="chip${s.season === prog.season ? ' on' : ''}">S${s.season} · ${s.episodes} сер.</span>`).join('')}</div>` : '',
    ];
    $('#d-sched').innerHTML = lines.filter(Boolean).map((l) => `<div>${l}</div>`).join('');
  }

  function renderFr() {
    if (view !== self) return;
    const a = item();
    $('#d-fr-panel').hidden = !a.anilistId;
    if (!a.anilistId) return;
    const f = franchiseOf(a);
    if (!f) {
      $('#d-fr').innerHTML = `<p class="small muted">${esc(frErr) || 'Завантаження…'}</p>`;
      return;
    }
    if (f.all.length < 2) {
      $('#d-fr').innerHTML = '<p class="small muted">Інших сезонів, OVA чи фільмів немає.</p>';
      return;
    }
    const watched = new Set(a.watchedExtras || []);
    $('#d-fr').innerHTML = `<div class="fr-list">${f.all.map((n) => {
      const idx = f.chain.indexOf(n);
      const isMain = idx >= 0;
      const isCur = idx === f.curIdx;
      const done = (isMain && idx < f.curIdx) || watched.has(n.id);
      const meta = [
        FORMAT_UK[n.format] || n.format, n.year, n.episodes ? `${n.episodes} сер.` : '',
        n.via === 'SPIN_OFF' ? 'спін-оф' : n.via === 'SUMMARY' ? 'рекап' : '',
        n.status !== 'FINISHED' ? AL_STATUS[n.status] : '',
      ].filter(Boolean).join(' · ');
      let action = '';
      if (isCur) action = '<span class="tag cur">зараз</span>';
      else if (isMain) action = ro ? (done ? '<span class="tag">переглянуто</span>' : '') : `<button class="btn sm" data-fr-pick="${n.id}">Обрати</button>`;
      else if (ro) action = watched.has(n.id) ? '<span class="tag">✓ переглянуто</span>' : '';
      else action = `<button class="btn sm${watched.has(n.id) ? ' on' : ''}" data-fr-watch="${n.id}">${watched.has(n.id) ? '✓ переглянуто' : 'не переглянуто'}</button>`;
      return `<div class="fr-row${isMain ? ' main' : ''}${isCur ? ' cur' : ''}${done ? ' done' : ''}">
        ${posterImg(n.cover)}
        <div class="grow"><a class="row-title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>
          <div class="muted small">${esc(meta)}</div></div>
        <div class="fr-act">${action}</div>
      </div>`;
    }).join('')}</div>
    <p class="hint">Виділено основну лінію сезонів. «Обрати» робить сезон поточним.</p>`;
  }

  function renderAl() {
    if (view !== self) return;
    const a = item();
    const $el = $('#d-al');
    if (!a.anilistId) {
      $el.innerHTML = `<p class="small muted">Не прив'язано, тож нові серії рахуються за TMDB.</p>
        ${ro ? '' : '<div class="row mt"><button class="btn sm" data-al="pick">Знайти на AniList</button></div>'}
        <div id="d-pick"></div>`;
      return;
    }
    const al = alFor(a.anilistId);
    const seq = nextSeasonOf(a);
    $el.innerHTML = `
      ${al ? `<p><a href="${esc(al.url)}" target="_blank" rel="noopener">${esc(al.title)}</a></p>
        <p class="small muted">${esc([al.format, al.year, al.episodes ? `${al.episodes} сер.` : '', AL_STATUS[al.status]].filter(Boolean).join(' · '))}</p>
        ${seq ? `<p class="small mt">Наступний сезон: ${esc(seq.title)} · ${AL_STATUS[seq.status] || ''}${
          seq.status === 'NOT_YET_RELEASED' ? `, ${fmtStart(seq.start)}` : ''}</p>` : ''}`
        : `<p class="small muted">${esc(alErr) || 'Завантаження…'}</p>`}
      ${ro ? '' : `<div class="row mt">
        ${seq ? `<button class="btn sm primary" data-al="next">Перейти на сезон ${prog.season + 1}</button>` : ''}
        <button class="btn sm" data-al="pick">Змінити</button>
        <button class="btn sm" data-al="unlink">Відв'язати</button>
      </div>`}
      <div id="d-pick"></div>`;
  }

  async function runPick(q) {
    const $list = $('#d-pick-list');
    $list.innerHTML = '<div class="loader"></div>';
    try {
      const list = await searchAnilist(q);
      if (view !== self) return;
      $list.innerHTML = list.length ? list.map((m) => `<div class="pick">
        ${posterImg(m.cover)}
        <div class="pick-body"><div class="row-title">${esc(m.title)}</div>
          <div class="muted small">${esc([m.format, m.year, m.episodes ? `${m.episodes} сер.` : ''].filter(Boolean).join(' · '))}</div></div>
        <button class="btn sm" data-choose="${m.id}">Обрати</button>
      </div>`).join('') : '<p class="empty">Нічого не знайдено.</p>';
    } catch (e) {
      if (view === self) $list.innerHTML = `<p class="notice">${esc(e.message)}</p>`;
    }
  }

  function openPicker() {
    const a = item();
    const q = (a.anilistId && alFor(a.anilistId)?.romaji) || a.originalTitle || a.title;
    $('#d-pick').innerHTML = `<form class="search-row mt" id="d-pick-form">
        <input class="input" type="search" name="q" value="${esc(q)}">
        <button class="btn">Шукати</button>
      </form>
      <div class="pick-list" id="d-pick-list"></div>`;
    runPick(q);
  }

  renderWatch(a0.watchUrl);
  getTv(a0.tmdbId)
    .then((t) => { state.tv.set(a0.tmdbId, t); renderSched(); if (!item().anilistId) fixProg(); })
    .catch((e) => { tvErr = `Не вдалося завантажити TMDB: ${e.message}`; renderSched(); });
  if (a0.anilistId) {
    getAnilist([a0.anilistId])
      .then((m) => {
        m.forEach((v, k) => state.al.set(k, v));
        if (!m.size) alErr = 'Запис не знайдено на AniList';
        renderAl(); renderSched(); fixProg();
      })
      .catch((e) => { alErr = e.message; renderAl(); renderSched(); });
    getFranchise(a0.anilistId)
      .then((data) => { setFranchise(data); renderFr(); renderAl(); renderSched(); fixProg(); })
      .catch((e) => { frErr = `Не вдалося завантажити франшизу: ${e.message}`; renderFr(); });
  }
  queueMicrotask(() => { renderSched(); renderAl(); renderFr(); });

  if (ro) return self;

  // прогрес: оновлюємо поля одразу, а в Firestore пишемо з невеликою затримкою
  let saveTimer = null;
  function setStatusUI(s) {
    status = s;
    $app.querySelectorAll('#d-status .tab').forEach((x) => x.classList.toggle('on', x.dataset.s === s));
    $('#d-badge').textContent = STATUSES[s];
  }

  // повертає новий статус, якщо він змінився автоматично (остання серія)
  function setProg(p) {
    const next = clampProg(item(), p);
    // AniList: зміна сезону = перехід на інший запис у лінії сезонів франшизи, серії з 0
    const a = item();
    const target = a.anilistId && next.season !== prog.season && franchiseOf(a)?.chain[next.season - 1];
    if (target && target.id !== a.anilistId) {
      clearTimeout(saveTimer);
      saveTimer = null;
      localPatch(id, { anilistId: target.id, progress: { season: next.season, episode: 0 } });
      toast(`Сезон ${next.season}: ${target.title}`);
      rerender();
      return null;
    }
    prog = next;
    $('#p-season').value = prog.season;
    $('#p-episode').value = prog.episode;
    item().progress = prog;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; patch(id, { progress: prog }); }, 500);
    const auto = autoStatus(item(), prog);
    if (auto) {
      localPatch(id, { status: auto });
      setStatusUI(auto);
      toast(autoStatusMessage(auto));
    }
    renderSched();
    return auto;
  }
  function flushProg() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    patch(id, { progress: prog });
  }

  $app.querySelectorAll('[data-step]').forEach((b) => {
    b.onclick = () => setProg({ ...prog, [b.dataset.step]: prog[b.dataset.step] + Number(b.dataset.d) });
  });
  $('#p-season').onchange = (e) => setProg({ ...prog, season: +e.target.value });
  $('#p-episode').onchange = (e) => setProg({ ...prog, episode: +e.target.value });
  $('#d-plus1').onclick = () => {
    const next = stepEp(item(), prog);
    if (!next) return toast(endMessage(item()));
    if (!setProg(next)) toast(`Переглянуто ${fmtEp(prog)}`);
  };

  $('#d-al').onclick = (e) => {
    const act = e.target.closest('[data-al]')?.dataset.al;
    const choose = e.target.closest('[data-choose]')?.dataset.choose;
    if (act === 'pick') openPicker();
    else if (act === 'unlink') { flushProg(); localPatch(id, { anilistId: null }); rerender(); }
    else if (act === 'next') { clearTimeout(saveTimer); saveTimer = null; startNextSeason(item(), prog.season); rerender(); }
    else if (choose) { flushProg(); localPatch(id, { anilistId: Number(choose) }); rerender(); toast('AniList прив\'язано'); }
  };
  $('#d-fr').onclick = (e) => {
    const pick = e.target.closest('[data-fr-pick]')?.dataset.frPick;
    const watch = e.target.closest('[data-fr-watch]')?.dataset.frWatch;
    const f = franchiseOf(item());
    if (!f) return;
    if (pick) {
      const idx = f.chain.findIndex((n) => n.id === Number(pick));
      const n = f.chain[idx];
      if (!n || !confirm(`Зробити поточним «${n.title}»? Це буде сезон ${idx + 1}, серії почнуться з 0.`)) return;
      clearTimeout(saveTimer);
      saveTimer = null;
      localPatch(id, { anilistId: n.id, progress: { season: idx + 1, episode: 0 } });
      rerender();
      toast(`Поточний сезон: ${n.title}`);
    } else if (watch) {
      const set = new Set(item().watchedExtras || []);
      const wid = Number(watch);
      if (set.has(wid)) set.delete(wid); else set.add(wid);
      localPatch(id, { watchedExtras: [...set] });
      renderFr();
    }
  };

  $('#d-al').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    if (q) runPick(q);
  };

  $('#d-status').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b || b.dataset.s === status) return;
    localPatch(id, { status: b.dataset.s });
    setStatusUI(b.dataset.s);
  };

  $('#d-private').onchange = (e) => {
    const isPrivate = e.target.checked;
    localPatch(id, { private: isPrivate });
    $('#d-priv').hidden = !isPrivate;
    toast(isPrivate ? 'Тайтл приховано: бачите лише ви' : 'Тайтл видно в режимі перегляду');
  };

  $('#d-url').onchange = (e) => {
    const url = e.target.value.trim();
    if (url && !safeUrl(url)) return toast('Посилання має починатися з http:// або https://');
    localPatch(id, { watchUrl: url });
    renderWatch(url);
    toast('Посилання збережено');
  };

  $('#d-delete').onclick = () => {
    if (!confirm(`Видалити «${a0.title}» зі списку?`)) return;
    clearTimeout(saveTimer);
    db.removeAnime(id).catch(fail);
    state.items.delete(id);
    location.hash = '#/list';
  };

  return self;
}

// ---------- картка фільму: без сезонів і серій

function movieDetail(id) {
  const self = { name: 'anime' };
  const a = state.items.get(id);
  const ro = !state.canEdit;
  const runtime = a.runtime ? `${Math.floor(a.runtime / 60)} год ${a.runtime % 60} хв` : '';
  const sub = [a.originalTitle && a.originalTitle !== a.title ? a.originalTitle : '', a.year, runtime].filter(Boolean).join(' · ');
  const statuses = STATUS_KEYS.filter((s) => s !== 'waiting');
  const doneBtn = () => (a.status === 'completed'
    ? '<button class="btn wide on" id="m-done">✓ Переглянуто</button>'
    : '<button class="btn primary wide" id="m-done">Позначити переглянутим</button>');

  $app.innerHTML = `<div class="detail">
    <div class="detail-head">
      ${posterImg(a.poster)}
      <div class="detail-info">
        <h1>${esc(a.title)}</h1>
        ${sub ? `<div class="muted">${esc(sub)}</div>` : ''}
        <div class="badges"><span class="badge">фільм</span><span class="badge" id="d-badge">${STATUSES[a.status]}</span>
          <span class="badge priv" id="d-priv"${a.private ? '' : ' hidden'}>🔒 тільки для мене</span></div>
        ${safeUrl(a.watchUrl) ? `<a class="btn primary" id="d-watch" href="${esc(a.watchUrl)}" target="_blank" rel="noopener">▶ Дивитись</a>` : ''}
      </div>
    </div>
    ${ro ? '' : `<div id="m-done-box">${doneBtn()}</div>
      <section class="panel"><h2>Статус</h2><div class="seg" id="d-status">${statuses.map((s) =>
        `<button class="tab${s === a.status ? ' on' : ''}" data-s="${s}">${STATUSES[s]}</button>`).join('')}</div></section>
      <section class="panel"><h2>Де дивлюсь</h2>
        <input class="input" type="url" id="d-url" placeholder="https://…" value="${esc(a.watchUrl)}"></section>
      <section class="panel"><h2>Видимість</h2>
        <label class="check"><input type="checkbox" id="d-private"${a.private ? ' checked' : ''}> 🔒 Тільки для мене</label></section>`}
    <section class="panel"><h2>Опис</h2><p class="overview">${esc(a.overview) || 'Опису немає.'}</p>
      ${a.anilistId ? `<p class="mt"><a href="https://anilist.co/anime/${a.anilistId}" target="_blank" rel="noopener">Відкрити на AniList</a></p>` : ''}</section>
    ${ro ? '' : '<button class="btn danger wide" id="d-delete">Видалити фільм</button>'}
  </div>`;

  if (ro) return self;
  const $ = (sel) => $app.querySelector(sel);

  function setStatus(s) {
    a.status = s;
    localPatch(id, { status: s });
    $('#d-badge').textContent = STATUSES[s];
    $app.querySelectorAll('#d-status .tab').forEach((x) => x.classList.toggle('on', x.dataset.s === s));
    $('#m-done-box').innerHTML = doneBtn();
  }

  $('#m-done-box').onclick = (e) => {
    if (!e.target.closest('#m-done')) return;
    setStatus(a.status === 'completed' ? 'planned' : 'completed');
    toast(a.status === 'completed' ? 'Фільм переглянуто' : 'Фільм у «Заплановано»');
  };
  $('#d-status').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (b && b.dataset.s !== a.status) setStatus(b.dataset.s);
  };
  $('#d-url').onchange = (e) => {
    const url = e.target.value.trim();
    if (url && !safeUrl(url)) return toast('Посилання має починатися з http:// або https://');
    localPatch(id, { watchUrl: url });
    toast('Посилання збережено');
    rerender();
  };
  $('#d-private').onchange = (e) => {
    localPatch(id, { private: e.target.checked });
    $('#d-priv').hidden = !e.target.checked;
    toast(e.target.checked ? 'Фільм приховано: бачите лише ви' : 'Фільм видно в режимі перегляду');
  };
  $('#d-delete').onclick = () => {
    if (!confirm(`Видалити «${a.title}» зі списку?`)) return;
    db.removeAnime(id).catch(fail);
    state.items.delete(id);
    location.hash = '#/list';
  };
  return self;
}

// ---------- додавання

function addView() {
  const self = { name: 'add' };
  $app.innerHTML = `
    <h1 class="page-title">Додати аніме</h1>
    <form class="search-row" id="a-form">
      <input type="search" class="input" id="a-q" placeholder="Назва українською, англійською чи оригінальна" autocomplete="off" required value="${esc(state.addQuery)}">
      <button class="btn primary">Шукати</button>
    </form>
    <label class="field-inline">Статус
      <select class="input" id="a-status">${STATUS_KEYS.map((s) =>
        `<option value="${s}"${s === state.addStatus ? ' selected' : ''}>${STATUSES[s]}</option>`).join('')}</select>
    </label>
    <label class="check"><input type="checkbox" id="a-private"${state.addPrivate ? ' checked' : ''}> 🔒 Тільки для мене</label>
    <div class="results" id="a-results"></div>
    <div id="a-al-box"></div>`;

  const $q = $app.querySelector('#a-q');
  const $res = $app.querySelector('#a-results');
  const $alBox = $app.querySelector('#a-al-box');

  // ---- пошук на AniList: там кожен сезон — окремий запис
  const alCard = (m) => `<article class="result">
    ${posterImg(m.cover)}
    <div class="result-body">
      <div class="result-title">${esc(m.title)}</div>
      <div class="muted small">${esc([FORMAT_UK[m.format] || m.format, m.year, m.episodes ? `${m.episodes} сер.` : ''].filter(Boolean).join(' · '))}</div>
      ${m.romaji && m.romaji !== m.title ? `<p class="small muted">${esc(m.romaji)}</p>` : ''}
      <div class="row"><button class="btn primary sm" data-al-add="${m.id}">Додати</button>
        <button class="btn sm" data-al-later="${m.id}">+ Пізніше</button></div>
    </div>
  </article>`;

  function showAl() {
    if (state.addResults === null && !state.alResults) { $alBox.innerHTML = ''; return; }
    if (state.alResults === 'loading') { $alBox.innerHTML = '<div class="loader"></div>'; return; }
    if (!state.alResults) {
      $alBox.innerHTML = '<button class="btn sm mt" id="a-al-search">Немає потрібного сезону? Шукати на AniList</button>';
      return;
    }
    const list = state.alResults.filter((m) => m.format !== 'MUSIC');
    $alBox.innerHTML = `<h2 class="section-title">На AniList</h2>
      <p class="muted small" style="margin:-6px 0 10px">Тут кожен сезон окремо. Сайт знайде серіал на TMDB (українська назва й опис) і виставить цей сезон.</p>
      ${list.length ? `<div class="results">${list.map(alCard).join('')}</div>` : '<p class="empty">На AniList теж нічого не знайдено.</p>'}`;
  }

  async function searchAl(q) {
    state.alResults = 'loading';
    showAl();
    const link = q.match(/anilist\.co\/anime\/(\d+)/i);
    try {
      const res = link ? [await getAnilistShort(Number(link[1]))].filter(Boolean) : await searchAnilist(parseSeasonQuery(q).base);
      if (view !== self) return;
      state.alResults = res;
    } catch (e) {
      state.alResults = [];
      toast(e.message);
    }
    showAl();
  }

  $alBox.onclick = async (e) => {
    if (e.target.closest('#a-al-search')) return searchAl(state.addQuery);
    const later = e.target.closest('[data-al-later]');
    if (later) {
      later.disabled = true;
      later.textContent = 'Додаю…';
      try {
        await addFromAnilist(state.alResults.find((x) => String(x.id) === later.dataset.alLater), 'later', state.addPrivate);
        later.textContent = '✓ У «Пізніше»';
        toast('Додано в «Переглянути пізніше»');
      } catch (err) {
        toast(err.message);
        later.disabled = false;
        later.textContent = '+ Пізніше';
      }
      return;
    }
    const b = e.target.closest('[data-al-add]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Шукаю на TMDB…';
    const m = state.alResults.find((x) => String(x.id) === b.dataset.alAdd);
    try {
      const id = await addFromAnilist(m, state.addStatus, state.addPrivate);
      location.hash = `#/anime/${id}`;
    } catch (err) {
      toast(err.message);
      b.disabled = false;
      b.textContent = 'Додати';
    }
  };

  const resultCard = (r) => {
    const sub = [r.mediaType === 'movie' ? 'фільм' : 'серіал', r.date.slice(0, 4),
      r.originalName !== r.name ? r.originalName : ''].filter(Boolean).join(' · ');
    const docId = resultDocId(r);
    return `<article class="result">
      ${posterImg(posterUrl(r.poster_path, 'w185'))}
      <div class="result-body">
        <div class="result-title">${esc(r.name)}</div>
        <div class="muted small">${esc(sub)}</div>
        <p class="clip small">${esc(r.overview)}</p>
        ${state.items.has(docId)
          ? `<a class="btn sm" href="#/anime/${esc(docId)}">${state.items.get(docId).status === 'later' ? 'У «Пізніше» →' : 'Вже у списку →'}</a>`
          : `<div class="row"><button class="btn primary sm" data-add="${esc(docId)}">Додати</button>
              <button class="btn sm" data-later="${esc(docId)}">+ Пізніше</button></div>`}
      </div>
    </article>`;
  };

  const show = () => {
    if (state.addResults === null) { $res.innerHTML = ''; return; }
    const hint = state.addHint ? `<p class="muted small search-hint">${esc(state.addHint)}</p>` : '';
    $res.innerHTML = hint + (state.addResults.length
      ? state.addResults.map(resultCard).join('')
      : `<p class="empty">Нічого не знайдено ні на TMDB, ні через AniList. Спробуйте англійську чи японську назву.</p>`);
  };

  let searchSeq = 0;
  let typingTimer;
  async function search(q) {
    const seq = ++searchSeq;
    state.addQuery = q;
    state.alResults = null;
    // вставлено посилання AniList — одразу показуємо цей запис
    if (/anilist\.co\/anime\/\d+/i.test(q)) {
      state.addResults = [];
      state.addSeason = null;
      state.addHint = 'Посилання AniList: оберіть запис нижче.';
      show();
      return searchAl(q);
    }
    if (!state.addResults?.length) $res.innerHTML = '<div class="loader"></div>';
    try {
      const { base, season } = parseSeasonQuery(q);
      let results = await searchMulti(base);
      let hint = '';
      // TMDB нічого не знайшов: беремо назви з AniList (англ., ромадзі, японська) і шукаємо ними
      if (!results.length) {
        const al = await searchAnilist(base).catch(() => []);
        state.alResults = al; // і показуємо самі записи AniList
        const names = [...new Set(al.slice(0, 3).flatMap((m) => [m.title, m.romaji, m.native]))]
          .filter((n) => n && n.toLowerCase() !== base.toLowerCase()).slice(0, 5);
        for (const name of names) {
          if (seq !== searchSeq) return;
          const { base: alBase } = parseSeasonQuery(name);
          results = await searchMulti(alBase).catch(() => []);
          if (results.length) { hint = `Знайдено через AniList за назвою «${alBase}».`; break; }
        }
      }
      if (seq !== searchSeq || view !== self) return; // прийшла відповідь на старіший запит
      state.addSeason = season;
      state.addHint = [
        base !== q ? `Шукаю «${base}»: сезони на TMDB лежать усередині одного серіалу.` : '',
        hint,
        season ? `Сезон ${season} виставиться автоматично після додавання серіалу.` : '',
      ].filter(Boolean).join(' ');
      // аніме (жанр «Анімація») — нагору
      results.sort((x, y) => (y.genre_ids?.includes(16) ? 1 : 0) - (x.genre_ids?.includes(16) ? 1 : 0));
      state.addResults = results;
      show();
      showAl();
    } catch (err) {
      if (seq === searchSeq && view === self) $res.innerHTML = `<p class="notice">${esc(err.message)}</p>`;
    }
  }

  // результати з'являються під час набору, з невеликою паузою
  $q.oninput = () => {
    clearTimeout(typingTimer);
    const q = $q.value.trim();
    if (q.length < 2) {
      searchSeq++;
      state.addQuery = q;
      state.addResults = null;
      state.addSeason = null;
      state.addHint = '';
      state.alResults = null;
      show();
      showAl();
      return;
    }
    typingTimer = setTimeout(() => search(q), 400);
  };

  $app.querySelector('#a-form').onsubmit = (e) => {
    e.preventDefault();
    clearTimeout(typingTimer);
    const q = $q.value.trim();
    if (!q) return;
    $q.blur(); // ховаємо клавіатуру на телефоні
    search(q);
  };

  // перехід зі сторінки порад: одразу шукаємо назву
  if (state.addAutoSearch && state.addQuery) {
    state.addAutoSearch = false;
    search(state.addQuery);
  }

  $app.querySelector('#a-status').onchange = (e) => { state.addStatus = e.target.value; };
  $app.querySelector('#a-private').onchange = (e) => { state.addPrivate = e.target.checked; };

  $res.onclick = async (e) => {
    const later = e.target.closest('[data-later]');
    if (later) {
      later.disabled = true;
      later.textContent = 'Додаю…';
      const r = state.addResults.find((x) => resultDocId(x) === later.dataset.later);
      await addAnime(r, 'later', state.addPrivate, state.addSeason, parseSeasonQuery(state.addQuery).base);
      toast('Додано в «Переглянути пізніше»');
      if (view === self) show();
      return;
    }
    const b = e.target.closest('[data-add]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Додаю…';
    const r = state.addResults.find((x) => resultDocId(x) === b.dataset.add);
    const id = await addAnime(r, state.addStatus, state.addPrivate, state.addSeason, parseSeasonQuery(state.addQuery).base);
    location.hash = `#/anime/${id}`;
  };

  show();
  showAl();
  return self;
}

// Додавання із запису AniList: шукаємо серіал / фільм на TMDB (українська назва й опис)
// і прив'язуємо саме цей запис, тобто потрібний сезон.
async function addFromAnilist(m, status, isPrivate) {
  const movie = m.format === 'MOVIE';
  let season = 1;
  let names = [m.title, m.romaji, m.native];
  if (!movie) {
    try {
      setFranchise(await getFranchise(m.id));
      const f = franchiseOf({ anilistId: m.id, type: 'tv' });
      if (f) {
        season = f.curIdx + 1;
        names = [f.chain[0].title, ...names]; // назва першого сезону зазвичай і є назвою серіалу на TMDB
      }
    } catch (e) { console.warn(e); }
  }
  const type = movie ? 'movie' : 'tv';
  const queries = [...new Set(names.filter(Boolean).map((n) => parseSeasonQuery(n.normalize('NFKC')).base))].slice(0, 5);
  let r = null;
  for (const q of queries) {
    const res = await searchMulti(q).catch(() => []);
    r = res.find((x) => x.mediaType === type && x.genre_ids.includes(16)) || res.find((x) => x.mediaType === type);
    if (r) break;
  }
  if (!r) throw new Error('Цього тайтлу немає на TMDB, тому додати його поки не вийде');

  const docId = resultDocId(r);
  const existing = state.items.get(docId);
  if (existing) {
    if (!movie && existing.anilistId !== m.id
      && confirm(`«${existing.title}» уже у списку. Перейти на «${m.title}» (сезон ${season})? Серії почнуться з 0.`)) {
      localPatch(docId, { anilistId: m.id, progress: { season, episode: 0 }, status: 'watching' });
    }
    return docId;
  }
  return movie
    ? addMovie(r, status, isPrivate, '', m.id)
    : addAnime(r, status, isPrivate, null, '', { anilistId: m.id, season });
}

const resultDocId = (r) => (r.mediaType === 'movie' ? `movie-${r.id}` : String(r.id));

// «86: Eighty Six 2 season» → { base: '86: Eighty Six', season: 2 }.
// TMDB тримає сезони всередині одного серіалу, тож слова про сезон у запиті заважають пошуку.
const SEASON_PATTERNS = [
  /(?:^|\s)(?:season|сезон|частина|part|cour)\s*(\d{1,2})(?=\s|$)/i,
  /(?:^|\s)(\d{1,2})\s*-?(?:st|nd|rd|th|й|ий|ій)?\s*(?:season|сезон|частина|part|cour)(?=\s|$)/i,
  /(?:^|\s)s(\d{1,2})(?=\s|$)/i,
];
function parseSeasonQuery(q) {
  for (const re of SEASON_PATTERNS) {
    const m = q.match(re);
    if (!m) continue;
    const base = q.replace(re, ' ').replace(/\s+/g, ' ').replace(/[\s:–—-]+$/, '').trim();
    if (base) return { base, season: Number(m[1]) || null };
  }
  return { base: q, season: null };
}

// override: { anilistId, season } — запис AniList уже вибрано (додавання з AniList)
async function addAnime(r, status, isPrivate = false, season = null, query = '', override = null) {
  if (r.mediaType === 'movie') return addMovie(r, status, isPrivate, query);
  const id = String(r.id);
  let tv = null;
  try { tv = await getTv(r.id); state.tv.set(r.id, tv); } catch (e) { console.warn(e); }
  const year = Number(r.date.slice(0, 4)) || null;
  let anilistId = override?.anilistId ?? null;
  if (!override) {
    try { anilistId = await matchAnilist([r.originalName, query, tv?.name, r.name], year); } catch (e) { console.warn(e); }
  }

  // у запиті був сезон («… 2 season»): переходимо на відповідний запис у лінії сезонів AniList
  let progressSeason = override?.season || 1;
  if (!override && season > 1) {
    if (anilistId) {
      try {
        setFranchise(await getFranchise(anilistId));
        const chain = franchiseOf({ anilistId, type: 'tv' })?.chain || [];
        const start = chain.findIndex((n) => n.id === anilistId);
        const node = chain[start + season - 1];
        if (start >= 0 && node) { anilistId = node.id; progressSeason = start + season; }
      } catch (e) { console.warn(e); }
    } else {
      progressSeason = Math.min(season, Math.max(1, ...(tv?.seasons || []).map((s) => s.season)));
    }
  }

  const now = Date.now();
  const data = {
    type: 'tv',
    tmdbId: r.id,
    anilistId,
    title: tv?.name || r.name,
    originalTitle: tv?.originalName || r.originalName || '',
    poster: posterUrl(tv?.poster || r.poster_path),
    overview: tv?.overview || r.overview || '',
    status,
    progress: { season: progressSeason, episode: 0 },
    watchUrl: '',
    watchedExtras: [],
    private: !!isPrivate,
    addedAt: now,
    updatedAt: now,
  };
  // не чекаємо підтвердження сервера: Firestore одразу запише локально (працює й офлайн)
  db.saveAnime(id, data).catch(fail);
  state.items.set(id, { id, ...data });
  return id;
}

async function addMovie(r, status, isPrivate, query = '', anilistOverride = null) {
  const id = `movie-${r.id}`;
  let mv = null;
  try { mv = await getMovie(r.id); } catch (e) { console.warn(e); }
  const year = Number(r.date.slice(0, 4)) || mv?.year || null;
  let anilistId = anilistOverride; // для порад
  if (!anilistId) {
    try { anilistId = await matchAnilist([r.originalName, query, mv?.name, r.name], year, ['MOVIE']); } catch (e) { console.warn(e); }
  }

  const now = Date.now();
  const data = {
    type: 'movie',
    tmdbId: r.id,
    anilistId,
    title: mv?.name || r.name,
    originalTitle: mv?.originalName || r.originalName || '',
    poster: posterUrl(mv?.poster || r.poster_path),
    overview: mv?.overview || r.overview || '',
    year,
    runtime: mv?.runtime || null,
    status: status === 'waiting' ? 'planned' : status, // «чекаю сезон» для фільму не має сенсу
    progress: { season: 1, episode: 0 },
    watchUrl: '',
    watchedExtras: [],
    private: !!isPrivate,
    addedAt: now,
    updatedAt: now,
  };
  db.saveAnime(id, data).catch(fail);
  state.items.set(id, { id, ...data });
  return id;
}

// ---------- «Ще»: акаунт, бекап

function moreView() {
  const u = state.user;
  $app.innerHTML = `
    <h1 class="page-title">Ще</h1>
    <div class="stack">
      <section class="panel">
        <h2>Акаунт</h2>
        <p>${esc(u.displayName)} <span class="muted">${esc(u.email)}</span></p>
        <p class="small muted">${state.canEdit ? 'Власник: повний доступ' : 'Тільки перегляд'}</p>
        <button class="btn" id="m-logout">Вийти</button>
      </section>
      <section class="panel">
        <h2>Резервна копія</h2>
        <p class="small muted">У списку ${state.items.size} ${plural(state.items.size, 'тайтл', 'тайтли', 'тайтлів')}.</p>
        <div class="row">
          <button class="btn" id="m-export">Експорт у JSON</button>
          ${state.canEdit ? '<label class="btn">Імпорт з JSON<input type="file" id="m-import" accept=".json,application/json" hidden></label>' : ''}
        </div>
        ${state.canEdit ? '<p class="hint">Імпорт додає тайтли з файлу. Тайтли з таким самим tmdbId буде перезаписано.</p>' : ''}
      </section>
      <section class="panel">
        <h2>Дані TMDB та AniList</h2>
        <p class="small muted">Інформація про серії кешується на ${cfg.CACHE_HOURS} год.</p>
        <button class="btn" id="m-refresh">Оновити зараз</button>
      </section>
    </div>`;

  const $ = (sel) => $app.querySelector(sel);
  $('#m-logout').onclick = () => db.logout();
  $('#m-export').onclick = exportJson;
  $('#m-refresh').onclick = () => {
    clearTvCache();
    clearAnilistCache();
    state.tv.clear();
    state.al.clear();
    ensureData(activeItems(), true);
    location.hash = '#/';
  };
  if (state.canEdit) {
    $('#m-import').onchange = (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) importJson(file);
    };
  }
  return { name: 'more' };
}

function exportJson() {
  const payload = {
    app: 'anilibrary',
    version: 1,
    exportedAt: new Date().toISOString(),
    items: items().map(({ id, ...rest }) => rest),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `anilibrary-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function normalize(x) {
  const posInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const tmdbId = posInt(x?.tmdbId);
  if (!tmdbId) return null;
  const int = (v, d) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const type = x.type === 'movie' ? 'movie' : 'tv';
  return {
    type,
    ...(type === 'movie' ? { year: posInt(x.year), runtime: posInt(x.runtime) } : {}),
    tmdbId,
    anilistId: posInt(x.anilistId),
    title: String(x.title || ''),
    originalTitle: String(x.originalTitle || ''),
    poster: String(x.poster || ''),
    overview: String(x.overview || ''),
    status: STATUSES[x.status] ? x.status : 'planned',
    progress: { season: int(x.progress?.season, 1), episode: int(x.progress?.episode, 0) },
    watchUrl: safeUrl(String(x.watchUrl || '')),
    watchedExtras: Array.isArray(x.watchedExtras) ? x.watchedExtras.map(posInt).filter(Boolean) : [],
    private: x.private === true,
    addedAt: Number(x.addedAt) || Date.now(),
    updatedAt: Number(x.updatedAt) || Date.now(),
  };
}

async function importJson(file) {
  let list;
  try {
    const data = JSON.parse(await file.text());
    list = (Array.isArray(data) ? data : data.items || []).map(normalize).filter(Boolean);
  } catch {
    return toast('Не вдалося прочитати файл');
  }
  if (!list.length) return toast('У файлі немає тайтлів');
  if (!confirm(`Імпортувати ${list.length} ${plural(list.length, 'тайтл', 'тайтли', 'тайтлів')}?`)) return;
  try {
    await db.importAnime(list);
    toast(`Імпортовано: ${list.length}`);
  } catch (e) {
    fail(e);
  }
}
