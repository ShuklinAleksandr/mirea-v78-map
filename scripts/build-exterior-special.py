#!/usr/bin/env python3
"""Explicit photo-models where room outlines are not exterior facade outlines."""
import json,math
from pathlib import Path
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union

ROOT=Path(__file__).resolve().parents[1];DATA=ROOT/'public/data'

def main():
    f=json.loads((DATA/'campuses/v-78/v-78-floor1.json').read_text())
    config=json.loads((ROOT/'scripts/exterior-overrides.json').read_text())
    override=next(o for o in config['overrides'] if o.get('featureId')=='conference-hall')
    selected=[p for p in f['polygons'] if p['id'] in override['sourceRoomIds']]
    assert len(selected)==20
    group=unary_union([Polygon(p['points'],p['holes']) for p in selected])
    # The rear shares a foyer; fit only the exposed southern perimeter, preserving
    # its native local coordinate system. The source is interior geometry, so the
    # fitted circle deliberately remains an exterior approximation.
    pts=np.array([p for p in group.convex_hull.exterior.coords if p[1]>49])
    def fit(points):
        v=np.linalg.lstsq(np.c_[2*points[:,0],2*points[:,1],np.ones(len(points))],np.sum(points*points,axis=1),rcond=None)[0]
        return v[:2],math.sqrt(v[2]+v[0]**2+v[1]**2)
    center,radius=fit(pts)
    # Ignore protruding escape stairs/entry stubs, not the circular facade itself.
    selected_arc=pts[np.abs(np.linalg.norm(pts-center,axis=1)-radius)<1]
    center,radius=fit(selected_arc)
    residual=np.linalg.norm(selected_arc-center,axis=1)-radius
    circle=[[round(center[0]+radius*math.cos(i*math.tau/96),4),round(center[1]+radius*math.sin(i*math.tau/96),4)] for i in range(96)]
    ring={'points':circle,'holes':[]}
    result={'schemaVersion':1,'campusId':'v-78','status':'photo-informed-approximation',
        'features':[{'id':'conference-hall','label':'Конференц-зал «Черепаха»',
            'type':'rounded-hall','sourceFloorId':f['id'],'sourcePolygonIds':override['sourceRoomIds'],
            'replaceShellOverrideIds':['v-78--floor-1--6kc'],
            'center':[round(float(v),4) for v in center],'radius':round(radius,4),
            'polygons':[ring],'base':0,'height':5,'heightStatus':'photo-informed-approximation',
            'geometryStatus':'circle-fit-to-source-exposed-perimeter-checked-against-photo',
            'sourceSelectedArea':round(group.area,4),'fittedArea':round(Polygon(circle).area,4),
            'fit':{'pointCount':len(selected_arc),'rmsResidual':round(float(np.sqrt(np.mean(residual*residual))),4),
                'note':'Невязка характеризует подгонку круга к исходной дуге, а не точность обмера здания.'},
            'roof':{'type':'shallow-frustum','base':5,'height':4,'topRadius':5.5,
                'eaveOverhang':.6,'geometryStatus':'photo-informed-approximation'},
            'evidence':['source/maps/original/pulse/campus_v-78.json',
                'analysis/exterior-references/campus-2.webp','analysis/exterior-references/v78.webp'],
            'note':'Фотография показывает гладкий круглый корпус с невысокой кровлей. Ниши и ступенчатый контур отдельного помещения не перенесены на фасад. Интерьерные планы не изменены; вынос карниза, верхняя площадка и подъём кровли приблизительны.'}],
        'unmodeledFeatures':[{'id':'sports-elevated-bridge','label':'Надземный переход у ФОК',
            'render':False,'existenceStatus':'photo-confirmed','geometryStatus':'not-located-in-source-plans',
            'evidence':['analysis/exterior-references/sports-yandex-1.jpg'],
            'note':'Фото подтверждает просвет под переходом. В этажах 0–4 В78 нет соединяющего ФОК с корпусами полигона; два выступа area545/546 также существуют на нижнем уровне и не идентифицированы как мост. В локальном OSM три corridor building:part находятся у корпуса А. Координаты перехода и отметки не назначены произвольно.'}]}
    (DATA/'exterior-special.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print('Conference exterior:',len(selected),'native areas; center',result['features'][0]['center'],'radius',round(radius,3),'m; source perimeter fit RMS',result['features'][0]['fit']['rmsResidual'])

if __name__=='__main__':main()
