import {readFile} from 'node:fs/promises';
import {canonical,digest,fail,text} from './security.mjs';
const refPattern=/^[a-z0-9]{20}$/;
export const expectedScopes=Object.freeze({discovery:['projects:read','database:read','auth:read'],install:['projects:read','database:read','database:write','auth:read','auth:write','secrets:read']});
const authFields=['site_url','uri_allow_list','disable_signup','external_email_enabled','mailer_autoconfirm','mailer_allow_unverified_email_sign_ins','external_anonymous_users_enabled','mailer_templates_confirmation_content','mailer_templates_magic_link_content','external_google_enabled','external_apple_enabled'];
export const learningRedirects=hubOrigin=>[hubOrigin+'/auth/return\\?touchline-return=*','http://127.0.0.1:8765/auth/return\\?touchline-return=*','http://localhost:8765/auth/return\\?touchline-return=*','love.hannasage.touchline://auth/return\\?attempt=*'];
const tokenTemplate='<p>Your Touchline sign-in code is {{ .Token }}</p>';
// The captured PostgreSQL 17 baseline has four GRANT ALL entries for MAINTAIN,
// introduced in 17: https://www.postgresql.org/docs/release/17.0/
// Adapt only expected evidence for 15/16. Never remove observed grants or alter hashes.
const maintainKeys=new Set(['learning_courses','learning_libraries','learning_library_snapshots','learning_snapshots'].map(name=>`public.${name}:service_role:MAINTAIN`));
const expectedCatalog=(catalog,major)=>major===15||major===16?catalog.filter(item=>!(item.kind==='table-grant'&&maintainKeys.has(item.key)&&item.value===false)):catalog;
export class SupabaseProvider {
 #apps;#migrations;#request;#now;#catalog;#evidence;
 constructor({apps,migrations,request=fetch,now=Date.now,catalog,evidence}){this.#apps=structuredClone(apps);this.#migrations=structuredClone(migrations);this.#request=request;this.#now=now;this.#catalog=catalog.trim().replace(/;$/,'');this.#evidence=structuredClone(evidence);}
 static async create(options){const [catalog,raw]=await Promise.all([readFile(new URL('./catalog.sql',import.meta.url),'utf8'),readFile(new URL('./catalog-evidence.json',import.meta.url),'utf8')]);const evidence=JSON.parse(raw);if(canonical(evidence.at(-1).migrations)!==canonical(options.migrations.map(({id,sha256})=>({id,sha256}))))throw Error('Regenerate catalog evidence for this migration release.');return new SupabaseProvider({...options,catalog,evidence});}
 #ref(ref){if(!refPattern.test(ref))fail('invalid_project','The project reference is invalid.');return ref;}
 async #json(path,{token,method='GET',body,headers={}}={}){
  const destination='https://api.supabase.com'+path;let response;
  try{response=await this.#request(destination,{method,redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token.accessToken}:{}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});}catch{fail('provider_unavailable','Supabase could not be reached. Recheck setup before retrying.',true);}
  if(response.redirected||response.url&&response.url!==destination)fail('provider_error','Supabase returned an unexpected destination.');
  if(!response.ok){if([401,403].includes(response.status))fail('provider_denied','Supabase setup permission is missing or was revoked. Authorize again.');if(response.status===429)fail('provider_rate_limited','Supabase is limiting setup requests. Wait before retrying.',true);fail('provider_unavailable','Supabase could not complete this setup step. Recheck it before retrying.',true);}
  if(response.status===204)return null;
  if(!response.headers.get('content-type')?.startsWith('application/json'))fail('provider_error','Supabase returned an unsupported response.');
  const reader=response.body?.getReader();if(!reader)fail('provider_error','Supabase returned an empty response.');let size=0;const chunks=[];
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>1048576){await reader.cancel();fail('provider_error','The Supabase setup response exceeded its size limit.');}chunks.push(part.value);}}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('provider_error','Supabase returned invalid setup data.');}
 }
 async exchange(phase,{code,verifier,redirectUri}){
  const app=this.#apps[phase];if(!app||redirectUri!==app.redirectUri)fail('invalid_state','The setup callback address changed.');text(code,4096);text(verifier,128);
  const result=await this.#json('/v1/oauth/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(app.clientId+':'+app.clientSecret).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:redirectUri}).toString()});
  try {
  text(result?.access_token,8000);text(result?.refresh_token,8000);if(result.token_type!=='Bearer'||!Number.isSafeInteger(result.expires_in)||result.expires_in<=0||result.expires_in>86400)fail('provider_error','Supabase returned invalid token metadata.');
  if(result.scope!==undefined){if(typeof result.scope!=='string')fail('invalid_scopes','Supabase returned invalid setup scopes.');const granted=new Set(result.scope.split(/\s+/).filter(Boolean)),expected=expectedScopes[phase];if(expected.some(value=>!granted.has(value))||[...granted].some(value=>!expected.includes(value)))fail('invalid_scopes','The OAuth registration permissions do not match this setup step. Correct its scopes.');}
  return {accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:this.#now()+result.expires_in*1000};
  } catch(error) {
   error.revocationPending=true;
   if(typeof result?.refresh_token==='string'&&result.refresh_token.length>0&&result.refresh_token.length<=8000){try{await this.revoke(phase,{refreshToken:result.refresh_token});error.revocationPending=false;}catch{/* The safe flow status must retain the manual revocation notice. */}}
   throw error;
  }
 }
 async revoke(phase,token){const app=this.#apps[phase];if(!app)fail('invalid_state','Unknown setup registration.');return this.#json('/v1/oauth/revoke',{method:'POST',body:{client_id:app.clientId,client_secret:app.clientSecret,refresh_token:token.refreshToken}});}
 async projects(token){const values=await this.#json('/v1/projects',{token});if(!Array.isArray(values)||values.length>1000)fail('provider_error','Supabase returned an invalid project list.');return values.map(value=>({ref:value.ref||value.id,organizationId:value.organization_slug||value.organization_id,name:value.name}));}
 async #query(token,ref,query,parameters=[],readOnly=true){const result=await this.#json(`/v1/projects/${this.#ref(ref)}/database/query${readOnly?'/read-only':''}`,{token,method:'POST',body:{query,parameters}});if(!Array.isArray(result))fail('provider_error','Supabase returned an unsupported SQL result.');return result;}
 async #auth(token,ref){const raw=await this.#json(`/v1/projects/${this.#ref(ref)}/config/auth`,{token});if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('provider_error','Supabase returned invalid account configuration.');return Object.fromEntries(authFields.map(key=>[key,raw[key]??null]));}
 async #snapshot(token,ref){const rows=await this.#query(token,ref,`select catalog,md5(catalog::text) as schema_hash,current_setting('server_version_num')::integer/10000 as postgres_major from (${this.#catalog}) snapshot`);const row=rows[0];if(rows.length!==1||!Array.isArray(row?.catalog)||!/^[a-f0-9]{32}$/.test(row?.schema_hash||'')||!Number.isInteger(row.postgres_major)||row.postgres_major<15)fail('inspection_failed','The database catalog could not be read safely.');return row;}
 #matches(snapshot,catalog){return canonical(snapshot.catalog)===canonical(expectedCatalog(catalog,snapshot.postgres_major));}
 async #dedicated(token,ref){
  const resources=['storage.buckets','storage.objects','vault.secrets','supabase_functions.hooks'];
  const existing=await this.#query(token,ref,'select name from unnest($1::text[]) name where pg_catalog.to_regclass(name) is not null',[resources]);
  for(const row of existing){if(!resources.includes(row.name))fail('inspection_failed','The project resource inventory is invalid.');const result=await this.#query(token,ref,`select exists(select 1 from ${row.name} limit 1) as occupied`);if(result.length!==1||result[0].occupied!==false)return false;}return true;
 }
 async #ownerBoundary(token,ref,ownerEmail){
  const rows=await this.#query(token,ref,`select s.email,s.owner_user_id,u.email as account_email,u.email_confirmed_at is not null and not coalesce(u.is_anonymous,false) and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now()) as active,(select count(*)::integer from auth.users) as users from touchline_private.owner_settings s left join auth.users u on u.id=s.owner_user_id where s.singleton`);
  if(rows.length>1)fail('incompatible_owner','Inspect the existing owner configuration manually.');
  if(!rows.length){const count=await this.#query(token,ref,'select count(*)::integer as users from auth.users');if(count[0]?.users!==0)fail('incompatible_owner','This project contains accounts outside the configured owner boundary.');return null;}
  const owner=rows[0];if(owner.email!==ownerEmail||owner.owner_user_id&&(owner.account_email?.toLowerCase()!==ownerEmail||owner.active!==true||owner.users!==1)||!owner.owner_user_id&&owner.users!==0)fail('incompatible_owner','This project belongs to another or unconfirmed owner. Use the manual review route.');return owner;
 }
 async inspect(token,ref,{ownerEmail}={}){
  const [snapshot,auth,metadata]=await Promise.all([this.#snapshot(token,ref),this.#auth(token,ref),this.#query(token,ref,"select current_setting('server_version_num')::integer/10000 as major, count(*)::integer as users from auth.users")]);
  if(metadata.length!==1||metadata[0].major!==snapshot.postgres_major||!Number.isInteger(metadata[0].users))fail('inspection_failed','The database version and account boundary could not be confirmed.');
  const stage=this.#evidence.find(value=>this.#matches(snapshot,value.catalog));
  const owner=stage?.migrations.length?await this.#ownerBoundary(token,ref,ownerEmail):null;
  const dedicated=await this.#dedicated(token,ref);
  const compatibility=!dedicated?'unknown':stage?.migrations.length===0&&metadata[0].users===0?'empty':stage?.migrations.length?'touchline':'unknown';
  return {compatibility,fingerprint:digest(canonical({schema:snapshot.schema_hash,auth,owner,dedicated,users:metadata[0].users})),schemaHash:snapshot.schema_hash,authHash:digest(canonical(auth)),postgresMajor:metadata[0].major,migrations:stage?stage.migrations:[]};
 }
 #guard(schemaHash){if(!/^[a-f0-9]{32}$/.test(schemaHash||''))fail('stale_review','The database fingerprint is missing. Inspect the project again.');return `do $touchline_guard$ begin if (select md5(catalog::text) from (${this.#catalog}) snapshot) <> '${schemaHash}' then raise exception 'Touchline project changed after review'; end if; end $touchline_guard$;`;}
 async applyMigration(token,ref,migration,{schemaHash}={}){
  const index=this.#migrations.findIndex(value=>value.id===migration.id&&value.sha256===migration.sha256&&value.sql===migration.sql);if(index<0)fail('invalid_migration','Only the shipped migration SQL can run.');
  const before=await this.#snapshot(token,ref);if(before.schema_hash!==schemaHash||!this.#matches(before,this.#evidence[index].catalog))fail('stale_review','The database changed before this migration. Inspect it again.');
  const body=migration.sql.replace(/\bbegin\s*;/i,'').replace(/commit;\s*$/i,'');
  await this.#json(`/v1/projects/${this.#ref(ref)}/database/migrations`,{token,method:'POST',body:{name:'touchline_'+migration.id.replace(/\.sql$/,''),query:`begin; select pg_advisory_xact_lock(hashtext('touchline-setup')); ${this.#guard(schemaHash)}\n${body}\ncommit;`}});
  const after=await this.#snapshot(token,ref);if(!this.#matches(after,this.#evidence[index+1].catalog))fail('inspection_failed','The installed catalog differs from this release. Stop and inspect the project manually.');return {schemaHash:after.schema_hash};
 }
 async configureOwner(token,ref,{ownerEmail},{schemaHash}={}){text(ownerEmail,254);if(await this.#ownerBoundary(token,ref,ownerEmail))return;if(!/^[a-f0-9]{32}$/.test(schemaHash||''))fail('stale_review','Inspect the project again before configuring its owner.');const rows=await this.#query(token,ref,`select touchline_private.configure_owner($1::text) as owner_id where (select md5(catalog::text) from (${this.#catalog}) snapshot)=$2`,[ownerEmail,schemaHash],false);if(rows.length!==1)fail('stale_review','The database changed before owner configuration.');}
 async configureAuth(token,ref,{hubOrigin},{authHash}={}){
  const current=await this.#auth(token,ref);if(digest(canonical(current))!==authHash)fail('stale_review','Account configuration changed after review. Inspect it again.');
  const redirects=(current.uri_allow_list||'').split(',').map(value=>value.trim()).filter(Boolean);for(const callback of learningRedirects(hubOrigin))if(!redirects.includes(callback))redirects.push(callback);
  await this.#json(`/v1/projects/${this.#ref(ref)}/config/auth`,{token,method:'PATCH',body:{site_url:hubOrigin,disable_signup:false,uri_allow_list:redirects.join(','),external_email_enabled:true,mailer_autoconfirm:false,mailer_allow_unverified_email_sign_ins:false,external_anonymous_users_enabled:false,mailer_templates_confirmation_content:tokenTemplate,mailer_templates_magic_link_content:tokenTemplate}});
 }
 async verify(token,ref,config){
  const [snapshot,auth,owners,keys]=await Promise.all([this.#snapshot(token,ref),this.#auth(token,ref),this.#ownerBoundary(token,ref,config.ownerEmail),this.#json(`/v1/projects/${this.#ref(ref)}/api-keys?reveal=false`,{token})]);
  if(!learningRedirects(config.hubOrigin).every(value=>(auth.uri_allow_list||'').split(',').includes(value))||!this.#matches(snapshot,this.#evidence.at(-1).catalog)||!owners||owners.email!==config.ownerEmail||auth.site_url!==config.hubOrigin||auth.disable_signup!==false||auth.external_email_enabled!==true||auth.mailer_autoconfirm!==false||auth.mailer_allow_unverified_email_sign_ins!==false||auth.external_anonymous_users_enabled!==false||auth.mailer_templates_confirmation_content!==tokenTemplate||auth.mailer_templates_magic_link_content!==tokenTemplate)fail('verification_failed','The private backend configuration does not match the approved setup.');
  if(!Array.isArray(keys))fail('verification_failed','A publishable key could not be confirmed.');const key=keys.find(value=>value.type==='publishable'&&/^sb_publishable_[A-Za-z0-9_-]+$/.test(value.api_key||''));if(!key)fail('verification_failed','This project needs a publishable API key before its hub can be published.');
  return {ready:true,backend:{type:'supabase',url:`https://${ref}.supabase.co`,publishableKey:key.api_key},providers:['google','apple'].filter(name=>auth['external_'+name+'_enabled']===true)};
 }
}
