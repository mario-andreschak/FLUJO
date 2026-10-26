'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { readParentConfiguration, providerFromParent, equipmentFromParent } = require('./runtime-bootstrap.cjs');
const { hash } = require('./profile.cjs');

test('parent configuration is bounded, EOF-delimited and rejects malformed or timed-out input', async () => {
  let stream = new PassThrough(), settled = false;
  const pending = readParentConfiguration(stream).then(value => { settled = true; return value; });
  stream.write('{"version":1}'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); stream.end(); assert.deepEqual(await pending, {version:1});
  for (const bytes of [Buffer.alloc(4097), Buffer.from([0xff]), Buffer.from('{broken')]) {
    stream = new PassThrough(); const result = readParentConfiguration(stream); stream.end(bytes);
    await assert.rejects(result, /allowance|Malformed/);
  }
  await assert.rejects(readParentConfiguration(new PassThrough(), 10), /timed out/);
});

test('parent binding rejects wrong nonce, runtime, source, provider PID, token or endpoint', () => {
  const contract = {mode:'pilot',bootstrapNonce:'a'.repeat(48), token:'b'.repeat(48), sourceHead:'head', harnessSha256:'harness', profileSha256:'profile'};
  const ready = {pid:123,origin:'http://127.0.0.1:45678',tokenSha256:hash(contract.token)};
  const message = {version:'runtime-provider-v1',nonce:contract.bootstrapNonce,pid:process.pid,sourceHead:'head',harnessSha256:'harness',profileSha256:'profile',
    provider:{pid:123,port:45678,token:contract.token}};
  assert.equal(providerFromParent(message,contract,ready).port,45678);
  for (const changed of [{...message,nonce:'c'.repeat(48)},{...message,pid:process.pid+1},{...message,sourceHead:'changed'},
    {...message,harnessSha256:'changed'},{...message,profileSha256:'changed'},{...message,extra:true},
    ...[{pid:124},{port:45679},{port:65536},{token:'c'.repeat(48)},{extra:true}].map(change => ({...message,provider:{...message.provider,...change}}))]) {
    assert.throws(() => providerFromParent(changed,contract,ready));
  }
  for (const changed of [{...ready,pid:124},{...ready,origin:'http://localhost:45678'},{...ready,tokenSha256:'x'}]) {
    assert.throws(() => providerFromParent(message,contract,changed));
  }
});

test('equipment IPC is separate, has no provider endpoint and cannot enter qualification modes', () => {
  const contract={mode:'equipment-bootstrap',equipmentOnly:true,qualification:false,bootstrapNonce:'a'.repeat(48),sourceHead:'head',harnessSha256:'harness',profileSha256:'profile'};
  const message={version:'runtime-equipment-v1',nonce:contract.bootstrapNonce,pid:process.pid,sourceHead:'head',harnessSha256:'harness',profileSha256:'profile',peer:{pid:123}};
  equipmentFromParent(message,contract);
  for(const mode of ['pilot','endurance']) assert.throws(()=>equipmentFromParent(message,{...contract,mode}));
  assert.throws(()=>equipmentFromParent({...message,provider:{port:45678}},contract));
  assert.throws(()=>equipmentFromParent(message,{...contract,equipmentOnly:false}));
  assert.throws(()=>providerFromParent(message,contract,{}));
});

test('bootstrap gate rejects other commands and captured references remain blocked after irreversible seal', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert=require('node:assert/strict'),cp=require('node:child_process'),net=require('node:net'),path=require('node:path'),{promisify}=require('node:util');
    const guard=require(process.argv[1]).installRuntimeGuard();
    const captured=cp.execFile, asyncCaptured=promisify(captured);
    const exe=path.win32.join(process.env.SystemRoot||'C:\\\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const args=['-NoProfile','-NonInteractive','-Command', '$p=Get-Process -Id '+process.pid+' -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks'];
    const options={encoding:'utf8',timeout:10000,windowsHide:true};
    (async()=>{
      assert.throws(()=>net.connect({host:'127.0.0.1',port:45678}));
      assert.throws(()=>guard.activateProvider(45678));
      for(const [file,argv,opts] of [[process.execPath,args,options],[exe,[...args.slice(0,3),args[3].replace(String(process.pid),String(process.pid+1))],options],
        [exe,[...args,'extra'],options],[exe,args,{...options,shell:true}],[exe,args,{...options,detached:true}],[exe,args,{...options,timeout:0}]]) assert.throws(()=>captured(file,argv,opts,()=>{}));
      for(const key of ['spawn','spawnSync','exec','execSync','execFileSync','fork']) assert.throws(()=>cp[key](process.execPath,[]));
      if(process.platform==='win32') await assert.rejects(guard.sealBootstrap(),/native birth probe/); else await guard.sealBootstrap();
      assert.throws(()=>captured(exe,args,options,()=>{})); await assert.rejects(asyncCaptured(exe,args,options));
      await assert.rejects(guard.sealBootstrap());
      if(process.platform==='win32') assert.throws(()=>guard.activateProvider(45678)); else guard.activateProvider(45678);
      assert.throws(()=>guard.activateProvider(45679));
      assert.throws(()=>net.connect({host:'127.0.0.1',port:45679}));
      await assert.rejects(asyncCaptured(exe,args,options));
    })().catch(error=>{console.error(error);process.exitCode=1});
  `,path.join(__dirname,'network-guard.cjs')], {encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr); assert.equal(result.signal,null);
});
