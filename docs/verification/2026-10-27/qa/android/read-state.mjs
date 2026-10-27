import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const qa=path.dirname(fileURLToPath(import.meta.url)), adb=path.resolve(qa,'../../../../.native-tools/android/platform-tools/adb');
const call=args=>execFileSync(adb,['-s','emulator-5554',...args],{encoding:'utf8',timeout:15000}).trim();
const pid=call(['shell','pidof','ru.mirea.spatialatlas']).split(' ')[0];
const port=call(['forward','tcp:0',`localabstract:webview_devtools_remote_${pid}`]);
try {
 const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=pages.find(p=>/^https?:\/\/localhost/.test(p.url));
 if(!target)throw Error('Own local app WebView page missing');
 const url=new URL(target.webSocketDebuggerUrl);url.hostname='127.0.0.1';url.port=port;
 const result=await new Promise((resolve,reject)=>{
  const ws=new WebSocket(url);const timer=setTimeout(()=>{ws.close();reject(Error('Read-only CDP timeout'));},10000);
  ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'({userLocation:window.__atlas?.state.userLocation,tracking:window.__atlas?.state.locationTracking,surveyLocation:window.__atlas?.state.surveyLocation,headingStatus:window.__atlas?.state.headingStatus,heading:window.__atlas?.scene.userHeading,camera:{position:window.__atlas?.scene.camera?.position?.toArray(),zoom:window.__atlas?.scene.camera?.zoom,target:window.__atlas?.scene.controls?.target?.toArray(),followAnchor:window.__atlas?.scene.userLocationFollowAnchor?.toArray(),transition:window.__atlas?.scene.transition?{to:window.__atlas.scene.transition.to?.toArray(),toTarget:window.__atlas.scene.transition.toTarget?.toArray(),start:window.__atlas.scene.transition.start}:null},route:window.__atlas?.routes?.getRoute?.(),picker:{active:window.__atlas?.scene.locationPicking,valid:document.querySelector("#location-crosshair")?.dataset.valid,label:document.querySelector("#location-pick-validity")?.textContent},view:{floorId:window.__atlas?.state.floor?.id,building:window.__atlas?.state.building,mode:window.__atlas?.state.mode,projection:window.__atlas?.scene.plan?"2d":"3d"}})',returnByValue:true}})));
  ws.addEventListener('message',event=>{const x=JSON.parse(event.data);if(x.id!==1)return;clearTimeout(timer);ws.close();if(x.error||x.result?.exceptionDetails)reject(Error(JSON.stringify(x)));else resolve(x.result.result.value);});
  ws.addEventListener('error',e=>{clearTimeout(timer);reject(Error('Own WebView read failed'));});
 });
 const record={recordedAt:new Date().toISOString(),method:'Read-only Runtime.evaluate through ADB-forwarded own debug WebView; no app state mutation',...result};
 fs.writeFileSync(path.join(qa,(process.argv[2]||'state')+'.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
} finally {call(['forward','--remove',`tcp:${port}`]);}
