import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, query, where,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const col = collection(db, 'anime');

export const watchAuth = (cb) => onAuthStateChanged(auth, cb);
export const logout = () => signOut(auth);

// Лише вхід через спливаюче вікно. signInWithRedirect на GitHub Pages не працює в Safari / iOS
// (сайт і сторінка входу Firebase на різних доменах, браузер ізолює їхнє сховище —
// «missing initial state»). Помилки віддаємо наверх, щоб пояснити користувачу, що робити.
export async function login() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    throw e;
  }
}

// publicOnly: для глядача беремо лише тайтли без позначки «тільки для мене».
// Правила Firestore дозволяють глядачу саме такий запит, тож приховане до нього не потрапляє.
export function subscribeAnime(onData, onError, { publicOnly = false } = {}) {
  const q = publicOnly ? query(col, where('private', '==', false)) : col;
  return onSnapshot(q, (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError);
}

// старим документам без поля private ставимо private: false, щоб їх бачив глядач
export async function markPublic(ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = writeBatch(db);
    for (const id of ids.slice(i, i + 400)) batch.update(doc(col, id), { private: false });
    await batch.commit();
  }
}

export const saveAnime = (id, data) => setDoc(doc(col, id), data);
export const patchAnime = (id, data) => updateDoc(doc(col, id), { ...data, updatedAt: Date.now() });
export const removeAnime = (id) => deleteDoc(doc(col, id));

// id документа: серіал — tmdbId, фільм — movie-<tmdbId> (id фільмів і серіалів у TMDB перетинаються)
export const docIdOf = (item) => (item.type === 'movie' ? `movie-${item.tmdbId}` : String(item.tmdbId));

export async function importAnime(list) {
  for (let i = 0; i < list.length; i += 400) {
    const batch = writeBatch(db);
    for (const item of list.slice(i, i + 400)) batch.set(doc(col, docIdOf(item)), item);
    await batch.commit();
  }
}
