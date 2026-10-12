#!/usr/bin/env node
// Render the deterministic walkthrough canvas to a silent, timeline-length MP4.
// No frame directory or intermediate video is written to disk.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { FILM, DURATION } from '../renderer.js';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const options={};let outputArgument;
for(let i=2;i<process.argv.length;i++){
  const argument=process.argv[i];
  if(['--poster','--portrait','--prototype'].includes(argument)){options[argument.slice(2)]=true;continue;}
  const match=/^--(t|start|end)(?:=(.*))?$/.exec(argument);
  if(match){const value=match[2]??process.argv[++i];if(value===undefined||value.trim()===''||!Number.isFinite(Number(value)))throw new Error(`${match[1]} requires a finite number of seconds.`);options[match[1]]=Number(value);continue;}
  if(argument.startsWith('-'))throw new Error(`Unknown option: ${argument}`);
  if(outputArgument)throw new Error('Only one output path is allowed.');
  outputArgument=argument;
}
const {poster=false,portrait=false,prototype=false}=options;
const duration=DURATION,fps=FILM.fps??30,metadata=FILM;
if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(fps)||fps<=0)throw new Error('The renderer must define a positive duration and frame rate.');
if(!['prototype','final'].includes(metadata.stage))throw new Error('The renderer must identify its prototype or final stage.');
if(!prototype&&(metadata.exportReady!==true||metadata.stage!=='final'))throw new Error('Final export is not ready. A bounded prototype requires --prototype --start <seconds> --end <seconds>, or --prototype --poster --t <seconds>.');
if(prototype&&!poster&&(options.start===undefined||options.end===undefined))throw new Error('Prototype video export requires explicit --start and --end bounds.');
if(prototype&&poster&&options.t===undefined)throw new Error('Prototype poster export requires an explicit --t timestamp.');
const start=options.start??0,end=options.end??duration,previewTime=options.t??start;
if(start<0||end>duration||end<=start)throw new Error(`Export bounds must satisfy 0 <= start < end <= ${duration}.`);
if(previewTime<0||previewTime>duration)throw new Error(`Poster time must be between 0 and ${duration}.`);
const startFrame=Math.round(start*fps),endFrame=Math.round(end*fps),frames=endFrame-startFrame;
if(!poster){
  for(const [name,seconds,index] of [['start',start,startFrame],['end',end,endFrame]]){
    if(!Number.isSafeInteger(index)||Math.abs(index-seconds*fps)>1e-6)throw new Error(`Export ${name} must lie on the ${fps} fps frame grid.`);
  }
  if(frames<1)throw new Error(`The selected duration must contain at least one frame at ${fps} fps.`);
}
if(typeof metadata.exportFilename!=='string'||!/^[-a-zA-Z0-9_.]+\.mp4$/.test(metadata.exportFilename))throw new Error('FILM.exportFilename must be a local MP4 filename.');
const filename=metadata.exportFilename.replace(/\.mp4$/,`${prototype?'.prototype':''}.${poster?'png':'mp4'}`);
const output=resolve(outputArgument||join(here,'..',filename));
const require=createRequire(import.meta.url);
const candidates=[process.env.PLAYWRIGHT_MODULE,'playwright'].filter(Boolean);
let chromium;
for(const candidate of candidates){try{({chromium}=require(candidate));break}catch{}}
if(!chromium)throw new Error('Playwright is required for export only. Set PLAYWRIGHT_MODULE to an existing installation.');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4'};
const server=createServer(async(req,res)=>{
  try{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
    const urlPath=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=resolve(root,`.${urlPath.endsWith('/')?urlPath+'index.html':urlPath}`);
    if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}).end(req.method==='HEAD'?undefined:body);
  }catch{res.writeHead(404).end()}
});
let browser,encoder;
const started=performance.now();
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:portrait?{width:390,height:520}:{width:1280,height:800},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/film/?render=1&t=0`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.film&&window.film.mediaStatus!=='loading',null,{timeout:90000});
  await page.evaluate(()=>window.film.ready);
  const runtime=await page.evaluate(()=>({duration:window.film.duration,fps:window.film.fps,metadata:window.film.metadata}));
  if(runtime.duration!==duration||runtime.fps!==fps||JSON.stringify(runtime.metadata)!==JSON.stringify(metadata))throw new Error('The browser timeline changed after export validation. Restart the export against one frozen revision.');
  if(poster){
    await page.evaluate(t=>window.film.seek(t),previewTime);
    if(errors.length)throw new Error(`Browser errors: ${errors.join('; ')}`);
    await page.screenshot({path:output,type:'png'});console.log(JSON.stringify({poster:output,time:previewTime,stage:metadata.stage,prototype,errors}));
  }
  else{
    encoder=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-frames:v',String(frames),'-an','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});
    let stderr='';encoder.stderr.on('data',b=>{stderr+=b.toString()});
    const completed=once(encoder,'close');
    for(let frame=0;frame<frames;frame++){
      const timelineSeconds=(startFrame+frame)/fps;
      await page.evaluate(t=>window.film.seek(t),timelineSeconds);
      const buffer=await page.screenshot({type:'jpeg',quality:94});
      if(!encoder.stdin.write(buffer))await once(encoder.stdin,'drain');
      if(frame%Math.max(1,Math.round(fps*10))===0)console.log(JSON.stringify({frame,total:frames,timelineSeconds}));
    }
    encoder.stdin.end();const [code]=await completed;
    if(code!==0)throw new Error(`FFmpeg exited ${code}: ${stderr}`);
    if(errors.length)throw new Error(`Browser errors: ${errors.join('; ')}`);
    console.log(JSON.stringify({output,duration:frames/fps,timelineDuration:duration,start,end,fps,frames,stage:metadata.stage,prototype,audio:false,elapsedSeconds:Math.round((performance.now()-started)/100)/10,errors}));
  }
}finally{
  if(encoder&&encoder.exitCode===null)encoder.kill();
  if(browser)await browser.close();
  server.close();server.closeAllConnections();
}
