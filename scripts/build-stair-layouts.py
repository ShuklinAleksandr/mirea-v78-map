"""Build photo-verified stair layouts without changing source room geometry.

Plan shape/orientation is interpreted from listed fire plans. All vertical values,
rendered tread counts and fine subdivision proportions remain approximate.
"""
import json, math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'public/data'
FLOORS={n:json.loads((DATA/f'campuses/v-78/v-78-floor{n}.json').read_text()) for n in range(5)}
LAYOUTS=[]

def frame_for(polygons, hint, depth_limit=None):
    pts=[p for polygon in polygons for p in polygon['points']]
    # Native edges fix the orientation; the photo specifies which edge is horizontal.
    candidates=[]
    for polygon in polygons:
        ring=polygon['points']
        for a,b in zip(ring,ring[1:]+ring[:1]):
            dx,dz=b[0]-a[0],b[1]-a[1];length=math.hypot(dx,dz)
            if length<.5:continue
            u=[dx/length,dz/length]
            if sum(x*y for x,y in zip(u,hint))<0:u=[-x for x in u]
            alignment=sum(x*y for x,y in zip(u,hint))
            if alignment<.92:continue
            v=[-u[1],u[0]]
            us=[sum(x*y for x,y in zip(p,u)) for p in pts]
            vs=[sum(x*y for x,y in zip(p,v)) for p in pts]
            bounds=[min(us),min(vs),max(us),max(vs)]
            score=(bounds[2]-bounds[0])*(bounds[3]-bounds[1])
            candidates.append((score,u,v,bounds))
    _,u,v,b=min(candidates,key=lambda item:item[0])
    if depth_limit is not None:b[3]=min(b[3],b[1]+depth_limit)
    margin=.12
    b=[b[0]+margin,b[1]+margin,b[2]-margin,b[3]-margin]
    return {'origin':[round(u[i]*b[0]+v[i]*b[1],4) for i in range(2)],
      'axisU':[round(x,6) for x in u],'axisV':[round(x,6) for x in v],
      'size':[round(b[2]-b[0],4),round(b[3]-b[1],4)],
      'status':'native-bounds-photo-oriented' if depth_limit is None else 'native-width-photo-approximate-depth'}

def flight(a,b,width,e0,e1):
    return {'from':a,'to':b,'widthFraction':width,'baseFraction':e0,'topFraction':e1,
      'treadCount':None,'treadCountStatus':'not-reliably-readable'}
def landing(x0,z0,x1,z1,e):
    return {'points':[[x0,z0],[x1,z0],[x1,z1],[x0,z1]],'elevationFraction':e}

def geometry(kind):
    if kind=='wide-well-U':
      bridge={'points':[[.02,.02],[.98,.02],[.98,.22],[.76,.22],[.24,.22],[.02,.22]],'elevationFraction':.5,'railEdges':[3]}
      return [flight([.13,.7],[.13,.22],.22,0,.5),flight([.87,.22],[.87,.7],.22,.5,1)], [bridge,landing(.02,.7,.24,.94,0),landing(.76,.7,.98,.94,1)]
    if kind=='compact-U':
      return [flight([.25,.75],[.25,.23],.42,0,.5),flight([.75,.23],[.75,.75],.42,.5,1)], [landing(.03,.02,.97,.23,.5),landing(.03,.75,.47,.97,0),landing(.53,.75,.97,.97,1)]
    if kind in ['side-left-U','side-right-U']:
      flights=[flight([.76,.25],[.24,.25],.42,0,.5),flight([.24,.75],[.76,.75],.42,.5,1)]
      landings=[landing(.02,.03,.24,.97,.5),landing(.76,.03,.98,.47,0),landing(.76,.53,.98,.97,1)]
      if kind=='side-right-U':
       for f in flights:
        for key in ['from','to']:f[key][0]=1-f[key][0]
       for l in landings:l['points']=[[1-x,z] for x,z in l['points']]
      return flights,landings
    if kind=='straight-singleflight':
      return [flight([.5,.12],[.5,.8],.84,0,1)], [landing(.08,.02,.92,.12,0),landing(.08,.8,.92,.98,1)]
    raise ValueError(kind)

def add(n,building,lk,area_id,photo,kind,hint,depth_limit=None,extra_ids=None):
    ids=[area_id if isinstance(area_id,str) else f'v-78-floor{n}-area-{area_id}',*(extra_ids or [])]
    polygons=[p for p in FLOORS[n]['polygons'] if p['id'] in ids]
    assert len(polygons)==len(ids),(n,ids)
    frame=frame_for(polygons,hint,depth_limit)
    flights,landings=geometry(kind)
    center=[frame['origin'][i]+frame['axisU'][i]*frame['size'][0]/2+frame['axisV'][i]*frame['size'][1]/2 for i in range(2)]
    LAYOUTS.append({'id':f'v78-{building}-{n}-{lk}','campusId':'v-78','floorId':FLOORS[n]['id'],
      'building':building,'physicalFloor':n if building=='А' else n+1,'label':lk,
      'fitAreaId':ids[0],'sourcePolygonIds':ids,'sourcePhotoIds':[f'photo-{photo}'],
      'sourcePhotos':[f'/data/photos/IMG_{photo}.jpg'],'center':[round(x,4) for x in center],
      'shape':kind,'shapeStatus':'photo-plan-observed','placementStatus':frame['status'],
      'verticalStatus':'approximate','ascentDirectionStatus':'not-inferred-from-evacuation-arrows',
      'frame':frame,'footprint':[[0,0],[1,0],[1,1],[0,1]],'flights':flights,'landings':landings,
      'notes':['Форма, положение площадок и направление маршей сверены по пожарному плану; нормированные доли сняты визуально.',
       'Горизонтальное пятно привязано к исходному полигону. Высота, число визуальных ступеней, толщина и поручни приблизительны.',
       'Стрелки эвакуации не использованы как доказательство направления подъёма. Направление подъёма в3D условное.']})
    if n==0 and kind=='wide-well-U':
      LAYOUTS[-1]['nativeCoverageException']={
       'status':'documented-photo-native-discrepancy','scope':'raised-cross-landing',
       'sourcePhotoIds':[f'photo-{photo}'],
       'reason':'Поперечная площадка и два боковых марша видны на пожарном плане; полигон первого этажа содержит выемку под большей частью площадки. Сохранена фотографическая форма, но горизонтальная привязка площадки над выемкой и её высота не подтверждены обмером. Небольшое расхождение края марша также не маскируется.'}
      LAYOUTS[-1]['notes'].append(LAYOUTS[-1]['nativeCoverageException']['reason'])

# All three stair locations are visible on every listed G/V/B fire plan.
for n,photo,c,l,r in [(0,3158,185,162,None),(1,3151,307,328,351),(2,3156,201,203,235),(3,3157,173,210,209)]:
 add(n,'Г','ЛК2',c,photo,'wide-well-U',[.94,-.34],depth_limit=8 if n==0 else None)
 add(n,'Г','ЛК3',l,photo,'side-left-U',[.94,-.34])
 if r:add(n,'Г','ЛК1',r,photo,'side-right-U',[.94,-.34])
for n,photo,c,l,r in [(0,3213,120,102,108),(1,3212,259,282,292),(2,3209,184,156,168),(3,3210,159,150,120)]:
 add(n,'В','ЛК2',c,photo,'wide-well-U',[.94,.34],depth_limit=8 if n==0 else None)
 add(n,'В','ЛК3',l,photo,'side-left-U',[.94,.34])
 add(n,'В','ЛК1',r,photo,'side-right-U',[.94,.34])
for n,photo,c,l,r in [(1,3218,229,247,215),(2,3217,98,122,132),(3,3214,105,87,112)]:
 add(n,'Б','ЛК2',c,photo,'wide-well-U',[.94,.34])
 add(n,'Б','ЛК3',l,photo,'side-left-U',[.94,.34])
 add(n,'Б','ЛК1',r,photo,'side-right-U',[.94,.34])

# A layouts are appended from explicitly checked native correspondences.
a_mapping=ROOT/'scripts/stair-layout-a.json'
if a_mapping.exists():
 a_data=json.loads(a_mapping.read_text())
 for a in a_data['layouts']:
  add(a['level'],'А',a['label'],a['area'],a['photo'],a.get('shape','compact-U'),a['axisHint'])
  LAYOUTS[-1]['landmarkNote']=a['landmarkNote']
 for a in a_data['wideStairGroups']:
  place=a['placement'];w=place['length'];d=place['width'];count=a['flightCount']
  # Each side of the hall has its own sequence. Companion photos 3166/3167
  # and 3232/3230 must be read together; they are not one end-to-end ramp.
  # Graph edges 20745/20744 identify the two lower outer / upper inner ends.
  landing_width=.032;start=.02;end=.45
  flight_width=(end-start-(count-1)*landing_width)/count
  flights=[];landings=[]
  base_offset=-1 if a['levelRole']=='upper-arrival' else 0
  for branch in ['left','right']:
   for i in range(count):
    x0=start+i*(flight_width+landing_width);x1=x0+flight_width
    f=flight([x0,.5],[x1,.5],.92,base_offset+i/count,base_offset+(i+1)/count)
    f.update(branch=branch,sourceTransitionId=a['branchSourceIds'][branch])
    if branch=='right':
     f['from'][0]=1-f['from'][0];f['to'][0]=1-f['to'][0]
    flights.append(f)
    if i<count-1:
     l=landing(x1,.04,x1+landing_width,.96,base_offset+(i+1)/count)
     l['role']='intermediate';l['branch']=branch;l['railEdges']=[0,2]
     if branch=='right':l['points']=[[1-x,z] for x,z in l['points']]
     landings.append(l)
  shared=landing(.45,.04,.55,.96,base_offset+1)
  shared['role']='central-arrival';shared['railEdges']=[0]
  landings.append(shared)
  region_id=f"{a['floorId']}-photo-stair-wide-hall"
  LAYOUTS.append({'id':region_id,'campusId':'v-78','floorId':a['floorId'],'building':'А',
   'physicalFloor':a['physicalFloor'],'label':a['label'],'fitAreaId':region_id,
   'containerAreaId':a['containerAreaId'],'sourcePolygonIds':[a['containerAreaId']],
   'sourceMarkerIds':[a['branchSourceIds']['left'],a['branchSourceIds']['right']],
   'sourcePhotoIds':a['pairedPhotoIds'],
   'sourcePhotos':a['pairedPhotoUrls'],'center':place['center'],'shape':'straight-multiflight',
   'layoutMode':a['layoutMode'],'levelRole':a['levelRole'],'branchSourceIds':a['branchSourceIds'],
   'displayCutout':a['levelRole']=='upper-arrival',
   'shapeStatus':'photo-plan-observed','placementStatus':place['status'],
   'verticalStatus':'approximate','ascentDirectionStatus':'not-inferred-from-evacuation-arrows',
   'frame':{'origin':[place['center'][0]-w/2,place['center'][1]-d/2],
    'axisU':[1,0],'axisV':[0,1],'size':[w,d],'status':place['status']},
   'footprint':[[0,0],[1,0],[1,1],[0,1]],'flights':flights,'landings':landings,
   'notes':[a['note'],'Подъём каждой ветви направлен к центру по исходным межэтажным связям, а не по эвакуационным стрелкам. На А3 показан спуск к А2; отдельная малая лестница к А4 не объединена с главной.']})
 for a in a_data.get('hallRegionLayouts',[]):
  flights,landings=geometry(a['shape'])
  if a.get('levelRole')=='upper-arrival':
   for f in flights:
    f['baseFraction']-=1;f['topFraction']-=1
   for l in landings:l['elevationFraction']-=1
  region_id=a['id']
  LAYOUTS.append({'id':region_id,'campusId':'v-78','floorId':a['floorId'],'building':'А',
   'physicalFloor':a['physicalFloor'],'label':a['label'],'fitAreaId':region_id,
   'containerAreaId':a['containerAreaId'],'sourcePolygonIds':[a['containerAreaId']],
   'sourceMarkerIds':a['sourceMarkerIds'],'sourcePhotoIds':[a['photoId']],
   'sourcePhotos':[a['photoUrl']],'center':a['center'],'shape':a['shape'],
   'shapeStatus':'photo-plan-observed','placementStatus':a['frame']['status'],
   'verticalStatus':'approximate','ascentDirectionStatus':'not-inferred-from-evacuation-arrows',
   'frame':a['frame'],'footprint':[[0,0],[1,0],[1,1],[0,1]],'flights':flights,'landings':landings,
   'notes':[a['note'],'Фото подтверждает форму; отдельного исходного полигона лестницы нет. Ограниченная область в холле, высота и число визуальных ступеней приблизительны.']})
  if a.get('levelRole'):
   LAYOUTS[-1].update(levelRole=a['levelRole'],displayCutout=a['levelRole']=='upper-arrival')
  if a.get('pairedLayoutId'):LAYOUTS[-1]['pairedLayoutId']=a['pairedLayoutId']
  for key in ['shapeSourcePhotoIds','shapeSourcePhotos']:
   if a.get(key):LAYOUTS[-1][key]=a[key]
 for a in a_data.get('userConfirmedDescents',[]):
  source=next(item for item in LAYOUTS if item['id']==a['anchorLayoutId'])
  flights,landings=geometry(source['shape'])
  for f in flights:f['baseFraction']-=1;f['topFraction']-=1
  for l in landings:l['elevationFraction']-=1
  frame={**source['frame'],'status':'approximate-under-user-confirmed-main-hall-stair'}
  LAYOUTS.append({'id':a['id'],'campusId':source['campusId'],'floorId':source['floorId'],
   'building':source['building'],'physicalFloor':source['physicalFloor'],'label':a['label'],
   'fitAreaId':a['id'],'containerAreaId':source['containerAreaId'],
   'sourcePolygonIds':source['sourcePolygonIds'],'sourceMarkerIds':[],
   'sourcePhotoIds':source['sourcePhotoIds'],'sourcePhotos':source['sourcePhotos'],
   'sourcePhotoPurpose':'location-of-stair-above-only-not-basement-shape',
   'anchorLayoutId':source['id'],'evidence':a['evidence'],
   'existenceStatus':'user-confirmed-existence','destinationLabel':a['destinationLabel'],
   'destinationStatus':a['destinationStatus'],'routingStatus':a['routingStatus'],
   'note':a['note'],'center':source['center'],'shape':source['shape'],
   'shapeStatus':'user-confirmed-existence-approximate-shape','placementStatus':frame['status'],
   'verticalStatus':'approximate','ascentDirectionStatus':'not-inferred-from-evacuation-arrows',
   'levelRole':'upper-arrival','displayCutout':True,'frame':frame,
   'footprint':source['footprint'],'flights':flights,'landings':landings,
   'notes':[a['note'],a['evidence']['limitations'],
    'Визуальный модуль без плана цокольного этажа, новых помещений и межэтажных связей графа.']})

result={'schemaVersion':1,'status':'photo-plan-layouts-with-approximate-vertical-geometry',
 'coordinateSystem':'Each layout uses normalized0..1 coordinates in its frame. frame axes and dimensions are native plan display units.',
 'verticalAssumptionsUrl':'/data/stair-assumptions.json',
 'notes':['Only observed layouts are rendered as stairs. Other source points remain point symbols.',
  'No new navigational transition is inferred from a photographed stair. Source graph connections remain separate.',
  'Floor-height, vertical direction, step count and railing geometry remain approximations.'],
 'layouts':LAYOUTS,
 'unresolved':[{'floorId':'v-78-floor0','building':'Г','label':'ЛК1','sourcePhotoId':'photo-3158',
  'reason':'На первом этаже показан неполный/ломаный марш; его геометрия отличается от верхних этажей. Не заменён автоматически типовойU.'}]}
(DATA/'stair-layouts.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print('Photo stair layouts:',len(LAYOUTS))
