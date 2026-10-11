import { DURATION, SCENES, drawFilm, sceneAt } from './renderer.js';
import { CAPTURES } from './captures.js';

const $ = id => document.getElementById(id);
const player=$('player'), canvas=$('film-canvas'), ctx=canvas.getContext('2d',{alpha:false});
const playButton=$('play'), seek=$('seek'), overlay=$('start-overlay'), motion=$('motion');
const media=window.matchMedia('(prefers-reduced-motion: reduce)');
const params=new URLSearchParams(location.search);
const preview=params.has('t');
const bounded=value=>Math.min(DURATION,Math.max(0,Number.isFinite(Number(value))?Number(value):0));
let currentTime=bounded(params.get('t')||0), playing=false, reducedMotion=media.matches;
let anchorTime=0, anchorPosition=0, frame=0, previousScene=-1, userMotion=false;
const images={};
const format=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;

if(params.get('render')==='1')document.body.classList.add('render-mode');
if(preview)overlay.hidden=true;
function render(){
  drawFilm(ctx,currentTime,canvas.width,canvas.height,{reducedMotion,images});
  seek.value=String(currentTime);
  seek.setAttribute('aria-valuetext',`${Math.floor(currentTime)} seconds of 60`);
  $('time').textContent=`${format(currentTime)} / 1:00`;
  const scene=sceneAt(currentTime);
  if(scene!==previousScene){
    previousScene=scene;
    $('scene-status').textContent=`Scene ${scene+1} of ${SCENES.length}: ${SCENES[scene].title}`;
    canvas.setAttribute('aria-label',`${SCENES[scene].title}. ${SCENES[scene].text}`);
    document.querySelectorAll('[data-chapter]').forEach((b,i)=>b.setAttribute('aria-current',i===scene?'true':'false'));
  }
}
function syncButtons(){
  playButton.setAttribute('aria-label',playing?'Pause film':currentTime===DURATION?'Replay film':'Play film');
  playButton.querySelector('.play-icon').textContent=playing?'Ⅱ':currentTime===DURATION?'↺':'▶';
  playButton.querySelector('.play-label').textContent=playing?'Pause':currentTime===DURATION?'Replay':'Play';
  motion.setAttribute('aria-pressed',String(reducedMotion));
  motion.title=reducedMotion?'Gentle motion on: scenes change without animated movement':'Reduce animated movement';
}
function tick(now){
  if(!playing)return;
  currentTime=Math.min(DURATION,anchorPosition+(now-anchorTime)/1000);
  render();
  if(currentTime>=DURATION){pause();return}
  frame=requestAnimationFrame(tick);
}
function play(){
  if(playing)return;
  if(currentTime>=DURATION)currentTime=0;
  playing=true;overlay.hidden=true;anchorPosition=currentTime;anchorTime=performance.now();syncButtons();frame=requestAnimationFrame(tick);
}
function pause(){
  if(playing)currentTime=Math.min(DURATION,anchorPosition+(performance.now()-anchorTime)/1000);
  playing=false;cancelAnimationFrame(frame);syncButtons();render();
}
function setTime(value){
  currentTime=bounded(value);anchorPosition=currentTime;anchorTime=performance.now();overlay.hidden=true;
  if(currentTime===DURATION){playing=false;cancelAnimationFrame(frame)}
  syncButtons();render();
}
function resize(){
  const rect=canvas.getBoundingClientRect(),ratio=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.round(rect.width*ratio));canvas.height=Math.max(1,Math.round(rect.height*ratio));render();
}
async function fullscreen(){
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else if(player.requestFullscreen)await player.requestFullscreen();
  }catch{ $('scene-status').textContent='Fullscreen is unavailable in this browser. The film still plays in this page.'; }
}

SCENES.forEach((scene,index)=>{
  const li=document.createElement('li'),button=document.createElement('button'),copy=document.createElement('p'),title=document.createElement('strong');
  button.type='button';button.textContent=format(scene.start);button.dataset.chapter=String(index);button.setAttribute('aria-label',`Jump to ${scene.title} at ${format(scene.start)}`);
  button.addEventListener('click',()=>{pause();setTime(scene.start);player.focus()});
  title.textContent=scene.title;copy.append(title,document.createTextNode(scene.text));li.append(button,copy);$('chapters').append(li);
});

playButton.addEventListener('click',()=>playing?pause():play());
overlay.addEventListener('click',()=>{play();playButton.focus()});
$('replay').addEventListener('click',()=>{setTime(0);play()});
seek.addEventListener('input',()=>setTime(seek.value));
motion.addEventListener('click',()=>{userMotion=true;reducedMotion=!reducedMotion;syncButtons();render()});
media.addEventListener('change',event=>{if(!userMotion){reducedMotion=event.matches;syncButtons();render()}});
$('fullscreen').addEventListener('click',fullscreen);
if(!document.fullscreenEnabled)$('fullscreen').hidden=true;
document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen');resize()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
player.addEventListener('keydown',event=>{
  if(event.target.matches('input, button, a, select, textarea'))return;
  const key=event.key.toLowerCase();
  if(key===' '||key==='k'){event.preventDefault();playing?pause():play()}
  else if(key==='arrowleft'||key==='arrowright'){event.preventDefault();setTime(currentTime+(key==='arrowleft'?-5:5))}
  else if(key==='home'||key==='end'){event.preventDefault();setTime(key==='home'?0:DURATION)}
  else if(key==='f'){event.preventDefault();fullscreen()}
});
const observer=new ResizeObserver(resize);observer.observe(canvas);
const ready=Promise.all(Object.entries(CAPTURES).map(async([key,entry])=>{
  const image=new Image();image.src=entry.src;await image.decode();
  let mobileImage;
  if(entry.mobileSrc){mobileImage=new Image();mobileImage.src=entry.mobileSrc;await mobileImage.decode()}
  images[key]={image,mobileImage,crop:entry.crop,mobileCrop:entry.mobileCrop};
})).then(()=>{resize();return true});
ready.catch(()=>{$('scene-status').textContent='A product capture could not load. The illustrated story and controls remain available.';resize()});
Object.defineProperty(window,'film',{value:Object.freeze({duration:DURATION,scenes:SCENES,ready,seek:setTime,play,pause,render:render,
  get currentTime(){return currentTime},get playing(){return playing},get reducedMotion(){return reducedMotion},get captureCount(){return Object.keys(images).length}
})});
syncButtons();resize();
