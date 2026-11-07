import * as cfg from './config.js';
import { searchTv, getTv, peekTv, clearTvCache, posterUrl, cmpEp, nextEp, countNew } from './tmdb.js';
import { getAnilist, peekAnilist, searchAnilist, matchAnilist, clearAnilistCache, getAiring } from './anilist.js';

const STATUSES = {
  watching: 'Дивлюсь',
  waiting: 'Чекаю сезон',
  planned: 'Заплановано',
  completed: 'Переглянуто',
  dropped: 'Кинуто',
};
const STATUS_KEYS = Object.keys(STATUSES);
const ACTIVE = ['watching', 'waiting'];
const AL_STATUS = {
  FINISHED: 'завершено', RELEASING: 'виходить', NOT_YET_RELEASED: 'анонсовано', CANCELLED: 'скасовано', HIATUS: 'перерва',
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
  listStatus: 'watching',
  listQuery: '',
  addQuery: '',
  addResults: null,
  addStatus: 'watching',
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
const activeItems = () => items().filter((a) => ACTIVE.includes(a.status));
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
const sequelOf = (sch) => (sch?.source === 'anilist' && sch.fresh === 0 && sch.al.status === 'FINISHED' ? sch.al.sequel : null);
const isOut = (seq) => seq && (seq.status === 'RELEASING' || seq.status === 'FINISHED');

const hasNew = (a) => ACTIVE.includes(a.status) && scheduleFor(a)?.fresh > 0;

// Межі прогресу за відомими даними: не можна переглянути більше серій, ніж є в сезоні.
// null — межа невідома (немає даних або AniList ще не знає кількості серій).
function limits(a, season) {
  if (a.anilistId) return { maxSeason: null, maxEpisode: alFor(a.anilistId)?.episodes || null };
  const seasons = tvFor(a.tmdbId)?.seasons;
  if (!seasons?.length) return { maxSeason: null, maxEpisode: null };
  return {
    maxSeason: Math.max(...seasons.map((s) => s.season)),
    maxEpisode: seasons.find((s) => s.season === season)?.episodes || null,
  };
}

function clampProg(a, p) {
  let season = Math.max(1, p.season | 0);
  let episode = Math.max(0, p.episode | 0);
  const { maxSeason } = limits(a, season);
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

const endMessage = (a) => (a.anilistId && alFor(a.anilistId)?.sequel
  ? 'Сезон переглянуто: можна перейти на наступний'
  : 'Це остання серія, що є');

function startNextSeason(a, season = a.progress.season) {
  const seq = alFor(a.anilistId)?.sequel;
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
    } else {
      view?.update?.();
    }
  }, (err) => {
    console.error(err);
    screen('Немає доступу', err.code === 'permission-denied'
      ? '<p class="muted">Firestore відхилив запит. Перевірте uid у <code>config.js</code> та в правилах Firestore.</p>'
      : `<p class="muted">${esc(err.message)}</p>`, true);
  });
}

function showLogin() {
  $app.innerHTML = `<div class="center-screen">
    <img src="icons/icon.svg" class="logo" alt="">
    <h1>Anilibrary</h1>
    <p class="muted">Особистий трекер аніме</p>
    <button class="btn primary" id="login">Увійти через Google</button>
  </div>`;
  const btn = $app.querySelector('#login');
  btn.onclick = async () => {
    btn.disabled = true;
    try { await db.login(); } catch (e) { fail(e); } finally { btn.disabled = false; }
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

const VIEWS = { '': home, list: listView, calendar: calendarView, anime: detail, add: addView, more: moreView };
const NAV_OF = { home: 'home', list: 'list', calendar: 'calendar', anime: 'list', add: 'add', more: 'more' };
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
    localPatch(a.id, { progress });
    toast(`Переглянуто ${fmtEp(progress)}`);
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

    const empty = state.items.size
      ? 'Нових серій немає: усе переглянуто.'
      : `Список порожній. ${state.canEdit ? '<a href="#/add">Додайте перше аніме</a>' : ''}`;

    $app.innerHTML = `
      <h1 class="page-title">Є нові серії</h1>
      ${busy ? '<p class="muted small">Оновлюю дані…</p>' : ''}
      ${loadError ? `<p class="notice">${esc(loadError)}</p>` : ''}
      ${fresh.length ? `<div class="ep-list">${fresh.map(newCard).join('')}</div>` : `<p class="empty">${empty}</p>`}
      ${seasons.length ? `<h2 class="section-title">Вийшов новий сезон</h2><div class="ep-list">${seasons.map(seasonCard).join('')}</div>` : ''}
      ${upcoming.length ? `<h2 class="section-title">Скоро вийде</h2><div class="rows">${upcoming.map(upRow).join('')}</div>` : ''}`;
  }

  render();
  return self;
}

// ---------- списки

function listView(arg) {
  if (arg === 'all' || STATUSES[arg]) state.listStatus = arg;
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
      state.listStatus === 'all' ? STATUSES[a.status] : '',
      a.progress.episode > 0 ? fmtEp(a.progress) : '',
      a.rating ? `★ ${a.rating}` : '',
    ].filter(Boolean).join(' · ');
    return `<a class="card" href="#/anime/${esc(a.id)}">
      <div class="card-poster">${posterImg(a.poster)}${hasNew(a) ? '<span class="dot-new">нові</span>' : ''}</div>
      <div class="card-title">${esc(a.title)}</div>
      ${meta ? `<div class="card-meta">${meta}</div>` : ''}
    </a>`;
  }

  function update() {
    const q = state.listQuery.trim().toLowerCase();
    const all = items().filter((a) => !q || `${a.title} ${a.originalTitle || ''}`.toLowerCase().includes(q));
    const inTab = (s) => all.filter((a) => s === 'all' || a.status === s);
    $tabs.innerHTML = ['all', ...STATUS_KEYS].map((s) => `<button class="tab${s === state.listStatus ? ' on' : ''}" data-tab="${s}">
      ${s === 'all' ? 'Усі' : STATUSES[s]} <span>${inTab(s).length}</span></button>`).join('');
    const shown = inTab(state.listStatus);
    $grid.innerHTML = shown.length
      ? shown.map(card).join('')
      : `<p class="empty">${q ? 'Нічого не знайдено.' : 'Тут поки порожньо.'}</p>`;
  }

  update();
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
        const seq = alFor(a.anilistId)?.sequel;
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

// ---------- картка тайтлу

function detail(id) {
  const self = { name: 'anime' };
  const a0 = state.items.get(id);
  if (!a0) {
    $app.innerHTML = '<p class="empty">Тайтл не знайдено. <a href="#/list">До списків</a></p>';
    return self;
  }
  const item = () => state.items.get(id) || a0;
  const ro = !state.canEdit;
  let prog = { ...a0.progress };
  let status = a0.status;
  let rating = a0.rating || null;
  let tvErr = '', alErr = '';

  const stepper = (key, label) => `<div>
    <span class="stepper-label">${label}</span>
    <div class="stepper-row">
      <button class="btn icon" data-step="${key}" data-d="-1" aria-label="${label}: менше">−</button>
      <input class="input" type="number" inputmode="numeric" min="0" id="p-${key}" value="${prog[key]}">
      <button class="btn icon" data-step="${key}" data-d="1" aria-label="${label}: більше">+</button>
    </div></div>`;

  const ratingBtns = () => Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<button data-r="${n}" class="${rating && n <= rating ? 'on' : ''}">${n}</button>`).join('');

  $app.innerHTML = `<div class="detail">
    <div class="detail-head">
      ${posterImg(a0.poster)}
      <div class="detail-info">
        <h1>${esc(a0.title)}</h1>
        ${a0.originalTitle && a0.originalTitle !== a0.title ? `<div class="muted">${esc(a0.originalTitle)}</div>` : ''}
        <div class="badges"><span class="badge" id="d-badge">${STATUSES[status] || status}</span>
          ${ro && rating ? `<span class="badge">★ ${rating}</span>` : ''}</div>
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

    ${ro ? '' : `<section class="panel"><h2>Статус</h2><div class="seg" id="d-status">${STATUS_KEYS.map((s) =>
      `<button class="tab${s === status ? ' on' : ''}" data-s="${s}">${STATUSES[s]}</button>`).join('')}</div></section>`}

    ${ro ? '' : `<section class="panel"><h2>Де дивлюсь</h2>
      <input class="input" type="url" id="d-url" placeholder="https://…" value="${esc(a0.watchUrl)}"></section>`}

    ${ro ? '' : `<section class="panel"><h2>Оцінка</h2><div class="rating" id="d-rating">${ratingBtns()}</div></section>`}

    ${ro
      ? (a0.note ? `<section class="panel"><h2>Нотатка</h2><p class="note-text">${esc(a0.note)}</p></section>` : '')
      : `<section class="panel"><h2>Нотатка</h2><textarea class="input" id="d-note" placeholder="Думки, де зупинився, що дивитись далі…">${esc(a0.note)}</textarea></section>`}

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
    const { maxSeason, maxEpisode } = limits(item(), prog.season);
    const btn = (key, d) => $app.querySelector(`[data-step="${key}"][data-d="${d}"]`);
    btn('season', '-1').disabled = prog.season <= 1;
    btn('season', '1').disabled = !!maxSeason && prog.season >= maxSeason;
    btn('episode', '-1').disabled = prog.episode <= 0;
    btn('episode', '1').disabled = !!maxEpisode && prog.episode >= maxEpisode;
    $('#p-season').max = maxSeason || '';
    $('#p-episode').max = maxEpisode || '';
  }

  // після свіжих даних TMDB / AniList виправляємо прогрес, що виходить за межі (напр. S3E25 при 21 серії)
  function fixProg() {
    if (ro || view !== self) return;
    const fixed = clampProg(item(), prog);
    if (cmpEp(fixed, prog) !== 0) {
      setProg(fixed);
      toast(`Прогрес виправлено на ${fmtEp(fixed)}: більше серій у сезоні немає`);
    }
  }

  function renderSched() {
    if (view !== self) return;
    const a = item();
    renderSteppers();
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
    const seq = al?.sequel;
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
  }
  queueMicrotask(() => { renderSched(); renderAl(); });

  if (ro) return self;

  // прогрес: оновлюємо поля одразу, а в Firestore пишемо з невеликою затримкою
  let saveTimer = null;
  function setProg(p) {
    prog = clampProg(item(), p);
    $('#p-season').value = prog.season;
    $('#p-episode').value = prog.episode;
    item().progress = prog;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; patch(id, { progress: prog }); }, 500);
    renderSched();
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
    setProg(next);
    toast(`Переглянуто ${fmtEp(prog)}`);
  };

  $('#d-al').onclick = (e) => {
    const act = e.target.closest('[data-al]')?.dataset.al;
    const choose = e.target.closest('[data-choose]')?.dataset.choose;
    if (act === 'pick') openPicker();
    else if (act === 'unlink') { flushProg(); localPatch(id, { anilistId: null }); rerender(); }
    else if (act === 'next') { clearTimeout(saveTimer); saveTimer = null; startNextSeason(item(), prog.season); rerender(); }
    else if (choose) { flushProg(); localPatch(id, { anilistId: Number(choose) }); rerender(); toast('AniList прив\'язано'); }
  };
  $('#d-al').onsubmit = (e) => {
    e.preventDefault();
    const q = e.target.elements.q.value.trim();
    if (q) runPick(q);
  };

  $('#d-status').onclick = (e) => {
    const b = e.target.closest('[data-s]');
    if (!b || b.dataset.s === status) return;
    status = b.dataset.s;
    localPatch(id, { status });
    $app.querySelectorAll('#d-status .tab').forEach((x) => x.classList.toggle('on', x === b));
    $('#d-badge').textContent = STATUSES[status];
  };

  $('#d-url').onchange = (e) => {
    const url = e.target.value.trim();
    if (url && !safeUrl(url)) return toast('Посилання має починатися з http:// або https://');
    localPatch(id, { watchUrl: url });
    renderWatch(url);
    toast('Посилання збережено');
  };

  $('#d-rating').onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    const n = Number(b.dataset.r);
    rating = rating === n ? null : n;
    localPatch(id, { rating });
    $('#d-rating').innerHTML = ratingBtns();
  };

  $('#d-note').onchange = (e) => { localPatch(id, { note: e.target.value }); toast('Нотатку збережено'); };

  $('#d-delete').onclick = () => {
    if (!confirm(`Видалити «${a0.title}» зі списку?`)) return;
    clearTimeout(saveTimer);
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
    <div class="results" id="a-results"></div>`;

  const $q = $app.querySelector('#a-q');
  const $res = $app.querySelector('#a-results');

  const resultCard = (r) => {
    const year = (r.first_air_date || '').slice(0, 4);
    const sub = [r.original_name !== r.name ? r.original_name : '', year].filter(Boolean).join(' · ');
    return `<article class="result">
      ${posterImg(posterUrl(r.poster_path, 'w185'))}
      <div class="result-body">
        <div class="result-title">${esc(r.name)}</div>
        ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}
        <p class="clip small">${esc(r.overview)}</p>
        ${state.items.has(String(r.id))
          ? `<a class="btn sm" href="#/anime/${r.id}">Вже у списку →</a>`
          : `<button class="btn primary sm" data-add="${r.id}">Додати</button>`}
      </div>
    </article>`;
  };

  const show = () => {
    if (state.addResults === null) $res.innerHTML = '';
    else $res.innerHTML = state.addResults.length ? state.addResults.map(resultCard).join('') : '<p class="empty">Нічого не знайдено.</p>';
  };

  let searchSeq = 0;
  let typingTimer;
  async function search(q) {
    const seq = ++searchSeq;
    state.addQuery = q;
    if (!state.addResults?.length) $res.innerHTML = '<div class="loader"></div>';
    try {
      const results = await searchTv(q);
      if (seq !== searchSeq || view !== self) return; // прийшла відповідь на старіший запит
      // аніме (жанр «Анімація») — нагору
      results.sort((x, y) => (y.genre_ids?.includes(16) ? 1 : 0) - (x.genre_ids?.includes(16) ? 1 : 0));
      state.addResults = results;
      show();
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
      show();
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

  $app.querySelector('#a-status').onchange = (e) => { state.addStatus = e.target.value; };

  $res.onclick = async (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    b.disabled = true;
    b.textContent = 'Додаю…';
    const r = state.addResults.find((x) => String(x.id) === b.dataset.add);
    const id = await addAnime(r, state.addStatus);
    location.hash = `#/anime/${id}`;
  };

  show();
  return self;
}

async function addAnime(r, status) {
  const id = String(r.id);
  let tv = null;
  try { tv = await getTv(r.id); state.tv.set(r.id, tv); } catch (e) { console.warn(e); }
  const year = Number((r.first_air_date || '').slice(0, 4)) || null;
  let anilistId = null;
  try { anilistId = await matchAnilist([r.original_name, tv?.name, r.name], year); } catch (e) { console.warn(e); }

  const now = Date.now();
  const data = {
    tmdbId: r.id,
    anilistId,
    title: tv?.name || r.name,
    originalTitle: tv?.originalName || r.original_name || '',
    poster: posterUrl(tv?.poster || r.poster_path),
    overview: tv?.overview || r.overview || '',
    status,
    progress: { season: 1, episode: 0 },
    watchUrl: '',
    rating: null,
    note: '',
    addedAt: now,
    updatedAt: now,
  };
  // не чекаємо підтвердження сервера: Firestore одразу запише локально (працює й офлайн)
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
  const rating = Number(x.rating);
  return {
    tmdbId,
    anilistId: posInt(x.anilistId),
    title: String(x.title || ''),
    originalTitle: String(x.originalTitle || ''),
    poster: String(x.poster || ''),
    overview: String(x.overview || ''),
    status: STATUSES[x.status] ? x.status : 'planned',
    progress: { season: int(x.progress?.season, 1), episode: int(x.progress?.episode, 0) },
    watchUrl: safeUrl(String(x.watchUrl || '')),
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null,
    note: String(x.note || ''),
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
