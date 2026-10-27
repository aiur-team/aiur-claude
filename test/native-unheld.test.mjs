import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAppServer } from '../dist/server.js';
import { fakeConn, waitFor } from './helpers.mjs';

const terminal = readFileSync(new URL('./fixtures/native-deferred.ndjson', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse).find(e => e.type === 'result');
const tool = terminal.deferred_tool_use;
const assistant = {type:'assistant',message:{id:'multi',content:[{type:'tool_use',...tool},{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'pwd'}}]}};

async function setup(t, deferred) {
  const dir = mkdtempSync(join(tmpdir(), 'native-unheld-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const cli=join(dir,'claude'); const log=join(dir,'stdin.jsonl');
  const result = deferred ? terminal : {type:'result',subtype:'success',session_id:terminal.session_id};
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('fs'); if(process.argv.includes('--version')){console.log('fixture');process.exit(0);}
let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const first=!fs.existsSync(${JSON.stringify(log)});fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+'\\n');
 if(first){console.log(${JSON.stringify(JSON.stringify(assistant))});console.log(${JSON.stringify(JSON.stringify(result))});}
 else console.log(JSON.stringify({type:'result',subtype:'success',session_id:${JSON.stringify(terminal.session_id)}}));
});`,{mode:0o700});
  const server=new ClaudeAppServer(cli,false,async()=>undefined); const conn=fakeConn();conn.initialized=true;
  const call=(method,params)=>server.handleMessage({jsonrpc:'2.0',id:1,method,params},conn);
  const start=await call('thread/start',{cwd:dir,nativeQuestions:true,permissionMode:'bypassPermissions'});
  await call('turn/start',{threadId:start.result.thread.id,content:'ask'});
  const request=await waitFor(()=>conn.sent.find(m=>m.method==='item/tool/requestUserInput'));
  return {server,conn,request,log};
}

test('multi-call without terminal deferral releases and sends Command text into the same session', async t=>{
  const {server,conn,request,log}=await setup(t,false);
  assert.equal(request.params.holdable,false);
  assert.equal(request.params.itemId,tool.id);
  const text='Your question is recorded as Command dec_123. Stop and end your turn; the answer will arrive as a message.';
  await server.handleMessage({jsonrpc:'2.0',id:request.id,result:{answers:{[request.params.questions[0].id]:{answers:[text]}}}},conn);
  await waitFor(()=>conn.sent.find(m=>m.method==='turn/completed'));
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),['ask',text]);
  assert.equal(conn.sent.filter(m=>m.method==='turn/started').length,1);
});

test('multi-call terminal deferral stays holdable and resumes with empty stdin', async t=>{
  const {server,conn,request,log}=await setup(t,true);
  assert.notEqual(request.params.holdable,false);
  await server.handleMessage({jsonrpc:'2.0',id:request.id,result:{answers:{[request.params.questions[0].id]:{answers:['red']}}}},conn);
  await waitFor(()=>conn.sent.find(m=>m.method==='turn/completed'));
  assert.deepEqual(readFileSync(log,'utf8').trim().split('\n').map(JSON.parse),['ask','']);
  assert.equal(conn.sent.filter(m=>m.method==='item/tool/requestUserInput').length,1);
});
