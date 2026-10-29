import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SupabaseProvider,learningRedirects} from '../provider.mjs';
import {loadMigrations} from '../migrations.mjs';
const evidence=JSON.parse(await readFile(new URL('../catalog-evidence.json',import.meta.url),'utf8'));
const migrations=await loadMigrations(),ref='abcdefghijklmnopqrst',config={ownerEmail:'owner@example.com',hubOrigin:'https://hub.example.com'};
const maintainKeys=new Set(['learning_courses','learning_libraries','learning_library_snapshots','learning_snapshots'].map(name=>`public.${name}:service_role:MAINTAIN`));
const olderCatalog=catalog=>catalog.filter(item=>!(item.kind==='table-grant'&&maintainKeys.has(item.key)&&item.value===false));
// PostgreSQL 17's captured fixture minus the four new MAINTAIN grants models
// 15/16's documented GRANT ALL table privilege set. Observed grants stay intact.
async function fixture(major,{stage=0,alter=value=>value}={}){
 let current=stage,migrationCalls=0;
 const snapshot=()=>{const catalog=alter(structuredClone(major<17?olderCatalog(evidence[current].catalog):evidence[current].catalog));return {catalog,schema_hash:createHash('md5').update(JSON.stringify(catalog)).digest('hex'),postgres_major:major};};
 const auth={site_url:config.hubOrigin,uri_allow_list:learningRedirects(config.hubOrigin).join(','),disable_signup:false,external_email_enabled:true,mailer_autoconfirm:false,mailer_allow_unverified_email_sign_ins:false,external_anonymous_users_enabled:false,mailer_templates_confirmation_content:'<p>Your Touchline sign-in code is {{ .Token }}</p>',mailer_templates_magic_link_content:'<p>Your Touchline sign-in code is {{ .Token }}</p>'};
 const request=async(address,options)=>{
  const path=new URL(address).pathname;if(path.endsWith('/config/auth'))return Response.json(auth);if(path.endsWith('/api-keys'))return Response.json([{type:'publishable',api_key:'sb_publishable_example'}]);
  if(path.endsWith('/database/migrations')){migrationCalls++;current++;return Response.json({});}
  const {query}=JSON.parse(options.body);
  if(query.startsWith('select catalog,'))return Response.json([snapshot()]);
  if(query.includes("current_setting('server_version_num')"))return Response.json([{major,users:0}]);
  if(query.startsWith('select name from unnest'))return Response.json([]);
  if(query.startsWith('select s.email'))return Response.json([{email:config.ownerEmail,owner_user_id:null,users:0}]);
  throw Error('Unexpected catalog-version fixture query');
 };
 const provider=await SupabaseProvider.create({apps:{},migrations,request});
 return {provider,snapshot,get migrationCalls(){return migrationCalls;}};
}
test('catalog inspection, every migration checkpoint and verification support version-specific table grants',async()=>{
 for(const major of [15,16,17]){
  const f=await fixture(major);
  for(let index=0;index<=migrations.length;index++){
   const inspected=await f.provider.inspect({},ref,config);assert.equal(inspected.compatibility,index?'touchline':'empty',`PostgreSQL ${major}, migration ${index}`);assert.equal(inspected.postgresMajor,major);assert.equal(inspected.schemaHash,f.snapshot().schema_hash);
   if(index<migrations.length){const result=await f.provider.applyMigration({},ref,migrations[index],{schemaHash:f.snapshot().schema_hash});assert.equal(result.schemaHash,f.snapshot().schema_hash);}
  }
  assert.equal((await f.provider.verify({},ref,config)).ready,true);assert.equal(f.migrationCalls,4);
 }
});
test('version adaptation never ignores observed extra grants, changed grant options or missing current privileges',async()=>{
 for(const major of [15,16,17])for(const alter of [
  catalog=>[...catalog,{kind:'table-grant',key:'public.learning_courses:unexpected_role:SELECT',value:false}],
  catalog=>[...catalog,{kind:'table-grant',key:'public.learning_courses:anon:MAINTAIN',value:false}],
  catalog=>catalog.map(item=>item.key==='public.learning_courses:service_role:SELECT'?{...item,value:true}:item),
 ]){const f=await fixture(major,{stage:1,alter});assert.equal((await f.provider.inspect({},ref,config)).compatibility,'unknown');await assert.rejects(f.provider.applyMigration({},ref,migrations[1],{schemaHash:f.snapshot().schema_hash}),{code:'stale_review'});assert.equal(f.migrationCalls,0);const complete=await fixture(major,{stage:4,alter});await assert.rejects(complete.provider.verify({},ref,config),{code:'verification_failed'});}
 const missing=await fixture(17,{stage:1,alter:olderCatalog});assert.equal((await missing.provider.inspect({},ref,config)).compatibility,'unknown');await assert.rejects(missing.provider.applyMigration({},ref,migrations[1],{schemaHash:missing.snapshot().schema_hash}),{code:'stale_review'});const incomplete=await fixture(17,{stage:4,alter:olderCatalog});await assert.rejects(incomplete.provider.verify({},ref,config),{code:'verification_failed'});
});
