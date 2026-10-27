#!/usr/bin/env python3
"""Read a cached OSM extract and use the plan's existing approximate affine registration."""
import json, hashlib, math
from pathlib import Path
import xml.etree.ElementTree as ET
from shapely.geometry import Point, Polygon, LineString, GeometryCollection
from shapely.ops import unary_union, polygonize
from shapely import make_valid

ROOT=Path(__file__).resolve().parents[1];DATA=ROOT/'public/data';SOURCE=ROOT/'source/maps'
QUERY='https://api.openstreetmap.org/api/0.6/map?bbox=37.4745,55.6655,37.486,55.674'

def parts(g,kind='Polygon'):
    if g.is_empty:return []
    if g.geom_type==kind:return [g]
    return [p for c in getattr(g,'geoms',[]) for p in parts(c,kind)]

def serial(p):
    return {'points':[[round(x,3),round(y,3)] for x,y in list(p.exterior.coords)[:-1]],
            'holes':[[[round(x,3),round(y,3)] for x,y in list(r.coords)[:-1]] for r in p.interiors]}

def main():
    source=json.loads((SOURCE/'original/pulse/campus_v-78.json').read_text());f=source['floors'][0]
    anchor,a,b=f['anchors'];w=f['width'];h=f['height'];scale=f['meters_per_unit']
    xx=(a['longitude']-anchor['longitude'])/w;xy=(a['latitude']-anchor['latitude'])/w
    yx=(b['longitude']-anchor['longitude'])/h;yy=(b['latitude']-anchor['latitude'])/h;det=xx*yy-xy*yx
    def project(lon,lat):
        x=lon-anchor['longitude'];y=lat-anchor['latitude']
        return ((x*yy-y*yx)/det-w/2)*scale,((xx*y-xy*x)/det-h/2)*scale
    xml=(SOURCE/'exterior-osm.xml').read_bytes();root=ET.fromstring(xml)
    nodes={n.get('id'):project(float(n.get('lon')),float(n.get('lat'))) for n in root.findall('node')}
    ways={e.get('id'):e for e in root.findall('way')};relations={e.get('id'):e for e in root.findall('relation')}
    def tags(e):return {t.get('k'):t.get('v') for t in e.findall('tag')}
    def waypoints(e):return [nodes[n.get('ref')] for n in e.findall('nd') if n.get('ref') in nodes]
    def geometry(e):
        if e.tag=='way':
            coords=waypoints(e)
            return make_valid(Polygon(coords)) if len(coords)>=4 and coords[0]==coords[-1] else GeometryCollection()
        by_role={'outer':[],'inner':[]}
        for m in e.findall('member'):
            if m.get('type')=='way' and m.get('ref') in ways:
                coords=waypoints(ways[m.get('ref')]);role=m.get('role') or 'outer'
                if len(coords)>=2 and role in by_role:by_role[role].append(LineString(coords))
        regions={role:unary_union(list(polygonize(unary_union(lines)))) for role,lines in by_role.items()}
        return make_valid(regions['outer'].difference(regions['inner']))
    campus_geom=geometry(relations['2799811'])
    assert not campus_geom.is_empty
    manifest=json.loads((DATA/'manifest.json').read_text())
    floor_data=[json.loads((ROOT/'public'/f['url'].lstrip('/')).read_text()) for f in next(c for c in manifest['campuses'] if c['id']=='v-78')['floors']]
    plan=unary_union([Polygon(p['points'],p['holes']) for f in floor_data for p in f['exteriorFootprints']])
    # Keep the optional background close to the buildings, excluding the remote park parcel.
    context_extent=plan.envelope.buffer(85,join_style=2)
    buildings=[];reference=[];roads=[];surfaces=[];trees=[]
    for e in list(ways.values())+list(relations.values()):
        t=tags(e);osm_id=f'{e.tag}/{e.get("id")}';url='https://www.openstreetmap.org/'+osm_id
        if 'building' in t and 'building:part' not in t:
            g=geometry(e)
            if g.is_empty or not campus_geom.covers(g.representative_point()) or not context_extent.covers(g.representative_point()):continue
            if t.get('fixme') or t.get('building')=='construction':continue
            if t.get('addr:housenumber') and not t['addr:housenumber'].startswith('78'):continue
            overlap=g.intersection(plan).area/max(g.area,.001)
            record={'id':'osm:'+osm_id,'sourceUrl':url,'name':t.get('name') or t.get('description') or 'Строение '+t.get('addr:housenumber',e.get('id')),
                'address':t.get('addr:housenumber'),'sourceTags':t,'sourceOverlapRatio':round(overlap,4),
                'geometryStatus':'osm-affine-approximate','interiorStatus':'not-available',
                'affiliationStatus':'source-address-78' if t.get('addr:housenumber','').startswith('78') else 'within-osm-campus-boundary-not-independently-verified',
                'polygons':[serial(p) for p in parts(g)]}
            # Existing named campus buildings must not be duplicated even where registration is imperfect.
            known=t.get('ref') in ['А','Б','В','Г','Д','Е','И','ИВЦ','ФОК'] or e.get('id')=='28751380'
            if overlap>.12 or known:reference.append(record);continue
            levels=float(t.get('building:levels',1))
            record.update({'height':round(levels*3.2,1),'heightStatus':'approximate-from-osm-levels' if 'building:levels' in t else 'assumed-3.2m',
                'base':0,'role':'exterior-only-campus-building','confidence':'approximate'})
            buildings.append(record)
        if e.tag=='way' and 'highway' in t:
            coords=waypoints(e)
            if len(coords)<2:continue
            kind=t['highway'];line=LineString(coords)
            # Indoor graph ways and broad neighbouring roads are not imported as campus paths.
            if t.get('indoor') or t.get('level') or kind not in ['primary','secondary','tertiary','residential','service','footway','path','pedestrian','steps','living_street']:continue
            clipped=line.intersection(context_extent)
            lane_count=int(t.get('lanes','2').split(';')[0]) if t.get('lanes','2').split(';')[0].isdigit() else 2
            default_width=1.6 if kind in ['footway','path','steps'] else 3 if kind in ['service','pedestrian'] else min(15,3.1*lane_count)
            try:width=float(t.get('width',default_width));measured='width' in t
            except ValueError:width=default_width;measured=False
            for j,p in enumerate(parts(clipped,'LineString')):
                if p.length<3:continue
                roads.append({'id':f'osm:{osm_id}:{j}','name':t.get('name'),'kind':kind,'points':[[round(x,3),round(y,3)] for x,y in p.coords],
                    'width':width,'widthStatus':'source' if measured else 'cartographic-assumption','sourceUrl':url,'geometryStatus':'osm-affine-approximate'})
        area_kind='grass' if t.get('landuse') in ['grass','meadow'] or t.get('natural') in ['wood','scrub','grassland'] or t.get('leisure') in ['garden','park'] else 'water' if t.get('natural')=='water' else 'sport' if t.get('leisure') in ['pitch','stadium','sports_centre','track'] and 'building' not in t else None
        if area_kind:
            g=geometry(e).intersection(campus_geom).intersection(context_extent)
            for i,p in enumerate(parts(g)):
                if p.area<10:continue
                surfaces.append({'id':f'osm:{osm_id}:{i}','kind':area_kind,'name':t.get('name'),**serial(p),'sourceUrl':url,'geometryStatus':'osm-affine-approximate'})
    for n in root.findall('node'):
        if tags(n).get('natural')=='tree' and campus_geom.contains(Point(nodes[n.get('id')])) and context_extent.covers(Point(nodes[n.get('id')])):trees.append([round(v,3) for v in nodes[n.get('id')]])
    result={'schemaVersion':1,'campusId':'v-78','units':'meters','defaultVisible':False,
        'source':{'label':'OpenStreetMap contributors','url':QUERY,'attribution':'© OpenStreetMap contributors','license':'ODbL 1.0','licenseUrl':'https://www.openstreetmap.org/copyright','retrievedDate':'2026-10-19','sha256':hashlib.sha256(xml).hexdigest()},
        'registration':{'status':'approximate','method':'inverse existing plan geographic affine anchors','source':f['georeference'],
            'note':'Это обратное преобразование приблизительной исходной привязки. Контуры OSM не подогнаны к интерьерным планам; возможны смещения, особенно в библиотеке.'},
        'campusBoundary':[serial(p) for p in parts(campus_geom.intersection(context_extent))],
        'campusBoundaryClippedToView':True,'bounds':[round(x,3) for x in context_extent.bounds],
        'buildings':buildings,'referenceBuildings':reference,'roads':roads,'surfaces':surfaces,'trees':trees,
        'excludedNeighbour':'Высотные башни 80А к1 относятся к ЖК Академ-Палас, а не кампусу. Не включены.',
        'limitations':['Высоты дополнительных строений условны: этажность OSM ×3,2 м.','Полнота и актуальность вспомогательных строений не проверены на местности.','Контекст не является маршрутизатором и не подтверждает доступность проходов.']}
    (DATA/'exterior-context.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
    (ROOT/'analysis/maps-exterior-context-audit.json').write_text(json.dumps({'buildings':buildings,'referenceBuildings':reference,'counts':{'roads':len(roads),'surfaces':len(surfaces),'trees':len(trees)}},ensure_ascii=False,indent=2)+'\n')
    for b in buildings:print('NEW',b['id'],b['name'],b['height'],'overlap',b['sourceOverlapRatio'])
    print('TOTAL',len(buildings),'new buildings',len(reference),'existing',len(roads),'road sections',len(surfaces),'surfaces',len(trees),'source trees')

if __name__=='__main__':main()
