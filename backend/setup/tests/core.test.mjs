import test from 'node:test';
import assert from 'node:assert/strict';
import {SetupService} from '../core.mjs';
import {loadMigrations} from '../migrations.mjs';
import {MemoryStore,fixture} from './fixtures.mjs';

const settings={projectRef:'abcdefghijklmnopqrst',ownerEmail:'owner@example.com',hubName:'My learning hub',hubOrigin:'https://hub.example.com'};
async function discovered(f){const started=await f.service.begin(f.context);const state=new URL(started.authorizeUrl).searchParams.get('state');await f.service.callback(f.context,'discovery',{state,code:'discovery-code'});return started.id;}
async function approved(f){const id=await discovered(f);const review=await f.service.review(f.context,id,settings);const install=await f.service.authorizeInstall(f.context,id,review.reviewHash);await f.service.callback(f.context,'install',{state:new URL(install.authorizeUrl).searchParams.get('state'),code:'install-code'});return {id,review};}

async function finish(f,id,hash){for(let i=0;i<12;i++){const state=await f.service.prepare(f.context,id,hash);if(state.phase==='complete')return state;}throw Error('Setup did not finish');}

test('separate registrations, PKCE and encrypted server state; no secrets in safe views',async()=>{
 const f=fixture();const start=await f.service.begin(f.context,'org-one');const url=new URL(start.authorizeUrl);
 assert.equal(url.origin,'https://api.supabase.com');assert.equal(url.pathname,'/v1/oauth/authorize');assert.equal(url.searchParams.get('client_id'),'discovery-app');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('scope'),null);
 await f.service.callback(f.context,'discovery',{state:url.searchParams.get('state'),code:'test-code'});
 const raw=JSON.stringify([...f.store.rows.values()]);assert.ok(!raw.includes('access-secret'));assert.ok(!raw.includes('refresh-secret'));assert.ok(!raw.includes('codeVerifier'));
 const safe=JSON.stringify(await f.service.status(f.context,start.id));assert.ok(!safe.includes('sealed'));assert.ok(!safe.includes('secret'));assert.equal((await f.service.projects(f.context,start.id)).length,1);
});
test('state is single-use across two service instances and malformed callbacks fail closed',async()=>{
 const f=fixture();const started=await f.service.begin(f.context);const state=new URL(started.authorizeUrl).searchParams.get('state');
 const other=new SetupService({...f.options,store:f.store});const results=await Promise.allSettled([f.service.callback(f.context,'discovery',{state,code:'one'}),other.callback(f.context,'discovery',{state,code:'one'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.calls.filter(x=>x[0]==='exchange').length,1);
 await assert.rejects(f.service.callback(f.context,'install',{state,code:'one'}),{code:'invalid_state'});
});
test('owner session and CSRF bind every action, including callbacks',async()=>{
 const f=fixture();const started=await f.service.begin(f.context);const state=new URL(started.authorizeUrl).searchParams.get('state');
 for(const change of [{ownerId:'another'},{sessionId:'another'},{csrfToken:'another'},{verified:false}])await assert.rejects(f.service.callback({...f.context,...change},'discovery',{state,code:'code'}));
 assert.equal(f.calls.length,0);await f.service.callback(f.context,'discovery',{state,code:'code'});
});
test('expiry erases temporary credentials and rejects expired approvals',async()=>{
 const f=fixture();const {id,review}=await approved(f);f.advance(901000);await assert.rejects(finish(f,id,review.reviewHash),{code:'expired'});
 const row=await f.store.read(id);assert.equal(row.phase,'expired');assert.deepEqual(row.tokens,{});assert.equal(row.oauth,null);assert.equal(f.calls.filter(x=>x[0]==='apply').length,0);
});
test('unknown schemas and projects outside the consented organization never reach writes',async()=>{
 const f=fixture();const id=await discovered(f);f.inspection.compatibility='unknown';await assert.rejects(f.service.review(f.context,id,settings),{code:'incompatible_project'});
 f.inspection.compatibility='empty';await assert.rejects(f.service.review(f.context,id,{...settings,projectRef:'zzzzzzzzzzzzzzzzzzzz'}),{code:'project_not_authorized'});
 assert.equal(f.calls.filter(x=>x[0]==='apply').length,0);
});
test('explicit installation approval binds project, configuration and migration digest',async()=>{
 const f=fixture();const id=await discovered(f);const review=await f.service.review(f.context,id,settings);
 await assert.rejects(finish(f,id,review.reviewHash),{code:'approval_required'});
 await assert.rejects(f.service.authorizeInstall(f.context,id,'0'.repeat(64)),{code:'stale_review'});
 assert.equal(review.config.ownerEmail,'owner@example.com');assert.equal(review.config.hubName,'My learning hub');assert.ok(review.steps.some(s=>s.id==='configure-owner'));
});
test('stale inspection and installation organization changes block all writes',async()=>{
 const f=fixture();const {id,review}=await approved(f);f.inspection.fingerprint='changed';await assert.rejects(finish(f,id,review.reviewHash),{code:'stale_review'});assert.equal(f.calls.filter(x=>x[0]==='apply').length,0);
 const g=fixture();const flow=await approved(g);g.project.organizationId='org-other';await assert.rejects(g.service.prepare(g.context,flow.id,flow.review.reviewHash),{code:'project_not_authorized'});assert.equal(g.calls.filter(x=>x[0]==='apply').length,0);
});
test('concurrent prepare calls claim one operation and cancelled work cannot resume',async()=>{
 const f=fixture();const {id,review}=await approved(f);let release;const gate=new Promise(r=>{release=r;});f.setApply(async()=>gate);
 const first=finish(f,id,review.reviewHash);await f.waitForApply();await assert.rejects(f.service.prepare(f.context,id,review.reviewHash),{code:'operation_busy'});
 await f.service.cancel(f.context,id);release();await assert.rejects(first,{code:'operation_cancelled'});assert.equal((await f.store.read(id)).phase,'cancelled');assert.equal(f.calls.filter(x=>x[0]==='apply').length,1);
});
test('ambiguous writes require a new review; failures are scrubbed and credentials stay private',async()=>{
 const f=fixture();const {id,review}=await approved(f);f.setApply(async()=>{throw new Error('token access-secret should never escape');});
 await assert.rejects(finish(f,id,review.reviewHash),{code:'preparation_failed'});const status=await f.service.status(f.context,id);assert.equal(status.phase,'preparation-failed');assert.ok(!JSON.stringify(status).includes('access-secret'));
 await assert.rejects(finish(f,id,review.reviewHash),{code:'approval_required'});
});
test('failed durable writes prevent provider exchange and preparation',async()=>{
 const f=fixture();const started=await f.service.begin(f.context);f.store.fail=true;await assert.rejects(f.service.callback(f.context,'discovery',{state:new URL(started.authorizeUrl).searchParams.get('state'),code:'code'}));assert.equal(f.calls.length,0);
});
test('successful setup removes tokens and records only public result and step receipts',async()=>{
 const f=fixture();const {id,review}=await approved(f);const result=await finish(f,id,review.reviewHash);assert.equal(result.phase,'complete');assert.equal(result.steps.every(s=>s.status==='complete'),true);assert.deepEqual((await f.store.read(id)).tokens,{});assert.ok(!JSON.stringify(result).includes('access-secret'));
});
test('manifest is exactly the shipped migration allowlist and store has no silent fallback',async()=>{
 const migrations=await loadMigrations();assert.equal(migrations.length,4);assert.match(migrations[0].sha256,/^[a-f0-9]{64}$/);assert.ok(migrations.every(m=>m.sql.includes('begin;')));
 assert.throws(()=>new SetupService({...fixture().options,store:null}),/durable/i);assert.ok(new MemoryStore());
});
test('cancellation during backend verification cannot publish a public hub',async()=>{
 const f=fixture();let resolveVerify,observed;const gate=new Promise(r=>{resolveVerify=r;});const entered=new Promise(r=>{observed=r;});const original=f.options.provider.verify;f.options.provider.verify=async()=>{observed();await gate;return original();};
 const {id,review}=await approved(f);const pending=finish(f,id,review.reviewHash);await entered;await f.service.cancel(f.context,id);resolveVerify();await assert.rejects(pending,{code:'operation_cancelled'});assert.equal(await f.store.read('public-hub'),null);
});
test('unreadable token material records unresolved revocation without retaining credentials',async()=>{
 const f=fixture();const id=await discovered(f);const row=await f.store.read(id);await f.store.compareAndSwap(id,row.version,{...row,version:row.version+1,tokens:{discovery:'damaged'}});const result=await f.service.cancel(f.context,id);assert.equal(result.revocationPending,true);assert.deepEqual((await f.store.read(id)).tokens,{});
});
test('failed hosted discovery cannot mark the prepared backend complete',async()=>{
 const f=fixture();f.options.verifyPublished=async()=>false;f.service=new SetupService(f.options);const {id,review}=await approved(f);await assert.rejects(finish(f,id,review.reviewHash),{code:'verification_failed'});assert.equal((await f.service.status(f.context,id)).phase,'preparation-failed');
});
test('terminal state records pending revocation before network cleanup begins',async()=>{
 const f=fixture();const id=await discovered(f);let entered,release;const seen=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});f.options.provider.revoke=async()=>{entered();await gate;};
 const closing=f.service.cancel(f.context,id);await seen;const row=await f.store.read(id);assert.equal(row.phase,'cancelled');assert.equal(row.revocationPending,true);assert.deepEqual(row.tokens,{});release();assert.equal((await closing).revocationPending,false);
});
test('cancel during token exchange preserves failed revocation notice',async()=>{
 const f=fixture();const start=await f.service.begin(f.context);let entered,release;const seen=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});const original=f.options.provider.exchange;f.options.provider.exchange=async(...args)=>{entered();await gate;return original(...args);};f.options.provider.revoke=async()=>{throw Error('offline');};
 const callback=f.service.callback(f.context,'discovery',{state:new URL(start.authorizeUrl).searchParams.get('state'),code:'held'});await seen;await f.service.cancel(f.context,start.id);release();await assert.rejects(callback,{code:'operation_cancelled'});const row=await f.store.read(start.id);assert.equal(row.phase,'cancelled');assert.equal(row.revocationPending,true);
});
test('prepare preflight and each write have separate durable request boundaries',async()=>{
 const f=fixture();const {id,review}=await approved(f);let state=await f.service.prepare(f.context,id,review.reviewHash);assert.equal(state.phase,'ready-to-prepare');assert.equal(f.calls.filter(x=>x[0]==='apply').length,0);state=await f.service.prepare(f.context,id,review.reviewHash);assert.equal(state.steps.filter(x=>x.status==='complete').length,1);assert.equal(state.phase,'ready-to-prepare');
});
test('an interrupted step lease forces fresh inspection instead of blind retry',async()=>{
 const f=fixture();const {id,review}=await approved(f);await f.service.prepare(f.context,id,review.reviewHash);let release;const gate=new Promise(r=>{release=r;});f.setApply(async()=>gate);const pending=f.service.prepare(f.context,id,review.reviewHash);await f.waitForApply();f.advance(61000);assert.equal((await f.service.status(f.context,id)).phase,'preparation-failed');release();await assert.rejects(pending,{code:'operation_cancelled'});await assert.rejects(f.service.prepare(f.context,id,review.reviewHash),{code:'approval_required'});
});
test('failed exchange cleanup cannot be erased by authorizing another grant in the same flow',async()=>{
 const f=fixture();const id=await discovered(f);const review=await f.service.review(f.context,id,settings);const install=await f.service.authorizeInstall(f.context,id,review.reviewHash);f.options.provider.exchange=async()=>{const error=Error('invalid grant');error.revocationPending=true;throw error;};await assert.rejects(f.service.callback(f.context,'install',{state:new URL(install.authorizeUrl).searchParams.get('state'),code:'invalid'}));assert.equal((await f.service.status(f.context,id)).revocationPending,true);await assert.rejects(f.service.authorizeInstall(f.context,id,review.reviewHash),{code:'manual_revoke_required'});assert.equal((await f.service.status(f.context,id)).revocationPending,true);
});
test('expired status exposes the safe cleanup receipt while mutations stay rejected',async()=>{
 const f=fixture();const {id,review}=await approved(f);f.options.provider.revoke=async()=>{throw Error('offline');};f.advance(901000);const state=await f.service.status(f.context,id);assert.equal(state.phase,'expired');assert.equal(state.revocationPending,true);assert.deepEqual((await f.store.read(id)).tokens,{});assert.equal((await f.service.status(f.context,id)).phase,'expired');await assert.rejects(f.service.prepare(f.context,id,review.reviewHash),{code:'expired'});await assert.rejects(f.service.status({...f.context,sessionId:'other'},id),{code:'unauthorized'});
});
