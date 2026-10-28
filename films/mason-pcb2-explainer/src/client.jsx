import React from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import * as THREE from 'three';
import {STLLoader} from 'three/addons/loaders/STLLoader.js';
import plan from '../plan.json';
const clamp=x=>Math.max(0,Math.min(1,x));
const ease=x=>{x=clamp(x);return x*x*(3-2*x)};
const seg=(t,a,b)=>ease((t-a)/(b-a));
const lerp=(a,b,p)=>a+(b-a)*p;
const shots=Object.fromEntries(plan.shots.map(s=>[s.id,s]));
const event=id=>plan.shots.flatMap(s=>s.actions.map(a=>({...a,time:s.start+a.at}))).find(a=>a.id===id).time;
let board,mechanics,models={},scene,camera,renderer,rootGroup,pcb,metal,standalone,jig,unit,screws,active='intro';
const root=createRoot(document.getElementById('film-root'));
const pathD=pts=>pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(3)},${(-y).toFixed(3)}`).join(' ')+'Z';
const allPads=()=>board.pads.map(p=>p.parts.map(q=>pathD(q.points)+(q.holes||[]).map(pathD).join('')).join('')).join('');
function Logo(){return <span className="brand"><svg viewBox="0 0 64 64"><path d="M14 14H50V26H26V38H50V50H14"/><circle cx="14" cy="14" r="4"/><circle cx="14" cy="50" r="4"/></svg>MASON<span className="brand-cn">泥瓦匠</span></span>}
function BoardDiagram({t}){
  const p=seg(t,.1,2.3),reveal=seg(t,.7,2.2),w=board.width,h=board.height;
  return <div className="board-diagram"><svg viewBox="-64 -51 128 102">
    <defs><clipPath id="scan-mask"><rect x={-w/2-1} y={-h/2-1} width={(w+2)*reveal} height={h+2}/></clipPath></defs>
    <path d={pathD(board.outline)} fill="#E2ECE4" stroke="none"/>
    <path d={pathD(board.outline)} fill="none" stroke="#3E7D62" strokeWidth=".28" pathLength="1" strokeDasharray="1" strokeDashoffset={1-p}/>
    <g clipPath="url(#scan-mask)"><path d={allPads()} fill="#507C68" fillRule="evenodd"/></g>
    {reveal>0&&reveal<1&&<line x1={-w/2+w*reveal} x2={-w/2+w*reveal} y1={-h/2-4} y2={h/2+4} stroke="#D9913D" strokeWidth=".4"/>}
    <g className="dimensions" opacity={seg(t,1.6,2.3)}><path d={`M${-w/2},${h/2+4}v7m${w},-7v7M${-w/2},${h/2+9}H${w/2}`}/><path d={`M${w/2+4},${-h/2}h7m-7,${h}h7M${w/2+9},${-h/2}V${h/2}`}/><text x="0" y={h/2+15} textAnchor="middle">{w.toFixed(0)} mm</text><text x={w/2+14} y="1" textAnchor="middle" transform={`rotate(90 ${w/2+14} 1)`}>{h.toFixed(0)} mm</text></g>
  </svg><div className="diagram-tag">TOP PASTE <span>{board.topCount} 个解析焊盘</span></div></div>
}
function Film({time=0}){
  const shot=plan.shots.find(s=>time>=s.start&&time<s.end)||plan.shots.at(-1);
  active=shot.id;const local=time-shot.start,assembly=shot.id==='assembly';
  const stage=!assembly?'':time<event('clamp')-1.4?'四层结构，一目了然':time<event('clamp')+.8?'01 / 先夹紧金属钢网':time<event('seat')?'02 / 整体沿定位柱落下':'03 / 落位完成';
  const headlines={intro:<>一块板子。<br/><em>两种做法。</em></>,parse:<>读懂板框，<br/><em>也读懂焊盘。</em></>,modes:<>选对工具，<br/><em>开始制作。</em></>,assembly:<>先夹紧，<br/><em>再定位。</em></>,export:<>从文件，<br/>到<em>打印模型。</em></>};
  const details={intro:'把 Gerber 变成适合你的锡膏印刷工具。',parse:'轮廓与锡膏层来自同一份 Gerber，保留板子的真实形状与焊盘位置。',modes:'已有金属钢网，配套生成夹具。\n快速原型，也可以打印一体式钢网。',assembly:'顶盖与底座夹住钢网，再一起落到承托 PCB 的托盘上。',export:'预览确认后，导出 STL 或 STEP。\n下载同款示例，亲手试一遍。'};
  return <main id="film"><div className="paper-lines"/><header><Logo/><span className="header-note">FROM GERBER TO PRINT<span>PCB2 / 真实示例</span></span></header>
    <div className="scene-copy" style={{transform:`translateY(${local<.32&&time>.4?16*(1-seg(local,0,.32)):0}px)`}}><div className="kicker"><span>{String(plan.shots.indexOf(shot)+1).padStart(2,'0')}</span>{shot.headlineEn}</div><h1>{headlines[shot.id]}</h1><p className="description">{details[shot.id]}</p>
      {shot.id==='intro'&&<div className="sample-chip"><i/>PCB2 <b>85 × 60</b><span>mm</span></div>}
      {shot.id==='parse'&&<div className="layer-list"><div><b>.GKO</b><span>板框轮廓</span><i>已识别</i></div><div><b>.GTP</b><span>顶层锡膏</span><i>{board.topCount} 个焊盘</i></div><div><b>.GBP</b><span>底层锡膏</span><i>{board.bottomCount} 个焊盘</i></div></div>}
      {assembly&&<div className="part-legend">{[['A','A 面顶盖','amber'],['—','金属钢网','silver'],['B','B 面底座','blue'],['C','PCB 托盘','green']].map(([n,label,color])=><div key={color}><i className={color}/><b>{n}</b><span>{label}</span></div>)}<small>四角：一体定位柱<br/>周圈：夹紧螺丝</small></div>}
      {shot.id==='export'&&<div className="file-formats"><b>STL</b><b>STEP</b><span>本地生成 · 离线可用</span></div>}
    </div><div id="model-mount" style={{opacity:shot.id==='parse'?0:1}}/>
    {shot.id==='parse'&&<BoardDiagram t={local}/>}
    {shot.id==='modes'&&<div className="mode-captions"><div><b>钢网夹具</b><span>配合金属钢网使用</span></div><div><b>一体式 PCB 钢网</b><span>可直接打印，独立使用</span></div></div>}
    {assembly&&<div className="assembly-status"><span className="status-dot"/>{stage}</div>}
    {shot.id==='intro'&&<div className="model-caption">实际板框与锡膏层驱动 <span>85 × 60 mm</span></div>}
    {shot.id==='export'&&<div className="end-tag"><span>TRY THIS BOARD</span><b>官网提供同款 Gerber 示例 ↓</b></div>}
    <footer><div className="chapter-track">{plan.shots.map(s=><div className={s.id===shot.id?'on':time>=s.end?'done':''} key={s.id}><span style={{width:clamp((time-s.start)/(s.end-s.start))*100+'%'}}/>{({intro:'真实板子',parse:'解析 Gerber',modes:'两种模式',assembly:'装配关系',export:'导出模型'})[s.id]}</div>)}</div><span className="footer-note">MASON / OPEN SOURCE</span></footer>
  </main>
}
function shape(points,holes=[]){const s=new THREE.Shape(points.map(([x,y])=>new THREE.Vector2(x,y)));for(const h of holes)s.holes.push(new THREE.Path(h.map(([x,y])=>new THREE.Vector2(x,y))));return s;}
function plate(points,height,color,holes=[]){const geo=new THREE.ExtrudeGeometry(shape(points,holes),{depth:height,bevelEnabled:false,curveSegments:16});geo.rotateX(-Math.PI/2);return new THREE.Mesh(geo,new THREE.MeshStandardMaterial({color,roughness:.58,metalness:color===0xbfcac7?.65:.05}));}
function mesh(name,color){const g=models[name].clone();g.computeVertexNormals();return new THREE.Mesh(g,new THREE.MeshStandardMaterial({color,roughness:.53,metalness:.06}));}
function setup3D(){
  const mount=document.getElementById('model-mount');scene=new THREE.Scene();camera=new THREE.OrthographicCamera(-135,135,91,-91,.1,2500);
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,preserveDrawingBuffer:true});renderer.setSize(1180,800);renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.3;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;mount.append(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff,0x9da89c,2.0));const key=new THREE.DirectionalLight(0xfff6e9,3);key.position.set(-100,230,170);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.camera.left=-180;key.shadow.camera.right=180;key.shadow.camera.top=180;key.shadow.camera.bottom=-180;key.shadow.bias=-.0006;key.shadow.normalBias=.08;scene.add(key);const fill=new THREE.DirectionalLight(0xdbe7ff,1.2);fill.position.set(130,80,-120);scene.add(fill);
  rootGroup=new THREE.Group();scene.add(rootGroup);pcb=new THREE.Group();const boardBody=plate(board.outline,1.6,0x285a47,board.holes);pcb.add(boardBody);
  for(const p of board.pads)for(const q of p.parts){if(q.polarity==='C'||q.points.length<3)continue;const pad=plate(q.points,.025,0xc8b274,q.holes||[]);pad.position.y=1.6;pcb.add(pad);}rootGroup.add(pcb);
  jig=new THREE.Group();rootGroup.add(jig);const tray=mesh('insert',0x5a9b7f);jig.add(tray);unit=new THREE.Group();jig.add(unit);
  const base=mesh('base',0x4c6f94);base.geometry.rotateX(Math.PI);base.geometry.translate(0,4,0);unit.add(base);unit.userData.base=base;
  const cover=mesh('cover',0xd9913d);unit.add(cover);unit.userData.cover=cover;
  const {stencil_size_x:sx,stencil_size_y:sy}=board.params;const holes=board.pads.flatMap(p=>p.parts.filter(q=>q.polarity!=='C').map(q=>q.points));
  metal=plate([[-sx/2,-sy/2],[sx/2,-sy/2],[sx/2,sy/2],[-sx/2,sy/2]],.3,0xbfcac7,holes);unit.add(metal);
  screws=new THREE.Group();unit.add(screws);for(const [x,y] of mechanics.screws){const bolt=new THREE.Group();const shaft=new THREE.Mesh(new THREE.CylinderGeometry(1.45,1.45,7.3,12),new THREE.MeshStandardMaterial({color:0x69726e,metalness:.7,roughness:.4}));shaft.position.y=8.65;bolt.add(shaft);const head=new THREE.Mesh(new THREE.CylinderGeometry(2.8,2.8,1.7,18),shaft.material);head.position.y=13.15;bolt.add(head);bolt.position.set(x,0,-y);screws.add(bolt);}
  standalone=mesh('stencil_top',0x5a9b7f);rootGroup.add(standalone);rootGroup.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=false;}});
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(2000,2000),new THREE.ShadowMaterial({color:0x1f3d31,opacity:.07}));floor.rotation.x=-Math.PI/2;floor.position.y=-.2;floor.receiveShadow=true;scene.add(floor);
}
function update3D(time){
  const local=time-shots[active].start;pcb.visible=false;jig.visible=false;standalone.visible=false;screws.visible=false;pcb.position.set(0,0,0);pcb.rotation.set(0,0,0);pcb.scale.setScalar(1);jig.position.set(0,0,0);jig.scale.setScalar(1);jig.rotation.set(0,0,0);standalone.position.set(0,0,0);standalone.scale.setScalar(1);standalone.rotation.set(0,0,0);rootGroup.rotation.y=0;
  let target=new THREE.Vector3(0,15,0),cam=new THREE.Vector3(175,210,225),zoom=1;
  unit.position.y=0;unit.userData.base.position.y=4;metal.position.y=8;unit.userData.cover.position.y=8.3;
  if(active==='intro'){pcb.visible=true;pcb.scale.setScalar(1.9);pcb.position.y=10;rootGroup.rotation.y=-.16+local*.045;zoom=1.13;target.y=8;}
  else if(active==='modes'){jig.visible=standalone.visible=pcb.visible=screws.visible=true;jig.scale.setScalar(.73);jig.position.set(-62,0,0);pcb.scale.setScalar(.73);pcb.position.set(-62,6.4*.73,0);standalone.scale.setScalar(1);standalone.position.set(64,12,0);rootGroup.rotation.y=-.15+local*.025;target.y=3;cam.set(90,250,260);zoom=.95;}
  else if(active==='assembly'){jig.visible=pcb.visible=true;pcb.position.y=6.4;const closed=seg(time,event('clamp')-1.4,event('clamp')),seated=seg(time,event('seat')-1.4,event('seat'));unit.position.y=lerp(30,0,seated);metal.position.y=lerp(39,8,closed);unit.userData.cover.position.y=lerp(72,8.3,closed);screws.visible=time>=event('clamp')-.4;screws.position.y=lerp(8,0,seg(time,event('clamp')-.4,event('clamp')));target.y=lerp(43,15,seated);cam.set(160,190,245);rootGroup.rotation.y=-.20+seg(local,0,9)*.10;zoom=lerp(.78,1.08,seated);}
  else if(active==='export'){standalone.visible=true;standalone.scale.setScalar(1.55);standalone.position.y=8;rootGroup.rotation.y=-.1+local*.045;zoom=1.2;target.y=3;cam.set(125,230,200);}
  window.__assembly={unit:unit.position.y,base:unit.userData.base.position.y,metal:metal.position.y,cover:unit.userData.cover.position.y};camera.zoom=zoom;camera.position.copy(cam);camera.lookAt(target);camera.updateProjectionMatrix();renderer.render(scene,camera);
}
let playing=false;
window.seek=async time=>{time=Math.max(0,Math.min(plan.duration-.001,time));flushSync(()=>root.render(<Film time={time}/>));if(renderer){const mount=document.getElementById('model-mount');if(renderer.domElement.parentNode!==mount)mount.append(renderer.domElement);update3D(time);}window.__filmTime=time;};
window.playFilm=()=>{if(playing){playing=false;return;}playing=true;const start=performance.now();const tick=now=>{if(!playing)return;const t=(now-start)/1000;if(t>=plan.duration){playing=false;return;}window.seek(t);requestAnimationFrame(tick)};requestAnimationFrame(tick)};
window.__filmReady=(async()=>{[board,mechanics]=await Promise.all(['board.json','mechanics.json'].map(n=>fetch(n).then(r=>r.json())));const loader=new STLLoader();await Promise.all(['insert','base','cover','stencil_top'].map(async n=>{models[n]=loader.parse(await fetch('models/'+n+'.stl').then(r=>r.arrayBuffer()));}));flushSync(()=>root.render(<Film time={0}/>));setup3D();await document.fonts.ready;await window.seek(0);})();
document.addEventListener('keydown',e=>{if(e.code==='Space'){e.preventDefault();window.playFilm();}});
