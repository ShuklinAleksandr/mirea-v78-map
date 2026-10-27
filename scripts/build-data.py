#!/usr/bin/env python3
"""Rebuild browser-ready geometry from the checked-in source cache.

Horizontal coordinates are copied from source SVGs; no building envelopes,
room numbers, doorways, heights or geographic registrations are invented.
Requires: shapely>=2, svgpathtools>=1.6 (only the MP-1 legacy SVG uses curves).
"""
from __future__ import annotations

import hashlib
import argparse
import io
import json
import math
import re
import zipfile
from datetime import datetime, timezone
from collections import Counter, defaultdict
from pathlib import Path
import xml.etree.ElementTree as ET

from shapely import make_valid, set_precision
from shapely.geometry import GeometryCollection, LineString, Point, Polygon
from shapely.ops import unary_union
from svgpathtools import parse_path, Line

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
SOURCE = ROOT / 'source/maps'
OUT = ROOT / 'public/data'
ANALYSIS = ROOT / 'analysis'
IDENTITY = (1, 0, 0, 1, 0, 0)
NUM = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?'
CLASSIFICATIONS = json.loads((ROOT / 'scripts/map-classifications.json').read_text())
CAMPUS_IDS = ('v-78','v-86','s-20','mp-1')


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def multiply(m, n):
    a,b,c,d,e,f=m; g,h,i,j,k,l=n
    return (a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*k+c*l+e,b*k+d*l+f)


def transform_matrix(value):
    result = IDENTITY
    for name, values in re.findall(r'(\w+)\s*\(([^)]*)\)', value or ''):
        v = list(map(float,re.findall(NUM,values)))
        if name == 'matrix': m=tuple(v)
        elif name == 'scale': m=(v[0],0,0,v[-1],0,0)
        elif name == 'translate': m=(1,0,0,1,v[0],v[1] if len(v)>1 else 0)
        elif name == 'rotate':
            angle=math.radians(v[0]); co=math.cos(angle); si=math.sin(angle)
            m=(co,si,-si,co,0,0)
            if len(v)==3:m=multiply(multiply((1,0,0,1,v[1],v[2]),m),(1,0,0,1,-v[1],-v[2]))
        else: raise ValueError(f'Unsupported source transform: {name}')
        result=multiply(result,m)
    return result


def iter_svg(root):
    def walk(node, matrix=IDENTITY, ancestors=(), object_id=None, label=None, fill=None):
        tag=node.tag.split('}')[-1]
        if tag in ('defs','clipPath','filter','title','desc'): return
        matrix=multiply(matrix,transform_matrix(node.get('transform')))
        object_id=node.get('data-object',object_id)
        label=node.get('data-name',label)
        fill=node.get('fill',fill)
        classes=ancestors+(node.get('class',''),)
        yield node,matrix,classes,object_id,label,fill
        for child in node:yield from walk(child,matrix,classes,object_id,label,fill)
    yield from walk(root)


def polygon_parts(geometry):
    if geometry.is_empty:return []
    if geometry.geom_type=='Polygon':return [geometry]
    return [p for child in geometry.geoms for p in polygon_parts(child)] if hasattr(geometry,'geoms') else []


def line_parts(geometry):
    if geometry.is_empty:return []
    if geometry.geom_type in ('LineString','LinearRing'):return [geometry]
    return [p for child in geometry.geoms for p in line_parts(child)] if hasattr(geometry,'geoms') else []


def shape_geometry(node, convert):
    tag=node.tag.split('}')[-1]
    rings=[]
    if tag=='rect':
        x=float(node.get('x',0));y=float(node.get('y',0));w=float(node.get('width',0));h=float(node.get('height',0))
        rx=min(float(node.get('rx',0)),w/2);ry=min(float(node.get('ry',rx)),h/2)
        if rx and ry:
            pts=[]
            for cx,cy,start in [(x+w-rx,y+ry,-90),(x+w-rx,y+h-ry,0),(x+rx,y+h-ry,90),(x+rx,y+ry,180)]:
                pts.extend((cx+rx*math.cos(math.radians(start+i*15)),cy+ry*math.sin(math.radians(start+i*15))) for i in range(7))
        else:pts=[(x,y),(x+w,y),(x+w,y+h),(x,y+h)]
        rings=[pts]
    elif tag=='path':
        d=node.get('d','')
        # Preserve the native, straight-sided polygons without interpolation.
        if set(re.findall('[a-zA-Z]',d))<=set('MLZ'):
            for sub in re.split('[Mm]',d)[1:]:
                nums=list(map(float,re.findall(NUM,sub)))
                rings.append(list(zip(nums[0::2],nums[1::2])))
        else:
            for sub in parse_path(d).continuous_subpaths():
                pts=[]
                for segment in sub:
                    count=1 if isinstance(segment,Line) else max(4,min(24,math.ceil(segment.length()/4)))
                    pts.extend((segment.point(t/count).real,segment.point(t/count).imag) for t in range(count))
                pts.append((sub.end.real,sub.end.imag))
                rings.append(pts)
    elif tag=='polygon':
        nums=list(map(float,re.findall(NUM,node.get('points',''))));rings=[list(zip(nums[0::2],nums[1::2]))]
    else:return GeometryCollection()
    # SVGs use evenodd for multipart paths. XOR retains voids/courtyards.
    result=GeometryCollection()
    for ring in rings:
        pts=[convert(p) for p in ring]
        if len(set(pts))<3:continue
        p=make_valid(Polygon(pts))
        result=result.symmetric_difference(p)
    return make_valid(result)


def rounded(p):return [round(p[0],4),round(p[1],4)]


def serial_polygon(p):
    return {'points':[rounded(x) for x in list(p.exterior.coords)[:-1]],'holes':[[rounded(x) for x in list(r.coords)[:-1]] for r in p.interiors]}


def building(label,campus):
    m=re.match(r'^([А-ЯЁA-Z]+)-',label or '')
    if m:return {'K':'К'}.get(m[1],m[1])
    return 'Основной' if campus=='s-20' else None


def floor_building_levels(campus,level,buildings):
    if campus=='v-78':
        levels={b:level+1 for b in ('Б','В','Г','Д') if 0<=level<=3}
        levels.update({b:level for b in ('А','Е','И','ИВЦ') if level>=1})
        return {b:levels.get(b) for b in buildings}
    return {b:level for b in buildings}


def source_info(campus,floor):
    return {'archive':'mirea-maps.zip','asset':f'original/pulse/campus_{campus["id"]}.json',
        'sourceLabel':campus['source_label'],'sourceUrl':campus['source_url'],
        'capturedAt':floor.get('captured_at',campus.get('source_captured_at')),
        'sourceFloorId':floor['id'],'sourceLayerId':floor.get('source_layer_id'),
        'sourceInternalLevel':floor.get('source_internal_level'),'svgSha256':sha(floor['svg'].encode()),
        'geometryStatus':'schematic' if campus['id']=='mp-1' else 'source-plan',
        'physicallySurveyed':False}


def make_floor(campus,floor):
    cid=campus['id'];legacy=cid=='mp-1'
    scale=0.1 if legacy else floor['meters_per_unit']
    ox=floor['width']/2;oy=floor['height']/2
    def normal(p):return ((p[0]-ox)*scale,(p[1]-oy)*scale)
    rooms={r['id']:r for r in campus['rooms'] if r['floor_id']==floor['id']}
    polygons=[];shape_geoms=[];doors=[];extra_walls=[];stats=Counter();unmatched=[]
    uncertainty_regions=[]
    for region in floor.get('georeference',{}).get('excluded_regions',[]):
        x,y,w,h=(region[k] for k in ('x','y','width','height'))
        uncertainty_regions.append({'points':[rounded(normal(p)) for p in [(x,y),(x+w,y),(x+w,y+h),(x,y+h)]],
            'holes':[],'kind':'placement-unverified','note':'Положение отдельного блока относительно кампуса не подтверждено источником; показано расположение на схеме.'})
    for node,matrix,classes,oid,label,fill in iter_svg(ET.fromstring(floor['svg'])):
        tag=node.tag.split('}')[-1]
        a,b,c,d,e,f=matrix
        def convert(p):return normal((a*p[0]+c*p[1]+e,b*p[0]+d*p[1]+f))
        if tag=='line' and not legacy:
            p1=convert((float(node.get('x1')),float(node.get('y1'))));p2=convert((float(node.get('x2')),float(node.get('y2'))))
            if node.get('stroke')=='#F4F7FC':doors.append({'id':f'{floor["id"]}-door-{len(doors)}','a':rounded(p1),'b':rounded(p2),'source':'source-svg-door-opening','confidence':'source-plan'})
            elif node.get('stroke')=='#7D8DA6':extra_walls.append(LineString([p1,p2]))
            continue
        if tag not in ('path','rect','polygon'):continue
        if not legacy:
            if tag!='path' or fill in ('none',None):continue
        else:
            # Ladder backgrounds and stair icons are location symbols, not stairwell footprints.
            if 'Ladder' in classes or 'stairsup' in classes:continue
            if not ('Room' in classes and fill=='#8E96FF') and not ('BigAreaPath' in classes or 'Paths' in classes):continue
        geom=set_precision(shape_geometry(node,convert),0.0001)
        if geom.is_empty:continue
        room=rooms.get(oid,{})
        kind=room.get('kind','circulation' if legacy and 'Room' not in classes else 'unclassified')
        bldg=building(room.get('label',label),cid)
        for pi,p in enumerate(polygon_parts(geom)):
            if p.area<1e-5:continue
            sid=oid or f'{floor["id"]}-area-{len(polygons)}'
            center=normal((room['x'],room['y'])) if room else tuple(p.representative_point().coords)[0]
            if not p.buffer(1e-6).covers(Point(center)):center=tuple(p.representative_point().coords)[0]
            obj={'id':sid if pi==0 else f'{sid}-part-{pi}','roomId':oid,'label':room.get('label',label),
                'kind':kind,'building':bldg,'center':rounded(center),'confidence':'schematic' if legacy else 'source-plan',
                'sourceId':oid,'sourceGeometry':'legacy-svg' if legacy else 'native-area-polygon',**serial_polygon(p)}
            if any(Polygon(reg['points']).covers(Point(center)) for reg in uncertainty_regions):
                obj['placementConfidence']='unverified'
            if legacy:obj['note']='Схема University App: форма и масштаб не являются обмером.'
            polygons.append(obj);shape_geoms.append(p);stats[kind]+=1
    overrides=CLASSIFICATIONS.get(floor['id'],{})
    if overrides:
        assert sha(floor['svg'].encode())==overrides['expectedEmbeddedSvgSha256'], 'Source changed: review outdoor classification before rebuilding.'
    for obj in polygons:
        classification=overrides.get('outdoorAreas',{}).get(obj['id'])
        obj['exteriorEligible']=not bool(classification)
        if classification:
            obj['sourceKind']=obj['kind'];obj['kind']='outdoor';obj['classification']=classification
    covered={p['roomId'] for p in polygons}
    markers=[]
    for room in rooms.values():
        if room['id'] in covered:continue
        markers.append({'id':room['id'],'label':room['label'],'kind':room['kind'],'building':building(room['label'],cid),
            'position':rounded(normal((room['x'],room['y']))),'center':rounded(normal((room['x'],room['y']))),
            'confidence':'source-marker','note':'Подтверждена подпись и точка, полигон помещения в источнике отсутствует.'})
        unmatched.append(room['id'])
    node_by_id={n['id']:n for n in campus['graph']['nodes']}
    transitions=[]
    for edge in campus['graph']['edges']:
        if edge.get('kind') not in ('stairs','elevator','lift'):continue
        start=node_by_id[edge['from_node_id']];end=node_by_id[edge['to_node_id']]
        for this,other in ((start,end),(end,start)):
            if this['floor_id']!=floor['id']:continue
            transitions.append({'id':edge['id'],'kind':edge['kind'],'position':rounded(normal((this['x'],this['y']))),
                'targetFloorId':other['floor_id'],'targetPosition':rounded(normal((other['x'],other['y']))),'sourceId':edge.get('source_id'),
                'source':'source-navigation-graph','label':'Лестница','confidence':'source-graph'})
    for t in transitions:
        key=(tuple(t['position']),t['targetFloorId'])
        if not any(tuple(x['position'])==key[0] and x.get('targetFloorId')==key[1] for x in markers):markers.append(t)
    union=unary_union(shape_geoms)
    interior_geoms=[g for g,p in zip(shape_geoms,polygons) if p['exteriorEligible']]
    outdoor_geoms=[g for g,p in zip(shape_geoms,polygons) if not p['exteriorEligible']]
    exterior_union=unary_union(interior_geoms)
    # Plan boundaries are centerlines for display, not measured wall thickness.
    boundaries=unary_union([p.boundary for p in interior_geoms]+extra_walls)
    if doors:
        # 2 cm tolerance only handles source rounding at shared vertices.
        cuts=unary_union([LineString([d['a'],d['b']]).buffer(0.02,cap_style=2) for d in doors])
        boundaries=boundaries.difference(cuts)
    walls=[]
    for line in line_parts(boundaries):
        points=list(line.coords)
        for a,b in zip(points,points[1:]):
            if math.dist(a,b)>0.015:walls.append({'a':rounded(a),'b':rounded(b),'source':'source-svg-boundary','confidence':'schematic' if legacy else 'source-plan'})
    # Assign unnamed areas to a building only when a named room shares their boundary.
    # Do not use nearest-centre guessing: shared spaces remain unassigned.
    result={'schemaVersion':1,'id':floor['id'],'campusId':cid,'level':floor['level'],
        'label':f'Уровень {floor["level"]}' if cid=='v-78' else floor['label'],
        'originalLabel':floor['label'],'units':'map-units' if legacy else 'meters',
        'bounds':list(map(lambda x:round(x,4),union.bounds)),'polygons':polygons,'walls':walls,'doors':doors,
        'footprints':[serial_polygon(p) for p in polygon_parts(union)],'markers':markers,'transitions':transitions,
        'exteriorFootprints':[serial_polygon(p) for p in polygon_parts(exterior_union)],
        'outdoorPolygons':[p for p in polygons if not p['exteriorEligible']],
        'exteriorBounds':list(map(lambda x:round(x,4),exterior_union.bounds)),
        'uncertaintyRegions':uncertainty_regions,
        'source':source_info(campus,floor),'roomCount':len(rooms),'geometryCounts':dict(stats),
        'limitations':['Вертикальные размеры и толщины стен не заданы источником.','Неподписанные области сохранены без назначения; графические значки не превращены в помещения.']+(['Схематическая геометрия; точные проёмы и физический масштаб отсутствуют.'] if legacy else []),
        'sourceScale':{'metersPerSvgUnit':floor.get('meters_per_unit'),'sourceUnit':floor.get('source_unit'),
            'displayUnitsPerSvgUnit':scale,'originSvg':[ox,oy],'yDirection':'source-svg-down'},
        'unmatchedRoomIds':unmatched}
    return result


def cached_assets():
    return [{'asset':str(p.relative_to(SOURCE)), 'sha256':sha(p.read_bytes())}
        for p in sorted((SOURCE/'original').rglob('*')) if p.is_file()]


def prepare_sources(args,parser):
    required=[SOURCE/'original/pulse/catalog.json',
        *[SOURCE/f'original/pulse/campus_{cid}.json' for cid in CAMPUS_IDS]]
    if not args.from_archives:
        missing=[str(p.relative_to(ROOT)) for p in required if not p.is_file()]
        if missing:parser.error('Incomplete cached sources: '+', '.join(missing)+'. Restore source/maps or use --from-archives with all original files.')
        catalog=json.loads(required[0].read_text())
        if {c['id'] for c in catalog['campuses']}!=set(CAMPUS_IDS):
            parser.error('Cached catalog must contain the four expected campus IDs; no substitute geometry will be generated.')
        report={'sourceMode':'cached','sourceAssets':cached_assets(),
            'archiveSha256':None,'apkAssetComparison':[],'standaloneIndexIdentical':None,
            'archiveAudit':{'status':'not-run','note':'Cached rebuild does not read or re-verify the parent ZIP, XAPK or standalone HTML.'}}
        previous_path=SOURCE/'archive-audit.json'
        if previous_path.is_file():
            previous=json.loads(previous_path.read_text())
            report['previousArchiveAudit']={**previous,
                'matchesCurrentCachedAssets':previous.get('sourceAssets')==report['sourceAssets']}
        print('Source mode: cached source/maps (no parent archives required)',flush=True)
        return report
    archives_dir=args.archives_dir.resolve()
    paths={name:archives_dir/name for name in ['mirea-maps.zip','Ninja+Mirea_5.3.0_APKPure.xapk','index.html']}
    missing=[str(p) for p in paths.values() if not p.is_file()]
    if missing:parser.error('--from-archives requires all three originals before extraction: '+', '.join(missing))
    with zipfile.ZipFile(paths['mirea-maps.zip']) as archive:
        for info in archive.infolist():
            if info.is_dir():continue
            name=Path(info.filename)
            if name.is_absolute() or '..' in name.parts:raise ValueError('Unsafe archive path: '+info.filename)
            rel=name.relative_to('mirea-map');dest=SOURCE/rel
            dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(archive.read(info))
    with zipfile.ZipFile(paths['Ninja+Mirea_5.3.0_APKPure.xapk']) as xapk:
        apk=zipfile.ZipFile(io.BytesIO(xapk.read('ninja.mirea.mireaapp.apk')))
    prefix='assets/flutter_assets/packages/app_ui/assets/maps/'
    compared=[]
    for n in apk.namelist():
        if not n.startswith(prefix):continue
        local=SOURCE/'original'/n[len(prefix):]
        if local.is_file():compared.append({'asset':n[len(prefix):],'sha256':sha(local.read_bytes()),'identicalToApk':local.read_bytes()==apk.read(n)})
    apk.close()
    audit={'archiveSha256':sha(paths['mirea-maps.zip'].read_bytes()),
        'xapkSha256':sha(paths['Ninja+Mirea_5.3.0_APKPure.xapk'].read_bytes()),
        'standaloneIndexSha256':sha(paths['index.html'].read_bytes()),
        'apkAssetComparison':compared,'sourceAssets':cached_assets(),
        'standaloneIndexIdentical':paths['index.html'].read_bytes()==(SOURCE/'index.html').read_bytes(),
        'auditedAt':datetime.now(timezone.utc).isoformat(),
        'archiveAudit':{'status':'performed','note':'Archive hashes and APK comparisons were read during this explicit --from-archives run.'}}
    write_json(SOURCE/'archive-audit.json',audit)
    print('Source mode: explicit archive extraction and APK/HTML audit',flush=True)
    return {'sourceMode':'archives',**audit}


def main(argv=None):
    parser=argparse.ArgumentParser(description='Rebuild all 23 floor datasets from source/maps. The default cached mode needs no parent ZIP, XAPK or standalone HTML.')
    parser.add_argument('--from-archives',action='store_true',help='Explicitly re-extract mirea-maps.zip and audit it against the XAPK and standalone index.html. All three originals are required.')
    parser.add_argument('--archives-dir',type=Path,default=PROJECT,help='Directory containing the three originals for --from-archives (default: project parent). Ignored in cached mode.')
    args=parser.parse_args(argv)
    report=prepare_sources(args,parser)
    manifest={'schemaVersion':1,'title':'РТУ МИРЭА · 3D-карта','campuses':[],'limitations':['Модель использует сохранённые материалы, не является геодезическим обмером.','Фасадные высоты и архитектурные детали не заданы цифровыми планами.']}
    search=[];report['campuses']=[]
    for cid in CAMPUS_IDS:
        campus=json.loads((SOURCE/f'original/pulse/campus_{cid}.json').read_text())
        buildings=sorted({b for r in campus['rooms'] if (b:=building(r['label'],cid))})
        item={'id':cid,'title':campus['title'],'shortTitle':campus['short_title'],'address':campus['address'],
            'buildings':buildings,'units':'map-units' if cid=='mp-1' else 'meters','roomCount':len(campus['rooms']),'floors':[],
            'source':{'label':campus['source_label'],'url':campus['source_url'],'capturedAt':campus.get('source_captured_at')},
            'sourceMeterFidelity':'absent-schematic' if cid=='mp-1' else 'declared-centimeters-in-source-not-field-verified',
            'source-meter-fidelity':'absent-schematic' if cid=='mp-1' else 'declared-centimeters-in-source-not-field-verified',
            'georeference':campus['floors'][0].get('georeference'),'geographicCenter':[campus['longitude'],campus['latitude']],
            'heightStatus':'unknown','layoutStatus':'schematic' if cid=='mp-1' else 'source-plan'}
        allbounds=[];floor_reports=[]
        for f in campus['floors']:
            data=make_floor(campus,f)
            fbuildings=sorted({p['building'] for p in data['polygons'] if p['building']})
            levels=floor_building_levels(cid,f['level'],fbuildings)
            data['buildingLevels']=levels
            url=f'/data/campuses/{cid}/{f["id"]}.json'
            write_json(OUT/url.removeprefix('/data/'),data)
            # Source plan is available from the UI alongside the reconstruction.
            svg_dest=OUT/f'plans/{cid}/{f["id"]}.svg';svg_dest.parent.mkdir(parents=True,exist_ok=True);svg_dest.write_text(f['svg'])
            summary={'id':f['id'],'level':f['level'],'label':data['label'],'originalLabel':f['label'],'url':url,
                'sourcePlanUrl':f'/data/plans/{cid}/{f["id"]}.svg','buildingLevels':levels,
                'buildings':fbuildings,'bounds':data['bounds'],'roomCount':data['roomCount'],
                'polygonCount':len(data['polygons']),'doorCount':len(data['doors']),'wallCount':len(data['walls']),
                'sourceInternalLevel':f.get('source_internal_level'),'uncertaintyRegions':data['uncertaintyRegions'],
                'outdoorPolygonCount':len(data['outdoorPolygons']),'exteriorBounds':data['exteriorBounds']}
            if cid=='v-78':summary['note']='Общий уровень источника: номера физических этажей различаются между корпусами.'
            item['floors'].append(summary);allbounds.append(data['bounds']);floor_reports.append(summary)
            byid={p['roomId']:p for p in data['polygons'] if p['roomId']}
            for r in campus['rooms']:
                if r['floor_id']!=f['id']:continue
                scale=data['sourceScale']['displayUnitsPerSvgUnit'];ox,oy=data['sourceScale']['originSvg']
                p=byid.get(r['id'])
                search.append({'id':r['id'],'label':r['label'],'kind':p['kind'] if p else r['kind'],'sourceKind':r['kind'],'building':building(r['label'],cid),
                    'campusId':cid,'floorId':f['id'],'level':f['level'],'center':p['center'] if p else rounded(((r['x']-ox)*scale,(r['y']-oy)*scale)),
                    'sourceUrl':r.get('source_url'),'confidence':'schematic' if cid=='mp-1' else 'source-plan','hasPolygon':bool(p)})
            print(f'{cid} / {f["level"]}: {len(data["polygons"])} polygons, {len(data["walls"])} walls, {len(data["doors"])} doors',flush=True)
        item['bounds']=[min(b[0] for b in allbounds),min(b[1] for b in allbounds),max(b[2] for b in allbounds),max(b[3] for b in allbounds)]
        manifest['campuses'].append(item);report['campuses'].append({'id':cid,'floorCount':len(floor_reports),'rooms':len(campus['rooms']),'floors':floor_reports})
        # Emit incrementally so the application can be built while conversion proceeds.
        write_json(OUT/'manifest.json',manifest);write_json(OUT/'search-index.json',search)
    report['totals']={'campuses':len(manifest['campuses']),'floors':sum(len(c['floors']) for c in manifest['campuses']),'rooms':len(search)}
    write_json(ANALYSIS/'maps-audit.json',report)
    print(json.dumps(report['totals']))


if __name__=='__main__':main()
