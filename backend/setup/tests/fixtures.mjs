import {randomBytes} from 'node:crypto';
import {SetupService} from '../core.mjs';
import {digest,fail} from '../security.mjs';
import {mergePublicHub} from '../public-hub.mjs';
export class MemoryStore {
 // Test double only: deliberately not exported from production modules.
 rows=new Map();fail=false;
 async create(row){if(this.fail)throw Error('disk failure');if(this.rows.has(row.id))return false;this.rows.set(row.id,structuredClone(row));return true;}
 async commitPublicHub(id,version,input,now){if(this.fail)throw Error('disk failure');const flow=this.rows.get(id);if(!flow||flow.version!==version||flow.phase!=='preparing'||flow.expiresAt<=now)fail('operation_cancelled','Setup changed.');const prior=this.rows.get('public-hub'),description=mergePublicHub(prior?.description,input),next={...structuredClone(flow),version:version+1,publicHub:description};this.rows.set('public-hub',{id:'public-hub',version:prior?prior.version+1:0,description});this.rows.set(id,next);return {flow:structuredClone(next),description:structuredClone(description)};}
 async read(id){return structuredClone(this.rows.get(id)||null);}
 async compareAndSwap(id,version,next){if(this.fail)throw Error('disk failure');if(this.rows.get(id)?.version!==version)return false;this.rows.set(id,structuredClone(next));return true;}
}
export function fixture(){
 let now=1000000,apply=async()=>{};const calls=[],store=new MemoryStore();let observed;const started=new Promise(r=>{observed=r;});
 const context={ownerId:'owner',sessionId:'session',csrfToken:'csrf',expiresAt:now+3600000,verified:true};
 const project={ref:'abcdefghijklmnopqrst',organizationId:'org-one',name:'Dedicated project'};
 const inspection={compatibility:'empty',fingerprint:'initial',postgresMajor:15,migrations:[]};
 const provider={
  async exchange(phase){calls.push(['exchange',phase]);return {accessToken:'access-secret-'+phase,refreshToken:'refresh-secret-'+phase,expiresAt:now+3600000};},
  async revoke(phase){calls.push(['revoke',phase]);},
  async projects(){return [structuredClone(project)];},
  async inspect(){return structuredClone(inspection);},
  async applyMigration(_token,ref,migration){calls.push(['apply',ref,migration.id]);observed();await apply();},
  async configureOwner(){calls.push(['owner']);},
  async configureAuth(){calls.push(['auth']);},
  async verify(){return {ready:true,backend:{type:'supabase',url:'https://abcdefghijklmnopqrst.supabase.co',publishableKey:'sb_publishable_test'},providers:[]};}
 };
 const options={store,provider,key:randomBytes(32),now:()=>now,authenticate:async value=>value,
  verifyPublished:async()=>true,
  apps:{discovery:{clientId:'discovery-app',redirectUri:'https://connector.example.com/setup/callback/discovery'},install:{clientId:'install-app',redirectUri:'https://connector.example.com/setup/callback/install'}},
  migrations:[{id:'001_private_writes.sql',sha256:digest('begin; select 1; commit;'),sql:'begin; select 1; commit;'}]};
 return {service:new SetupService(options),options,context,store,calls,project,inspection,advance:ms=>{now+=ms;},setApply:fn=>{apply=fn;},waitForApply:()=>started};
}
