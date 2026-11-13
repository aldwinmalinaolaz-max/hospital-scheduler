// Route finding for the Digital Wayfinding System: shortest walking route over the map's path
// network (Dijkstra) and plain-language directions. Used by the Directory page and the tests.
(function (root) {
  const WALK_M_PER_MIN = 72; // about 1.2 m/s

  // ratio = image height / width; widthM = real width covered by the map (null if unknown)
  function makeGraph(points, paths, { stepFree = false } = {}) {
    const byId = new Map(points.map((p) => [p.id, p]));
    const adj = new Map(points.map((p) => [p.id, []]));
    for (const [a, b, ok = true] of paths) {
      if (!byId.has(a) || !byId.has(b) || (stepFree && !ok)) continue;
      adj.get(a).push(b);
      adj.get(b).push(a);
    }
    return { byId, adj };
  }

  // Distance between two points in meters (or in map units when the scale is not set)
  const distance = (p, q, ratio, widthM) => Math.hypot((q.x - p.x) / 100, ((q.y - p.y) / 100) * ratio) * (widthM || 100);

  function shortestPath(graph, from, to, ratio, widthM) {
    if (!graph.byId.has(from) || !graph.byId.has(to)) return null;
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const done = new Set();
    // Small graphs (hundreds of points): a simple scan is fast enough
    for (;;) {
      let u = null;
      for (const [id, d] of dist) if (!done.has(id) && (u === null || d < dist.get(u))) u = id;
      if (u === null) return null;
      if (u === to) break;
      done.add(u);
      // Buildings and gates are where routes start or end, never places to walk through
      // (corridors through a building are drawn with junction points)
      const kind = graph.byId.get(u).kind;
      if (u !== from && (kind === 'BUILDING' || kind === 'GATE')) continue;
      for (const v of graph.adj.get(u)) {
        const nd = dist.get(u) + distance(graph.byId.get(u), graph.byId.get(v), ratio, widthM);
        if (nd < (dist.has(v) ? dist.get(v) : Infinity)) {
          dist.set(v, nd);
          prev.set(v, u);
        }
      }
    }
    const ids = [to];
    while (ids[0] !== from) ids.unshift(prev.get(ids[0]));
    return { ids, length: dist.get(to) };
  }

  const label = (p) => (p.kind === 'BUILDING' && p.code ? `${p.name} (Bldg. ${p.code})` : p.name);
  const roundM = (m) => (m < 15 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10);

  // Turn at point b when walking a -> b -> c: degrees, right turns positive (screen y points down)
  function turnAngle(a, b, c, ratio) {
    const v1 = [b.x - a.x, (b.y - a.y) * ratio];
    const v2 = [c.x - b.x, (c.y - b.y) * ratio];
    const cross = v1[0] * v2[1] - v1[1] * v2[0];
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    return (Math.atan2(cross, dot) * 180) / Math.PI;
  }
  function turnWords(deg) {
    const side = deg > 0 ? 'right' : 'left';
    const a = Math.abs(deg);
    if (a < 35) return null;
    if (a < 60) return `bear ${side}`;
    if (a < 140) return `turn ${side}`;
    return `turn sharply ${side}`;
  }

  // The closest named building or landmark to an unnamed junction (to describe where to turn)
  function nearestLandmark(points, p, ratio, widthM) {
    let best = null;
    let bestD = Infinity;
    for (const q of points) {
      if (!q.name || q.map_id !== p.map_id || q.id === p.id || q.kind === 'JUNCTION') continue;
      const d = distance(p, q, ratio, widthM || 100);
      if (d < bestD) (best = q), (bestD = d);
    }
    // Only when it is close enough to help (about 25 m, or 8% of the map width)
    return bestD <= (widthM ? 25 : 8) ? best : null;
  }

  // Full route with step-by-step directions. Returns { found, ids, meters, minutes, steps } or { found: false }.
  function directions(points, paths, fromId, toId, { ratio = 1, widthM = null, stepFree = false } = {}) {
    const graph = makeGraph(points, paths, { stepFree });
    const from = graph.byId.get(fromId);
    const to = graph.byId.get(toId);
    if (!from || !to) return { found: false };
    if (fromId === toId) return { found: true, ids: [fromId], meters: 0, minutes: 0, steps: [`You are already at ${label(to)}.`] };
    const r = shortestPath(graph, fromId, toId, ratio, widthM);
    if (!r) return { found: false };
    const pts = r.ids.map((id) => graph.byId.get(id));
    const len = (i) => distance(pts[i], pts[i + 1], ratio, widthM);
    const walk = (m) => (widthM ? `Walk about ${roundM(m)} m` : 'Walk');
    const steps = [`Start at ${label(from)}.`];
    let run = 0;
    let passing = [];
    for (let i = 1; i < pts.length - 1; i++) {
      run += len(i - 1);
      const p = pts[i];
      const words = turnWords(turnAngle(pts[i - 1], p, pts[i + 1], ratio));
      if (words) {
        const near = !p.name && nearestLandmark(points, p, ratio, widthM);
        const at = p.name ? `at ${label(p)}` : near ? `at the junction near ${label(near)}` : 'at the junction';
        steps.push(`${walk(run)}${passing.length ? `, passing ${passing.join(', ')}` : ''}, then ${words} ${at}.`);
        run = 0;
        passing = [];
      } else if (p.name && p.kind !== 'JUNCTION') passing.push(label(p));
    }
    run += len(pts.length - 2);
    steps.push(`${walk(run)}${passing.length ? `, passing ${passing.join(', ')}` : ''} to ${label(to)}. You have arrived.`);
    const meters = widthM ? Math.round(r.length) : null;
    return { found: true, ids: r.ids, meters, minutes: meters === null ? null : Math.max(1, Math.round(meters / WALK_M_PER_MIN)), steps };
  }

  const api = { directions, makeGraph, shortestPath, turnAngle, label };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Wayfind = api;
})(typeof window !== 'undefined' ? window : globalThis);
