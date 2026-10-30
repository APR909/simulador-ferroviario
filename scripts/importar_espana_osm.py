#!/usr/bin/env python3
"""Create a national railway map from Geofabrik Spain and Canary OSM PBFs.

Two streaming passes keep only selected railway node IDs in a Python set and
never index every node in the full PBF. This avoids the multi-GB dense node-ID
index used by some generic filtering commands. Pyosmium is required only to
rebuild the data; the application itself has no third-party Python dependency.

Example:
  python3 scripts/importar_espana_osm.py spain-261029.osm.pbf canary-islands-261029.osm.pbf
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

try:
    import osmium
except ImportError:
    raise SystemExit('Instala la dependencia de importación: python3 -m pip install osmium')

ROOT = Path(__file__).resolve().parent.parent
TYPES = {'rail', 'narrow_gauge', 'subway', 'light_rail', 'tram'}
STOPS = {'station', 'halt', 'tram_stop'}
SERVICE = {'yard', 'siding', 'spur', 'crossover'}


def classify(tags):
    railway = tags.get('railway')
    if railway not in TYPES:
        return None
    if railway in ('subway', 'light_rail', 'tram'):
        return 'urban'
    if railway == 'narrow_gauge':
        return 'narrow'
    # Never infer high-speed infrastructure merely from gauge or maxspeed.
    if tags.get('highspeed') == 'yes':
        return 'highspeed'
    if tags.get('service') in SERVICE:
        return 'service'
    return 'rail'


class NationalWays(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.needed = set()
        self.seen = set()

    def way(self, way):
        if way.id in self.seen:
            return
        railway = way.tags.get('railway')
        if railway not in TYPES:
            return
        tags = {tag.k: tag.v for tag in way.tags}
        group = classify(tags)
        ids = [node.ref for node in way.nodes]
        if not group or len(ids) < 2:
            return
        self.seen.add(way.id)
        self.needed.update(ids)
        # Compact schema: OSM way id, group, name, ref, maxspeed, railway, nodes.
        self.ways.append([way.id, group, str(tags.get('name', ''))[:160], str(tags.get('ref', ''))[:40],
                          str(tags.get('maxspeed', ''))[:40], railway, ids])


class NationalNodes(osmium.SimpleHandler):
    def __init__(self, needed):
        super().__init__()
        self.needed = needed
        self.nodes = {}
        self.stations = []
        self.seen_stations = set()

    def node(self, node):
        if not node.location.valid():
            return
        if node.id in self.needed:
            self.nodes[node.id] = [round(node.location.lat, 5), round(node.location.lon, 5)]
        if len(node.tags) and node.id not in self.seen_stations:
            kind = node.tags.get('railway')
            if kind in STOPS:
                name = node.tags.get('name')
                if name:
                    self.seen_stations.add(node.id)
                    self.stations.append([node.id, round(node.location.lat, 5), round(node.location.lon, 5),
                                          str(name)[:120], str(kind)])


def make_features(ways, nodes):
    features = []
    missing = 0
    for way in ways:
        chunk = []
        for node_id in way[6]:
            point = nodes.get(node_id)
            if point is None:
                missing += 1
                if len(chunk) >= 2:
                    features.append(way[:6] + [chunk])
                chunk = []
                continue
            if not chunk or point != chunk[-1]:
                chunk.append(point)
        if len(chunk) >= 2:
            features.append(way[:6] + [chunk])
    return features, missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pbf', nargs='+', help='Extractos PBF con vías y nodos')
    parser.add_argument('--date', default='2026-10-29', help='Fecha de la instantánea OSM')
    parser.add_argument('--spain-source', default='https://download.geofabrik.de/europe/spain-261029.osm.pbf')
    parser.add_argument('--canary-source', default='https://download.geofabrik.de/africa/canary-islands-261029.osm.pbf')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/espana-osm.json')
    args = parser.parse_args()
    ways = NationalWays()
    for filename in args.pbf:
        ways.apply_file(filename)
    print(f'Primera pasada: {len(ways.ways):,} vías, {len(ways.needed):,} nodos necesarios.', flush=True)
    nodes = NationalNodes(ways.needed)
    for filename in args.pbf:
        nodes.apply_file(filename)
    print(f'Segunda pasada: {len(nodes.nodes):,} nodos obtenidos, {len(nodes.stations):,} paradas con nombre.', flush=True)
    features, missing = make_features(ways.ways, nodes.nodes)
    if not features:
        raise SystemExit('No se han encontrado vías completas.')
    counts = Counter(feature[1] for feature in features)
    output = {
        'source': 'OpenStreetMap contributors · extractos Geofabrik España y Canarias',
        'source_date': args.date,
        'created_utc': datetime.now(timezone.utc).isoformat(),
        'source_urls': [args.spain_source, args.canary_source],
        'attribution': '© OpenStreetMap contributors',
        'license': 'ODbL 1.0',
        'schema': ['osm_way_id','group','name','ref','maxspeed','railway','lat_lon_points'],
        'counts': dict(counts),
        'missing_node_references': missing,
        'features': features,
        'stations': nodes.stations,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{args.output}: {len(features):,} fragmentos, {len(nodes.stations):,} paradas, '
          f'{missing} referencias ausentes; {dict(counts)}; {args.output.stat().st_size:,} bytes', flush=True)


if __name__ == '__main__':
    main()
