/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { usePocketSpeech } from '@/vendor/avatar/client/usePocketSpeech';
const waveResponse=()=>{let read=false;return {ok:true,headers:{get:()=> 'audio/wav'},body:{getReader:()=>({read:async()=>{if(read)return {done:true};read=true;return {done:false,value:new Uint8Array(48)};},cancel:async()=>{},releaseLock:()=>{}})}} as unknown as Response;};

describe('local speech lifetime',()=>{
  const audio={pause:jest.fn(),play:jest.fn(async()=>{}),onended:null as null|(()=>void),onerror:null as null|(()=>void)};
  beforeEach(()=>{
    jest.clearAllMocks();audio.onended=null;audio.onerror=null;
    Object.defineProperty(global,'Audio',{configurable:true,value:jest.fn(()=>audio)});
    URL.createObjectURL=jest.fn(()=> 'blob:local-test');URL.revokeObjectURL=jest.fn();
  });
  it('cancels a pending reply on stop and suppresses its late audio',async()=>{
    let resolve!:(response:Response)=>void;let signal!:AbortSignal;
    const request=jest.fn((_result,owned:AbortSignal)=>{signal=owned;return new Promise<Response>(r=>resolve=r);});
    const {result}=renderHook(()=>usePocketSpeech(request));
    act(()=>{result.current.enable();result.current.speak({conversationId:'saved',messageId:'reply',locale:'en'});});
    act(()=>result.current.stop());expect(signal.aborted).toBe(true);
    await act(async()=>{resolve(waveResponse());});
    expect(global.Audio).not.toHaveBeenCalled();expect(result.current.speaking).toBe(false);
  });
  it('plays bounded audio, then stops and disposes it on unmount',async()=>{
    const request=jest.fn(async()=>waveResponse());
    const {result,unmount}=renderHook(()=>usePocketSpeech(request));
    await act(async()=>{result.current.enable();result.current.speak({conversationId:'saved',messageId:'reply',locale:'de'});});
    expect(result.current.speaking).toBe(true);expect(audio.play).toHaveBeenCalledTimes(1);
    unmount();expect(audio.pause).toHaveBeenCalled();expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-test');
  });
  it('reports local failure with no paid provider retry',async()=>{
    const request=jest.fn(async()=>({ok:false} as Response));
    const {result}=renderHook(()=>usePocketSpeech(request));
    await act(async()=>result.current.speak({conversationId:'saved',messageId:'reply',locale:'es'}));
    expect(request).toHaveBeenCalledTimes(1);expect(result.current.error).toContain('saved');expect(global.Audio).not.toHaveBeenCalled();
  });
});
