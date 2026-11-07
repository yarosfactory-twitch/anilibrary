// Налаштування застосунку. Як отримати значення — див. README.md.

// Firebase Console → Project settings → General → Your apps → SDK setup and configuration → Config
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// uid власника: може читати й редагувати.
export const OWNER_UID = '';

// uid другої людини: тільки читання.
export const READER_UID = '';

// Ключ TMDB API v3 (https://www.themoviedb.org/settings/api)
export const TMDB_API_KEY = '';

// Скільки годин зберігати відповіді TMDB і AniList у localStorage.
export const CACHE_HOURS = 6;
