#!/usr/bin/env python3
"""Checks real geometry invariants: valid shapes, references and open doorways."""
import json
import math
from pathlib import Path
from collections import Counter
from shapely.geometry import Polygon, LineString
from shapely.ops import unary_union

ROOT=Path(__file__).resolve().parents[1]
manifest=json.loads((ROOT/'public/data/manifest.json').read_text())
search=json.loads((ROOT/'public/data/search-index.json').read_text())
assert len(manifest['campuses'])==4
assert sum(len(c['floors']) for c in manifest['campuses'])==23
assert len(search)==2659
report={'floors':[]};totals=Counter();floor_ids=set()
for campus in manifest['campuses']:
    for summary in campus['floors']:
        data=json.loads((ROOT/'public'/summary['url'].lstrip('/')).read_text())
        floor_ids.add(data['id']);invalid=[]
        for p in data['polygons']:
            if not Polygon(p['points'],p['holes']).is_valid:invalid.append(p['id'])
        for p in data['footprints']+data['exteriorFootprints']:
            assert Polygon(p['points'],p['holes']).is_valid
        walls=unary_union([LineString([w['a'],w['b']]) for w in data['walls']])
        blocked=[]
        for door in data['doors']:
            a,b=door['a'],door['b']
            aa=[a[k]+(b[k]-a[k])*.1 for k in range(2)]
            bb=[a[k]+(b[k]-a[k])*.9 for k in range(2)]
            overlap=walls.intersection(LineString([aa,bb]).buffer(.005,cap_style=2))
            if overlap.length>.02:blocked.append(door['id'])
        row={'id':data['id'],'polygons':len(data['polygons']),'walls':len(data['walls']),
             'doors':len(data['doors']),'invalidSerializedPolygons':invalid,'doorOpeningConflicts':blocked}
        report['floors'].append(row);totals.update({k:row[k] for k in ('polygons','walls','doors')})
        assert not invalid, invalid
        assert not blocked, blocked
assert all(r['floorId'] in floor_ids for r in search)
assert len({r['id'] for r in search})==len(search)
report['totals']=dict(totals)
(ROOT/'analysis/maps-geometry-qa.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(f'PASS: 4 campuses, 23 floors, {len(search)} objects; {dict(totals)}; no blocked doorways or invalid polygons.')
