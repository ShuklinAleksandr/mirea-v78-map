// public/sw.js
const CACHE_NAME = 'mirea-v78-map-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  // Сюда нужно добавить пути к основным JS и CSS файлам после сборки,
  // а также к данным карты. Пример:
  '/data/buildings.json',
  '/data/rooms.json',
  '/data/campuses/v-78/v-78.json',
  '/data/campuses/v-78/v-78-floor0.json',
  '/data/campuses/v-78/v-78-floor1.json',
  '/data/campuses/v-78/v-78-floor2.json',
  '/data/campuses/v-78/v-78-floor3.json',
  '/data/campuses/v-78/v-78-floor4.json',
  '/dist/assets/route-worker-DWiEbR59.js', 
  // ... и другие критичные файлы
];

// Установка: кэшируем основные ресурсы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

// Активация: удаляем старые кэши
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Перехват запросов
self.addEventListener('fetch', (event) => {
  // Стратегия: сначала кэш, потом сеть (Cache First) для статики и данных
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request).then((networkResponse) => {
        // Опционально: можно кэшировать новые запросы на лету
        return caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
          return networkResponse;
        });
      });
    })
  );
});
