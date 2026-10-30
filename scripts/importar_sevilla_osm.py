#!/usr/bin/env python3
"""Build the bundled Seville-area track extract from a regional OSM PBF.

Requires Python package 'osmium' only when rebuilding the data. Runtime has no
third-party Python dependencies. All OSM node IDs are preserved so route
connectivity is based on shared nodes, not visual crossings.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

try:
    import osmium
except ImportError:
    raise SystemExit('Instala la dependencia de importación: python3 -m pip install osmium')

# A deliberately documented rectangle, not an official administrative boundary.
BBOX = {'west': -6.28, 'south': 37.14, 'east': -5.68, 'north': 37.60}
# The park's small monorail attraction is not part of the requested networks.
RAIL_TYPES = {'rail', 'subway', 'light_rail', 'tram', 'narrow_gauge'}
STATION_TYPES = {'station', 'halt', 'tram_stop'}


def inside(lat, lon):
    return BBOX['south'] <= lat <= BBOX['north'] and BBOX['west'] <= lon <= BBOX['east']


def intersects(a, b):
    """Liang-Barsky line-segment/rectangle intersection in lon/lat."""
    x0, y0, x1, y1 = a['lon'], a['lat'], b['lon'], b['lat']
    dx, dy = x1 - x0, y1 - y0
    low, high = 0.0, 1.0
    for p, q in ((-dx, x0 - BBOX['west']), (dx, BBOX['east'] - x0),
                 (-dy, y0 - BBOX['south']), (dy, BBOX['north'] - y0)):
        if p == 0:
            if q < 0:
                return False
            continue
        r = q / p
        if p < 0:
            low = max(low, r)
        else:
            high = min(high, r)
        if low > high:
            return False
    return True


class CollectWays(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.needed = set()

    def way(self, way):
        tags = {tag.k: tag.v for tag in way.tags}
        if tags.get('railway') not in RAIL_TYPES:
            return
        nodes = [int(node.ref) for node in way.nodes]
        if len(nodes) < 2:
            return
        self.ways.append({'id': way.id, 'nodes': nodes, 'tags': tags})
        self.needed.update(nodes)


class CollectNodes(osmium.SimpleHandler):
    def __init__(self, needed):
        super().__init__()
        self.needed = needed
        self.nodes = {}
        self.stations = []

    def node(self, node):
        if not node.location.valid():
            return
        lat, lon = node.location.lat, node.location.lon
        if node.id in self.needed:
            value = {'lat': lat, 'lon': lon}
            # Switches and crossings are useful for inspection, but retain no
            # unrelated metadata or OSM contributor identifiers.
            tags = {tag.k: tag.v for tag in node.tags}
            if tags:
                value['tags'] = tags
            self.nodes[int(node.id)] = value
        # Do not retain unnamed signalling stops.
        railway = node.tags.get('railway')
        name = node.tags.get('name')
        if railway in STATION_TYPES and name and inside(lat, lon):
            tags = {tag.k: tag.v for tag in node.tags
                    if tag.k in ('railway', 'name', 'ref', 'network', 'operator', 'station', 'subway', 'train', 'tram', 'light_rail')}
            self.stations.append({'id': int(node.id), 'lat': lat, 'lon': lon, 'tags': tags})


def trim_ways(ways, nodes):
    selected = []
    used = set()
    for way in ways:
        chunk = []
        for a_id, b_id in zip(way['nodes'], way['nodes'][1:]):
            a, b = nodes.get(a_id), nodes.get(b_id)
            include = bool(a and b and intersects(a, b))
            if include:
                if not chunk:
                    chunk = [a_id]
                chunk.append(b_id)
            elif chunk:
                selected.append({**way, 'nodes': chunk})
                used.update(chunk)
                chunk = []
        if chunk:
            selected.append({**way, 'nodes': chunk})
            used.update(chunk)
    return selected, used


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', help='Extracto regional .osm.pbf de Andalucía')
    parser.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'data/sevilla-osm.json'))
    parser.add_argument('--source-url', default='https://download.geofabrik.de/europe/spain/andalucia-latest.osm.pbf')
    parser.add_argument('--source-date', default=None, help='Fecha de la instantánea OSM, si se conoce (AAAA-MM-DD)')
    args = parser.parse_args()
    ways_handler = CollectWays()
    ways_handler.apply_file(args.pbf)
    print(f"Andalucía: {len(ways_handler.ways)} vías ferroviarias, {len(ways_handler.needed)} nodos referenciados", file=sys.stderr)
    nodes_handler = CollectNodes(ways_handler.needed)
    nodes_handler.apply_file(args.pbf)
    ways, used = trim_ways(ways_handler.ways, nodes_handler.nodes)
    if not ways:
        raise SystemExit('No se encontraron vías en el rectángulo indicado.')
    data = {
        'source': 'OpenStreetMap contributors via Geofabrik Andalucía extract',
        'source_url': args.source_url,
        'source_date': args.source_date,
        'created_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'attribution': '© OpenStreetMap contributors',
        'url': 'https://www.openstreetmap.org/copyright',
        'license': 'ODbL 1.0',
        'bbox': BBOX,
        'railway_types': sorted(RAIL_TYPES),
        'nodes': {str(node_id): nodes_handler.nodes[node_id] for node_id in sorted(used)},
        'ways': ways,
        'stations': nodes_handler.stations,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f"Sevilla: {len(ways)} fragmentos de vías, {len(used)} nodos, {len(nodes_handler.stations)} estaciones/paradas; {out.stat().st_size:,} bytes", file=sys.stderr)
    print('Tipos: ' + str(dict(Counter(w['tags']['railway'] for w in ways))), file=sys.stderr)
    print('Estaciones: ' + ', '.join(s['tags']['name'] for s in nodes_handler.stations[:30]), file=sys.stderr)


if __name__ == '__main__':
    main()
