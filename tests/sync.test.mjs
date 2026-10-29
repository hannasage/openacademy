import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {ConnectionController} from '../web/connection/controller.js';
const backup=JSON.parse(await readFile('tests/fixtures/contracts/valid/legacy-backup.json','utf8'));
const record=JSON.parse(await readFile('tests/fixtures/contracts/valid/local-record.json','utf8'));
const hub=JSON.parse(await readFile('tests/fixtures/contracts/valid/hub-description.json','utf8'));
const account={id:'0bdb7cc4-f92d-4ac7-84b7-49928d888f2c',email:'learner@example.com',email_confirmed_at:'2026-10-28T12:00:00Z',is_anonymous:false};
const sessionId='fbbbbccb-8f23-4e5f-b13c-c7ff2a814079';
function storage(){const map=new Map();return {get length(){return map.size;},clear(){map.clear();},key(i){return Array.from(map.keys())[i]??null;},getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};}
function harness(){
 const stored=storage(),transient=storage(),events=[];
 let user=null,now=100000,listener=()=>{},scopeFailure=false,otpFailure=false,signOutFailure=false,denied=false,rows=[];
 let getUserHook, snapshotHook, verifyHook,scopeHook,registerHook;
 const rpc=async(name,args)=>{
  events.push({rpc:name,args});
  if(name==='register_touchline_session')return registerHook?registerHook():denied?{data:null,error:{code:'42501'}}:{data:{sessionId,accountId:user?.id},error:null};
  if(name==='list_touchline_sessions')return {data:[{sessionId,label:'Browser',createdAt:null,lastSeenAt:null,isCurrent:true}],error:null};
  if(name==='revoke_touchline_session'){denied=true;return {data:true,error:null};}
  return {data:{id:args.course_id,curriculum:args.course_content,progress:args.course_progress,status:args.course_status,format_version:1,revision:0,updated_at:'2026-10-29T12:00:00Z'},error:null};
 };
 const client={auth:{
  onAuthStateChange:callback=>{listener=callback;return {data:{subscription:{unsubscribe(){}}}};},
  getSession:async()=>({data:{session:user?{user,access_token:'token-'+user.id}:null},error:null}),
  getUser:async()=>getUserHook?getUserHook():({data:{user},error:null}),
  signInWithOtp:async args=>{events.push({otp:args});return {data:{user:null,session:null},error:otpFailure?{status:429}:null};},
  verifyOtp:async args=>{events.push({verify:args});if(verifyHook)return verifyHook();user=account;listener('SIGNED_IN',{user,access_token:'token-'+user.id});return {data:{user},error:null};},
  signOut:async args=>{events.push({signout:args});if(signOutFailure)return {error:Error('offline')};user=null;listener('SIGNED_OUT',null);return {error:null};},
  signInWithOAuth:async args=>{events.push({oauth:args});return {data:{url:hub.backend.url+'/auth/v1/authorize?provider='+args.provider},error:null};},
  exchangeCodeForSession:async code=>{events.push({exchange:code});user=account;return {data:{user},error:null};},
 },rpc,from:()=>({select:()=>({order:async()=>({data:rows,error:null}),eq:()=>({single:async()=>({data:{...rows[0],progress:backup.state},error:null})})})})};
 const deps={makeClient:(_hub,token)=>{events.push({clientToken:token??null});return client;},storage:stored,transient,now:()=>now,appOrigin:'http://127.0.0.1:8765',navigate:url=>events.push({navigate:url}),request:async()=>new Response(JSON.stringify(hub),{headers:{'content-type':'application/json'}}),accounts:{
  setAccountScope:async origin=>{if(scopeFailure)throw Error('Save failed');if(scopeHook)await scopeHook(origin);events.push({scope:origin});},
  invalidateAccountScope:async()=>{events.push('invalidated');},
  snapshot:async()=>snapshotHook?snapshotHook():backup,
  importCloud:async()=>true,download(){},
  publicationRecords:async()=>{if(snapshotHook)await snapshotHook();return {records:[record],focusRecordId:record.recordId};},
  prepareCloudImport:async()=>({token:'review',local:record}),commitCloudImport:async()=>({recordId:record.recordId,revision:1}),
 }};
 const controller=new ConnectionController(deps);
 return {controller,deps,events,stored,transient,client,
  connect:async()=>{await controller.find(hub.hubOrigin);assert.equal(await controller.confirm(),true);},
  login:async()=>{await controller.requestCode(account.email);assert.equal(await controller.verifyCode('123456'),true);},
  registerHook:value=>{registerHook=value;},scopeHook:value=>{scopeHook=value;},advance:ms=>{now+=ms;},deny:value=>{denied=value;},failScope:value=>{scopeFailure=value;},failOTP:value=>{otpFailure=value;},failSignOut:value=>{signOutFailure=value;},rows:value=>{rows=value;},getUserHook:value=>{getUserHook=value;},snapshotHook:value=>{snapshotHook=value;},verifyHook:value=>{verifyHook=value;},changeAccount:value=>{user=value;listener(value?'SIGNED_IN':'SIGNED_OUT',value?{user:value,access_token:'token-'+value.id}:null);},
 };
}
test('email code and confirmed owner registration precede private selection',async()=>{
 const h=harness();await h.connect();await h.controller.requestCode(account.email);
 assert.equal(h.controller.getSnapshot().phase,'code');assert.equal(h.events.filter(x=>x?.scope?.kind==='cloud').length,0);
 assert.equal(await h.controller.requestCode(account.email),false);h.advance(61000);assert.equal(await h.controller.requestCode(account.email),true);
 assert.equal(await h.controller.verifyCode('123456'),true);assert.equal(h.controller.getSnapshot().phase,'ready');
 assert.ok(h.events.findIndex(x=>x?.rpc==='register_touchline_session')<h.events.findIndex(x=>x?.scope?.kind==='cloud'));
 assert.ok(h.events.some(x=>x?.clientToken==='token-'+account.id));
});
test('expired codes, rate limits and unknown accounts preserve local learning',async()=>{
 const h=harness();await h.connect();h.failOTP(true);assert.equal(await h.controller.requestCode(account.email),false);assert.match(h.controller.getSnapshot().message,/Too many/);
 h.failOTP(false);await h.controller.requestCode(account.email);h.verifyHook(async()=>({error:Error('otp_expired')}));assert.equal(await h.controller.verifyCode('123456'),false);assert.match(h.controller.getSnapshot().message,/expired/);
 h.verifyHook(null);h.deny(true);assert.equal(await h.controller.verifyCode('123456'),false);assert.equal(h.controller.getSnapshot().accountId,null);assert.ok(h.events.includes('invalidated'));assert.equal(h.events.filter(x=>x?.scope?.kind==='cloud').length,0);
});
test('failed local saving prevents backend replacement and another operation cannot overlap',async()=>{
 const h=harness();await h.connect();h.failScope(true);assert.equal(await h.controller.useDifferentHub(),false);assert.equal(h.controller.getSnapshot().hub.hubId,hub.hubId);
 h.failScope(false);let resolve;h.verifyHook(()=>new Promise(r=>{resolve=r;}));await h.controller.requestCode(account.email);const pending=h.controller.verifyCode('123456');await new Promise(r=>setTimeout(r,0));assert.equal(await h.controller.useDifferentHub(),false);resolve({error:Error('expired')});await pending;
});
test('account loss cancels a delayed verification and publication',async()=>{
 const h=harness();await h.connect();await h.login();let finish;
 h.snapshotHook(()=>new Promise(r=>{finish=r;}));const publishing=h.controller.publications.publish([record.recordId]);while(!finish)await new Promise(r=>setTimeout(r,0));h.changeAccount(null);finish(backup);assert.equal(await publishing,false);
 assert.equal(h.events.some(x=>x?.rpc==='publish_learning_course'),false);assert.equal(h.controller.getSnapshot().courses.length,0);
});
test('canceled download does not advance the saved publication revision',async()=>{
 const h=harness();await h.connect();await h.login();h.rows([{id:backup.curriculum.id,curriculum:backup.curriculum,revision:8,status:'active',format_version:1,updated_at:'2026-10-28T12:00:00Z'}]);
 await h.controller.download(backup.curriculum.id);h.controller.publications.cancelReview();assert.match(h.controller.publications.state.message,/unchanged/);await h.controller.publications.publish([record.recordId]);assert.equal(h.events.find(x=>x?.rpc==='publish_learning_course').args.expected_revision,-1);
});
test('revocation denies the next private request and sign-out cleanup remains retryable',async()=>{
 const h=harness();await h.connect();await h.login();h.deny(true);assert.equal(await h.controller.refresh(),false);assert.equal(h.controller.getSnapshot().accountId,null);assert.equal(h.controller.getSnapshot().needsSignOut,true);
 h.failSignOut(true);assert.equal(await h.controller.signOut(),false);assert.equal(h.controller.getSnapshot().needsSignOut,true);h.failSignOut(false);assert.equal(await h.controller.signOut(),true);assert.equal(h.controller.getSnapshot().needsSignOut,false);
});
test('provider returns bind to one hub, nonce, callback, expiry and PKCE exchange',async()=>{
 const h=harness();await h.connect();const provider=hub.auth.providers[0];
 assert.ok(provider);assert.equal(await h.controller.startProvider(provider),true);
 const pending=JSON.parse(h.transient.getItem('touchline-account-return:v1'));assert.ok(pending.nonce);
 const returned=new ConnectionController(h.deps);assert.equal(await returned.initialize(pending.callback+'&code=one-use-code'),true);assert.equal(returned.getSnapshot().phase,'ready');assert.equal(h.events.filter(x=>x?.exchange).length,1);
 const replay=new ConnectionController(h.deps);assert.equal(await replay.initialize(pending.callback+'&code=one-use-code'),false);assert.equal(h.events.filter(x=>x?.exchange).length,1);
});
test('denied, mismatched, expired and foreign-provider returns never exchange a code',async()=>{
 for(const variant of ['denied','state','expired','path']){
  const h=harness();await h.connect();await h.controller.startProvider(hub.auth.providers[0]);const pending=JSON.parse(h.transient.getItem('touchline-account-return:v1'));
  if(variant==='expired')h.advance(600001);
  const url=variant==='denied'?pending.callback+'&error=access_denied':variant==='state'?pending.callback.replace(pending.nonce,crypto.randomUUID())+'&code=no':variant==='path'?pending.callback.replace('/auth/return','/other')+'&code=no':pending.callback+'&code=no';
  assert.equal(await new ConnectionController(h.deps).initialize(url),false);assert.equal(h.events.filter(x=>x?.exchange).length,0);
 }
 const h=harness();await h.connect();assert.equal(await h.controller.startProvider('supabase'),false);
});

test('a new sign-in interrupts initial account verification before scope selection',async()=>{
 const h=harness();await h.connect();await h.controller.requestCode(account.email);
 let resolve;h.getUserHook(()=>new Promise(r=>{resolve=r;}));const pending=h.controller.verifyCode('123456');
 while(!resolve)await new Promise(r=>setTimeout(r,0));
 h.changeAccount({...account,id:'49bfc14a-a9d6-4941-8016-e480d719a061'});
 resolve({data:{user:account},error:null});assert.equal(await pending,false);
 assert.equal(h.events.filter(x=>x?.scope?.kind==='cloud').length,0);assert.equal(h.controller.getSnapshot().accountId,null);
});

test('an account change during activation clears the delayed private scope',async()=>{
 const h=harness();await h.connect();await h.controller.requestCode(account.email);let resolve;
 h.scopeHook(origin=>origin?new Promise(r=>{resolve=r;}):undefined);
 const pending=h.controller.verifyCode('123456');while(!resolve)await new Promise(r=>setTimeout(r,0));
 h.changeAccount({...account,id:'49bfc14a-a9d6-4941-8016-e480d719a061'});resolve();assert.equal(await pending,false);
 const lastScope=h.events.findLastIndex(x=>x?.scope?.kind==='cloud'),invalidation=h.events.lastIndexOf('invalidated');
 assert.ok(lastScope>=0&&invalidation>lastScope);assert.equal(h.controller.getSnapshot().accountId,null);
});

for(const step of ['getUser','register'])for(const failure of ['503','network'])test(`${step} ${failure} hides private records and retries without a new login`,async()=>{
 const h=harness();await h.connect();await h.login();
 const fail=async()=>{if(failure==='network')throw TypeError('Failed to fetch');return {data:null,error:{status:503,message:'unavailable'}};};
 if(step==='getUser')h.getUserHook(fail);else h.registerHook(fail);
 assert.equal(await h.controller.refresh(),false);
 assert.equal(h.controller.getSnapshot().accountId,null);assert.deepEqual(h.controller.getSnapshot().sessions,[]);
 assert.equal(h.controller.getSnapshot().needsSignOut,false);assert.equal(h.controller.getSnapshot().needsVerificationRetry,true);
 assert.match(h.controller.getSnapshot().message,/temporarily unavailable/);assert.ok(h.events.includes('invalidated'));
 const codes=h.events.filter(x=>x?.verify).length;
 h.getUserHook(null);h.registerHook(null);assert.equal(await h.controller.retryVerification(),true);
 assert.equal(h.controller.getSnapshot().phase,'ready');assert.equal(h.controller.getSnapshot().needsVerificationRetry,false);
 assert.equal(h.events.filter(x=>x?.verify).length,codes);assert.equal(h.events.some(x=>x?.signout),false);
});
for(const status of [401,403])test(`getUser ${status} requires sign-out rather than connection retry`,async()=>{
 const h=harness();await h.connect();await h.login();h.getUserHook(async()=>({data:{user:null},error:{status}}));
 assert.equal(await h.controller.refresh(),false);assert.equal(h.controller.getSnapshot().needsSignOut,true);
 assert.equal(h.controller.getSnapshot().needsVerificationRetry,false);assert.equal(h.controller.getSnapshot().accountId,null);
});

for(const status of [401,403])test(`registration HTTP ${status} with untyped error denies private access`,async()=>{
 const h=harness();await h.connect();await h.login();h.registerHook(async()=>({data:null,status,error:{message:'unauthorized'}}));
 assert.equal(await h.controller.refresh(),false);assert.equal(h.controller.getSnapshot().needsSignOut,true);
 assert.equal(h.controller.getSnapshot().needsVerificationRetry,false);assert.equal(h.controller.getSnapshot().accountId,null);
});
