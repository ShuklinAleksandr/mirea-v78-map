"""Conservative surfaces from supplied Polycam points, without RGB/UV/textures.

Requires Open3D 0.19 and NumPy. No new points, hole filling or route edges.
The source PLY files are read-only; output retains source XYZ coordinates.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import time
from pathlib import Path
import numpy as np
import open3d as o3d

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'analysis/scans-2026-10-28/processed'
ASSETS=ROOT/'src/data/stair-scan-meshes'
DTYPE=np.dtype([('x','<f8'),('y','<f8'),('z','<f8'),('r','u1'),('g','u1'),('b','u1')])
CONFIG={
 1:dict(id='grand-upper',zmax=5.2,floorRange=[-1.575,3.775],axes={'u':[0.9785179506459076,-0.2061616362559561],'v':[-0.2061616362559561,-0.9785179506459076]},ceiling=6.425,landingBands=[-1.575,1.075,3.775],fitBounds={'min':[-19.46,-4.22],'max':[19.34,3.73]}),
 2:dict(id='standard-cell',zmax=3.65,floorRange=[-1.375,2.475],axes={'u':[0,1],'v':[1,0]},ceiling=5.275,landingBands=[-1.375,.425,2.475],fitBounds={'min':[-4.25,-4.15],'max':[4.25,4.05]}),
 3:dict(id='grand-lower',zmax=.25,floorRange=[-9.375,-1.375],axes={'u':[0.10692700089173526,0.9942668738725529],'v':[0.9942668738725529,-0.10692700089173526]},ceiling=2.125,landingBands=[-9.375,-7.425,-5.475,-3.425,-1.375],fitBounds={'min':[-12.198,-4.457],'max':[13.083,3.234]}),
}

def read_xyz(path):
 with path.open('rb') as f:
  while f.readline().strip()!=b'end_header':pass
  offset=f.tell()
 records=np.memmap(path,mode='r',offset=offset,dtype=DTYPE)
 xyz=np.column_stack([records[k] for k in ['x','y','z']])
 return xyz[np.isfinite(xyz).all(1)]

def get_cloud(index,voxel):
 path=ROOT/f'source/lidar/2026-10-26/scan-{index}.ply'
 cache=OUT/f'scan-{index}-normals-{voxel:.3f}.npz'
 if cache.exists():
  v=np.load(cache);return v['points'],v['normals'],int(v['sourceCount'])
 xyz=read_xyz(path);n=len(xyz)
 pcd=o3d.geometry.PointCloud(o3d.utility.Vector3dVector(xyz))
 pcd=pcd.voxel_down_sample(voxel)
 print(f'scan{index}: {n} original, {len(pcd.points)} voxel points',flush=True)
 pcd,_=pcd.remove_statistical_outlier(nb_neighbors=20,std_ratio=3.0)
 pcd.estimate_normals(o3d.geometry.KDTreeSearchParamHybrid(radius=voxel*3.8,max_nn=40))
 print(f'scan{index}: normals estimated, orienting',flush=True)
 pcd.orient_normals_consistent_tangent_plane(20)
 points=np.asarray(pcd.points).copy();normals=np.asarray(pcd.normals).copy()
 # Fix global sign using an observed upper ceiling, not arbitrary +Z normals.
 ceiling=CONFIG[index]['ceiling']
 top=(np.abs(points[:,2]-ceiling)<.06)&(np.abs(normals[:,2])>.85)
 if top.any() and np.median(normals[top,2])>0:normals*=-1
 np.savez_compressed(cache,points=points,normals=normals,sourceCount=np.array(n))
 return points,normals,n

def describe_bands(points,normals):
 bins=np.arange(np.floor(points[:,2].min()/.05)*.05,np.ceil(points[:,2].max()/.05)*.05+.05,.05)
 mask=np.abs(normals[:,2])>.9
 hist,edges=np.histogram(points[mask,2],bins=bins)
 peaks=[]
 for i in np.argsort(hist)[::-1]:
  z=float((edges[i]+edges[i+1])/2)
  if any(abs(z-p['z'])<.2 for p in peaks):continue
  band=mask&(np.abs(points[:,2]-z)<.035)
  p=points[band];n=normals[band]
  peaks.append(dict(z=z,count=len(p),upFraction=float(np.mean(n[:,2]>0)),xyBounds=[p[:,:2].min(0).tolist(),p[:,:2].max(0).tolist()]))
  if len(peaks)>=14:break
 return peaks

def build(index,voxel,triangles):
 start=time.time();cfg=CONFIG[index];points,normals,sourceCount=get_cloud(index,voxel)
 bands=describe_bands(points,normals)
 (OUT/f'scan-{index}-horizontal-bands.json').write_text(json.dumps(bands,indent=2)+'\n')
 print(f'scan{index}: horizontal bands '+json.dumps(bands),flush=True)
 mask=points[:,2]<=cfg['zmax']
 downwardCeilings=normals[:,2]<-.70
 mask &= ~downwardCeilings
 # The compact standard cell has visible straight perimeter walls; cut only
 # captured neighbouring corridor/room protrusions beyond those wall bounds.
 outsideCell=np.zeros(len(points),dtype=bool)
 if index==2:
  outsideCell=(points[:,0]<-4.3)|(points[:,0]>4.5)|(points[:,1]<-4.5)|(points[:,1]>4.5)
  mask &= ~outsideCell
 # Explicitly observed source ceiling above the low landing of standard cell.
 # Restrict to broad +X landing footprint and near-horizontal normals; the real
 # upper flight's treads at this height run near X0 and remain in the data.
 localCeiling=np.zeros(len(points),dtype=bool)
 if index==2:
  localCeiling=(np.abs(points[:,2]-1.425)<.065)&(points[:,0]>1.3)&(np.abs(normals[:,2])>.85)
  mask&=~localCeiling
 selected=points[mask];selectedNormals=normals[mask]
 pcd=o3d.geometry.PointCloud(o3d.utility.Vector3dVector(selected))
 pcd.normals=o3d.utility.Vector3dVector(selectedNormals)
 radii=[voxel*1.5,voxel*2.3,voxel*3.1]
 print(f'scan{index}: BPA {len(selected)} points, radii {radii}',flush=True)
 mesh=o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pcd,o3d.utility.DoubleVector(radii))
 mesh.remove_degenerate_triangles();mesh.remove_duplicated_triangles();mesh.remove_duplicated_vertices();mesh.remove_non_manifold_edges()
 rawTriangles=len(mesh.triangles)
 labels,counts,areas=mesh.cluster_connected_triangles()
 labels=np.asarray(labels);counts=np.asarray(counts)
 minComponent=50
 if len(labels):mesh.remove_triangles_by_mask(counts[labels]<minComponent)
 mesh.remove_unreferenced_vertices()
 retainedTriangles=len(mesh.triangles)
 print(f'scan{index}: {rawTriangles} reconstructed -> {retainedTriangles} component-filtered triangles; simplifying',flush=True)
 if len(mesh.triangles)>triangles:
  mesh=mesh.simplify_quadric_decimation(triangles,boundary_weight=10.0)
 mesh.remove_degenerate_triangles();mesh.remove_duplicated_triangles();mesh.remove_duplicated_vertices();mesh.remove_non_manifold_edges();mesh.remove_unreferenced_vertices();mesh.compute_vertex_normals()
 # Decimation can leave isolated slivers from previously supported components.
 # Keep larger disconnected observed rail/wall patches, discard only tiny debris.
 finalLabels,finalCounts,_=mesh.cluster_connected_triangles()
 finalLabels=np.asarray(finalLabels);finalCounts=np.asarray(finalCounts)
 postMinComponent=10
 if len(finalLabels):mesh.remove_triangles_by_mask(finalCounts[finalLabels]<postMinComponent)
 mesh.remove_unreferenced_vertices();mesh.compute_vertex_normals()
 positions=np.asarray(mesh.vertices);indices=np.asarray(mesh.triangles)
 if len(indices)==0:raise RuntimeError('No supported surface triangles reconstructed')
 bounds=dict(min=positions.min(0).tolist(),max=positions.max(0).tolist())
 source=ROOT/f'source/lidar/2026-10-26/scan-{index}.ply'
 data=dict(id=cfg['id'],schemaVersion=1,positions=np.round(positions,4).ravel().tolist(),indices=indices.ravel().tolist(),
  source=dict(index=index,path=str(source.relative_to(ROOT)),sha256=hashlib.sha256(source.read_bytes()).hexdigest(),pointCount=sourceCount,format='binary-little-endian-ply-point-cloud',facesPresent=False,upAxis='Z',units='not-declared; metre interpretation plausible, not independently surveyed'),
  sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),upAxis='Z',floorRange=cfg['floorRange'],horizontalAxes=cfg['axes'],fitBounds=cfg['fitBounds'],
  landingBands=dict(values=cfg['landingBands'],status='geometric-inference-not-numbered-floor-survey'),bounds=bounds,
  reconstruction=dict(method='observed-surface-ball-pivoting',open3dVersion=o3d.__version__,voxel=voxel,normalRadius=voxel*3.8,normalMaxNeighbours=40,statisticalOutlierStdRatio=3.0,ballRadii=radii,fillHoles=False,minimumComponentTriangles=minComponent,postSimplificationMinimumComponentTriangles=postMinComponent,preSimplificationTriangles=retainedTriangles,targetTriangles=triangles,decimationBoundaryWeight=10.0),
  crop=dict(maxSourceZ=cfg['zmax'],ceilingPointsRemoved=int(np.sum(points[:,2]>cfg['zmax'])),localCeilingPointsRemoved=int(localCeiling.sum()),downwardFacingCeilingPointsRemoved=int(downwardCeilings.sum()),outsideCellPointsRemoved=int(outsideCell.sum()),notes='Captured upper ceilings removed by explicit Z cut and globally oriented downward surface normals (<-0.70 Z), validated against ceiling/floor bands. Standard-cell neighbouring corridor protrusions cropped at X[-4.3,4.5],Y[-4.5,4.5]. No missing surfaces filled. Raw PLY unchanged.'),
  vertexCount=len(positions),triangleCount=len(indices),textures=False,vertexColors=False,uv=False)
 target=ASSETS/f"{cfg['id']}.json";target.write_text(json.dumps(data,separators=(',',':'))+'\n')
 o3d.io.write_triangle_mesh(str(OUT/f"{cfg['id']}.ply"),mesh,write_vertex_normals=True,write_vertex_colors=False,write_triangle_uvs=False)
 (OUT/f"{cfg['id']}-metadata.json").write_text(json.dumps({k:v for k,v in data.items() if k not in ['positions','indices']},indent=2)+'\n')
 print(json.dumps(dict(id=cfg['id'],vertices=len(positions),triangles=len(indices),bytes=target.stat().st_size,seconds=time.time()-start)),flush=True)

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--scan',type=int,choices=[1,2,3],action='append');parser.add_argument('--voxel',type=float,default=.055);parser.add_argument('--triangles',type=int,default=6000);args=parser.parse_args()
 OUT.mkdir(parents=True,exist_ok=True);ASSETS.mkdir(parents=True,exist_ok=True)
 for index in args.scan or [1,2,3]:build(index,args.voxel,args.triangles)
