import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWaitingAudio} from '../src/backend/services/avatar/waiting-audio.mjs';
test('prepared cues require exact locale and canonical PCM sample counts',()=>{
  const value={locale:'es',text:'Mmm, dame un momento.',data:Buffer.alloc(12).toString('base64'),samples:6};
  assert.equal(validateWaitingAudio(value,'es').samples,6);
  assert.throws(()=>validateWaitingAudio(value,'en'));
  assert.throws(()=>validateWaitingAudio({...value,samples:7},'es'));
  assert.throws(()=>validateWaitingAudio({...value,data:'file:///private'},'es'));
  assert.throws(()=>validateWaitingAudio({...value,text:'x'.repeat(121)},'es'));
});
