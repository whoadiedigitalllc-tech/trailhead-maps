// Self-check for geo.js: node web/geo.test.mjs
import assert from 'node:assert/strict';
import { haversine, lineLength, ringArea, trackStats, lonLatToTile, tilesInBbox, fmt, toGpx } from './geo.js';

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// 1 degree of latitude ≈ 111.2 km
near(haversine([-91, 30], [-91, 31]), 111195, 50);
near(lineLength([[-91, 30], [-91, 30.5], [-91, 31]]), 111195, 50);

// ~1 km square near Baton Rouge ≈ 1,000,000 m² (247 ac)
const dLat = 1000 / 111195, dLon = dLat / Math.cos(30.45 * Math.PI / 180);
const sq = [[-91.1, 30.45], [-91.1 + dLon, 30.45], [-91.1 + dLon, 30.45 + dLat], [-91.1, 30.45 + dLat]];
near(ringArea(sq), 1e6, 5000);
assert.equal(ringArea(sq.slice(0, 2)), 0);

// Elevation noise under 3 m is ignored, real climbs count
const pts = [0, 1, -1, 2, 10, 9, 20, 5].map((ele, i) => ({ lon: -91, lat: 30 + i * 1e-4, ele, t: i * 1000 }));
const s = trackStats(pts);
near(s.gain, 20, 0.01);
near(s.loss, 15, 0.01);
assert.equal(s.secs, 7);

// Tiles: z0 is one tile; known tile for Baton Rouge at z10
assert.deepEqual(lonLatToTile(-91.15, 30.45, 0), [0, 0]);
assert.deepEqual(lonLatToTile(-91.15, 30.45, 10), [252, 420]);
assert.equal(tilesInBbox([-91.16, 30.46, -91.15, 30.48], 10, 10).length, 1);
assert.equal(tilesInBbox([-91.2, 30.4, -91.1, 30.5], 10, 10).length, 2); // crosses a tile row edge
assert.ok(tilesInBbox([-91.2, 30.4, -91.1, 30.5], 10, 14).length > 20);

assert.equal(fmt.duration(3725), '1:02:05');
assert.equal(fmt.acres(4046.856), '1.0 ac');
assert.match(toGpx({ kind: 'waypoint', name: 'A<b>', geom: [-91, 30] }), /<wpt lat="30" lon="-91"><name>A&#60;b&#62;<\/name>/);

console.log('geo.js: all checks passed');
