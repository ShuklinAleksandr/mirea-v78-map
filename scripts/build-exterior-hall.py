#!/usr/bin/env python3
"""Photo-informed entrance exterior, kept separate from source interior plans."""
import json,math
from pathlib import Path
from shapely.geometry import Polygon, LineString, box
from shapely.ops import unary_union

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'

def parts(g):
    if g.is_empty:return []
    if g.geom_type=='Polygon':return [g]
    return [p for c in getattr(g,'geoms',[]) for p in parts(c)]

def serial(p):
    return {'points':[[round(x,4),round(y,4)] for x,y in list(p.exterior.coords)[:-1]],
        'holes':[[[round(x,4),round(y,4)] for x,y in list(r.coords)[:-1]] for r in p.interiors]}

def visible_wall_segments(rear):
    exterior=json.loads((DATA/'exterior-shells.json').read_text())['campuses']['v-78']
    bands=exterior.get('displayFacadeBands',exterior['facadeBands'])
    vicinity=LineString(rear).buffer(4).intersection(box(25,-20,77,15))
    result=[]
    for band in bands:
        if band['top']<=5 or band['base']>=18:continue
        for ring in band['rings']:
            points=ring['points']
            signed=sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1]))
            sign=1 if signed>0 else -1
            for a,b in zip(points,points[1:]+points[:1]):
                dx=b[0]-a[0];dz=b[1]-a[1];length=math.hypot(dx,dz)
                if length<.15:continue
                normal=[sign*dz/length,-sign*dx/length]
                if normal[1]<.35:continue
                clipped=LineString([a,b]).intersection(vicinity)
                lines=[clipped] if clipped.geom_type=='LineString' else list(getattr(clipped,'geoms',[]))
                for line in lines:
                    if line.geom_type!='LineString' or line.length<.15:continue
                    result.append({'a':[round(v,4) for v in line.coords[0]],
                        'b':[round(v,4) for v in line.coords[-1]],'base':max(5,band['base']),
                        'top':min(18,band['top']),'outwardNormal':[round(v,6) for v in normal],
                        'horizontalStatus':'visible-display-facade-band-boundary',
                        'heightStatus':'approximate-adjacent-A-envelope'})
    assert result,'No visible facade segments found behind the hall'
    return result

def main():
    floor=json.loads((DATA/'campuses/v-78/v-78-floor2.json').read_text())
    overrides=json.loads((ROOT/'scripts/exterior-overrides.json').read_text())['overrides']
    group=next(o for o in overrides if o.get('featureId')=='main-entrance-hall')
    ids=[*group['sourceRoomIds'],'v-78--floor-2--9yb']
    selected=[p for p in floor['polygons'] if p['id'] in ids]
    assert len(selected)==len(ids)==13
    low=unary_union([Polygon(p['points'],p['holes']) for p in selected])
    assert low.geom_type=='Polygon' and low.is_valid and not low.interiors
    upper=[]
    for n in [3,4]:
        f=json.loads((DATA/f'campuses/v-78/v-78-floor{n}.json').read_text())
        upper.extend(Polygon(p['points'],p['holes']) for p in f['exteriorFootprints'])
    protected=unary_union(upper)
    volumes=low.difference(protected)
    # All frontage and rear-interface vertices are copied from the native boundary.
    frontage=[[27.019,41.2044],[29.075,40.5804],[36.786,39.0154],
        [40.085,38.6734],[43.5,38.5824],[55.565,39.2074],[59.054,39.7674],
        [61.54,40.2034],[71.465,43.0334]]
    rear=[[77.127,1.0004],[65.195,-3.1856],[62.41,-4.0836],
        [59.097,-5.1516],[54.43,-5.8626],[50.041,-6.1296],
        [47.563,-6.1426],[43.735,-5.6876],[41.48,-5.2226],
        [39.782,-4.8726],[36.979,-4.1706],[25.393,-0.5946]]
    for line in [LineString(frontage),LineString(rear)]:
        assert line.difference(low.boundary.buffer(.0002)).length<.001
    # Outside is the left side of the west-to-east frontage in source x/z coordinates.
    canopy=LineString(frontage).buffer(1.25,single_sided=True,join_style='mitre')
    result={
        'schemaVersion':1,'campusId':'v-78','id':'main-entrance-hall',
        'label':'Главный вход и широкий вестибюль',
        'status':'photo-informed-approximation','units':'meters',
        'sourceFloorId':floor['id'],'sourcePolygonIds':ids,
        'horizontalStatus':'union-of-native-source-polygons',
        'heightStatus':'photo-informed-approximation',
        'base':0,'height':5,'estimatedHeightRange':[4,7],
        'lowPolygon':serial(low),
        'volumePolygons':[serial(p) for p in parts(volumes)],
        'roofPolygons':[serial(low)],
        'protectedUpperOverlapArea':round(low.intersection(protected).area,4),
        'replaceShellOverrideIds':['v-78-floor2-area-6','v-78--floor-2--9yb'],
        'entranceFrontSegment':{'a':[43.5,38.5824],'b':[55.565,39.2074],
            'sourceRoomId':'v-78--floor-2--9yb','horizontalStatus':'native-source-edge'},
        'frontage':frontage,
        'frontGlazingSegments':[{'a':a,'b':b,'base':.25,'top':4.15,
            'geometryStatus':'native-horizontal-photo-vertical'} for a,b in zip(frontage,frontage[1:])],
        'topWallSegments':[{'a':a,'b':b,'base':5,'top':18,
            'horizontalStatus':'native-hall-to-A-interface',
            'heightStatus':'approximate-adjacent-A-envelope'} for a,b in zip(rear,rear[1:])],
        'visibleTopWallSegments':visible_wall_segments(rear),
        'topWall':{'style':'pale-solid-mosaic-facade','noRegularWindowRows':True,
            'note':'Фото подтверждает высокий преимущественно глухой фасад за низким вестибюлем. Линия взята из границы вестибюля с А; верх18м согласован с условной оболочкой А, не обмер. Мозаичный рисунок и отдельные окна не оцифрованы.'},
        'canopy':{**serial(canopy),'base':4.45,'height':.4,'overhang':1.25,
            'geometryStatus':'photo-approximation-offset-from-native-frontage',
            'note':'Проекция козырька отсутствует в исходном плане; полоса выведена наружу от точного фронта на условные1.25м. Нижняя отметка и толщина оценочные.'},
        'roof':{'type':'flat','height':5,'parapetHeight':.25,
            'note':'Единая плоская крыша над всей входной группой; внутренний островок столовой не является отверстием кровли.'},
        'evidence':['source/maps/original/pulse/campus_v-78.json',
            'analysis/exterior-references/campus-1.webp',
            'analysis/exterior-references/v78.webp'],
        'limitations':['Наружный контур получен из объединения внутренних полигонов; толщина наружных стен не обмерена.',
            'Верхние планы А немного пересекаются с планом вестибюля; volumePolygons исключают их, сохраняя высокий фасад.',
            'Отметка земли, высоты остекления, козырька и парапета оценочные. Число дверей и стоек не задано.',
            'lowPolygon/roofPolygons содержат общий силуэт; для нового объёма использовать volumePolygons. Существующие оболочки с replaceShellOverrideIds следует заменить, а не продублировать.']
    }
    (DATA/'exterior-hall.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print('Main hall:',len(selected),'source polygons;',round(low.area,2),'square source meters;',len(parts(volumes)),'volumes; no roof holes;',len(result['visibleTopWallSegments']),'visible upper facade segments')

if __name__=='__main__':main()
