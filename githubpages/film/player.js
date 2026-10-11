import { DURATION, SCENES, drawFilm, sceneAt } from './renderer.js';
import { CAPTURES, CLIPS, BRAND } from './captures.js';

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
const videos={};
const clipSources=new Map(), objectUrls=[];
let mediaReady=false, mediaError='';
let seekEpoch=0, seeking=false, resumeAfterSeek=false;
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
function clipTime(entry,time){
  const position=reducedMotion?(entry.stillTime??entry.sourceStart??0):(entry.sourceStart||0)+(time-entry.start)*(entry.rate||1);
  return Math.min(Math.max(0,entry.video.duration-.05),Math.max(0,position));
}
function syncPlayingMedia(){
  if(!mediaReady)return;
  for(const entry of Object.values(videos)){
    const active=currentTime>=entry.start&&currentTime<entry.end;
    if(active&&playing&&!reducedMotion){
      const position=clipTime(entry,currentTime);
      if(Math.abs(entry.video.currentTime-position)>.3)entry.video.currentTime=position;
      if(position>=entry.video.duration-.06&&entry.video.currentTime>=entry.video.duration-.08){entry.video.pause();continue;}
      entry.video.playbackRate=entry.rate||1;
      if(entry.video.paused)entry.video.play().catch(()=>{mediaError='A recorded clip could not play.'});
    }else{
      entry.video.pause();
      // Prepare the next excerpt before its boundary. Seeking only when it
      // becomes visible can briefly draw a frame from the previous playback.
      if(!reducedMotion&&currentTime<entry.start&&!entry.video.seeking&&Math.abs(entry.video.currentTime-(entry.sourceStart||0))>.004)
        entry.video.currentTime=entry.sourceStart||0;
    }
  }
}
async function seekVideo(entry,position){
  if(Math.abs(entry.video.currentTime-position)<.004&&!entry.video.seeking)return;
  await new Promise((resolve,reject)=>{
    const onSeek=()=>{entry.video.removeEventListener('error',onError);resolve()};
    const onError=()=>{entry.video.removeEventListener('seeked',onSeek);reject(new Error('Recorded clip seek failed'))};
    entry.video.addEventListener('seeked',onSeek,{once:true});
    entry.video.addEventListener('error',onError,{once:true});
    entry.video.currentTime=position;
  });
}
async function seekMedia(targetTime=currentTime){
  if(!mediaReady)return;
  await Promise.all(Object.values(videos).map(async entry=>{
    entry.video.pause();
    if(!reducedMotion&&targetTime>=entry.end)return;
    const position=!reducedMotion&&targetTime<entry.start?(entry.sourceStart||0):clipTime(entry,targetTime);
    await seekVideo(entry,position);
  }));
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
  syncPlayingMedia();
  render();
  if(currentTime>=DURATION){pause();return}
  frame=requestAnimationFrame(tick);
}
function play(){
  if(seeking){resumeAfterSeek=true;return;}
  if(playing)return;
  if(currentTime>=DURATION)currentTime=0;
  playing=true;overlay.hidden=true;anchorPosition=currentTime;anchorTime=performance.now();syncButtons();frame=requestAnimationFrame(tick);
  syncPlayingMedia();
}
function pause(){
  resumeAfterSeek=false;
  if(playing)currentTime=Math.min(DURATION,anchorPosition+(performance.now()-anchorTime)/1000);
  playing=false;cancelAnimationFrame(frame);syncButtons();render();
  syncPlayingMedia();
}
async function setTime(value){
  if(!seeking)resumeAfterSeek=playing;
  const epoch=++seekEpoch;seeking=true;playing=false;cancelAnimationFrame(frame);
  currentTime=bounded(value);anchorPosition=currentTime;anchorTime=performance.now();overlay.hidden=true;
  if(currentTime===DURATION)resumeAfterSeek=false;
  syncButtons();
  try{await seekMedia(currentTime)}catch(error){mediaError=error.message;if(epoch===seekEpoch)seeking=false;throw error;}
  if(epoch!==seekEpoch)return;
  seeking=false;render();
  if(resumeAfterSeek)play();else{syncButtons();syncPlayingMedia();}
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
motion.addEventListener('click',()=>{userMotion=true;reducedMotion=!reducedMotion;syncButtons();setTime(currentTime)});
media.addEventListener('change',event=>{if(!userMotion){reducedMotion=event.matches;syncButtons();setTime(currentTime)}});
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
function clipSource(src){
  if(!clipSources.has(src))clipSources.set(src,(async()=>{
    const response=await fetch(src);if(!response.ok)throw new Error('A recorded clip could not load.');
    // Small reviewed clips are buffered once so seeking also works on simple
    // static preview servers without HTTP Range support.
    const url=URL.createObjectURL(await response.blob());objectUrls.push(url);return url;
  })());
  return clipSources.get(src);
}
window.addEventListener('pagehide',event=>{if(!event.persisted)objectUrls.forEach(url=>URL.revokeObjectURL(url))});
const ready=Promise.all([(async()=>{const image=new Image();image.src=BRAND.src;await image.decode();images.brand={image}})(),...Object.entries(CAPTURES).map(async([key,entry])=>{
  const image=new Image();image.src=entry.src;await image.decode();
  let mobileImage;
  if(entry.mobileSrc){mobileImage=new Image();mobileImage.src=entry.mobileSrc;await mobileImage.decode()}
  images[key]={image,mobileImage,crop:entry.crop,mobileCrop:entry.mobileCrop};
}),...Object.entries(CLIPS).map(async([key,entry])=>{
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
  const source=await clipSource(entry.src);
  await new Promise((resolve,reject)=>{video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(`Recorded clip failed: ${key}`)),{once:true});video.src=source;video.load()});
  const required=(entry.sourceStart||0)+(entry.end-entry.start)*(entry.rate||1);
  if(!entry.holdLastFrame&&required>video.duration+.05)throw new Error(`Recorded clip is too short: ${key}`);
  videos[key]={...entry,video};
})]).then(async()=>{
  Object.assign(images,videos);
  await Promise.all(Object.values(videos).map(entry=>seekVideo(entry,entry.sourceStart||0)));
  mediaReady=true;await seekMedia();resize();return true;
});
ready.catch(()=>{$('scene-status').textContent='A product capture could not load. The transcript and controls remain available.';resize()});
Object.defineProperty(window,'film',{value:Object.freeze({duration:DURATION,scenes:SCENES,ready,seek:setTime,play,pause,render:render,
  get currentTime(){return currentTime},get playing(){return playing},get reducedMotion(){return reducedMotion},get captureCount(){return Object.keys(CAPTURES).length},get clipCount(){return Object.keys(videos).length},get mediaError(){return mediaError},
  get mediaState(){return Object.entries(videos).map(([key,entry])=>({key,time:entry.video.currentTime,duration:entry.video.duration,start:entry.start,end:entry.end,paused:entry.video.paused,muted:entry.video.muted,readyState:entry.video.readyState,seeking:entry.video.seeking}))}
})});
syncButtons();resize();
