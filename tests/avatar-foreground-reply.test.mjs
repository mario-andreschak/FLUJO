import test from 'node:test';
import assert from 'node:assert/strict';
import { completedForegroundDispatch } from '../src/backend/services/avatar/foreground-reply.mjs';
const message={id:'reply',role:'assistant',content:'Started the task.',timestamp:20,processNodeId:'conversation'};
const dispatch={type:'model:dispatch',seq:10,timestamp:10,turn:{id:'turn',conversationId:'root',node:{nodeId:'conversation'}}};
const result={type:'model:dispatch-result',dispatchId:'turn',outcome:'completed',timestamp:30};
const committed={type:'message',seq:20,message};
test('a finished root utterance can be spoken while its child remains active',()=>{
  assert.equal(completedForegroundDispatch('root',message,[dispatch,committed,result,{type:'model:dispatch',depth:1,timestamp:31,turn:{id:'child',conversationId:'child'}}]),true);
});
test('partial, failed, newer, unrelated and discarded turns cannot authorize speech',()=>{
  assert.equal(completedForegroundDispatch('root',message,[dispatch]),false);
  assert.equal(completedForegroundDispatch('root',message,[dispatch,committed,{...result,outcome:'error'}]),false);
  assert.equal(completedForegroundDispatch('root',message,[dispatch,committed,result,{...dispatch,seq:40,turn:{...dispatch.turn,id:'new'}}]),false);
  assert.equal(completedForegroundDispatch('other',message,[dispatch,result]),false);
  assert.equal(completedForegroundDispatch('root',{...message,depth:1},[dispatch,result]),false);
  assert.equal(completedForegroundDispatch('root',{...message,tool_calls:[{}]},[dispatch,result]),false);
  assert.equal(completedForegroundDispatch('root',{...message,content:'Changed'},[dispatch,committed,result]),false);
  assert.equal(completedForegroundDispatch('root',message,[dispatch,committed,result,{type:'model:end',messageId:'reply',discard:true}]),false);
  assert.equal(completedForegroundDispatch('root',message,[dispatch,result]),false);
});
