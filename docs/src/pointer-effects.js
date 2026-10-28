// Small, damped pointer responses. The frame loop stops as soon as it settles.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const mouse = matchMedia('(hover: hover) and (pointer: fine)');
const enabled = () => mouse.matches && !reduced.matches && !document.hidden;
const clamp = value => Math.max(-1,Math.min(1,value));
const controllers=[];

function follow(element, properties, paint) {
  let x=0,y=0,targetX=0,targetY=0,frame=0,last=0,active=false;
  let clientX=0,clientY=0;
  function clear() {
    cancelAnimationFrame(frame);frame=0;last=0;active=false;x=y=targetX=targetY=0;
    for(const name of properties) element.style.removeProperty(name);
    element.removeAttribute('data-pointer-active');element.removeAttribute('data-pointer-settling');
  }
  function tick(now) {
    frame=0;
    if(!enabled()) {clear();return;}
    const dt=last?Math.min(40,now-last):16.67;last=now;
    const blend=1-Math.exp(-dt/65);
    x+=(targetX-x)*blend;y+=(targetY-y)*blend;
    const settled=Math.abs(targetX-x)+Math.abs(targetY-y)<.002;
    if(settled) {x=targetX;y=targetY;last=0;}
    paint(x,y);
    element.dataset.pointerSettling=String(!settled);
    if(!settled) frame=requestAnimationFrame(tick);
    else if(!active) clear();
  }
  function schedule() {if(!frame)frame=requestAnimationFrame(tick);}
  function move(event) {
    if(event.pointerType!=='mouse'||!enabled())return;
    clientX=event.clientX;clientY=event.clientY;
    const bounds=element.getBoundingClientRect();
    if(!bounds.width||!bounds.height)return;
    targetX=clamp((event.clientX-bounds.left)/bounds.width*2-1);
    targetY=clamp((event.clientY-bounds.top)/bounds.height*2-1);
    if(!active) {active=true;x=targetX;y=targetY;}
    element.dataset.pointerActive='true';schedule();
  }
  function leave() {
    active=false;targetX=targetY=0;element.removeAttribute('data-pointer-active');
    if(enabled())schedule();else clear();
  }
  element.addEventListener('pointerenter',move);
  element.addEventListener('pointermove',move,{passive:true});
  element.addEventListener('pointerleave',leave);
  element.addEventListener('pointercancel',clear);
  function checkPosition() {
    if(!active)return;
    const bounds=element.getBoundingClientRect();
    if(clientX<bounds.left||clientX>bounds.right||clientY<bounds.top||clientY>bounds.bottom||bounds.bottom<0||bounds.top>innerHeight)clear();
  }
  controllers.push({element,clear,checkPosition,isActive:()=>active});
}
const hero=document.querySelector('.hero');
follow(hero,['--mouse-x','--mouse-y','--hero-rx','--hero-ry','--hero-x','--hero-y','--grid-x','--grid-y'],(x,y)=>{
  hero.style.setProperty('--mouse-x',(50+x*50).toFixed(2)+'%');
  hero.style.setProperty('--mouse-y',(50+y*50).toFixed(2)+'%');
  hero.style.setProperty('--hero-rx',(-y*1.5).toFixed(3)+'deg');
  hero.style.setProperty('--hero-ry',(x*2).toFixed(3)+'deg');
  hero.style.setProperty('--hero-x',(x*5).toFixed(2)+'px');
  hero.style.setProperty('--hero-y',(y*3).toFixed(2)+'px');
  hero.style.setProperty('--grid-x',(-x*4).toFixed(2)+'px');
  hero.style.setProperty('--grid-y',(-y*3).toFixed(2)+'px');
});
document.querySelectorAll('.mode,.feat,.wf-stage,.steps-v .step').forEach(card=>{
  follow(card,['--spot-x','--spot-y','--tilt-x','--tilt-y'],(x,y)=>{
    card.style.setProperty('--spot-x',(50+x*50).toFixed(2)+'%');
    card.style.setProperty('--spot-y',(50+y*50).toFixed(2)+'%');
    card.style.setProperty('--tilt-x',(-y*1.1).toFixed(3)+'deg');
    card.style.setProperty('--tilt-y',(x*1.3).toFixed(3)+'deg');
  });
});
function reset(){controllers.forEach(controller=>controller.clear());}
reduced.addEventListener('change',reset);mouse.addEventListener('change',reset);
window.addEventListener('blur',reset);
window.addEventListener('resize',reset,{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();});
// Scrolling can move a card out from under a stationary pointer.
let scrollFrame=0;
window.addEventListener('scroll',()=>{
  if(scrollFrame||!controllers.some(controller=>controller.isActive()))return;
  scrollFrame=requestAnimationFrame(()=>{
    scrollFrame=0;
    controllers.forEach(controller=>controller.checkPosition());
  });
},{passive:true});
