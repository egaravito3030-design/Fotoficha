/* Service worker de FotoFicha: guarda la app para que abra sin internet.
   Al publicar una versión nueva, cambiar CACHE (ej. fotoficha-v2). */
const CACHE = 'fotoficha-v5';
const ARCHIVOS = ['./', 'index.html', 'styles.css', 'app.js', 'lib/piexif.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // mapas y geocodificación van directo a internet
  // motor y modelos de caras (~8 MB): primero la copia guardada, así se descargan una sola vez
  if (u.pathname.includes('/models/') || u.pathname.endsWith('/lib/face-api.js')) {
    e.respondWith(caches.match(e.request).then((m) => m || fetch(e.request).then((r) => {
      const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r;
    })));
    return;
  }
  // primero la red (para recibir actualizaciones), si no hay red, la copia guardada
  e.respondWith(fetch(e.request).then((r) => {
    const copia = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
