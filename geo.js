// Pure geometry/format helpers. No DOM, so geo.test.mjs can run them in Node.
const R = 6371008.8; // mean Earth radius, m
const rad = d => d * Math.PI / 180;

/** Great-circle distance in metres between [lon, lat] points. */
export function haversine([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function lineLength(coords) {
  let m = 0;
  for (let i = 1; i < coords.length; i++) m += haversine(coords[i - 1], coords[i]);
  return m;
}

/** Spherical polygon area in m² for a ring of [lon, lat] (open or closed). */
export function ringArea(ring) {
  if (ring.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    s += rad(x2 - x1) * (2 + Math.sin(rad(y1)) + Math.sin(rad(y2)));
  }
  return Math.abs(s * R * R / 2);
}

/** Track stats from points [{lon, lat, ele, t, acc}]. Elevation uses 3 m hysteresis so GPS noise doesn't pile up. */
export function trackStats(points) {
  let dist = 0, gain = 0, loss = 0, ref = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (i) dist += haversine([points[i - 1].lon, points[i - 1].lat], [p.lon, p.lat]);
    if (p.ele == null) continue;
    if (ref == null) ref = p.ele;
    else if (p.ele - ref >= 3) { gain += p.ele - ref; ref = p.ele; }
    else if (ref - p.ele >= 3) { loss += ref - p.ele; ref = p.ele; }
  }
  const secs = points.length > 1 ? (points.at(-1).t - points[0].t) / 1000 : 0;
  return { dist, gain, loss, secs, speed: secs ? dist / secs : 0 };
}

/** Slippy-map tile x/y for a lon/lat at zoom z. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * n);
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)];
}

/** Every [z, x, y] covering bbox [w, s, e, n] for zooms minZ..maxZ. */
export function tilesInBbox([w, s, e, n], minZ, maxZ) {
  const out = [];
  for (let z = minZ; z <= maxZ; z++) {
    const [x0, y0] = lonLatToTile(w, n, z), [x1, y1] = lonLatToTile(e, s, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  }
  return out;
}

export const fmt = {
  miles: m => (m / 1609.344).toFixed(m < 16093 ? 2 : 1) + ' mi',
  feet: m => Math.round(m * 3.28084).toLocaleString() + ' ft',
  acres: m2 => (m2 / 4046.856).toFixed(m2 < 404686 ? 1 : 0) + ' ac',
  duration: s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60);
                   return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; },
  coord: ([lon, lat]) => `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
};

const esc = s => String(s ?? '').replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);

/** One saved item -> GPX 1.1 string. */
export function toGpx(item) {
  const name = `<name>${esc(item.name)}</name>`, desc = item.notes ? `<desc>${esc(item.notes)}</desc>` : '';
  let body;
  if (item.kind === 'waypoint') {
    const [lon, lat] = item.geom;
    body = `<wpt lat="${lat}" lon="${lon}">${name}${desc}</wpt>`;
  } else if (item.kind === 'track') {
    const pts = item.points.map(p => `<trkpt lat="${p.lat}" lon="${p.lon}">${p.ele != null ? `<ele>${p.ele}</ele>` : ''}<time>${new Date(p.t).toISOString()}</time></trkpt>`).join('');
    body = `<trk>${name}${desc}<trkseg>${pts}</trkseg></trk>`;
  } else {
    const ring = item.kind === 'area' ? [...item.geom, item.geom[0]] : item.geom;
    body = `<rte>${name}${desc}${ring.map(([lon, lat]) => `<rtept lat="${lat}" lon="${lon}"/>`).join('')}</rte>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Trailhead" xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;
}

/** GPX string -> list of items (waypoints, tracks, routes as lines). Uses DOMParser passed in so Node tests can skip it. */
export function fromGpx(xml, parser) {
  const doc = parser.parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid GPX file');
  const txt = (el, tag) => el.querySelector(tag)?.textContent?.trim() || '';
  const pt = el => [parseFloat(el.getAttribute('lon')), parseFloat(el.getAttribute('lat'))];
  const ok = ([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const items = [];
  for (const w of doc.querySelectorAll('wpt')) {
    const g = pt(w); if (ok(g)) items.push({ kind: 'waypoint', name: txt(w, 'name') || 'Imported point', notes: txt(w, 'desc'), geom: g });
  }
  for (const t of doc.querySelectorAll('trk')) {
    const points = [...t.querySelectorAll('trkpt')].map(p => {
      const [lon, lat] = pt(p), ele = parseFloat(txt(p, 'ele')), time = Date.parse(txt(p, 'time'));
      return { lon, lat, ele: Number.isFinite(ele) ? ele : null, t: Number.isFinite(time) ? time : 0 };
    }).filter(p => ok([p.lon, p.lat]));
    if (points.length > 1) items.push({ kind: 'track', name: txt(t, 'name') || 'Imported track', notes: '', points });
  }
  for (const r of doc.querySelectorAll('rte')) {
    const geom = [...r.querySelectorAll('rtept')].map(pt).filter(ok);
    if (geom.length > 1) items.push({ kind: 'line', name: txt(r, 'name') || 'Imported route', notes: '', geom });
  }
  return items;
}
