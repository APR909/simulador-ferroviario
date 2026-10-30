#!/usr/bin/env python3
"""Añade atributos de vías y extrae señales, agujas, cruces e hitos de OSM.

Entrada recomendada: PBF pequeños prefiltrados con osmium tags-filter -R.
Las vías deben corresponder a los mismos extractos y fecha que espana-osm.json.
No se deducen estados en tiempo real ni se validan instalaciones operativas.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

try:
    import osmium
except ImportError:
    raise SystemExit('Instala PyOsmium: python3 -m pip install osmium')

ROOT = Path(__file__).resolve().parent.parent
WAY_KEYS = {
    'gauge','electrified','voltage','frequency','usage','service','operator','owner',
    'maxspeed:forward','maxspeed:backward','tracks','passenger_lines','highspeed',
    'bridge','tunnel','layer','location','start_date','railway:track_ref',
    'railway:asfa','railway:asfa_200','railway:etcs','railway:lzb','railway:pzb',
    'railway:ato','railway:atc','railway:atp','railway:traffic_mode',
    'railway:bidirectional','railway:preferred_direction','construction:railway:etcs',
}
NODE_KINDS = {'signal','switch','level_crossing','crossing','milestone'}
NODE_KEYS = {'railway','name','ref','operator','network','railway:position',
             'railway:position:exact','railway:turnout_side','railway:local_operated',
             'railway:switch','direction','side','crossing','highway','supervised'}
NODE_PREFIXES = ('railway:signal:', 'railway:switch:', 'crossing:')


def safe_value(value):
    return str(value).strip()[:240]


class WayDetails(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.details = {}

    def way(self, way):
        if way.id in self.details:
            return
        values = {tag.k: safe_value(tag.v) for tag in way.tags if tag.k in WAY_KEYS and tag.v}
        self.details[way.id] = values


class Infrastructure(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.features = []
        self.seen = set()

    def node(self, node):
        kind = node.tags.get('railway')
        if kind not in NODE_KINDS or node.id in self.seen or not node.location.valid():
            return
        self.seen.add(node.id)
        tags = {tag.k: safe_value(tag.v) for tag in node.tags
                if (tag.k in NODE_KEYS or tag.k.startswith(NODE_PREFIXES)) and tag.v}
        self.features.append([node.id, round(node.location.lat, 7), round(node.location.lon, 7), kind, tags])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ways', nargs='+', required=True, help='PBF filtrados que contienen vías OSM')
    parser.add_argument('--nodes', nargs='+', required=True, help='PBF filtrados que contienen nodos de infraestructura')
    parser.add_argument('--date', default='2026-10-29', help='Fecha OSM, igual a la red nacional')
    parser.add_argument('--network', type=Path, default=ROOT/'data/espana-osm.json')
    parser.add_argument('--output', type=Path, default=ROOT/'data/infraestructura-osm.json')
    args = parser.parse_args()
    network = json.loads(args.network.read_text(encoding='utf-8'))
    if network.get('source_date') != args.date:
        raise SystemExit('La fecha no coincide con la red nacional; usa la misma instantánea.')
    ways = WayDetails()
    for filename in args.ways:
        ways.apply_file(filename)
    updated = missing = 0
    for feature in network['features']:
        detail = ways.details.get(feature[0])
        if detail is None:
            detail = {}
            missing += 1
        if len(feature) >= 8:
            feature[7] = detail
        else:
            feature.append(detail)
        updated += bool(detail)
    if missing:
        raise SystemExit(f'Faltan etiquetas para {missing} vías; no se modificó el archivo nacional.')
    network['schema'] = ['osm_way_id','group','name','ref','maxspeed','railway','lat_lon_points','tags']
    network['details_source_date'] = args.date
    nodes = Infrastructure()
    for filename in args.nodes:
        nodes.apply_file(filename)
    counts = dict(Counter(feature[3] for feature in nodes.features))
    data = {
        'source': 'OpenStreetMap contributors · extractos Geofabrik España y Canarias',
        'source_date': args.date,
        'source_urls': network.get('source_urls', []),
        'created_utc': datetime.now(timezone.utc).isoformat(),
        'attribution': '© OpenStreetMap contributors', 'license': 'ODbL 1.0',
        'schema': ['osm_node_id','latitude','longitude','railway','tags'],
        'counts': counts, 'features': nodes.features,
    }
    # Both files are written only after all inputs and matching IDs were checked.
    args.network.write_text(json.dumps(network, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{updated:,} vías con atributos; {len(nodes.features):,} nodos de infraestructura: {counts}')
    print(f'Red: {args.network.stat().st_size:,} bytes · Infraestructura: {args.output.stat().st_size:,} bytes')


if __name__ == '__main__':
    main()
