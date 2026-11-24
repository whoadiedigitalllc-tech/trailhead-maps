import { lineLength, ringArea, trackStats, tilesInBbox, fmt, toGpx, fromGpx } from './geo.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
const uid = () => crypto.randomUUID();

// ---------- storage (IndexedDB) ----------
const dbp = new Promise((ok, fail) => {
  const r = indexedDB.open('trailhead', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); r.result.createObjectStore('offline', { keyPath: 'id' }); };
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
});
const tx = async (store, mode, fn) => { const db = await dbp; return new Promise((ok, fail) => {
  const t = db.transaction(store, mode), req = fn(t.objectStore(store));
  t.oncomplete = () => ok(req?.result); t.onerror = () => fail(t.error); t.onabort = () => fail(t.error);
}); };
const db = {
  all: s => tx(s, 'readonly', o => o.getAll()),
  put: (s, v) => tx(s, 'readwrite', o => o.put(v)),
  del: (s, id) => tx(s, 'readwrite', o => o.delete(id)),
};
navigator.storage?.persist?.(); // ask Safari not to evict saved data / offline tiles

// ---------- constants ----------
const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services';
const BASEMAPS = { topo: 'USGSTopo', imagery: 'USGSImageryOnly', hybrid: 'USGSImageryTopo' };
const tileUrl = (base, z, x, y) => `${USGS}/${BASEMAPS[base]}/MapServer/tile/${z}/${y}/${x}`;
const MGR = {
  BLM: ['Bureau of Land Management', '#e8c13a'], USFS: ['U.S. Forest Service', '#3f9b4a'], NPS: ['National Park Service', '#8a63c2'],
  FWS: ['U.S. Fish & Wildlife Service', '#d9822b'], SFW: ['State Wildlife Agency (WMA)', '#3d84d6'], SDNR: ['State Natural Resources', '#3d84d6'],
  SPR: ['State Parks', '#3d84d6'], SLB: ['State Land Board', '#3d84d6'], OTHS: ['Other State', '#3d84d6'], TRIB: ['Tribal', '#b08a5a'],
  DOD: ['Dept. of Defense', '#7fb5a8'], USACE: ['Army Corps of Engineers', '#7fb5a8'], OTHF: ['Other Federal', '#7fb5a8'],
  CITY: ['City', '#9aa0a6'], CNTY: ['Parish / County', '#9aa0a6'], REG: ['Regional', '#9aa0a6'], NGO: ['Nonprofit', '#9aa0a6'],
  PVT: ['Private (conservation)', '#9aa0a6'], UNK: ['Unknown', '#9aa0a6'], UNKL: ['Unknown', '#9aa0a6'],
};
const ACCESS = { OA: 'Open access', RA: 'Restricted access (permit or rules)', XA: 'Closed to public', UK: 'Access unknown' };
const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#ffffff', '#000000'];
const ICONS = ['📍', '🦌', '🪜', '📷', '🚗', '⛺', '🎯', '💧', '🐾', '🌳', '⚠️', '⭐', '🏠', '🦆', '🐗', '🚪'];
const KIND_ICON = { waypoint: '📍', line: '〰️', area: '⬠', track: '👣' };

// ---------- state ----------
let items = [];                 // all saved items
let mode = null;                // null | 'line' | 'area'
let draft = [];                 // vertices while drawing
let rec = null;                 // active track item while recording
let base = localStorage.getItem('base') || 'topo';
const markers = new Map();      // waypoint id -> maplibregl.Marker

// ---------- map ----------
const saved = JSON.parse(localStorage.getItem('view') || 'null');
const fc = features => ({ type: 'FeatureCollection', features });
const map = new maplibregl.Map({
  container: 'map',
  center: saved?.c || [-91.9, 31.0], zoom: saved?.z ?? 6.5, maxZoom: 19, attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      ...Object.fromEntries(Object.keys(BASEMAPS).map(b => [b, { type: 'raster', tileSize: 256, maxzoom: 16,
        tiles: [`${USGS}/${BASEMAPS[b]}/MapServer/tile/{z}/{y}/{x}`], attribution: 'USGS The National Map · PAD-US 4.1' }])),
      land: { type: 'geojson', data: 'data/land-LA.geojson' },
      markup: { type: 'geojson', data: fc([]) },
      draft: { type: 'geojson', data: fc([]) },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dde3d5' } },
      ...Object.keys(BASEMAPS).map(b => ({ id: b, type: 'raster', source: b, layout: { visibility: b === base ? 'visible' : 'none' } })),
      { id: 'land-fill', type: 'fill', source: 'land', paint: {
          'fill-color': ['match', ['get', 'mgr'], ...Object.entries(MGR).flatMap(([k, [, c]]) => [k, c]), '#9aa0a6'],
          'fill-opacity': ['case', ['==', ['get', 'access'], 'XA'], 0.12, 0.35] } },
      { id: 'land-line', type: 'line', source: 'land', paint: {
          'line-color': ['match', ['get', 'mgr'], ...Object.entries(MGR).flatMap(([k, [, c]]) => [k, c]), '#9aa0a6'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 2] } },
      { id: 'land-sel', type: 'line', source: 'land', filter: ['==', ['id'], -1], paint: { 'line-color': '#ffd60a', 'line-width': 3 } },
      { id: 'markup-fill', type: 'fill', source: 'markup', filter: ['==', ['get', 'kind'], 'area'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } },
      { id: 'markup-line', type: 'line', source: 'markup', layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'kind'], 'track'], 4, 3] } },
      { id: 'draft-fill', type: 'fill', source: 'draft', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffd60a', 'fill-opacity': 0.2 } },
      { id: 'draft-line', type: 'line', source: 'draft', filter: ['!=', ['geometry-type'], 'Point'], paint: { 'line-color': '#ffd60a', 'line-width': 3, 'line-dasharray': [2, 1] } },
      { id: 'draft-pts', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-radius': 6, 'circle-color': '#ffd60a', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 } },
    ],
  },
});
const geo = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true, showUserHeading: true });
map.addControl(geo);
geo.on('error', () => toast('Location unavailable. Check Settings › Privacy › Location Services › Safari Websites.'));

const showCoords = () => { const c = map.getCenter(); $('#coords').textContent = fmt.coord([c.lng, c.lat]); };
map.on('move', showCoords);
map.on('moveend', () => localStorage.setItem('view', JSON.stringify({ c: map.getCenter().toArray(), z: map.getZoom() })));
map.on('load', async () => { showCoords(); items = await db.all('items'); render(); recoverTrack(); });

// ---------- render saved content ----------
function render() {
  const feats = [];
  for (const it of items) {
    if (it.kind === 'line') feats.push({ type: 'Feature', properties: { id: it.id, kind: 'line', color: it.color }, geometry: { type: 'LineString', coordinates: it.geom } });
    if (it.kind === 'area') feats.push({ type: 'Feature', properties: { id: it.id, kind: 'area', color: it.color }, geometry: { type: 'Polygon', coordinates: [[...it.geom, it.geom[0]]] } });
    if (it.kind === 'track' && it.points.length > 1) feats.push({ type: 'Feature', properties: { id: it.id, kind: 'track', color: it.color },
      geometry: { type: 'LineString', coordinates: it.points.map(p => [p.lon, p.lat]) } });
  }
  map.getSource('markup').setData(fc(feats));
  for (const [id, m] of markers) if (!items.some(i => i.id === id)) { m.remove(); markers.delete(id); }
  for (const it of items.filter(i => i.kind === 'waypoint')) {
    let m = markers.get(it.id);
    if (!m) {
      const el = document.createElement('button');
      el.className = 'wpt';
      el.addEventListener('click', e => { e.stopPropagation(); openItem(it.id); });
      m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(it.geom).addTo(map);
      markers.set(it.id, m);
    }
    m.getElement().innerHTML = `${it.icon}<i style="background:${esc(it.color)}"></i>`;
    m.getElement().setAttribute('aria-label', `Waypoint ${it.name}`);
    m.setLngLat(it.geom);
  }
}
const save = async it => { it.updated = Date.now(); await db.put('items', it); const i = items.findIndex(x => x.id === it.id);
  i < 0 ? items.push(it) : (items[i] = it); render(); };

// ---------- sheet ----------
function sheet(title, html) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  $('#sheet').hidden = false;
  $('#sheet').scrollTop = 0;
  return $('#sheet-body');
}
const closeSheet = () => { $('#sheet').hidden = true; map.setFilter('land-sel', ['==', ['id'], -1]); };
$('#sheet-close').onclick = closeSheet;
function toast(msg) { sheet('Heads up', `<p>${esc(msg)}</p>`); }

// ---------- tap the map: land info ----------
map.on('click', async e => {
  if (mode) { draft.push(e.lngLat.toArray()); drawDraft(); return; }
  const lngLat = e.lngLat.toArray();
  const hits = map.queryRenderedFeatures(e.point, { layers: ['land-fill'] });
  // smallest unit on top (a WMA inside a national forest should win)
  const f = hits.sort((a, b) => (a.properties.acres || 0) - (b.properties.acres || 0))[0];
  map.setFilter('land-sel', f ? ['==', ['id'], f.id] : ['==', ['id'], -1]);
  const p = f?.properties;
  const body = sheet(p ? p.name : 'Private or unmapped land', `
    ${p ? `<p><span class="legend" style="background:${MGR[p.mgr]?.[1] || '#9aa0a6'}"></span>${esc(MGR[p.mgr]?.[0] || p.mgr)}</p>
      <p>${esc(ACCESS[p.access] || ACCESS.UK)}${p.acres ? ` · ${p.acres.toLocaleString()} ac` : ''}</p>`
      : `<p>No public land here in PAD-US. Treat it as private: get permission before you hunt.</p>`}
    <p class="muted">${fmt.coord(lngLat)}</p>
    <p id="wx" class="muted"></p>
    <p class="muted">Source: USGS PAD-US 4.1. Not a legal boundary survey; check LDWF regs and posted signs.</p>
    <div class="actions"><button class="primary" id="here-wpt">Add waypoint here</button></div>`);
  body.querySelector('#here-wpt').onclick = () => newWaypoint(lngLat);
  weather(lngLat).then(t => { const w = body.querySelector('#wx'); if (w) w.textContent = t; });
});

async function weather([lon, lat]) {
  if (!navigator.onLine) return 'Weather needs a connection.';
  try {
    const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset&timezone=auto&forecast_days=1&wind_speed_unit=mph&temperature_unit=fahrenheit`;
    const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)).json();
    const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(j.current.wind_direction_10m / 45) % 8];
    const t = s => new Date(s).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `Wind ${Math.round(j.current.wind_speed_10m)} mph from ${dir} · ${Math.round(j.current.temperature_2m)}°F · Sunrise ${t(j.daily.sunrise[0])} · Sunset ${t(j.daily.sunset[0])}`;
  } catch { return ''; }
}

// ---------- add menu ----------
$('#btn-add').onclick = () => {
  const b = sheet('Add', `<div class="actions">
    <button id="a-wpt">📍 Waypoint at centre</button><button id="a-line">〰️ Line</button>
    <button id="a-area">⬠ Area</button><button id="a-gpx">📂 Import GPX</button></div>
    <p class="muted">Line and area: tap the map to add points.</p>`);
  b.querySelector('#a-wpt').onclick = () => newWaypoint(map.getCenter().toArray());
  b.querySelector('#a-line').onclick = () => startDraw('line');
  b.querySelector('#a-area').onclick = () => startDraw('area');
  b.querySelector('#a-gpx').onclick = () => $('#gpx-file').click();
};
async function newWaypoint(geom) {
  const it = { id: uid(), kind: 'waypoint', name: `Waypoint ${items.filter(i => i.kind === 'waypoint').length + 1}`, notes: '',
               icon: '📍', color: COLORS[0], geom, created: Date.now() };
  await save(it); openItem(it.id, true);
}

// ---------- drawing ----------
function startDraw(kind) {
  closeSheet(); mode = kind; draft = [];
  $('#draw').hidden = false; $('#crosshair').hidden = true; drawDraft();
}
function drawDraft() {
  const feats = draft.map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } }));
  if (draft.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: mode === 'area' && draft.length > 2
    ? { type: 'Polygon', coordinates: [[...draft, draft[0]]] } : { type: 'LineString', coordinates: draft } });
  map.getSource('draft').setData(fc(feats));
  $('#draw-stat').textContent = mode === 'area'
    ? (draft.length < 3 ? `Tap ${3 - draft.length} more point${draft.length === 2 ? '' : 's'}` : `${fmt.acres(ringArea(draft))} · ${fmt.miles(lineLength([...draft, draft[0]]))} around`)
    : (draft.length < 2 ? 'Tap the map to start' : fmt.miles(lineLength(draft)));
}
const endDraw = () => { mode = null; draft = []; $('#draw').hidden = true; map.getSource('draft').setData(fc([])); };
$('#draw-undo').onclick = () => { draft.pop(); drawDraft(); };
$('#draw-cancel').onclick = endDraw;
$('#draw-done').onclick = async () => {
  const kind = mode, geom = draft;
  if (draft.length < (kind === 'area' ? 3 : 2)) return;
  endDraw();
  const it = { id: uid(), kind, name: `${kind === 'area' ? 'Area' : 'Line'} ${items.filter(i => i.kind === kind).length + 1}`,
               notes: '', color: COLORS[kind === 'area' ? 3 : 1], geom, created: Date.now() };
  await save(it); openItem(it.id, true);
};

// ---------- item detail / edit ----------
function statsHtml(it) {
  if (it.kind === 'waypoint') return `<p class="muted">${fmt.coord(it.geom)}</p>`;
  if (it.kind === 'line') return `<div class="stats"><div class="stat"><b>${fmt.miles(lineLength(it.geom))}</b><small>Length</small></div></div>`;
  if (it.kind === 'area') return `<div class="stats"><div class="stat"><b>${fmt.acres(ringArea(it.geom))}</b><small>Area</small></div>
    <div class="stat"><b>${fmt.miles(lineLength([...it.geom, it.geom[0]]))}</b><small>Perimeter</small></div></div>`;
  const s = trackStats(it.points);
  return `<div class="stats"><div class="stat"><b>${fmt.miles(s.dist)}</b><small>Distance</small></div>
    <div class="stat"><b>${fmt.duration(s.secs)}</b><small>Time</small></div>
    <div class="stat"><b>${fmt.feet(s.gain)}</b><small>Climb</small></div>
    <div class="stat"><b>${fmt.feet(s.loss)}</b><small>Descent</small></div></div>`;
}
function openItem(id, isNew = false) {
  const it = items.find(i => i.id === id); if (!it) return;
  const b = sheet(isNew ? 'Saved' : it.name, `
    ${statsHtml(it)}
    <label class="field">Name<input type="text" id="f-name" value="${esc(it.name)}" maxlength="80"></label>
    ${it.kind === 'waypoint' ? `<div class="field muted">Icon<div class="icons">${ICONS.map(i =>
      `<button data-icon="${i}" aria-pressed="${i === it.icon}" aria-label="Icon ${i}">${i}</button>`).join('')}</div></div>` : ''}
    <div class="field muted">Colour<div class="swatches">${COLORS.map(c =>
      `<button data-color="${c}" aria-pressed="${c === it.color}" aria-label="Colour ${c}"><i style="background:${c}"></i></button>`).join('')}</div></div>
    <label class="field">Notes<textarea id="f-notes" maxlength="2000">${esc(it.notes)}</textarea></label>
    <div class="actions"><button id="f-show">Show on map</button><button id="f-gpx">Export GPX</button>
      <button id="f-del" class="danger">Delete</button></div>`);
  let t;
  const later = () => { clearTimeout(t); t = setTimeout(() => save(it), 400); };
  b.querySelector('#f-name').oninput = e => { it.name = e.target.value.trim() || 'Untitled'; $('#sheet-title').textContent = it.name; later(); };
  b.querySelector('#f-notes').oninput = e => { it.notes = e.target.value; later(); };
  b.querySelectorAll('[data-icon]').forEach(x => x.onclick = () => { it.icon = x.dataset.icon;
    b.querySelectorAll('[data-icon]').forEach(y => y.setAttribute('aria-pressed', y === x)); save(it); });
  b.querySelectorAll('[data-color]').forEach(x => x.onclick = () => { it.color = x.dataset.color;
    b.querySelectorAll('[data-color]').forEach(y => y.setAttribute('aria-pressed', y === x)); save(it); });
  b.querySelector('#f-show').onclick = () => { closeSheet(); showItem(it); };
  b.querySelector('#f-gpx').onclick = () => download(`${it.name.replace(/[^\w -]/g, '') || 'export'}.gpx`, toGpx(it), 'application/gpx+xml');
  b.querySelector('#f-del').onclick = async () => {
    if (!confirm(`Delete "${it.name}"? This can't be undone.`)) return;
    await db.del('items', it.id); items = items.filter(i => i.id !== it.id); render(); closeSheet();
  };
}
function showItem(it) {
  const pts = it.kind === 'waypoint' ? [it.geom] : it.kind === 'track' ? it.points.map(p => [p.lon, p.lat]) : it.geom;
  if (pts.length === 1) return map.flyTo({ center: pts[0], zoom: Math.max(map.getZoom(), 15) });
  const b = pts.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
  map.fitBounds(b, { padding: 60, maxZoom: 17 });
}
function download(name, text, type) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- saved list ----------
$('#btn-content').onclick = () => {
  const b = sheet('Saved', `<input type="search" id="q" placeholder="Search saved" aria-label="Search saved"><div id="list"></div>`);
  const draw = () => {
    const q = b.querySelector('#q').value.toLowerCase();
    const list = items.filter(i => i !== rec && (i.name + ' ' + i.notes).toLowerCase().includes(q)).sort((a, c) => c.created - a.created);
    b.querySelector('#list').innerHTML = !items.length
      ? `<p class="empty">Nothing saved yet.<br>Drop a pin or record a track and it shows up here.</p>`
      : !list.length ? `<p class="empty">No matches for "${esc(q)}".</p>`
      : list.map(i => `<button class="list-btn" data-id="${i.id}"><span class="ico" style="color:${esc(i.color)}">${i.kind === 'waypoint' ? i.icon : KIND_ICON[i.kind]}</span>
          <span class="grow"><span class="title">${esc(i.name)}</span><br><span class="muted">${i.kind} · ${new Date(i.created).toLocaleDateString()}</span></span></button>`).join('');
    b.querySelectorAll('[data-id]').forEach(x => x.onclick = () => openItem(x.dataset.id));
  };
  b.querySelector('#q').oninput = draw; draw();
};

// ---------- GPX import ----------
$('#gpx-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  if (file.size > 20e6) return toast('That file is over 20 MB. Split it and try again.');
  try {
    const got = fromGpx(await file.text(), new DOMParser());
    if (!got.length) return toast('No waypoints, tracks or routes found in that file.');
    for (const g of got) await save({ id: uid(), icon: '📍', color: COLORS[4], created: Date.now(), ...g });
    sheet('Imported', `<p>Added ${got.length} item${got.length > 1 ? 's' : ''} from ${esc(file.name)}.</p>`);
    showItem(items.at(-1));
  } catch (err) { toast(`Couldn't read that file: ${err.message}`); }
};

// ---------- tracker ----------
let watchId = null, wake = null, lastSave = 0;
const keepAwake = async () => { try { wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported: fine */ } };
document.addEventListener('visibilitychange', () => { if (rec && document.visibilityState === 'visible') keepAwake(); });

function startTracking(existing) {
  rec = existing || { id: uid(), kind: 'track', name: `Track ${new Date().toLocaleDateString()}`, notes: '', color: '#ff3b30',
                      points: [], created: Date.now(), recording: true };
  $('#btn-track').setAttribute('aria-pressed', 'true');
  $('#btn-track').lastChild.textContent = 'Stop';
  keepAwake();
  watchId = navigator.geolocation.watchPosition(onFix, err => {
    if (err.code === 1) { stopTracking(); toast('Location permission is off, so tracking stopped.'); }
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  if (!geo._watchState || geo._watchState === 'OFF') geo.trigger(); // also follow on the map
  hud(); save(rec);
}
function onFix({ coords: c, timestamp: t }) {
  if (c.accuracy > 30) return;                        // drop poor fixes
  const last = rec.points.at(-1), p = { lon: c.longitude, lat: c.latitude, ele: c.altitude, t, acc: Math.round(c.accuracy) };
  if (last && lineLength([[last.lon, last.lat], [p.lon, p.lat]]) < 3) return; // standing still
  rec.points.push(p); hud();
  if (t - lastSave > 15000) { lastSave = t; save(rec); } // crash/kill loses at most ~15 s
  else render();
}
function hud() {
  const s = trackStats(rec.points), el = $('#hud');
  el.hidden = false;
  el.innerHTML = `<div><b>${fmt.duration((Date.now() - (rec.points[0]?.t || rec.created)) / 1000)}</b><small>Time</small></div>
    <div><b>${fmt.miles(s.dist)}</b><small>Distance</small></div><div><b>${fmt.feet(s.gain)}</b><small>Climb</small></div>
    <div><b>${rec.points.length}</b><small>Points</small></div><button class="danger" id="hud-stop">Stop</button>`;
  el.querySelector('#hud-stop').onclick = stopTracking;
}
setInterval(() => rec && hud(), 1000);
async function stopTracking() {
  navigator.geolocation.clearWatch(watchId); watchId = null; wake?.release?.(); wake = null;
  const it = rec; rec = null;
  $('#hud').hidden = true; $('#btn-track').removeAttribute('aria-pressed'); $('#btn-track').lastChild.textContent = 'Track';
  if (!it) return;
  delete it.recording;
  if (it.points.length < 2) { await db.del('items', it.id); items = items.filter(i => i.id !== it.id); render(); return toast('Track too short to save.'); }
  await save(it); openItem(it.id, true);
}
$('#btn-track').onclick = () => rec ? stopTracking() : startTracking();
function recoverTrack() {
  const open = items.find(i => i.recording);
  if (!open) return;
  const b = sheet('Unfinished track', `<p>"${esc(open.name)}" was still recording when the app closed (${open.points.length} points).</p>
    <div class="actions"><button class="primary" id="r-go">Keep recording</button><button id="r-stop">Finish and save</button></div>`);
  b.querySelector('#r-go').onclick = () => { closeSheet(); startTracking(open); };
  b.querySelector('#r-stop').onclick = () => { rec = open; stopTracking(); };
}

// ---------- layers ----------
$('#btn-layers').onclick = () => {
  const on = map.getLayoutProperty('land-fill', 'visibility') !== 'none';
  const b = sheet('Layers', `
    <div class="seg" role="group" aria-label="Basemap">${Object.keys(BASEMAPS).map(k =>
      `<button data-base="${k}" aria-pressed="${k === base}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>
    <label class="row"><span class="grow">Public land (Louisiana)</span><input type="checkbox" id="l-land" ${on ? 'checked' : ''}></label>
    <p class="muted">${[...new Set(Object.values(MGR).map(v => v[1]))].map(c =>
      `<span class="legend" style="background:${c}"></span>${{ '#e8c13a': 'BLM', '#3f9b4a': 'Forest Service', '#8a63c2': 'Park Service',
        '#d9822b': 'Fish & Wildlife', '#3d84d6': 'State / WMA', '#b08a5a': 'Tribal', '#7fb5a8': 'Other federal', '#9aa0a6': 'Local / other' }[c]}`).join('<br>')}</p>
    <p class="muted">Faded fill = closed to public. Private parcels aren't available yet (Louisiana has no free statewide parcel data).</p>`);
  b.querySelectorAll('[data-base]').forEach(x => x.onclick = () => {
    base = x.dataset.base; localStorage.setItem('base', base);
    Object.keys(BASEMAPS).forEach(k => map.setLayoutProperty(k, 'visibility', k === base ? 'visible' : 'none'));
    b.querySelectorAll('[data-base]').forEach(y => y.setAttribute('aria-pressed', y === x));
  });
  b.querySelector('#l-land').onchange = e => ['land-fill', 'land-line'].forEach(l => map.setLayoutProperty(l, 'visibility', e.target.checked ? 'visible' : 'none'));
};

// ---------- offline areas ----------
const MAX_TILES = 25000;
const tileKeys = a => tilesInBbox(a.bbox, a.minZ, a.maxZ).map(([z, x, y]) => tileUrl(a.base, z, x, y));
$('#btn-offline').onclick = offlineSheet;
async function offlineSheet() {
  const areas = (await db.all('offline')).sort((a, b) => b.created - a.created);
  const b = sheet('Offline maps', `
    <p class="muted">Downloads the <b>${base}</b> basemap for what's on screen now. Public land and your saved items always work offline.</p>
    <label class="field">Detail<select id="o-z">
      <option value="14">Standard (zoom 14)</option><option value="15" selected>High (zoom 15)</option><option value="16">Max (zoom 16)</option></select></label>
    <p id="o-est" class="muted"></p>
    <div class="actions"><button class="primary" id="o-go">Download this view</button></div>
    <h3>Saved areas</h3>
    ${areas.length ? areas.map(a => `<div class="row"><div class="grow"><div class="title">${esc(a.name)}</div>
        <div class="muted">${a.base} · zoom ${a.maxZ} · ${a.count.toLocaleString()} tiles · ${a.status === 'complete' ? 'ready offline' : `${a.done}/${a.count} ${a.status}${a.error ? ` (${esc(a.error)})` : ''}`}</div>
        ${a.status === 'downloading' ? `<progress value="${a.done}" max="${a.count}"></progress>` : ''}</div>
        ${a.status !== 'complete' ? `<button data-retry="${a.id}">Retry</button>` : ''}<button data-del="${a.id}" aria-label="Delete ${esc(a.name)}">🗑</button></div>`).join('')
      : `<p class="empty">No offline maps yet.<br>Download an area before you lose signal.</p>`}`);
  const est = () => {
    const bb = map.getBounds(), maxZ = +b.querySelector('#o-z').value, minZ = Math.min(Math.max(Math.floor(map.getZoom()) - 4, 0), maxZ);
    const n = tilesInBbox([bb.getWest(), bb.getSouth(), bb.getEast(), bb.getNorth()], minZ, maxZ).length;
    b.querySelector('#o-est').textContent = n > MAX_TILES ? `${n.toLocaleString()} tiles: too big. Zoom in or lower the detail.`
      : `${n.toLocaleString()} tiles, about ${Math.round(n * 0.022)} MB.`;
    b.querySelector('#o-go').disabled = n > MAX_TILES;
    return { minZ, maxZ, n, bbox: [bb.getWest(), bb.getSouth(), bb.getEast(), bb.getNorth()] };
  };
  b.querySelector('#o-z').onchange = est; est();
  b.querySelector('#o-go').onclick = async () => {
    const { minZ, maxZ, n, bbox } = est();
    if (n > MAX_TILES) return;
    const name = prompt('Name this area', `Area ${areas.length + 1}`); if (name === null) return;
    const a = { id: uid(), name: name || 'Offline area', bbox, minZ, maxZ, base, count: n, done: 0, status: 'downloading', created: Date.now() };
    await db.put('offline', a); offlineSheet(); fetchArea(a);
  };
  b.querySelectorAll('[data-retry]').forEach(x => x.onclick = () => { const a = areas.find(y => y.id === x.dataset.retry); a.status = 'downloading'; fetchArea(a); offlineSheet(); });
  b.querySelectorAll('[data-del]').forEach(x => x.onclick = async () => {
    const a = areas.find(y => y.id === x.dataset.del);
    if (!confirm(`Delete offline map "${a.name}"?`)) return;
    const keep = new Set(areas.filter(o => o.id !== a.id).flatMap(tileKeys)); // tiles shared with other areas stay
    const cache = await caches.open('tiles');
    await Promise.all(tileKeys(a).filter(k => !keep.has(k)).map(k => cache.delete(k)));
    await db.del('offline', a.id); offlineSheet();
  });
}
async function fetchArea(a) {
  const cache = await caches.open('tiles'), urls = tileKeys(a);
  let i = 0, failed = 0, lastUi = 0; a.done = 0;
  const worker = async () => {
    while (i < urls.length) {
      const u = urls[i++];
      try {
        if (!(await cache.match(u))) {
          const r = await fetch(u);
          if (!r.ok) throw new Error(r.status);
          await cache.put(u, r);
        }
        a.done++;
      } catch (e) {
        failed++;
        if (e?.name === 'QuotaExceededError') { i = urls.length; a.error = 'Phone storage full'; }
      }
      if (Date.now() - lastUi > 1000) { lastUi = Date.now(); await db.put('offline', a); if (!$('#sheet').hidden && $('#sheet-title').textContent === 'Offline maps') offlineSheet(); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  a.status = failed ? 'failed' : 'complete';
  await db.put('offline', a);
  if (!$('#sheet').hidden && $('#sheet-title').textContent === 'Offline maps') offlineSheet();
}

// ---------- misc controls ----------
$('#btn-locate').onclick = () => geo.trigger();
$('#btn-north').onclick = () => map.easeTo({ bearing: 0, pitch: 0 });
const net = () => { $('#net').hidden = navigator.onLine; };
addEventListener('online', net); addEventListener('offline', net); net();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
