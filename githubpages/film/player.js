import { DURATION, SCENES, FILM, drawFilm, sceneAt } from './renderer.js';
import { CAPTURES, CLIPS, BRAND } from './captures.js';

const $ = id => document.getElementById(id);
const player=$('player'), canvas=$('film-canvas'), ctx=canvas.getContext('2d',{alpha:false});
const playButton=$('play'), seek=$('seek'), overlay=$('start-overlay'), motion=$('motion'), speed=$('playback-speed');
const media=window.matchMedia('(prefers-reduced-motion: reduce)');
const params=new URLSearchParams(location.search);
const preview=params.has('t');
const bounded=value=>Math.min(DURATION,Math.max(0,Number.isFinite(Number(value))?Number(value):0));
let currentTime=bounded(params.get('t')||0), playing=false, reducedMotion=media.matches;
let playbackRate=1;
let anchorTime=0, anchorPosition=0, frame=0, previousScene=-1, userMotion=false;
const images={};
const videos={};
const clipSources=new Map(), objectUrls=[];
let mediaReady=false, mediaFailed=false, mediaError='', mediaStatus='loading', showOverlay=!preview;
let seekEpoch=0, seeking=false, resumeAfterSeek=false;
let mediaSeek=Promise.resolve();
const format=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
const fps=FILM.fps??30;
const durationLabel=format(DURATION);

seek.max=String(DURATION);
player.setAttribute('aria-label',`${FILM.title}. ${durationLabel}. Silent guided walkthrough`);
overlay.setAttribute('aria-label',`Play ${FILM.title}, ${durationLabel}`);
if(overlay.querySelector('small'))overlay.querySelector('small').textContent=`${durationLabel} · no audio`;
document.querySelectorAll('.film-duration, [data-film-duration]').forEach(el=>{el.textContent=durationLabel});
document.querySelectorAll('[data-film-title]').forEach(el=>{el.textContent=FILM.title});
document.querySelectorAll('[data-film-stage]').forEach(el=>{
  el.hidden=FILM.stage!=='prototype';el.textContent=FILM.stage==='prototype'?(FILM.stageLabel||'First act prototype'):'';
});
document.querySelectorAll('.download-link, [data-film-download]').forEach(link=>{
  const available=FILM.exportReady===true&&FILM.downloadReady===true;
  link.hidden=!available;
  if(available){link.setAttribute('href',FILM.exportFilename);link.setAttribute('download',FILM.exportFilename)}
  else link.removeAttribute('href');
});

if(params.get('render')==='1')document.body.classList.add('render-mode');
if(preview)overlay.hidden=true;
function render(){
  drawFilm(ctx,currentTime,canvas.width,canvas.height,{reducedMotion,images,mediaStatus});
  seek.value=String(currentTime);
  seek.setAttribute('aria-valuetext',`${format(currentTime)} of ${durationLabel}`);
  $('time').textContent=`${format(currentTime)} / ${durationLabel}`;
  if(mediaStatus==='loading'){
    canvas.setAttribute('aria-label','Loading walkthrough. Preparing the recorded footage.');
    $('scene-status').textContent='Loading walkthrough. Preparing the recorded footage.';
    previousScene=-1;return;
  }
  const scene=sceneAt(currentTime);
  if(scene!==previousScene){
    previousScene=scene;
    $('scene-status').textContent=`Chapter ${scene+1} of ${SCENES.length}: ${SCENES[scene].title}`;
    canvas.setAttribute('aria-label',`${SCENES[scene].title}. ${SCENES[scene].text}`);
    document.querySelectorAll('[data-chapter]').forEach(b=>b.setAttribute('aria-current',Number(b.dataset.chapter)===scene?'true':'false'));
  }
}
function clipBounds(entry){
  const start=entry.sourceStart??0;
  const sourceEnd=entry.sourceEnd??(start+(entry.end-entry.start-(entry.holdLead??0)-(entry.holdTail??0))*(entry.rate??1));
  return {start,end:Math.min(Math.max(0,entry.video.duration-.05),sourceEnd)};
}
function clipTime(entry,time){
  const {start,end}=clipBounds(entry);
  const position=reducedMotion?(entry.stillTime??start):start+Math.max(0,time-entry.start-(entry.holdLead??0))*(entry.rate??1);
  return Math.min(end,Math.max(start,position));
}
function clipHold(entry,time){
  if(time<entry.start||time>=entry.end)return null;
  if(reducedMotion)return 'still';
  if(time<entry.start+(entry.holdLead??0))return 'lead';
  const {start,end}=clipBounds(entry);
  return time>=entry.start+(entry.holdLead??0)+(end-start)/(entry.rate??1)?'tail':null;
}
function syncPlayingMedia(){
  if(!mediaReady&&!mediaFailed)return;
  for(const entry of Object.values(videos)){
    const rate=(entry.rate??1)*playbackRate;
    if(entry.video.playbackRate!==rate)entry.video.playbackRate=rate;
    const active=currentTime>=entry.start&&currentTime<entry.end;
    const hold=clipHold(entry,currentTime);
    if(active&&playing&&!hold){
      const position=clipTime(entry,currentTime);
      if(Math.abs(entry.video.currentTime-position)>.3)entry.video.currentTime=position;
      if(position>=entry.video.duration-.06&&entry.video.currentTime>=entry.video.duration-.08){entry.video.pause();continue;}
      if(entry.video.paused)entry.video.play().catch(()=>{mediaError='A recorded clip could not play.'});
    }else{
      entry.video.pause();
      if(active&&hold&&!entry.video.seeking&&Math.abs(entry.video.currentTime-clipTime(entry,currentTime))>.004)
        entry.video.currentTime=clipTime(entry,currentTime);
      // Prepare the next excerpt before its boundary. Seeking only when it
      // becomes visible can briefly draw a frame from the previous playback.
      if(!reducedMotion&&currentTime<entry.start&&!entry.video.seeking&&Math.abs(entry.video.currentTime-(entry.sourceStart||0))>.004)
        entry.video.currentTime=entry.sourceStart||0;
    }
  }
}
async function seekVideo(entry,position){
  if(entry.video.error)throw new Error('Recorded clip could not be decoded');
  if(Math.abs(entry.video.currentTime-position)<.004&&!entry.video.seeking&&entry.video.readyState>=2)return;
  await new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timeout);entry.video.removeEventListener('seeked',onSeek);entry.video.removeEventListener('error',onError)};
    const onSeek=()=>{cleanup();resolve()};
    const onError=()=>{cleanup();reject(new Error('Recorded clip seek failed'))};
    const timeout=setTimeout(()=>{
      cleanup();const error=new Error('Recorded clip seek timed out');error.code='FILM_SEEK_TIMEOUT';reject(error);
    },15000);
    entry.video.addEventListener('seeked',onSeek,{once:true});
    entry.video.addEventListener('error',onError,{once:true});
    try{entry.video.currentTime=position}catch(error){cleanup();reject(error)}
  });
}
async function prepareMedia(){
  const entries=Object.values(videos);let next=0;
  // Keep decoder preparation bounded. A busy browser may settle a timed-out
  // seek shortly afterward; retry that seek once, without hiding real failures.
  const workers=Array.from({length:Math.min(4,entries.length)},async()=>{
    while(next<entries.length){
      const entry=entries[next++],position=entry.sourceStart||0;
      try{await seekVideo(entry,position)}catch(error){
        if(error.code!=='FILM_SEEK_TIMEOUT'||entry.video.error)throw error;
        await seekVideo(entry,position);
      }
    }
  });
  const results=await Promise.allSettled(workers);
  const failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
}
async function seekMedia(targetTime=currentTime,{initializing=false}={}){
  if(!mediaReady&&!mediaFailed&&!initializing)return;
  await Promise.all(Object.values(videos).map(async entry=>{
    entry.video.pause();
    // The renderer keeps its final shot visible at the exact timeline end.
    const finalFrame=targetTime===DURATION&&entry.end===DURATION;
    if(!reducedMotion&&targetTime>=entry.end&&!finalFrame)return;
    const position=!reducedMotion&&targetTime<entry.start?(entry.sourceStart||0):clipTime(entry,targetTime);
    await seekVideo(entry,position);
  }));
}
function syncButtons(){
  const unavailable=mediaStatus!=='ready';
  playButton.disabled=unavailable;overlay.disabled=unavailable;$('replay').disabled=unavailable;
  overlay.hidden=!showOverlay||unavailable;
  player.setAttribute('aria-busy',String(mediaStatus==='loading'));
  player.dataset.mediaState=mediaStatus;
  playButton.setAttribute('aria-label',mediaStatus==='loading'?'Loading walkthrough':playing?'Pause film':currentTime===DURATION?'Replay film':'Play film');
  playButton.querySelector('.play-icon').textContent=playing?'Ⅱ':currentTime===DURATION?'↺':'▶';
  playButton.querySelector('.play-label').textContent=mediaStatus==='loading'?'Loading…':playing?'Pause':currentTime===DURATION?'Replay':'Play';
  motion.setAttribute('aria-pressed',String(reducedMotion));
  motion.title=reducedMotion?'Gentle motion on: scenes change without animated movement':'Reduce animated movement';
  if(speed)speed.value=String(playbackRate);
  if($('media-error-panel'))$('media-error-panel').hidden=mediaStatus!=='error';
}
function playingTime(now=performance.now()){
  return Math.min(DURATION,anchorPosition+(now-anchorTime)/1000*playbackRate);
}
function setPlaybackRate(value){
  const rate=Number(value);
  if(![1,2,5].includes(rate))throw new RangeError('Playback speed must be 1, 2, or 5.');
  const now=performance.now();
  if(playing)currentTime=playingTime(now);
  anchorPosition=currentTime;anchorTime=now;playbackRate=rate;
  syncButtons();
  if(playing&&currentTime===DURATION)setTime(DURATION,{playAfterSeek:false}).catch(reportError);
  else if(!seeking){syncPlayingMedia();render();}
  return playbackRate;
}
function tick(now){
  if(!playing)return;
  currentTime=playingTime(now);
  if(currentTime>=DURATION){setTime(DURATION,{playAfterSeek:false}).catch(reportError);return}
  syncPlayingMedia();
  render();
  frame=requestAnimationFrame(tick);
}
function play(){
  if(mediaStatus!=='ready')return;
  if(seeking){resumeAfterSeek=true;return;}
  if(playing)return;
  if(currentTime>=DURATION){setTime(0,{playAfterSeek:true}).catch(reportError);return;}
  playing=true;showOverlay=false;anchorPosition=currentTime;anchorTime=performance.now();syncButtons();frame=requestAnimationFrame(tick);
  syncPlayingMedia();
}
function pause(){
  resumeAfterSeek=false;
  if(playing)currentTime=playingTime();
  playing=false;cancelAnimationFrame(frame);syncButtons();render();
  syncPlayingMedia();
}
async function setTime(value,{playAfterSeek}={}){
  if(!seeking)resumeAfterSeek=playing;
  if(playAfterSeek!==undefined)resumeAfterSeek=playAfterSeek;
  const epoch=++seekEpoch;seeking=true;playing=false;cancelAnimationFrame(frame);
  currentTime=bounded(value);anchorPosition=currentTime;anchorTime=performance.now();showOverlay=false;
  if(currentTime===DURATION)resumeAfterSeek=false;
  syncButtons();
  const targetTime=currentTime;
  try{
    if(!mediaReady&&!mediaFailed)await ready;
    // One media seek owns each seeked event. Superseded requests may finish,
    // but cannot release a newer request before its own decoded frame is ready.
    mediaSeek=mediaSeek.catch(()=>{}).then(()=>epoch===seekEpoch?seekMedia(targetTime):undefined);
    await mediaSeek;
  }catch(error){
    if(epoch===seekEpoch){seeking=false;resumeAfterSeek=false;render();reportError(error)}
    throw error;
  }
  if(epoch!==seekEpoch)return;
  seeking=false;render();
  if(resumeAfterSeek)play();else{syncButtons();syncPlayingMedia();}
}
function reportError(error){
  mediaError=error.message||'A product capture could not load.';
  if($('media-error-message'))$('media-error-message').textContent=error.code==='FILM_SEEK_TIMEOUT'
    ?'A recorded scene took too long to prepare. Reload the walkthrough to try again.'
    :'The walkthrough could not load. Check your connection and reload to try again.';
  $('scene-status').textContent='A product capture could not load. The transcript and controls remain available.';
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
  const jump=()=>{pause();setTime(scene.start).catch(reportError);player.focus()};
  button.addEventListener('click',jump);
  title.textContent=scene.title;copy.append(title,document.createTextNode(` ${scene.text}`));li.append(button,copy);$('chapters')?.append(li);
  if($('chapter-nav')){
    const chapter=document.createElement('button');chapter.type='button';chapter.dataset.chapter=String(index);
    const timestamp=document.createElement('span'),name=document.createElement('span');
    timestamp.className='chapter-time';timestamp.textContent=format(scene.start);name.className='chapter-title';name.textContent=scene.title;
    chapter.append(timestamp,name);chapter.setAttribute('aria-label',`Jump to ${scene.title} at ${format(scene.start)}`);
    chapter.addEventListener('click',jump);$('chapter-nav').append(chapter);
  }
});

playButton.addEventListener('click',()=>playing?pause():play());
overlay.addEventListener('click',()=>{play();playButton.focus()});
$('replay').addEventListener('click',()=>setTime(0,{playAfterSeek:true}).catch(reportError));
seek.addEventListener('input',()=>setTime(seek.value).catch(reportError));
speed?.addEventListener('change',()=>setPlaybackRate(speed.value));
$('retry-media')?.addEventListener('click',()=>location.reload());
motion.addEventListener('click',()=>{userMotion=true;reducedMotion=!reducedMotion;syncButtons();setTime(currentTime).catch(reportError)});
media.addEventListener('change',event=>{if(!userMotion){reducedMotion=event.matches;syncButtons();setTime(currentTime).catch(reportError)}});
$('fullscreen').addEventListener('click',fullscreen);
if(!document.fullscreenEnabled)$('fullscreen').hidden=true;
document.addEventListener('fullscreenchange',()=>{$('fullscreen').setAttribute('aria-label',document.fullscreenElement?'Exit fullscreen':'Enter fullscreen');resize()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()});
player.addEventListener('keydown',event=>{
  if(event.target.matches('input, button, a, select, textarea'))return;
  const key=event.key.toLowerCase();
  if(key===' '||key==='k'){event.preventDefault();playing?pause():play()}
  else if(key==='arrowleft'||key==='arrowright'){event.preventDefault();setTime(currentTime+(key==='arrowleft'?-5:5)).catch(reportError)}
  else if(key==='home'||key==='end'){event.preventDefault();setTime(key==='home'?0:DURATION).catch(reportError)}
  else if(key==='f'){event.preventDefault();fullscreen()}
});
const observer=new ResizeObserver(resize);observer.observe(canvas);
function clipSource(src){
  if(!clipSources.has(src))clipSources.set(src,(async()=>{
    const response=await fetch(src);if(!response.ok)throw new Error('A recorded clip could not load.');
    // Reviewed clips are buffered once so seeking also works on simple
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
  const rate=entry.rate??1,sourceStart=entry.sourceStart??0,holdLead=entry.holdLead??0,holdTail=entry.holdTail??0;
  if(![entry.start,entry.end,rate,sourceStart,holdLead,holdTail].every(Number.isFinite)||entry.start<0||entry.end> DURATION||entry.end<=entry.start||rate<=0||sourceStart<0||holdLead<0||holdTail<0)
    throw new Error(`Recorded clip has invalid timing: ${key}`);
  const sourceEnd=entry.sourceEnd??(sourceStart+(entry.end-entry.start-holdLead-holdTail)*rate);
  if(!Number.isFinite(sourceEnd)||sourceEnd<=sourceStart||Math.abs(holdLead+(sourceEnd-sourceStart)/rate+holdTail-(entry.end-entry.start))>1e-6)
    throw new Error(`Recorded clip holds do not match its timeline: ${key}`);
  const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';
  video.playbackRate=rate*playbackRate;
  const source=await clipSource(entry.src);
  await new Promise((resolve,reject)=>{video.addEventListener('loadeddata',resolve,{once:true});video.addEventListener('error',()=>reject(new Error(`Recorded clip failed: ${key}`)),{once:true});video.src=source;video.load()});
  if(!Number.isFinite(video.duration)||video.duration<=0||sourceStart>video.duration-.05)throw new Error(`Recorded clip has no usable source frames: ${key}`);
  if((entry.sourceEnd!==undefined||!entry.holdLastFrame)&&sourceEnd>video.duration+.05)throw new Error(`Recorded clip is too short: ${key}`);
  videos[key]={...entry,video};
})]).then(async()=>{
  Object.assign(images,videos);
  await prepareMedia();
  await seekMedia(currentTime,{initializing:true});
  mediaReady=true;mediaFailed=false;mediaError='';mediaStatus='ready';syncButtons();if(!seeking)resize();return true;
});
ready.then(()=>{if(resumeAfterSeek&&!seeking)play()}).catch(error=>{mediaFailed=true;mediaStatus='error';resumeAfterSeek=false;syncButtons();resize();reportError(error)});
Object.defineProperty(window,'film',{value:Object.freeze({duration:DURATION,fps,metadata:FILM,scenes:SCENES,ready,seek:setTime,play,pause,setPlaybackRate,render:render,
  get currentTime(){return currentTime},get playbackRate(){return playbackRate},get playing(){return playing},get reducedMotion(){return reducedMotion},get captureCount(){return Object.keys(CAPTURES).length},get clipCount(){return Object.keys(videos).length},get mediaError(){return mediaError},get mediaStatus(){return mediaStatus},
  get mediaState(){return Object.entries(videos).map(([key,entry])=>({key,time:entry.video.currentTime,duration:entry.video.duration,start:entry.start,end:entry.end,hold:clipHold(entry,currentTime),paused:entry.video.paused,muted:entry.video.muted,playbackRate:entry.video.playbackRate,readyState:entry.video.readyState,seeking:entry.video.seeking,bufferedSource:entry.video.currentSrc.startsWith('blob:')}))}
})});
syncButtons();resize();
