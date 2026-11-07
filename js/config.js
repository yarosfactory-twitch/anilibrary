// Налаштування застосунку. Як отримати значення — див. README.md.

// Firebase Console → Project settings → General → Your apps → SDK setup and configuration → Config
export const firebaseConfig = {
  apiKey: 'AIzaSyD-tRQARK-wjMpgANi9rc_OnJQxyj6oKwk',
  authDomain: 'anilibrary-55236.firebaseapp.com',
  projectId: 'anilibrary-55236',
  storageBucket: 'anilibrary-55236.firebasestorage.app',
  messagingSenderId: '136456731382',
  appId: '1:136456731382:web:793ceb0ab52e0fab8acad7',
};

// uid власника: може читати й редагувати.
export const OWNER_UID = '';

// uid другої людини: тільки читання.
export const READER_UID = '';

// Ключ TMDB API v3 (https://www.themoviedb.org/settings/api)
export const TMDB_API_KEY = '7c2b3da6976f16ca5acc1b80122966bd';

// Скільки годин зберігати відповіді TMDB і AniList у localStorage.
export const CACHE_HOURS = 6;
