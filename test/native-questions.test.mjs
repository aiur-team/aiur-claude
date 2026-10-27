import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ClaudeAppServer } from '../dist/server.js';
import { deferredQuestion, toRequestUserInput, toUpdatedInput, questionId } from '../dist/native-questions.js';
import { permissionDecision, hookDecision } from '../dist/native-question-runtime.js';
import { fakeConn, waitFor, TOOLS } from './helpers.mjs';

const raw = readFileSync(new URL('./fixtures/native-deferred.ndjson', import.meta.url), 'utf8');
const terminal = raw.trim().split('\n').map(JSON.parse).find(e => e.type === 'result');
const tool = terminal.deferred_tool_use;
const runtime = fileURLToPath(new URL('../dist/native-question-runtime.js', import.meta.url));

async function setup(t, params = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'native-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const cli = join(dir, 'claude');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const cp = require('child_process');
if(process.argv.includes('--version')) { console.log('fixture-cli'); process.exit(0); }
let stdin=''; process.stdin.on('data', b => stdin+=b); process.stdin.on('end', () => {
 const args=process.argv.slice(2);
 const settings=JSON.parse(args[args.indexOf('--settings')+1]);
 const command=settings.hooks.PreToolUse[0].hooks[0].command;
 const decision=JSON.parse(cp.execFileSync('/bin/sh',['-c',command],{input:JSON.stringify(${JSON.stringify({tool_name:'AskUserQuestion',tool_use_id:tool.id,tool_input:tool.input})})})).hookSpecificOutput;
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,stdin,decision})+'\\n');
 if (decision.permissionDecision==='defer') process.stdout.write(${JSON.stringify(raw)});
 else { console.log(JSON.stringify({type:'assistant',message:{id:'answered',content:[{type:'text',text:JSON.stringify(decision)}]}})); console.log(JSON.stringify({type:'result',subtype:'success',session_id:${JSON.stringify(terminal.session_id)},total_cost_usd:0.01,usage:{input_tokens:10,output_tokens:20}})); }
});
`, { mode: 0o700 });
  const server = new ClaudeAppServer(cli, false, async () => undefined);
  const conn = fakeConn(); conn.initialized = true;
  const call = (method, params) => server.handleMessage({ jsonrpc:'2.0', id:1, method, params }, conn);
  const start = await call('thread/start', { cwd: dir, nativeQuestions:true, permissionMode:'bypassPermissions', ...params });
  const threadId = start.result.thread.id;
  t.after(() => server.getThread(threadId).nativeQuestions?.close());
  return { server, conn, call, threadId, log, dir };
}

const calls = path => readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);
const request = conn => conn.sent.find(m => m.method === 'item/tool/requestUserInput');
const completed = conn => conn.sent.find(m => m.method === 'turn/completed');

test('captured terminal maps stable question IDs and rejects malformed deferrals', () => {
  assert.equal(deferredQuestion(terminal).id, tool.id);
  const params = toRequestUserInput(tool, 'thread', 'turn');
  assert.deepEqual(params, { threadId:'thread', turnId:'turn', itemId:tool.id, questions:[{
    id:'5f49553a324eac0e', header:'Color', question:'Should isolated.md mention red or blue?', isOther:true, isSecret:false,
    options:tool.input.questions[0].options, multiSelect:false,
  }] });
  assert.equal(questionId(tool.input.questions[0].question), params.questions[0].id);
  assert.equal(deferredQuestion({type:'result',deferred_tool_use:tool}), undefined);
  assert.throws(() => deferredQuestion({...terminal,deferred_tool_use:{...tool,input:{questions:[]}}}), /Invalid/);
});

test('answers preserve input and join multi selections; single release covers all questions', () => {
  const multi = {...tool, input:{questions:[{...tool.input.questions[0],multiSelect:true}, {...tool.input.questions[0],question:'Second?'}]}};
  const result = toUpdatedInput(multi, {answers:{[questionId(multi.input.questions[0].question)]:{answers:['red','blue']},[questionId('Second?')]:{answers:['yes']}}});
  assert.equal(result.answers[multi.input.questions[0].question], 'red, blue');
  assert.equal(result.answers['Second?'], 'yes');
  const text='Your question is recorded as Command dec_123. Stop and end your turn.';
  assert.deepEqual(Object.values(toUpdatedInput(multi,{answers:{one:{answers:[text]}}}).answers),[text,text]);
  assert.throws(() => toUpdatedInput(tool,{answers:{}}), /Missing/);
});

test('nativeQuestions off keeps complete legacy argv; invalid flag is rejected', async t => {
  const {server,call,threadId}=await setup(t,{nativeQuestions:false});
  assert.deepEqual(server.buildClaudeArgs(server.getThread(threadId)),['--print','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','bypassPermissions','--session-id',threadId]);
  const response=await call('thread/start',{nativeQuestions:'true'});
  assert.equal(response.error.code,-32602);
});

test('deferred subprocess holds same turn then resumes with hook answer and empty stdin', async t => {
  const {server,conn,call,threadId,log}=await setup(t);
  const turn=await call('turn/start',{threadId,content:'ask a question'});
  const req=await waitFor(()=>request(conn));
  assert.equal(req.params.turnId,turn.result.turn.id);
  assert.equal(req.params.itemId,tool.id);
  assert.equal(completed(conn),undefined);
  await server.handleMessage({jsonrpc:'2.0',id:req.id,result:{answers:{[req.params.questions[0].id]:{answers:['wrong client']}}}},fakeConn());
  assert.equal(server.nativeRequests.pending.size,1);
  assert.equal((await call('turn/start',{threadId,content:'busy'})).error.code,-32003);
  await server.handleMessage({jsonrpc:'2.0',id:req.id,result:{answers:{[req.params.questions[0].id]:{answers:['red']}}}},conn);
  await waitFor(()=>completed(conn));
  const records=calls(log);
  assert.equal(records.length,2);
  assert.equal(records[0].decision.permissionDecision,'defer');
  assert.equal(records[1].stdin,'');
  assert.equal(records[1].args[records[1].args.indexOf('--resume')+1],terminal.session_id);
  assert.equal(records[1].decision.permissionDecision,'allow');
  assert.equal(records[1].decision.updatedInput.answers[tool.input.questions[0].question],'red');
  assert.equal(completed(conn).params.turn_id,turn.result.turn.id);
  assert.equal(completed(conn).params.cost_usd_raw,'0.0426653');
  assert.equal(completed(conn).params.usage.input_tokens,terminal.usage.input_tokens+10);
  assert.equal(completed(conn).params.usage.output_tokens,terminal.usage.output_tokens+20);
  assert.equal(conn.sent.filter(m=>m.method==='turn/started').length,1);
});

test('release text reaches resumed tool and completes the original turn', async t => {
  const {server,conn,call,threadId,log}=await setup(t);
  await call('turn/start',{threadId,content:'ask'});
  const req=await waitFor(()=>request(conn));
  const text='Your question is recorded as Command dec_123. Stop and end your turn.';
  await server.handleMessage({jsonrpc:'2.0',id:req.id,result:{answers:{release:{answers:[text]}}}},conn);
  await waitFor(()=>completed(conn));
  assert.equal(calls(log)[1].decision.updatedInput.answers[tool.input.questions[0].question],text);
  assert.equal(completed(conn).params.status,'completed');
});

test('interrupt denies pending tool on resume and late response cannot revive it', async t => {
  const {server,conn,call,threadId,log}=await setup(t);
  await call('turn/start',{threadId,content:'ask'});
  const req=await waitFor(()=>request(conn));
  await call('turn/interrupt',{threadId});
  assert.equal((await call('turn/start',{threadId,content:'too soon'})).error.code,-32003);
  await waitFor(()=>completed(conn));
  assert.equal(calls(log)[1].decision.permissionDecision,'deny');
  assert.equal(completed(conn).params.status,'interrupted');
  await server.handleMessage({jsonrpc:'2.0',id:req.id,result:{answers:{[req.params.questions[0].id]:{answers:['late']}}}},conn);
  assert.equal(calls(log).length,2);
  assert.equal(server.getThread(threadId).active_turn_id,undefined);
});

test('native config preserves dynamic tools and hook leaves Bash alone', async t => {
  const {server,threadId}=await setup(t,{dynamicTools:TOOLS});
  const thread=server.getThread(threadId);
  await thread.toolBridge.start(); t.after(()=>thread.toolBridge.close());
  const args=server.buildClaudeArgs(thread);
  const config=JSON.parse(args[args.indexOf('--mcp-config')+1]);
  assert.equal(config.mcpServers.aiur.args[1],thread.toolBridge.socketPath);
  assert.equal(config.mcpServers.aiur_native.args[0],runtime);
  assert.equal(args[args.indexOf('--permission-prompt-tool')+1],'mcp__aiur_native__approve');
  assert.deepEqual(JSON.parse(execFileSync(process.execPath,[runtime,'hook',thread.nativeQuestions.directory],{input:JSON.stringify({tool_name:'Bash'})})),{});
  assert.deepEqual(permissionDecision({tool_name:'Bash',input:{command:'ls'}},'bypassPermissions'),{behavior:'allow',updatedInput:{command:'ls'}});
  assert.equal(permissionDecision({tool_name:'AskUserQuestion',input:tool.input}).behavior,'deny');
});


test('permission host speaks MCP and allows only non-question inputs unchanged', () => {
  const messages = [
    {jsonrpc:'2.0',id:1,method:'initialize',params:{}},
    {jsonrpc:'2.0',id:2,method:'tools/list',params:{}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'approve',arguments:{tool_name:'Bash',input:{command:'ls'}}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'approve',arguments:{tool_name:'AskUserQuestion',input:tool.input}}},
  ];
  const out = execFileSync(process.execPath,[runtime,'host','bypassPermissions'],{input:messages.map(JSON.stringify).join('\n')+'\n'}).toString().trim().split('\n').map(JSON.parse);
  assert.equal(out[0].result.protocolVersion,'2025-06-18');
  assert.equal(out[1].result.tools[0].name,'approve');
  assert.deepEqual(JSON.parse(out[2].result.content[0].text),{behavior:'allow',updatedInput:{command:'ls'}});
  assert.equal(JSON.parse(out[3].result.content[0].text).behavior,'deny');
});

test('hook scopes and consumes answers by tool-use ID; a different call defers', t => {
  const dir=mkdtempSync(join(tmpdir(),'native-hook-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'answer.json');
  writeFileSync(file,JSON.stringify({toolUseId:tool.id,decision:{permissionDecision:'allow',updatedInput:{answers:{q:'red'}}}}));
  assert.equal(hookDecision({tool_name:'AskUserQuestion',tool_use_id:'another'},dir).hookSpecificOutput.permissionDecision,'defer');
  assert.equal(existsSync(file),true);
  assert.equal(hookDecision({tool_name:'AskUserQuestion',tool_use_id:tool.id},dir).hookSpecificOutput.updatedInput.answers.q,'red');
  assert.equal(existsSync(file),false);
  assert.equal(hookDecision({tool_name:'AskUserQuestion',tool_use_id:tool.id},dir).hookSpecificOutput.permissionDecision,'defer');
});

test('client error fails held turn without resuming and removes runtime files', async t => {
  const {server,conn,call,threadId,log}=await setup(t);
  await call('turn/start',{threadId,content:'ask'});
  const req=await waitFor(()=>request(conn));
  const directory=server.getThread(threadId).nativeQuestions.directory;
  await server.handleMessage({jsonrpc:'2.0',id:req.id,error:{code:-1,message:'client unavailable'}},conn);
  const fail=await waitFor(()=>conn.sent.find(m=>m.method==='turn/failed'));
  assert.match(fail.params.error,/client unavailable/);
  assert.equal(calls(log).length,1);
  await waitFor(()=>!existsSync(directory));
  assert.equal(server.getThread(threadId).active_turn_id,undefined);
});


test('permission host cannot approve non-question tools in guarded modes', () => {
  for (const mode of ['default','acceptEdits','dontAsk']) {
    const messages=[{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'approve',arguments:{tool_name:'Bash',input:{command:'dangerous'}}}}];
    const out=JSON.parse(execFileSync(process.execPath,[runtime,'host',mode],{input:messages.map(JSON.stringify).join('\n')+'\n'}));
    assert.equal(JSON.parse(out.result.content[0].text).behavior,'deny');
  }
});
