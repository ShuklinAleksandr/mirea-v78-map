"""Read original Polycam point clouds and make untextured geometric audit views."""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'analysis/scans-2026-10-28'
OUT.mkdir(parents=True, exist_ok=True)
DTYPE=np.dtype([('x','<f8'),('y','<f8'),('z','<f8'),('r','u1'),('g','u1'),('b','u1')])
try: FONT=ImageFont.truetype('/System/Library/Fonts/Menlo.ttc',16)
except OSError: FONT=ImageFont.load_default()

def load(path):
 with path.open('rb') as f:
  header=[]
  while True:
   line=f.readline();header.append(line)
   if line.strip()==b'end_header':break
  offset=f.tell();n=int(next(l for l in header if l.startswith(b'element vertex ')).split()[2])
 a=np.memmap(path,mode='r',offset=offset,dtype=DTYPE,shape=(n,))
 xyz=np.column_stack([a[k] for k in ['x','y','z']])
 return xyz[np.isfinite(xyz).all(1)]

def render(xyz,u,v,depth,title,size=(760,560),height_shading=True):
 # Original point positions only; no meshing/interpolation/invented surfaces.
 u=np.asarray(u);v=np.asarray(v);depth=np.asarray(depth)
 xy=xyz@np.column_stack([u,v]);d=xyz@depth
 mins=np.quantile(xy,.001,axis=0);maxs=np.quantile(xy,.999,axis=0)
 span=maxs-mins;scale=min((size[0]-50)/span[0],(size[1]-75)/span[1])
 pix=(xy-(mins+maxs)/2)*scale
 px=np.rint(pix[:,0]+size[0]/2).astype(np.int32)
 py=np.rint(-pix[:,1]+size[1]/2+15).astype(np.int32)
 valid=(px>=0)&(px<size[0])&(py>=42)&(py<size[1])
 px=px[valid];py=py[valid];d=d[valid];z=xyz[valid,2]
 ids=py*size[0]+px
 buf=np.full(size[0]*size[1],-np.inf)
 np.maximum.at(buf,ids,d)
 front=d>=buf[ids]-0.025
 # Grayscale from height provides visual layers without original RGB/texture.
 zz=np.quantile(xyz[:,2],[.01,.99]);sh=np.clip((z-zz[0])/(zz[1]-zz[0]+1e-9),0,1)
 values=(105+sh*140).astype(np.uint8) if height_shading else np.full(len(z),210,dtype=np.uint8)
 im=np.full(size[0]*size[1],18,dtype=np.uint8)
 np.maximum.at(im,ids[front],values[front])
 rgb=np.repeat(im.reshape(size[1],size[0],1),3,axis=2)
 image=Image.fromarray(rgb)
 draw=ImageDraw.Draw(image);draw.text((15,10),title,fill=(235,235,235),font=FONT)
 # Source units indicated as raw values: metric scale not independently measured.
 draw.text((15,size[1]-25),f'source span {span[0]:.2f} x {span[1]:.2f}',fill=(180,180,180),font=FONT)
 return image

allstats=[]
for index in [1,2,3]:
 xyz=load(ROOT/f'source/lidar/2026-10-26/scan-{index}.ply')
 zlo,zhi=np.quantile(xyz[:,2],[.001,.999]);hist,edges=np.histogram(xyz[:,2],bins=np.arange(np.floor(zlo/.05)*.05,np.ceil(zhi/.05)*.05+.05,.05))
 peaks=[]
 for i in np.argsort(hist)[::-1]:
  z=(edges[i]+edges[i+1])/2
  if all(abs(z-p['z'])>.2 for p in peaks):peaks.append({'z':float(z),'points':int(hist[i])})
  if len(peaks)>=12:break
 stat={'scan':index,'points':len(xyz),'bbox_min':xyz.min(0).tolist(),'bbox_max':xyz.max(0).tolist(),'z_histogram_peaks':peaks}
 allstats.append(stat)
 sample=xyz[::max(1,len(xyz)//1200000)]
 views=[render(sample,[1,0,0],[0,1,0],[0,0,-1],f'SCAN {index}: XY from below, grayscale by Z'),render(sample,[1,0,0],[0,0,1],[0,-1,0],f'SCAN {index}: XZ elevation'),render(sample,[0,1,0],[0,0,1],[1,0,0],f'SCAN {index}: YZ elevation'),render(sample,np.array([1,1,0])/2**.5,np.array([-1,1,2])/6**.5,np.array([1,-1,1])/3**.5,f'SCAN {index}: isometric')]
 canvas=Image.new('RGB',(1520,1120),(10,10,10))
 for k,im in enumerate(views):canvas.paste(im,((k%2)*760,(k//2)*560))
 canvas.save(OUT/f'scan-{index}-views.png')
 # Audit-only ceiling cuts expose flights. These are not production crop bounds.
 zmax={1:4.4,2:4.4,3:0.1}[index]
 cut=sample[sample[:,2]<zmax]
 cutaway=Image.new('RGB',(1520,1120),(10,10,10))
 for k,(name,az) in enumerate([('front',-45),('right',45),('rear',135),('left',225)]):
  a=np.radians(az)
  u=np.array([-np.sin(a),np.cos(a),0])
  d=np.array([np.cos(a),np.sin(a),.8]);d/=np.linalg.norm(d)
  v=np.cross(d,u)
  im=render(cut,u,v,d,f'SCAN {index}: {name}, cut Z < {zmax:.1f}')
  cutaway.paste(im,((k%2)*760,(k//2)*560))
 cutaway.save(OUT/f'scan-{index}-cutaway.png')
 # Relative height bands reveal stairs that would be hidden by upper slabs.
 cuts=np.linspace(zlo,zhi,7)
 slices=Image.new('RGB',(1520,1680),(10,10,10))
 for k in range(6):
  band=sample[(sample[:,2]>=cuts[k])&(sample[:,2]<cuts[k+1])]
  im=render(band,[1,0,0],[0,1,0],[0,0,1],f'SCAN {index}: Z {cuts[k]:.2f} .. {cuts[k+1]:.2f}',height_shading=False)
  slices.paste(im,((k%2)*760,(k//2)*560))
 slices.save(OUT/f'scan-{index}-height-bands.png')
 print(json.dumps(stat))
(OUT/'point-statistics.json').write_text(json.dumps(allstats,indent=2)+'\n')
