"""Photo-informed facade details, kept separate from source room geometry."""
import json, math
from pathlib import Path
root=Path(__file__).resolve().parents[1]
f=json.loads((root/'public/data/campuses/v-78/v-78-floor3.json').read_text())
features=[]
for p in f['polygons']:
 if p.get('label') in ['А-'+str(i) for i in range(9,19)]:
  pairs=list(zip(p['points'],p['points'][1:]+p['points'][:1]));a,b=max(pairs,key=lambda e: math.dist(*e));angle=-math.atan2(b[1]-a[1],b[0]-a[0])
  features.append({'type':'shed-skylight','sourceRoomId':p['id'],'center':p['center'],'width':7,'depth':5,'rise':1.8,'rotation':angle,'status':'photo-informed-approximate','evidence':'https://vika-it.rtuitlab.dev/infrastructure','note':'Шедовые фонари видны на аэроснимке. Привязка по центрам лекционных помещений; точные размеры, число и расположение не обмерены.'})
style={'schemaVersion':1,'campusId':'v-78','status':'photo-informed-approximate','windowPitch':1.55,'windowHeight':1.38,'windowGap':.12,'parapetHeight':.28,'photoSources':[{'title':'ВИКА / сообщество ИИТ · фотографии Вернадского, 78','url':'https://vika-it.rtuitlab.dev/infrastructure'},{'title':'РТУ МИРЭА · главный вход','url':'https://ok.ru/rtumirea/topic/157218002895701'}],'notes':['Оконные ряды, материал фасада, плоские кровли, шеды и диагональные опоры зала наблюдаются на фото.','Число окон, размеры окон/парапетов/опор и размещение фонарей приблизительные, не архитектурные обмеры.','Неподтвержденные дворовые фасады упрощены; рисунок мозаики не воспроизводится.'],'roofFeatures':features}
(root/'public/data/facade-style.json').write_text(json.dumps(style,ensure_ascii=False,indent=2))
print('Photo-based details:',len(features),'skylights; heights and positioning approximate')
