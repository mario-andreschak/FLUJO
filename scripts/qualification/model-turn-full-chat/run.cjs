'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]),base=path.resolve(process.argv[3]),{chromium}=require(path.join(root,'node_modules/playwright'));
let backend,browser,sampler;const errors=[],results=[],maxima={};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  backend=cp.fork(path.join(__dirname,'backend.cjs'),[root,base],{execArgv:['--max-old-space-size=384'],silent:true});
  backend.stdout.pipe(fs.createWriteStream(path.join(base,'backend-stdout.log')));backend.stderr.pipe(fs.createWriteStream(path.join(base,'backend-stderr.log')));
  const ready=await new Promise((resolve,reject)=>{backend.once('message',resolve);backend.once('exit',code=>reject(Error('Backend startup exit '+code)));});
  fs.writeFileSync(path.join(base,'browser-pids.json'),JSON.stringify([{type:'backend',id:backend.pid}]));
  const origin=ready.origin,cookie=ready.cookie.split(';')[0];
  const headers={cookie,origin,host:new URL(origin).host,'sec-fetch-site':'same-origin'};
  const diagnostics=()=>fetch(origin+'/fixture/diagnostics',{headers}).then(r=>r.json());
  const until=async check=>{const deadline=Date.now()+10000;while(Date.now()<deadline){const value=await diagnostics();if(check(value))return value;await wait(20);}throw Error('Admission/cleanup deadline exceeded');};
  const url=id=>origin+'/v1/chat/conversations/conversation/model-turns/'+id+'?format=chunks';
  const fixtures=JSON.parse(fs.readFileSync(path.join(base,'fixture-receipts.json'),'utf8'));
  const unauthorized=await fetch(url('dense'),{headers:{host:new URL(origin).host,'sec-fetch-site':'same-origin'}});assert.equal(unauthorized.status,401);
  await fetch(origin+'/fixture/lock',{headers});assert.equal((await fetch(url('dense'),{headers})).status,423);await fetch(origin+'/fixture/unlock',{headers});

  // Pause genuine HTTP consumers after headers. All four responses retain
  // their real descriptors/admissions under transport backpressure.
  const held=await Promise.all(['ascii','unicode','dense','wide'].map(id=>new Promise((resolve,reject)=>{
    const request=http.get(url(id),{headers},response=>{response.pause();response.on('error',()=>{});resolve({id,request,response});});request.on('error',reject);
  })));
  const saturated=await until(value=>value.activeReads===4);assert.equal(saturated.quarantinedReads,0);
  const fifth=await fetch(url('deep'),{headers});assert.equal(fifth.status,429);await fifth.arrayBuffer();
  held[0].response.destroy();held[0].request.destroy();await until(value=>value.activeReads===3);
  for(const item of held.slice(1)){
    assert.equal(item.response.statusCode,200);
    const hash=crypto.createHash('sha256');let bytes=0,pending='',terminal;
    for await(const chunk of item.response){pending+=chunk.toString('ascii');let newline;
      while((newline=pending.indexOf('\n'))>=0){assert.ok(newline<=90000);assert.equal(terminal,undefined);const record=JSON.parse(pending.slice(0,newline));pending=pending.slice(newline+1);
        if(record.kind==='chunk'){const value=Buffer.from(record.data,'base64');assert.ok(value.length<=65536);bytes+=value.length;hash.update(value);}else{assert.equal(record.kind,'end');terminal=record;}}
      assert.ok(pending.length<=90000);
    }
    const expected=fixtures.find(value=>value.mode===item.id);assert.equal(pending,'');assert.equal(bytes,67108864);assert.equal(hash.digest('hex'),expected.sha256);assert.equal(terminal.sha256,expected.sha256);assert.equal(terminal.bytes,bytes);
  }
  await until(value=>value.activeReads===0);

  // Controlled close fault wraps only the next actual archive descriptor.
  // It never fakes a successful close or relaxes the production admission rule.
  await fetch(origin+'/fixture/arm-close-failure',{headers});
  const failedClose=fetch(url('ascii'),{headers}).then(async response=>{const reader=response.body.getReader();try{while(!(await reader.read()).done){/* discard bounded chunks */}}finally{reader.releaseLock();}return false;},()=>true).catch(()=>true);
  const quarantined=await until(value=>value.quarantinedReads===1);assert.equal(quarantined.activeReads,1);assert.ok(quarantined.cleanupFailures>=3);
  assert.equal(await failedClose,true);const recovered=await until(value=>value.activeReads===0&&value.quarantinedReads===0);

  browser=await chromium.launch({headless:true,executablePath:process.env.FLUJO_PROFILE_CHROMIUM||'C:/Users/Moe/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe',args:['--js-flags=--max-old-space-size=128','--enable-precise-memory-info','--disable-gpu']});
  const context=await browser.newContext(),page=await context.newPage();const equal=cookie.indexOf('=');
  await context.addCookies([{name:cookie.slice(0,equal),value:cookie.slice(equal+1),url:origin,httpOnly:true,sameSite:'Strict'}]);
  await page.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());page.on('pageerror',error=>errors.push(error.message));
  const system=await browser.newBrowserCDPSession(),metrics=await context.newCDPSession(page);await metrics.send('Performance.enable');
  const sample=async()=>{const info=await system.send('SystemInfo.getProcessInfo');fs.writeFileSync(path.join(base,'browser-pids.json'),JSON.stringify([...info.processInfo,{type:'backend',id:backend.pid}]));
    const measured=await metrics.send('Performance.getMetrics');for(const value of measured.metrics)if(['JSHeapUsedSize','JSHeapTotalSize','Nodes','LayoutObjects'].includes(value.name))maxima[value.name]=Math.max(maxima[value.name]||0,value.value);};
  // Begin backend RSS sampling before the admission phase in the supervisor.
  await page.goto(origin+'/?conversation=conversation');await sample();sampler=setInterval(()=>sample().catch(()=>{}),200);
  await page.getByTestId('model-turn-timeline').waitFor();
  for(let index=0;index<fixtures.length;index++){
    const fixture=fixtures[index],started=Date.now();
    const responsePromise=page.waitForResponse(response=>response.url().includes('/model-turns/'+fixture.mode+'?format=chunks')&&response.status()===200);
    await page.getByTestId('model-turn-timeline').getByRole('option').nth(index).click();await responsePromise;
    // Actual effect completion is observed through the bounded rendered view,
    // never by a manual service call or an injected snapshot into Chat state.
    if(index<fixtures.length-1){await page.getByTestId('model-turn-timeline').getByText('History',{exact:true}).waitFor();await page.locator('pre').filter({hasText:'complete'}).first().waitFor();}
    await page.getByRole('button',{name:/Model input/i}).click();await page.getByRole('button',{name:'Request Detail',exact:true}).click();
    await page.getByTestId('request-parameter-value').waitFor();assert.ok((await page.getByTestId('request-parameter-value').textContent()).length<=65536);
    await page.getByRole('button',{name:'Original JSON',exact:true}).click();assert.ok((await page.locator('pre').first().textContent()).includes('"id":"'+fixture.mode+'"'));
    await page.getByRole('button',{name:'Chat',exact:true}).click();await sample();results.push({mode:fixture.mode,elapsedMs:Date.now()-started});
  }
  // A selection change/unmount must abort the root effect and release its read.
  await page.getByTestId('model-turn-timeline').getByRole('option').first().click();await page.evaluate(()=>window.unmountChat());
  const final=await until(value=>value.activeReads===0&&value.quarantinedReads===0);assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(base,'browser-result.json'),JSON.stringify({results,maxima,saturated,fifthStatus:fifth.status,quarantined,recovered,final,errors,fullChatRoot:true,forcedGC:false},null,2));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  clearInterval(sampler);if(browser)await browser.close();if(backend?.connected){backend.send('stop');await new Promise(resolve=>{backend.once('exit',resolve);setTimeout(()=>{backend.kill();resolve();},5000).unref();});}
});
