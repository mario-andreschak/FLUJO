import { readFile } from 'node:fs/promises';
import { PublicError } from '../../../vendor/avatar/server/support.mjs';
const cache=new Map();
export function validateWaitingAudio(value,locale){
  if(!value||value.locale!==locale||typeof value.text!=='string'||value.text.length>120||!value.text.trim()||typeof value.data!=='string'||value.data.length>800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.data))throw Error('Invalid prepared waiting audio');
  const bytes=Buffer.from(value.data,'base64');if(bytes.toString('base64')!==value.data||bytes.length%2||bytes.length<2||value.samples!==bytes.length/2)throw Error('Invalid prepared waiting samples');
  return {text:value.text,data:value.data,samples:value.samples};
}
/** Reuse prepared speech through the existing session ledger and PCM player.
 * A waiting cue is never a task result, a work claim, or a provider call. */
export async function streamWaitingAudio(payload,_config,_fetch,signal,emit,{turnId,onQualifiedResult,history,backendResult,setupFacts}={}){
  const locale=['en','es','pt'].includes(payload.locale)?payload.locale:'en';
  let audio=cache.get(locale);if(!audio){audio=validateWaitingAudio(JSON.parse(await readFile('/data/o-cloud/voice-feedback/'+locale+'.json','utf8')),locale);cache.set(locale,audio);}
  const check=()=>{if(signal.aborted)throw new PublicError(499,'voice_interrupted','Voice stopped.');};
  const usage={promptTokens:0,completionTokens:0,totalTokens:0,inputAudioTokens:null,outputAudioTokens:0,costUsd:0};
  check();await emit({type:'start',turnId,sampleRate:24000,sampleRateQualification:'assumed'});check();await emit({type:'caption',turnId,text:audio.text});
  const bytes=Buffer.from(audio.data,'base64');for(let offset=0;offset<bytes.length;offset+=24000){check();await emit({type:'audio',turnId,data:bytes.subarray(offset,offset+24000).toString('base64')});}
  const result={completed:true,text:audio.text,samples:audio.samples,usage,completionSource:'prepared_waiting_audio'};
  check();await onQualifiedResult?.(result);check();await emit({type:'complete',turnId,text:audio.text,samples:audio.samples,usage});return result;
}
