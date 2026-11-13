// Digital wayfinding: a network of points (gates, buildings, landmarks, path junctions) and the
// walkable paths between them, drawn on a Directory map. Visitors pick where they are and where
// they want to go; the route is worked out in their browser (public/js/wayfind.js).
const fs = require('node:fs');
const path = require('node:path');
const { imageType } = require('./directory');

const KINDS = ['GATE', 'BUILDING', 'LANDMARK', 'JUNCTION'];
const MAX_POINTS = 1500;

const clean = (v, max = 120) => String(v ?? '').trim().replace(/\s+/g, ' ').toUpperCase().slice(0, max);
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

// Everything visitors need for directions, for all maps
async function publicGraph(db) {
  const [points, paths] = await Promise.all([
    db.query('SELECT id, map_id, name, code, kind, x, y, is_start FROM way_points ORDER BY map_id, id'),
    db.query('SELECT a_id, b_id, step_free FROM way_paths ORDER BY id'),
  ]);
  return {
    points: points.map((p) => ({ ...p, x: Number(p.x), y: Number(p.y) })),
    paths: paths.map((p) => [p.a_id, p.b_id, p.step_free]),
  };
}

async function mapGraph(db, mapId) {
  const [points, paths, entries] = await Promise.all([
    db.query('SELECT id, name, code, kind, x, y, is_start FROM way_points WHERE map_id = $1 ORDER BY id', [mapId]),
    db.query('SELECT a_id, b_id, step_free FROM way_paths WHERE map_id = $1 ORDER BY id', [mapId]),
    db.query('SELECT id, name, category, way_point_id FROM directory_entries ORDER BY sort_order, name'),
  ]);
  return {
    points: points.map((p) => ({ ...p, x: Number(p.x), y: Number(p.y) })),
    paths: paths.map((p) => ({ a: p.a_id, b: p.b_id, step_free: p.step_free })),
    entries,
  };
}

// Checks a whole network sent by the editor. Points keep their id, or have a temporary
// `tmp` key when new; paths refer to either. Returns [value, error].
function cleanGraph(b) {
  const points = Array.isArray(b.points) ? b.points : null;
  const paths = Array.isArray(b.paths) ? b.paths : null;
  if (!points || !paths) return [null, 'Invalid wayfinding data.'];
  if (points.length > MAX_POINTS) return [null, `At most ${MAX_POINTS} points per map.`];
  const widthM = b.width_m === '' || b.width_m === null || b.width_m === undefined ? null : num(b.width_m);
  if (widthM !== null && !(widthM >= 5 && widthM <= 20000)) return [null, 'The map width must be 5 to 20,000 meters (or blank).'];
  const keys = new Set();
  const out = [];
  for (const p of points) {
    const key = p.id ? `id:${p.id}` : `tmp:${p.tmp}`;
    if ((!p.id && !p.tmp) || keys.has(key)) return [null, 'Invalid point in the wayfinding data.'];
    keys.add(key);
    const x = num(p.x);
    const y = num(p.y);
    if (!(x >= 0 && x <= 100 && y >= 0 && y <= 100)) return [null, 'A point is outside the map.'];
    const kind = KINDS.includes(p.kind) ? p.kind : 'JUNCTION';
    const name = clean(p.name);
    if (kind !== 'JUNCTION' && !name) return [null, `Every ${kind.toLowerCase()} needs a name.`];
    out.push({ key, id: p.id ? Number(p.id) : null, name: name || null, code: clean(p.code, 10) || null, kind, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, is_start: !!p.is_start && !!name });
  }
  const seen = new Set();
  const edges = [];
  for (const e of paths) {
    const a = e.a_key || (e.a ? `id:${e.a}` : null);
    const c = e.b_key || (e.b ? `id:${e.b}` : null);
    if (!keys.has(a) || !keys.has(c) || a === c) return [null, 'A path connects a point that does not exist.'];
    const pair = [a, c].sort().join('|');
    if (seen.has(pair)) continue;
    seen.add(pair);
    edges.push({ a, b: c, step_free: e.step_free !== false });
  }
  const links = Array.isArray(b.links) ? b.links : [];
  for (const l of links) {
    if (!Number.isInteger(Number(l.entry_id)) || (l.point && !keys.has(l.point))) return [null, 'Invalid directory link.'];
  }
  return [{ widthM, points: out, paths: edges, links }, null];
}

// Saves a cleaned network for a map: updates kept points, adds new ones, deletes removed ones
// (their paths go with them) and rebuilds the paths
async function saveGraph(t, mapId, g, by) {
  const existing = new Set((await t.query('SELECT id FROM way_points WHERE map_id = $1', [mapId])).map((r) => r.id));
  const idOf = new Map();
  for (const p of g.points) {
    if (p.id && !existing.has(p.id)) throw Object.assign(new Error('A point belongs to another map.'), { validation: true });
    let id = p.id;
    if (id) {
      await t.query('UPDATE way_points SET name = $1, code = $2, kind = $3, x = $4, y = $5, is_start = $6, updated_by = $7, updated_at = now() WHERE id = $8', [
        p.name, p.code, p.kind, p.x, p.y, p.is_start, by, id,
      ]);
    } else {
      id = (await t.one('INSERT INTO way_points (map_id, name, code, kind, x, y, is_start, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [
        mapId, p.name, p.code, p.kind, p.x, p.y, p.is_start, by,
      ])).id;
    }
    idOf.set(p.key, id);
  }
  const keep = [...idOf.values()];
  await t.query('DELETE FROM way_points WHERE map_id = $1 AND NOT (id = ANY($2::int[]))', [mapId, keep]);
  await t.query('DELETE FROM way_paths WHERE map_id = $1', [mapId]);
  for (const e of g.paths) {
    await t.query('INSERT INTO way_paths (map_id, a_id, b_id, step_free) VALUES ($1, $2, $3, $4)', [mapId, idOf.get(e.a), idOf.get(e.b), e.step_free]);
  }
  for (const l of g.links) {
    const pid = l.point ? idOf.get(l.point) : null;
    // Only links to points on this map are changed here
    await t.query(
      `UPDATE directory_entries SET way_point_id = $1 WHERE id = $2
         AND (way_point_id IS NULL OR way_point_id IN (SELECT id FROM way_points WHERE map_id = $3) OR $1::int IS NOT NULL)`,
      [pid, Number(l.entry_id), mapId],
    );
  }
  await t.query('UPDATE maps SET width_m = $1 WHERE id = $2', [g.widthM, mapId]);
  return idOf;
}

// Loads the campus map and its starting network into a database that has none (one time)
async function seedCampus(t, seed = require('./wayfinding-seed')) {
  if (await t.one('SELECT 1 FROM maps WHERE title = $1', [seed.title])) return false;
  let image;
  try {
    image = fs.readFileSync(path.join(__dirname, '..', seed.image));
  } catch {
    console.warn(`Wayfinding: ${seed.image} not found; the campus map was not added.`);
    return false;
  }
  const map = await t.one('INSERT INTO maps (title, description, image, mime, sort_order, width_m) VALUES ($1, $2, $3, $4, 1, $5) RETURNING id', [
    seed.title, seed.description, image, imageType(image) || 'image/jpeg', seed.width_m,
  ]);
  const ids = new Map();
  for (const p of seed.points) {
    ids.set(p.key, (await t.one('INSERT INTO way_points (map_id, name, code, kind, x, y, is_start, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id', [
      map.id, p.name || null, p.code, p.kind, p.x, p.y, p.is_start, 'system',
    ])).id);
  }
  for (const [a, b, stepFree = true] of seed.paths) {
    await t.query('INSERT INTO way_paths (map_id, a_id, b_id, step_free) VALUES ($1, $2, $3, $4)', [map.id, ids.get(a), ids.get(b), stepFree]);
  }
  for (const [name, code] of Object.entries(seed.links)) {
    const where = name === 'OPD_CLINICS' ? "category = 'OPD Clinic'" : 'name = $2';
    await t.query(`UPDATE directory_entries SET way_point_id = $1 WHERE way_point_id IS NULL AND ${where}`, name === 'OPD_CLINICS' ? [ids.get(code)] : [ids.get(code), name]);
  }
  return true;
}

module.exports = { KINDS, publicGraph, mapGraph, cleanGraph, saveGraph, seedCampus };
