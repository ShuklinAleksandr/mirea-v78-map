#!/usr/bin/env python3
"""Derived closed facade masses; the missing lower interiors remain unknown."""
import json
from pathlib import Path
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely import set_precision

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'

def parts(g):
    if g.is_empty:return []
    if g.geom_type=='Polygon':return [g]
    return [p for c in getattr(g,'geoms',[]) for p in parts(c)]

def serial(p):
    return {'points':[[round(x,4),round(y,4)] for x,y in list(p.exterior.coords)[:-1]],
        'holes':[[[round(x,4),round(y,4)] for x,y in list(r.coords)[:-1]] for r in p.interiors]}

def resolve_connections(campus_id,floors,geom,config):
    """A bridge owns only footprint that no other source level occupies."""
    resolved=[]
    for feature in config.get('elevatedConnections',[]):
        if feature['campusId']!=campus_id:continue
        if 'displayStorey' in feature:
            # Source floor ordinals and local room numbering are not a height.
            assert feature['base']==round((feature['displayStorey']-1)*3.6,4)
            assert feature['top']==round(feature['displayStorey']*3.6,4)
        index=next(i for i,f in enumerate(floors) if f['id']==feature['floorId'])
        source=next(p for p in floors[index]['polygons'] if p['id']==feature['sourcePolygonId'])
        original=set_precision(Polygon(source['points'],source['holes']),.0001)
        occupied=unary_union([g for i,g in enumerate(geom) if i!=index])
        exclusive=original.difference(occupied)
        assert not exclusive.is_empty,feature['id']
        assert exclusive.intersection(occupied).area<.00001
        point=exclusive.representative_point()
        resolved.append({**feature,'polygons':[serial(p) for p in parts(exclusive)],
            'sourcePolygons':[serial(original)],'sourceArea':round(original.area,4),
            'exclusiveArea':round(exclusive.area,4),
            'protectedOtherFloorArea':round(original.intersection(occupied).area,4),
            'samplePoint':[round(point.x,4),round(point.y,4)],
            'footprintRule':'source polygon minus union of all other source-level exterior footprints'})
    return resolved

def display_regions(campus_id,shells,connections):
    """Keep exact exterior bounds; regularize only tiny V78 roof-height fragments."""
    # Split before regularization: even a small bridge fragment has a deliberate
    # source silhouette, so it must not be raised to an adjoining building roof.
    original_shells=shells
    protected=unary_union([Polygon(p['points'],p['holes']) for c in connections for p in c['polygons']])
    shells=[]
    for shell in original_shells:
        g=set_precision(Polygon(shell['points'],shell['holes']),.0001)
        for role,part in [('ordinary',g.difference(protected)),('bridge',g.intersection(protected))]:
            for n,p in enumerate(parts(part)):
                if p.area<.0001:continue
                shells.append({**shell,**serial(p),'id':shell['id'] if role=='ordinary' and g.equals(p)
                    else f'{shell["id"]}:{role}:{n}','sourceShellId':shell['id'],
                    'protectSourceHeight':role=='bridge'})
    geoms=[set_precision(Polygon(s['points'],s['holes']),.0001) for s in shells]
    heights=[s['height'] for s in shells]
    changed=[]
    if campus_id=='v-78':
        candidates=[i for i,(s,g) in enumerate(zip(shells,geoms))
            if not s.get('overrideRoomId') and not s.get('protectSourceHeight')
            and (g.area<10 or (g.area<300 and 2*g.area/max(g.length,.001)<.6))]
        stable=[i for i,(s,g) in enumerate(zip(shells,geoms))
            if i not in candidates and not s.get('overrideRoomId')]
        for i in candidates:
            g=geoms[i]
            neighbours=[]
            for j in stable:
                if heights[j]<=heights[i] or g.distance(geoms[j])>.001:continue
                contact=g.boundary.intersection(geoms[j].boundary).length
                if contact>.05:neighbours.append((contact,j))
            if neighbours:
                _,j=max(neighbours)
                changed.append({'sourceShellId':shells[i]['sourceShellId'],'from':heights[i],
                    'to':heights[j],'area':round(g.area,4),'adjacentSourceShellId':shells[j]['id']})
                heights[i]=heights[j]
    # Equal-height regions share one cap and one outer facade, not room-boundary seams.
    rendered=[]
    for height in sorted(set(heights)):
        members=[g for s,g,h in zip(shells,geoms,heights) if h==height and not s.get('overrideRoomId')]
        for n,p in enumerate(parts(unary_union(members))):
            rendered.append({'id':f'{campus_id}:display:{height}:{n}',**serial(p),'base':0,
                'height':height,'heightStatus':'exterior-photo-regularized' if campus_id=='v-78' else 'approximate',
                'lowerInteriorStatus':'not-inferred'})
    rendered.extend(s for s in original_shells if s.get('overrideRoomId'))
    for connection in connections:
        if not connection['clearanceConfirmed']:continue
        bridge=unary_union([Polygon(p['points'],p['holes']) for p in connection['polygons']])
        remaining=[]
        for region in rendered:
            g=set_precision(Polygon(region['points'],region['holes']),.0001)
            if g.intersection(bridge).area<.00001:
                remaining.append(region);continue
            assert not region.get('overrideRoomId'),'Do not cut a special photo volume'
            for n,p in enumerate(parts(g.difference(bridge))):
                if p.area>.0001:remaining.append({**region,**serial(p),'id':region['id']+f':bridge-cut:{n}'})
        for n,p in enumerate(parts(bridge)):
            remaining.append({'id':connection['id']+f':display:{n}',**serial(p),
                'base':connection['base'],'height':round(connection['top']-connection['base'],4),
                'sourceFloorId':connection['floorId'],'sourcePolygonId':connection['sourcePolygonId'],
                'exteriorConnectionId':connection['id'],'heightStatus':connection['heightStatus'],
                'displayStorey':connection.get('displayStorey'),
                'clearanceStatus':connection['clearanceStatus'],'lowerInteriorStatus':'not-inferred'})
        rendered=remaining
    boundaries=sorted({0,*[s['base'] for s in rendered],*[s['base']+s['height'] for s in rendered]});bands=[]
    for base,top in zip(boundaries,boundaries[1:]):
        g=unary_union([Polygon(s['points'],s['holes']) for s in rendered
            if s['base']<=base+.00001 and s['base']+s['height']>=top-.00001])
        bands.append({'base':base,'top':top,'rings':[serial(p) for p in parts(g)],'heightStatus':'approximate'})
    assert all(Polygon(s['points'],s['holes']).is_valid for s in rendered)
    assert abs(sum(Polygon(s['points'],s['holes']).area for s in rendered)-sum(g.area for g in geoms))<.01
    return rendered,bands,{'status':'approximate-exterior-only','heightAdjustments':changed,
        'adjustedArea':round(sum(x['area'] for x in changed),4),
        'protectedConnectionIds':[c['id'] for c in connections],
        'raisedConnectionIds':[c['id'] for c in connections if c['clearanceConfirmed']],
        'rule':'V78 only: a roof fragment under10m² or under0.6m effective width is raised to a directly adjoining substantial higher region; source bridge footprints and explicit photo/user placements are protected. Bridge clearance applies only where no other source floor occupies the footprint; source floor ordinals never override a user-confirmed exterior storey.',
        'note':'По фото кровли основных корпусов непрерывные; мелкие ступени из несовпадающих контуров внутренних этажей сглажены только для наружного показа. Интерьеры и исходные shells неизменны.'}

def main():
    manifest=json.loads((DATA/'manifest.json').read_text())
    result={'schemaVersion':1,'assumptions':{'floorHeight':3.6,'heightStatus':'approximate',
        'rule':'maximum source level footprint extended down to common visual ground',
        'note':'Сплошные внешние фасады выведены из верхних контуров. Это не подтверждение помещений на отсутствующих нижних этажах. Отметка земли общая и условная; реальный уклон участка не измерен.'},'campuses':{}}
    override_config=json.loads((ROOT/'scripts/exterior-overrides.json').read_text())
    resolved_overrides=[]
    for campus in manifest['campuses']:
        floors=[json.loads((ROOT/'public'/f['url'].lstrip('/')).read_text()) for f in campus['floors']]
        geom=[set_precision(unary_union([Polygon(p['points'],p['holes']) for p in f['exteriorFootprints']]),.0001) for f in floors]
        higher=Polygon();shells=[];bands=[]
        for i in range(len(floors)-1,-1,-1):
            owned=geom[i].difference(higher)
            for n,p in enumerate(parts(owned)):
                if p.area<.0001:continue
                shells.append({'id':f'{campus["id"]}:shell:{i}:{n}',**serial(p),'base':0,
                    'height':round((i+1)*3.6,2),'sourceFloorId':floors[i]['id'],'sourceLevel':floors[i]['level'],
                    'sourceOrdinal':i,'heightStatus':'approximate','lowerInteriorStatus':'not-inferred'})
            higher=unary_union([higher,geom[i]])
            bands.append({'base':round(i*3.6,2),'top':round((i+1)*3.6,2),
                'rings':[serial(p) for p in parts(higher)],'heightStatus':'approximate'})
        special=[]
        for override in override_config['overrides']:
            if override['campusId']!=campus['id']:continue
            floor=next(f for f in floors if f['id']==override['floorId'])
            source_ids=set(override.get('sourceRoomIds',[override['roomId']]))
            areas=[p for p in floor['polygons'] if p['id'] in source_ids or p.get('roomId') in source_ids]
            assert areas,override['roomId']
            override_geom=unary_union([Polygon(p['points'],p['holes']) for p in areas]).intersection(higher)
            if override.get('protectHigherSourceFloors'):
                source_index=next(i for i,f in enumerate(floors) if f['id']==floor['id'])
                override_geom=override_geom.difference(unary_union(geom[source_index+1:]))
            override_geom=set_precision(override_geom,.0001)
            remaining=[]
            for shell in shells:
                g=set_precision(Polygon(shell['points'],shell['holes']),.0001).difference(override_geom)
                for n,p in enumerate(parts(g)):
                    if p.area>.0001:remaining.append({**shell,**serial(p),'id':shell['id']+f':override-cut:{n}'})
            shells=remaining
            for n,p in enumerate(parts(override_geom)):
                shells.append({'id':f'{override["roomId"]}:exterior:{n}',**serial(p),'base':0,'height':override['height'],
                    'sourceFloorId':floor['id'],'sourceLevel':floor['level'],'heightStatus':override['heightStatus'],
                    'lowerInteriorStatus':'not-inferred','overrideRoomId':override['roomId']})
            resolved={**override,'polygons':[serial(p) for p in parts(override_geom)]}
            special.append(resolved);resolved_overrides.append(resolved)
        # Rebuild facade height intervals after the explicit roof-volume overrides.
        boundaries=sorted({0,*[s['height'] for s in shells]});bands=[]
        for base,top in zip(boundaries,boundaries[1:]):
            band_geom=unary_union([Polygon(p['points'],p['holes']) for p in shells if p['height']>=top])
            bands.append({'base':base,'top':top,'rings':[serial(p) for p in parts(band_geom)],'heightStatus':'approximate'})
        bounds=[round(x,4) for x in higher.bounds]
        connections=resolve_connections(campus['id'],floors,geom,override_config)
        display,bands_display,display_policy=display_regions(campus['id'],shells,connections)
        result['campuses'][campus['id']]={'units':campus['units'],'shells':shells,'facadeBands':bands,'specialFeatures':special,
            'displayShells':display,'displayFacadeBands':bands_display,'displayPolicy':display_policy,
            'elevatedConnections':connections,
            'bounds':bounds,'footprints':[serial(p) for p in parts(higher)]}
        # Each region owns only its highest represented source level.
        sum_area=sum(Polygon(p['points'],p['holes']).area for p in shells)
        assert abs(sum_area-higher.area)<max(.001,higher.area*1e-6)
        assert all(Polygon(p['points'],p['holes']).is_valid for p in shells)
        print(campus['id'],len(shells),'closed facade regions',len(bands),'facade bands;',len(display),'display regions;',display_policy['adjustedArea'],'height-regularized area')
    (DATA/'exterior-shells.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
    (DATA/'exterior-overrides.json').write_text(json.dumps({'schemaVersion':1,'note':override_config['note'],'overrides':resolved_overrides},ensure_ascii=False,separators=(',',':'))+'\n')

if __name__=='__main__':main()
