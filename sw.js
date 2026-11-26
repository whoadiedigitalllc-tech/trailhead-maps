// Offline: app shell + land data cached on install; basemap tiles served from the 'tiles' cache filled by Offline maps.
// Parish parcel files (12-18 MB each) are cached the first time you view that parish, in their own cache that survives app updates.
const SHELL = 'shell-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'geo.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
               'vendor/maplibre-gl.js', 'vendor/maplibre-gl.css', 'data/land-LA.geojson', 'data/parcels/index.json'];

self.addEventListener('install', e => e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'basemap.nationalmap.gov') {
    // downloaded tiles first; otherwise the network
    e.respondWith(caches.open('tiles').then(c => c.match(url.href, { ignoreVary: true })).then(hit => hit || fetch(e.request)));
  } else if (url.origin === location.origin) {
    // stale-while-revalidate: instant + offline, picks up new versions on the next launch
    const parcelFile = url.pathname.includes('/data/parcels/') && !url.pathname.endsWith('index.json');
    e.respondWith(caches.open(parcelFile ? 'parcels' : SHELL).then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
  }
});
