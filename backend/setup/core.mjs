import {randomUUID} from 'node:crypto';
import {SetupError,fail,digest,secret,equal,canonical,exact,text,httpsOrigin,createVault} from './security.mjs';
import {migrationNames} from './migrations.mjs';
import {commitPublicHub} from './public-hub.mjs';
const FLOW_TTL=15*60*1000;
const STEP_LEASE=60000;
const callbackPhases=new Set(['discovery','install']);
const terminal=new Set(['complete','cancelled','expired']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reference=/^[a-z0-9]{20}$/;
const copy=value=>structuredClone(value);
const safeError=(code,message,retryable=false)=>({code,message,retryable});

// This service is server-only. Its durable store and authenticated context come
// from the owner-hosted adapter, never directly from an HTTP request body.
export class SetupService {
 #store;#provider;#vault;#now;#authenticate;#apps;#migrations;#manifest;#verifyPublished;
 constructor({store,provider,key,now=Date.now,authenticate,apps,migrations,verifyPublished}){
  if(!store||!['create','read','compareAndSwap','commitPublicHub'].every(name=>typeof store[name]==='function'))throw Error('A durable setup store is required.');
  if(typeof verifyPublished!=='function')throw Error('Hosted discovery and health verification is required.');
  this.#verifyPublished=verifyPublished;
  if(typeof authenticate!=='function')throw Error('A verified owner session is required.');
  if(!provider||!['exchange','revoke','projects','inspect','applyMigration','configureOwner','configureAuth','verify'].every(name=>typeof provider[name]==='function'))throw Error('A complete setup provider is required.');
  for(const phase of callbackPhases){const app=apps?.[phase];text(app?.clientId,200);text(app?.redirectUri,2048);const uri=new URL(app.redirectUri);if(uri.protocol!=='https:'||uri.username||uri.password||uri.search||uri.hash)throw Error('Use exact HTTPS setup callback URLs.');}
  if(apps.discovery.clientId===apps.install.clientId||apps.discovery.redirectUri===apps.install.redirectUri)throw Error('Discovery and installation need separate OAuth registrations.');
  if(!Array.isArray(migrations)||!migrations.length||migrations.length>migrationNames.length)throw Error('Use the shipped migration manifest.');
  migrations.forEach((value,index)=>{if(value.id!==migrationNames[index]||value.sha256!==digest(value.sql))throw Error('The migration manifest does not match its SQL.');});
  this.#store=store;this.#provider=provider;this.#vault=createVault(key);this.#now=now;this.#authenticate=authenticate;this.#apps=copy(apps);this.#migrations=copy(migrations);this.#manifest=digest(canonical(migrations.map(({id,sha256})=>({id,sha256}))));
 }
 async #identity(context){
  const value=await this.#authenticate(context);
  if(!value||value.verified!==true||!Number.isFinite(value.expiresAt)||value.expiresAt<=this.#now())fail('unauthorized','Unlock this connector before changing setup.');
  for(const key of ['ownerId','sessionId','csrfToken'])text(value[key],512);
  return digest(canonical({ownerId:value.ownerId,sessionId:value.sessionId,csrfToken:value.csrfToken}));
 }
 async #stored(id){if(!uuid.test(id))fail('invalid_input','Choose a valid setup.');try{const row=await this.#store.read(id);if(!row)fail('not_found','This setup no longer exists. Start again.');return row;}catch(error){if(error instanceof SetupError)throw error;fail('storage_unavailable','Setup storage is unavailable. No new step was started.',true);}}
 async #update(row,patch){const next={...copy(row),...copy(patch),version:row.version+1};let saved;try{saved=await this.#store.compareAndSwap(row.id,row.version,next);}catch{fail('storage_unavailable','Setup storage is unavailable. Check setup before retrying.',true);}if(!saved)fail('operation_cancelled','This setup changed in another request. Refresh its status.');return next;}
 async #flow(context,id,allowExpired=false){const binding=await this.#identity(context);let row=await this.#stored(id);if(!equal(binding,row.binding))fail('unauthorized','This setup belongs to another owner session.');if(row.expiresAt<=this.#now()&&!terminal.has(row.phase)){await this.expire(id);row=await this.#stored(id);}if(row.phase==='expired'&&!allowExpired)fail('expired','Setup permission expired. Start a new setup.');if(row.phase==='preparing'&&row.leaseUntil<=this.#now())return this.#update(row,{phase:'preparation-failed',approval:null,leaseUntil:null,error:safeError('interrupted_step','A setup step was interrupted. Inspect the project again before retrying.',true)});return row;}
 #safe(row){return {id:row.id,revision:row.version,phase:row.phase,expiresAt:row.expiresAt,review:row.review?copy(row.review):null,steps:copy(row.steps),error:row.error?copy(row.error):null,revocationPending:!!row.revocationPending,hub:row.publicHub?copy(row.publicHub):null};}
 #credentials(row,phase){const value=row.tokens[phase];if(!value)fail('authorization_required','Authorize this setup step first.');const credentials=this.#vault.open(value,row.id+':token:'+phase);if(!credentials||typeof credentials.accessToken!=='string'||credentials.expiresAt<=this.#now())fail('authorization_expired','Provider permission expired. Authorize setup again.');return credentials;}
 #authorize(row,phase){const nonce=secret(),verifier=secret(),app=this.#apps[phase],state=row.id+'.'+nonce;const url=new URL('https://api.supabase.com/v1/oauth/authorize');for(const [key,value] of Object.entries({client_id:app.clientId,redirect_uri:app.redirectUri,response_type:'code',state,code_challenge:Buffer.from(digest(verifier),'hex').toString('base64url'),code_challenge_method:'S256'}))url.searchParams.set(key,value);if(row.organizationId)url.searchParams.set('organization_slug',row.organizationId);return {authorizeUrl:url.href,oauth:{phase,stateDigest:digest(state),verifier:this.#vault.seal(verifier,row.id+':verifier:'+phase)}};}
 async begin(context,organizationId=null){
  const binding=await this.#identity(context);if(organizationId!==null&&(!/^[a-zA-Z0-9_-]{1,100}$/.test(organizationId)))fail('invalid_input','Choose a valid organization.');
  let row={id:randomUUID(),version:0,binding,phase:'awaiting-discovery',organizationId,expiresAt:this.#now()+FLOW_TTL,tokens:{},oauth:null,review:null,approval:null,steps:[],error:null,revocationPending:false};const {authorizeUrl,oauth}=this.#authorize(row,'discovery');row={...row,oauth};
  try{if(!await this.#store.create(row))throw Error();}catch{fail('storage_unavailable','Setup storage is unavailable. Authorization did not start.',true);}return {...this.#safe(row),authorizeUrl};
 }
 async callback(context,phase,input){
  if(!callbackPhases.has(phase))fail('invalid_state','This setup return is invalid.');exact(input,['state'],['code','error']);text(input.state,200);const id=input.state.split('.')[0];let row=await this.#flow(context,id);
  if(row.phase!=='awaiting-'+phase||row.oauth?.phase!==phase||!equal(row.oauth.stateDigest,digest(input.state)))fail('invalid_state','This setup return expired or was already used.');
  if((typeof input.code==='string')===(typeof input.error==='string'))fail('invalid_state','The provider returned an invalid setup result.');
  if(input.error!==undefined){text(input.error,200);row=await this.#update(row,{phase:phase==='discovery'?'authorization-failed':'reviewed',oauth:null,approval:null,error:safeError('consent_denied','Setup permission was not granted. No installation started.')});return this.#safe(row);}
  text(input.code,4096);const verifier=this.#vault.open(row.oauth.verifier,id+':verifier:'+phase);
  row=await this.#update(row,{phase:'exchanging-'+phase,oauth:null,revocationPending:true});let credentials;
  try{
   credentials=await this.#provider.exchange(phase,{code:input.code,verifier,redirectUri:this.#apps[phase].redirectUri});
   exact(credentials,['accessToken','refreshToken','expiresAt']);text(credentials.accessToken,16000);text(credentials.refreshToken,16000);if(!Number.isFinite(credentials.expiresAt)||credentials.expiresAt<=this.#now())fail('provider_error','The provider returned expired setup permission.');
   const current=await this.#flow(context,id);if(current.version!==row.version)fail('operation_cancelled','Setup changed before authorization completed.');
   row=await this.#update(row,{phase:phase==='discovery'?'choosing-project':'ready-to-prepare',tokens:{...row.tokens,[phase]:this.#vault.seal(credentials,id+':token:'+phase)},error:null,revocationPending:false});
   return this.#safe(row);
  }catch(error){
   const pending=credentials?await this.#revoke({[phase]:credentials}):error.revocationPending!==false;
   const current=await this.#stored(id);if(current.version===row.version)await this.#update(current,{phase:phase==='discovery'?'authorization-failed':'reviewed',approval:null,revocationPending:pending,error:safeError('authorization_failed','Provider authorization could not finish. Start authorization again.',true)});
   else if(pending&&!current.revocationPending)await this.#update(current,{revocationPending:true});
   if(error instanceof SetupError)throw error;fail('authorization_failed','Provider authorization could not finish. Start authorization again.',true);
  }
 }
 async #projects(row,phase){let result;try{result=await this.#provider.projects(this.#credentials(row,phase));}catch(error){if(error instanceof SetupError)throw error;fail('provider_unavailable','Projects could not be checked. Retry without changing setup.',true);}if(!Array.isArray(result)||result.length>1000)fail('provider_error','The provider returned an invalid project list.');return result.map(project=>{exact(project,['ref','organizationId','name']);if(!reference.test(project.ref))fail('provider_error','The provider returned an invalid project.');text(project.organizationId,100);text(project.name,200);return copy(project);}).filter(project=>!row.organizationId||project.organizationId===row.organizationId);}
 async projects(context,id){const row=await this.#flow(context,id);if(terminal.has(row.phase))fail('authorization_required','Start a new setup to inspect projects.');return this.#projects(row,'discovery');}
 async #inspection(row,phase,projectRef,ownerEmail){
  let inspection;try{inspection=await this.#provider.inspect(this.#credentials(row,phase),projectRef,{ownerEmail});}catch(error){if(error instanceof SetupError)throw error;fail('inspection_failed','Project compatibility could not be confirmed. Nothing was installed.',true);}
  exact(inspection,['compatibility','fingerprint','postgresMajor','migrations'],['schemaHash','authHash']);text(inspection.fingerprint,256);
  if(!['empty','touchline'].includes(inspection.compatibility)||!Number.isInteger(inspection.postgresMajor)||inspection.postgresMajor<15||!Array.isArray(inspection.migrations)||inspection.migrations.length>this.#migrations.length)fail('incompatible_project','This project is not a known compatible Touchline installation. Use the manual review route.');
  inspection.migrations.forEach((migration,index)=>{exact(migration,['id','sha256']);if(migration.id!==this.#migrations[index].id||migration.sha256!==this.#migrations[index].sha256)fail('incompatible_project','Existing migrations do not match this Touchline release.');});
  if(inspection.compatibility==='empty'&&inspection.migrations.length)fail('incompatible_project','The project inspection is inconsistent.');return copy(inspection);
 }
 async review(context,id,input){
  exact(input,['projectRef','ownerEmail','hubName','hubOrigin']);if(!reference.test(input.projectRef))fail('invalid_input','Choose a valid project.');text(input.ownerEmail,254);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail))fail('invalid_input','Enter a valid owner email.');text(input.hubName,100);httpsOrigin(input.hubOrigin);
  let row=await this.#flow(context,id);if(!['choosing-project','reviewed','preparation-failed','ready-to-prepare'].includes(row.phase))fail('operation_busy','Finish the current authorization before reviewing setup.');
  const project=(await this.#projects(row,'discovery')).find(value=>value.ref===input.projectRef);if(!project)fail('project_not_authorized','Choose a project from the authorized organization.');const inspection=await this.#inspection(row,'discovery',project.ref,input.ownerEmail.toLowerCase().trim());
  const config={...copy(input),ownerEmail:input.ownerEmail.toLowerCase().trim(),hubName:input.hubName.trim()};
  const steps=[...this.#migrations.slice(inspection.migrations.length).map(m=>({id:m.id,status:'pending'})),{id:'configure-owner',status:'pending'},{id:'configure-auth',status:'pending'},{id:'verify',status:'pending'}];
  const review={config,project,inspection,manifest:this.#manifest,steps,expiresAt:row.expiresAt};review.reviewHash=digest(canonical(review));
  row=await this.#update(row,{phase:'reviewed',review,steps,approval:null,error:null,preflight:false,leaseUntil:null});return copy(row.review);
 }
 async authorizeInstall(context,id,reviewHash){
  let row=await this.#flow(context,id);if(row.revocationPending)fail('manual_revoke_required','Revoke the earlier Supabase app permission in your organization settings, then start a new setup.');if(row.phase!=='reviewed')fail('approval_required','Review this project before approving installation.');if(!equal(row.review.reviewHash,reviewHash)||row.review.manifest!==this.#manifest)fail('stale_review','This review changed. Inspect the project again.');
  const {authorizeUrl,oauth}=this.#authorize({...row,organizationId:row.review.project.organizationId},'install');
  row=await this.#update(row,{phase:'awaiting-install',oauth,approval:{reviewHash,approvedAt:this.#now()},error:null});return {...this.#safe(row),authorizeUrl};
 }
 async prepare(context,id,reviewHash){
  let row=await this.#flow(context,id);if(row.phase==='preparing')fail('operation_busy','Preparation is already running. Refresh its status.');
  if(row.phase!=='ready-to-prepare'||!row.approval)fail('approval_required','Inspect and approve this setup before preparation.');
  if(!equal(reviewHash,row.review.reviewHash)||!equal(reviewHash,row.approval.reviewHash)||row.review.manifest!==this.#manifest)fail('stale_review','This review changed. Inspect the project again.');
  const project=row.review.project;
  if(!row.preflight){
   const authorized=(await this.#projects(row,'install')).find(value=>value.ref===project.ref&&value.organizationId===project.organizationId);if(!authorized)fail('project_not_authorized','Installation permission does not cover the reviewed project.');
   const inspection=await this.#inspection(row,'install',project.ref,row.review.config.ownerEmail);if(canonical(inspection)!==canonical(row.review.inspection))fail('stale_review','The project changed after review. Inspect it again before preparation.');
   const current=await this.#flow(context,id);if(current.version!==row.version)fail('operation_cancelled','Setup changed during preparation checks.');
   row=await this.#update(row,{preflight:true,error:null,...(inspection.schemaHash?{checkpointSchemaHash:inspection.schemaHash}:{})});return this.#safe(row);
  }
  row=await this.#update(row,{phase:'preparing',leaseUntil:this.#now()+STEP_LEASE,error:null});
  try{
   const index=row.steps.findIndex(step=>step.status!=='complete');if(index<0)fail('invalid_step','No setup step remains.');
   const token=this.#credentials(row,'install'),step=row.steps[index],config=row.review.config;let schemaHash;
   if(migrationNames.includes(step.id)){const migration=this.#migrations.find(item=>item.id===step.id);const applied=await this.#provider.applyMigration(token,project.ref,copy(migration),{schemaHash:row.checkpointSchemaHash});schemaHash=applied?.schemaHash;}
   else if(step.id==='configure-owner')await this.#provider.configureOwner(token,project.ref,{ownerEmail:config.ownerEmail},{schemaHash:row.checkpointSchemaHash});
   else if(step.id==='configure-auth')await this.#provider.configureAuth(token,project.ref,{hubOrigin:config.hubOrigin},{authHash:row.review.inspection.authHash});
   else if(step.id==='verify'){
    const result=await this.#provider.verify(token,project.ref,copy(config));
    if(result?.ready!==true)fail('verification_failed','Preparation could not be verified. Review the failed step.');
    const current=await this.#flow(context,id);if(current.version!==row.version||current.phase!=='preparing')fail('operation_cancelled','Preparation stopped before publishing the hub.');
    const committed=await commitPublicHub(this.#store,row,{format:'touchline-hub',version:1,hubId:randomUUID(),name:config.hubName,hubOrigin:config.hubOrigin,backend:result.backend,contracts:{snapshot:1,progress:1},auth:{email:'otp',providers:result.providers}},this.#now());
    row=committed.flow;if(await this.#verifyPublished(copy(committed.description))!==true)fail('verification_failed','The published hub could not be reached and verified. Retry its deployment check.');
   }
   else fail('invalid_step','This release does not recognize the setup step.');
   const current=await this.#flow(context,id);if(current.version!==row.version||current.phase!=='preparing')fail('operation_cancelled','Preparation stopped because this setup changed.');
   const steps=copy(row.steps);steps[index]={...steps[index],status:'complete'};
   if(index<steps.length-1){row=await this.#update(row,{steps,phase:'ready-to-prepare',leaseUntil:null,...(schemaHash?{checkpointSchemaHash:schemaHash}:{})});return this.#safe(row);}
   const credentials=this.#allCredentials(row);row=await this.#update(row,{steps,phase:'complete',leaseUntil:null,tokens:{},oauth:null,approval:null,revocationPending:true});const revocationPending=await this.#revoke(credentials);row=await this.#update(row,{revocationPending});return this.#safe(row);
  }catch(error){const current=await this.#stored(id);if(current.phase==='preparing'&&current.version===row.version)await this.#update(current,{phase:'preparation-failed',leaseUntil:null,approval:null,error:safeError('preparation_failed','Preparation stopped. Inspect the project again before retrying; completed steps may remain installed.',true)});if(error instanceof SetupError)throw error;fail('preparation_failed','Preparation stopped. Inspect the project again before retrying; completed steps may remain installed.',true);}
 }

 #allCredentials(row){const result={};for(const [phase,sealed] of Object.entries(row.tokens)){try{result[phase]=this.#vault.open(sealed,row.id+':token:'+phase);}catch{result.unreadable=true;}}return result;}
 async #revoke(credentials){let pending=!!credentials.unreadable;for(const [phase,value] of Object.entries(credentials)){if(phase==='unreadable')continue;try{await this.#provider.revoke(phase,value);}catch{pending=true;}}return pending;}
 async #close(row,phase){const credentials=this.#allCredentials(row),unresolved=!!row.revocationPending||row.phase.startsWith('exchanging-');row=await this.#update(row,{phase,tokens:{},oauth:null,approval:null,revocationPending:unresolved||Object.keys(credentials).length>0});const revocationPending=await this.#revoke(credentials)||unresolved;if(row.revocationPending!==revocationPending)row=await this.#update(row,{revocationPending});return this.#safe(row);}
 async cancel(context,id){const row=await this.#flow(context,id);if(terminal.has(row.phase))return this.#safe(row);return this.#close(row,'cancelled');}
 async status(context,id){return this.#safe(await this.#flow(context,id,true));}
 // Scheduler-only entry point. Never expose this method as an unauthenticated route.
 async expire(id){const row=await this.#stored(id);if(row.expiresAt>this.#now()||terminal.has(row.phase))return this.#safe(row);return this.#close(row,'expired');}
}
