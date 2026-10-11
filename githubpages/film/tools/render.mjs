#!/usr/bin/env node
// Render the same deterministic HTML5 canvas to a silent, exactly 60-second MP4.
// No frame directory or intermediate video is written to disk.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../..');
const require=createRequire(import.meta.url);
const candidates=[process.env.PLAYWRIGHT_MODULE,'playwright'].filter(Boolean);
let chromium;
for(const candidate of candidates){try{({chromium}=require(candidate));break}catch{}}
if(!chromium)throw new Error('Playwright is required for export only. Set PLAYWRIGHT_MODULE to an existing installation.');
const output=resolve(process.argv[2]||join(here,'../flujo-product-60s.mp4'));
const poster=process.argv.includes('--poster');
const portrait=process.argv.includes('--portrait');
const previewTime=Number(process.argv.find(arg=>arg.startsWith('--t='))?.slice(4)||3);
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4'};
const server=createServer(async(req,res)=>{
  try{
    const urlPath=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=resolve(root,`.${urlPath.endsWith('/')?urlPath+'index.html':urlPath}`);
    if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return}
    const body=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}).end(body);
  }catch{res.writeHead(404).end()}
});
let browser,encoder;
const started=performance.now();
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:portrait?{width:390,height:520}:{width:1280,height:720},deviceScaleFactor:1});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/film/?render=1&t=${previewTime}`,{waitUntil:'networkidle'});
  await page.evaluate(()=>window.film.ready);
  if(poster){await page.screenshot({path:output,type:'png'});console.log(JSON.stringify({poster:output,errors}));}
  else{
    const fps=30,frames=60*fps;
    encoder=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate',String(fps),'-vcodec','mjpeg','-i','pipe:0','-frames:v',String(frames),'-an','-c:v','libx264','-preset','medium','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',output],{stdio:['pipe','ignore','pipe']});
    let stderr='';encoder.stderr.on('data',b=>{stderr+=b.toString()});
    const completed=once(encoder,'close');
    for(let frame=0;frame<frames;frame++){
      await page.evaluate(t=>window.film.seek(t),frame/fps);
      const buffer=await page.screenshot({type:'jpeg',quality:94});
      if(!encoder.stdin.write(buffer))await once(encoder.stdin,'drain');
      if(frame%300===0)console.log(JSON.stringify({frame,total:frames,seconds:frame/fps}));
    }
    encoder.stdin.end();const [code]=await completed;
    if(code!==0)throw new Error(`FFmpeg exited ${code}: ${stderr}`);
    if(errors.length)throw new Error(`Browser errors: ${errors.join('; ')}`);
    console.log(JSON.stringify({output,duration:60,fps,frames,audio:false,elapsedSeconds:Math.round((performance.now()-started)/100)/10,errors}));
  }
}finally{
  if(encoder&&encoder.exitCode===null)encoder.kill();
  if(browser)await browser.close();
  server.close();server.closeAllConnections();
}
