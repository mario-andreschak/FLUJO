import { qualifyNativeCodex, assertNativeCodexQualification } from '@/backend/services/model/adapters/codexNativeQualification';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const catalogPath=process.env.FLUJO_LIVE_CODEX_CATALOG;
const output=process.env.FLUJO_LIVE_CODEX_RECEIPT;
const live=catalogPath&&output?it:it.skip;
live('qualifies exact Luna/medium through the restrictive Source catalogue and thread-bound MCP bridge',async()=>{
  if(!path.isAbsolute(output!) || !path.isAbsolute(catalogPath!))throw new Error('Absolute private live qualification paths required');
  const relative=path.relative(process.cwd(),output!);
  if(!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Live receipts must stay outside the checkout');
  const controller=new AbortController();let checks=0;
  const profile=await qualifyNativeCodex('gpt-6-luna','medium',controller.signal,async()=>{checks++;controller.signal.throwIfAborted();},{catalogPath});
  assertNativeCodexQualification(profile);
  expect(()=>assertNativeCodexQualification({...profile})).toThrow('unavailable');
  expect(checks).toBeGreaterThan(3);
  const receipt=JSON.parse(await fs.readFile(profile.verifiedModelCatalogPath.replace(/\.json$/,'.qualification.json'),'utf8'));
  expect(receipt).toMatchObject({kind:'live-source-native-codex-qualification',model:'gpt-6-luna',effort:'medium',
    cliVersion:'0.157.1',modelCallbackObserved:true,closeObserved:true,exit:{code:0,signal:null},output:'READY',billedCostUsd:null,countsAsBusinessWork:false,
    builtInDenial:{output:'BUILTINS_UNAVAILABLE',exit:{code:0,signal:null},closeObserved:true,sentinelAbsent:true}});
  expect(receipt.effectiveInventory).toMatchObject({kind:'offline-pinned-binary-inventory',posts:2,advertisedTools:[],
    forcedCallsDenied:true,authenticated:false,liveProvider:false,closeObserved:true});
  await fs.writeFile(output!,JSON.stringify(receipt,null,2),{mode:0o600});
},150000);
