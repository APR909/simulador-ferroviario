/** Geometry on WGS84. Distances along the sample are calculated in metres. */
export function haversine(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

export function makeRoute(graph, nodeIds) {
  if (nodeIds.length < 2) throw new Error('El recorrido necesita al menos dos nodos.');
  const points = [];
  let length = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    const node = graph.nodes.get(String(nodeIds[i]));
    if (!node) throw new Error('Falta un nodo de la ruta.');
    if (i > 0) {
      const previousId = String(nodeIds[i - 1]);
      const connected = (graph.adj.get(previousId) || []).some(edge => edge.to === String(nodeIds[i]));
      if (!connected) throw new Error('La ruta contiene nodos no conectados.');
      length += haversine(points[i - 1], node);
    }
    points.push({ id: String(nodeIds[i]), lat: node.lat, lon: node.lon, distance: length });
  }
  return { nodeIds: nodeIds.map(String), points, length };
}

export function pointAt(route, distance) {
  const s = Math.max(0, Math.min(route.length, distance));
  const pts = route.points;
  if (s <= 0) return [pts[0].lat, pts[0].lon];
  for (let i = 1; i < pts.length; i++) {
    if (s <= pts[i].distance || i === pts.length - 1) {
      const a = pts[i - 1], b = pts[i];
      const size = b.distance - a.distance;
      const t = size > 0 ? Math.max(0, Math.min(1, (s - a.distance) / size)) : 0;
      return [a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)];
    }
  }
  return [pts[pts.length - 1].lat, pts[pts.length - 1].lon];
}

export function sliceRoute(route, start, end) {
  const a = Math.max(0, Math.min(route.length, start));
  const b = Math.max(a, Math.min(route.length, end));
  const result = [pointAt(route, a)];
  for (const point of route.points) {
    if (point.distance > a && point.distance < b) result.push([point.lat, point.lon]);
  }
  result.push(pointAt(route, b));
  return result;
}
