import { useCallback, useEffect, useRef, useState } from 'react';

export interface PocketResult { conversationId: string; messageId: string; locale: string }
/** Output only. The host supplies authenticated canonical-result transport. */
export function usePocketSpeech(request: (result: PocketResult, signal: AbortSignal) => Promise<Response>) {
  const currentRequest=useRef(request);currentRequest.current=request;
  const [enabled,setEnabled]=useState(false),[speaking,setSpeaking]=useState(false),[error,setError]=useState('');
  const active=useRef<{controller:AbortController;audio?:HTMLAudioElement;url?:string}|null>(null);
  const stop=useCallback(()=>{const old=active.current;active.current=null;old?.controller.abort();old?.audio?.pause();if(old?.url)URL.revokeObjectURL(old.url);setSpeaking(false);},[]);
  const disable=useCallback(()=>{stop();setEnabled(false);},[stop]);
  const enable=useCallback(()=>{stop();setError('');setEnabled(true);},[stop]);
  const speak=useCallback((result:PocketResult)=>{
    stop();setError('');const owned:{controller:AbortController;audio?:HTMLAudioElement;url?:string}={controller:new AbortController()};active.current=owned;
    void currentRequest.current(result,AbortSignal.any([owned.controller.signal,AbortSignal.timeout(45000)])).then(async response=>{
      if(active.current!==owned||owned.controller.signal.aborted){await response.body?.cancel();return;}
      if(!response.ok||response.headers.get('content-type')?.split(';')[0]!=='audio/wav') {await response.body?.cancel();throw Error('Local speech unavailable.');}
      const reader=response.body?.getReader();if(!reader)throw Error('Local speech unavailable.');
      let bytes=0;const chunks:Uint8Array<ArrayBuffer>[]=[];
      try{while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.length;if(bytes>44+24000*2*31)throw Error('Invalid local audio.');chunks.push(new Uint8Array(item.value));}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      if(active.current!==owned||owned.controller.signal.aborted)return;
      if(bytes<46)throw Error('Invalid local audio.');
      const url=URL.createObjectURL(new Blob(chunks,{type:'audio/wav'})),audio=new Audio(url);owned.audio=audio;owned.url=url;
      audio.onended=()=>{if(active.current===owned)stop();};
      audio.onerror=()=>{if(active.current===owned){stop();setError('Local speech could not play. Your reply remains saved.');}};
      await audio.play();if(active.current===owned)setSpeaking(true);
    }).catch(()=>{if(active.current===owned){stop();setError('Local speech unavailable. Your reply remains saved.');}});
  },[stop]);
  useEffect(()=>()=>{const old=active.current;active.current=null;old?.controller.abort();old?.audio?.pause();if(old?.url)URL.revokeObjectURL(old.url);},[]);
  return {enabled,speaking,error,enable,disable,stop,speak};
}
