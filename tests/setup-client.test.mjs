import test from 'node:test';
import assert from 'node:assert/strict';
import {SetupClient} from '../web/setup/client.js';

const configuration={ready:true,missing:[],ownerEmail:'owner@example.com',hubOrigin:'https://hub.example.com'};
const unlocked={authenticated:true,csrfToken:'csrf-from-owner-session',configuration,setup:null,projects:[]};
function fixture(responses){
 const calls=[],redirects=[];
 const client=new SetupClient({fetch:async(url,options)=>{calls.push({url,options});const next=responses.shift();if(next instanceof Error)throw next;return new Response(JSON.stringify(next.body),{status:next.status??200,headers:{'Content-Type':'application/json'}});},navigate:url=>redirects.push(url)});
 return {client,calls,redirects};
}
test('setup code is posted once, never retained in state, and owner session uses same-origin requests',async()=>{
 const f=fixture([{body:{authenticated:false}},{body:unlocked}]);
 await f.client.load();assert.equal(f.client.getSnapshot().authenticated,false);
 await f.client.unlock('one-use-local-setup-code');
 assert.equal(f.client.getSnapshot().authenticated,true);
 assert.ok(!JSON.stringify(f.client.getSnapshot()).includes('one-use-local-setup-code'));
 assert.equal(f.calls[1].url,'/api/setup/unlock');
 assert.equal(f.calls[1].options.credentials,'same-origin');
 assert.equal(f.calls[1].options.redirect,'error');
 assert.equal(JSON.parse(f.calls[1].options.body).code,'one-use-local-setup-code');
});
test('mutating setup actions carry session CSRF and only validated authorization redirects leave the page',async()=>{
 const f=fixture([{body:unlocked},{body:{...unlocked,setup:{id:'setup-one',phase:'awaiting-discovery'},authorizeUrl:'https://api.supabase.com/v1/oauth/authorize?client_id=discovery'}}]);
 await f.client.load();await f.client.act('begin',{});
 assert.equal(f.calls[1].options.headers['X-Touchline-CSRF'],'csrf-from-owner-session');
 assert.equal(f.redirects.length,1);
 const bad=fixture([{body:unlocked},{body:{...unlocked,authorizeUrl:'https://untrusted.example/collect'}}]);
 await bad.client.load();await bad.client.act('begin',{});
 assert.deepEqual(bad.redirects,[]);assert.equal(bad.client.getSnapshot().error,true);
});
test('session loss clears private setup state and server exceptions do not become UI text',async()=>{
 const f=fixture([{body:{...unlocked,setup:{id:'setup-one',phase:'reviewed',review:{reviewHash:'a'.repeat(64)}}}},{status:401,body:{error:{code:'unauthorized',message:'secret must not render'}}}]);
 await f.client.load();await f.client.act('prepare',{id:'setup-one',reviewHash:'a'.repeat(64)});
 const state=f.client.getSnapshot();assert.equal(state.authenticated,false);assert.equal(state.setup,null);
 assert.ok(!state.message.includes('secret'));assert.equal(state.busy,false);
});
test('a failed request keeps the reviewed selection and offers an explicit retry without replaying writes',async()=>{
 const setup={id:'setup-one',phase:'reviewed',review:{reviewHash:'a'.repeat(64)}};
 const f=fixture([{body:{...unlocked,setup}},new Error('provider-token-secret')]);
 await f.client.load();await f.client.act('install',{id:'setup-one',reviewHash:'a'.repeat(64)});
 assert.deepEqual(f.client.getSnapshot().setup,setup);assert.equal(f.client.getSnapshot().error,true);
 assert.ok(!f.client.getSnapshot().message.includes('provider-token-secret'));assert.equal(f.calls.length,2);
});
test('preparation advances recorded steps without replaying failed or unchanged work',async()=>{
 const setup={id:'setup-one',revision:0,phase:'ready-to-prepare',steps:[{id:'first',status:'pending'}]};
 const f=fixture([{body:{...unlocked,setup}},{body:{...unlocked,setup:{...setup,revision:1}}},{body:{...unlocked,setup:{...setup,revision:2,steps:[{id:'first',status:'complete'}]}}},{body:{...unlocked,setup:{...setup,revision:3,phase:'complete'}}}]);
 await f.client.load();assert.equal(await f.client.prepare('setup-one','hash'),true);assert.equal(f.calls.length,4);
 const stalled=fixture([{body:{...unlocked,setup}},{body:{...unlocked,setup}}]);await stalled.client.load();assert.equal(await stalled.client.prepare('setup-one','hash'),false);assert.equal(stalled.calls.length,2);assert.match(stalled.client.getSnapshot().message,/no recorded progress/);
});
test('stalled request headers and response bodies release busy state without replay',async()=>{
 for(const kind of ['headers','body']){
  let calls=0,signal;
  const client=new SetupClient({requestTimeout:10,fetch:async(_url,options)=>{calls++;signal=options.signal;if(kind==='headers')return new Promise(()=>{});return new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.error(Error('aborted')));}}),{headers:{'Content-Type':'application/json'}});}});
  assert.equal(await client.load(),false);assert.equal(client.state.busy,false);assert.equal(client.state.error,true);assert.equal(signal.aborted,true);assert.equal(calls,1);
 }
});
test('unauthorized headers clear setup privacy immediately even when the error body stalls',async()=>{
 let calls=0;
 const client=new SetupClient({requestTimeout:30,fetch:async(_url,options)=>{if(++calls===1)return Response.json({...unlocked,setup:{id:'setup-one',phase:'reviewed'}});return new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.error(Error('aborted')));}}),{status:401,headers:{'Content-Type':'application/json'}});}});
 await client.load();const pending=client.load();await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(client.state.busy,true);assert.equal(client.state.authenticated,false);assert.equal(client.state.setup,null);assert.equal(client.state.configuration,null);assert.equal(client.csrf,'');
 assert.equal(await pending,false);assert.equal(client.state.busy,false);assert.equal(calls,2);
});
