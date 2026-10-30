import { haversine } from './geo.js';

/** Supported physical transport tracks. Planned/disused features are excluded. */
export const RAILWAY_TYPES = new Set(['rail', 'subway', 'light_rail', 'tram', 'narrow_gauge']);

/**
 * Read the bundled extract or an Overpass JSON response. Connectivity is by
 * OSM node identity, never by coordinates or visually intersecting lines. The
 * result is a geometric graph, not an operationally validated railway model.
 */
export function buildGraph(data) {
  const allNodes = new Map();
  let rawWays = [];
  if (Array.isArray(data?.elements)) {
    for (const element of data.elements) {
      if (element.type === 'node' && Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
        allNodes.set(String(element.id), { id: String(element.id), lat: element.lat, lon: element.lon, tags: element.tags || {} });
      } else if (element.type === 'way' && RAILWAY_TYPES.has(element.tags?.railway)) {
        rawWays.push(element);
      }
    }
  } else if (data?.nodes && Array.isArray(data.ways)) {
    for (const [id, node] of Object.entries(data.nodes)) {
      if (Number.isFinite(node.lat) && Number.isFinite(node.lon)) {
        allNodes.set(String(id), { id: String(id), lat: node.lat, lon: node.lon, tags: node.tags || {} });
      }
    }
    rawWays = data.ways.filter(way => RAILWAY_TYPES.has(way.tags?.railway));
  } else {
    throw new Error('Formato no reconocido: se espera JSON de Overpass con elements, o el extracto incluido.');
  }
  if (!rawWays.length) throw new Error('No se encontraron vías railway=rail, subway, light_rail, tram o narrow_gauge.');

  const adj = new Map();
  const nodes = new Map();
  const edges = new Map();
  const lines = [], lineRecords = [];
  const addLine = (points, way) => {
    if (points.length < 2) return;
    lines.push(points);
    lineRecords.push({ points, tags: way.tags || {}, wayId: String(way.id) });
  };
  let missingReferences = 0;
  const addNode = node => {
    nodes.set(node.id, node);
    if (!adj.has(node.id)) adj.set(node.id, []);
  };
  for (const way of rawWays) {
    if (!Array.isArray(way.nodes)) continue;
    let currentLine = [];
    for (let i = 0; i < way.nodes.length; i++) {
      const id = String(way.nodes[i]);
      const node = allNodes.get(id);
      if (!node) {
        missingReferences++;
        addLine(currentLine, way);
        currentLine = [];
        continue;
      }
      addNode(node);
      currentLine.push([node.lat, node.lon]);
      if (i === 0) continue;
      const previousId = String(way.nodes[i - 1]);
      const previous = allNodes.get(previousId);
      if (!previous || previousId === id) continue;
      addNode(previous);
      const length = haversine(previous, node);
      if (length < 0.001) continue;
      const key = [previousId, id].sort().join(':');
      if (edges.has(key)) continue;
      const edge = { id: key, a: previousId, b: id, length, wayId: String(way.id), tags: way.tags || {} };
      edges.set(key, edge);
      adj.get(previousId).push({ to: id, length, edgeId: key });
      adj.get(id).push({ to: previousId, length, edgeId: key });
    }
    addLine(currentLine, way);
  }
  if (!edges.size) throw new Error('No hay tramos completos: exporta los ways y todos sus nodos.');
  return { nodes, edges, adj, lines, lineRecords, wayCount: rawWays.length, missingReferences };
}

class MinHeap {
  constructor() { this.items = []; }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = Math.floor((i - 1) / 2);
      if (a[p].distance <= item.distance) break;
      a[i] = a[p]; i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items;
    if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        let left = 2 * i + 1, right = left + 1;
        if (left >= a.length) break;
        let child = right < a.length && a[right].distance < a[left].distance ? right : left;
        if (a[child].distance >= last.distance) break;
        a[i] = a[child]; i = child;
      }
      a[i] = last;
    }
    return top;
  }
  get size() { return this.items.length; }
}

/** Dijkstra over undirected rail geometry. This is NOT an operational route validator. */
export function shortestPath(graph, origin, destination) {
  origin = String(origin); destination = String(destination);
  if (!graph.adj.has(origin) || !graph.adj.has(destination)) return null;
  const distances = new Map([[origin, 0]]), previous = new Map(), queue = new MinHeap();
  queue.push({ node: origin, distance: 0 });
  while (queue.size) {
    const { node, distance } = queue.pop();
    if (distance !== distances.get(node)) continue;
    if (node === destination) break;
    for (const edge of graph.adj.get(node) || []) {
      const candidate = distance + edge.length;
      if (candidate < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, candidate);
        previous.set(edge.to, node);
        queue.push({ node: edge.to, distance: candidate });
      }
    }
  }
  if (!distances.has(destination)) return null;
  const path = [];
  for (let current = destination; current !== undefined; current = previous.get(current)) {
    path.push(current);
    if (current === origin) break;
  }
  return path.reverse();
}
