from pathlib import Path
from xml.etree import ElementTree as E
import subprocess,time,re,sys,datetime
root=Path(__file__).resolve().parents[4]
qa=Path(__file__).resolve().parent
adb=str(root/'.native-tools/android/platform-tools/adb'); base=[adb,'-s','emulator-5554']
def run(args,timeout=20,binary=False):
 r=subprocess.run(base+args,capture_output=True,text=not binary,timeout=timeout)
 with (qa/'actions.log').open('a') as f:f.write(datetime.datetime.now().astimezone().isoformat()+' '+repr(args)+'\n')
 if r.returncode:raise RuntimeError(str(r.stdout)+str(r.stderr))
 return r.stdout
def dump(name=None):
 run(['shell','uiautomator','dump','/sdcard/mirea-qa.xml'])
 xml=run(['exec-out','cat','/sdcard/mirea-qa.xml'])
 if name:
  (qa/(name+'.xml')).write_text(xml)
  (qa/(name+'.png')).write_bytes(run(['exec-out','screencap','-p'],binary=True))
 return E.fromstring(xml)
def taplabel(target,field='text',partial=False):
 nodes=dump().iter('node'); matches=[]
 for n in nodes:
  value=n.get(field,'')
  if ((target in value) if partial else value==target):
   b=[int(x) for x in re.findall(r'\d+',n.get('bounds',''))]
   if len(b)==4 and b[2]>b[0] and b[3]>b[1]:matches.append((n,b))
 if not matches:raise RuntimeError('Visible target missing:'+target)
 n,b=next(((n,b) for n,b in matches if n.get('clickable')=='true'),matches[0])
 run(['shell','input','tap',str((b[0]+b[2])//2),str((b[1]+b[3])//2)])
for cmd in sys.argv[1:]:
 p=cmd.split(':'); action=p[0]; v=':'.join(p[1:])
 if action=='wait':time.sleep(float(v))
 elif action=='snap':
  time.sleep(.7); r=dump(v); print('SNAP',v,flush=True)
  for n in r.iter('node'):
   if n.get('text'):print(n.get('text'),n.get('resource-id'),n.get('bounds'),flush=True)
 elif action=='tap':run(['shell','input','tap',*p[1:]])
 elif action=='text':run(['shell','input','text',v])
 elif action=='key':run(['shell','input','keyevent',v])
 elif action=='swipe':run(['shell','input','swipe',*p[1:]])
 elif action=='label':taplabel(v)
 elif action=='contains':taplabel(v,partial=True)
 elif action=='id':taplabel(v,'resource-id')
 else:raise ValueError(cmd)
