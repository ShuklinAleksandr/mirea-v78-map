#!/usr/bin/env python3
"""Check bridge cutouts against independent native floor footprints."""
import hashlib
import json
from pathlib import Path
from shapely import set_precision
from shapely.geometry import Polygon
from shapely.ops import unary_union

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'

def union(polygons):
    return set_precision(unary_union([Polygon(p['points'],p.get('holes',[])) for p in polygons]),.0001)

def main():
    source=json.loads((DATA/'exterior-shells.json').read_text())
    report={'scope':'exterior-only bridge cuts and source floor protection','campuses':{}}
    for campus_id,campus in source['campuses'].items():
        connections=campus.get('elevatedConnections',[])
        if not connections:continue
        floor_paths=sorted((DATA/'campuses'/campus_id).glob('*.json'))
        floors={p.stem:json.loads(p.read_text()) for p in floor_paths}
        baseline=union(campus['shells'])
        displayed=union(campus['displayShells'])
        ground=union([s for s in campus['displayShells'] if s['base']==0])
        assert baseline.symmetric_difference(displayed).area<.01,'Source footprint changed'
        cutouts=[]
        results=[]
        for connection in connections:
            if connection['sourcePolygonId'].split('-')[-1] in ['27','79','35']:
                assert connection['displayStorey']==2
                assert connection['base']==3.6 and connection['top']==7.2
                assert connection['placementEvidence']['type']=='user-correction'
            elif connection['sourcePolygonId']=='v-78-floor2-area-63':
                assert connection['base']==7.2 and connection['top']==10.8,'A–B was not part of the correction'
            floor=floors[connection['floorId']]
            polygon=next(p for p in floor['polygons'] if p['id']==connection['sourcePolygonId'])
            native=union([polygon])
            other_floors=union([p for f in floors.values() if f['id']!=floor['id'] for p in f['exteriorFootprints']])
            expected=native.difference(other_floors)
            actual=union(connection['polygons'])
            assert expected.symmetric_difference(actual).area<.001,connection['id']
            overlap=actual.intersection(other_floors).area
            assert overlap<.001,'Cut overlaps occupied source floor'
            occupied=native.intersection(other_floors)
            assert occupied.difference(ground).area<.001,'Lower source volume removed'
            roofs=union([s for s in campus['displayShells'] if abs(s['base']+s['height']-connection['top'])<.00001])
            assert actual.difference(roofs).area<.001,'Bridge roof silhouette regularized'
            # No horizontal translation or arbitrary connector rectangle: both
            # ends retain direct contact with existing source building volumes.
            contact=actual.boundary.intersection(baseline.difference(actual).boundary).length
            assert contact>1,'Connection no longer touches the native building volume'
            if connection['clearanceConfirmed']:
                cutouts.extend(connection['polygons'])
                raised=union([s for s in campus['displayShells'] if s.get('exteriorConnectionId')==connection['id']])
                assert actual.symmetric_difference(raised).area<.001
                assert actual.intersection(ground).area<.001
            else:
                assert actual.difference(ground).area<.001,'Unverified gap invented'
            results.append({'id':connection['id'],'sourceArea':round(native.area,4),
                'exclusiveArea':round(actual.area,4),'retainedOtherFloorArea':round(occupied.area,4),
                'occupiedOverlapRemoved':round(overlap,6),
                'retainedBuildingContactLength':round(contact,4),
                'base':connection['base'],'top':connection['top'],
                'clearanceRendered':connection['clearanceConfirmed']})
        assert baseline.difference(union(cutouts)).symmetric_difference(ground).area<.01
        report['campuses'][campus_id]={'checks':results,'floorSha256':{
            p.stem:hashlib.sha256(p.read_bytes()).hexdigest() for p in floor_paths},
            'exteriorFootprintDifference':round(baseline.symmetric_difference(displayed).area,6)}
    (ROOT/'analysis/exterior-connections-qa.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print('Exterior connections: exact source footprints retained; occupied other-floor geometry protected; only confirmed isolated cutouts opened.')

if __name__=='__main__':main()
