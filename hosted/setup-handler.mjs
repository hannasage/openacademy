import {createPublicHandler} from './public-handler.js';
import {createHash} from 'node:crypto';
import {validateHub} from '../web/connection/discovery.js';
const hubReview=value=>createHash('sha256').update(JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item)).digest('hex');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const securityHeaders={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
const json=(value,status=200,extra={})=>new Response(JSON.stringify(value),{status,headers:{...securityHeaders,'Content-Type':'application/json',...extra}});
const failure=(code,status=400)=>json({error:{code}},status);
const reject=code=>{const error=new Error('Setup request rejected.');error.code=code;throw error;};
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))reject('invalid_input');}
function cookie(request){const values=(request.headers.get('cookie')??'').split(';').map(value=>value.trim()).filter(value=>value.startsWith('touchline_setup='));return values.length===1?values[0].slice(16):'';}
const sessionCookie=(token,maxAge)=>`touchline_setup=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function body(request){if(request.headers.get('content-type')?.split(';')[0].trim()!=='application/json')reject('invalid_input');if(Number(request.headers.get('content-length'))>8192)reject('invalid_input');const reader=request.body?.getReader();if(!reader)reject('invalid_input');let length=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>8192){await reader.cancel();reject('invalid_input');}chunks.push(value);}}finally{reader.releaseLock();}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reject('invalid_input');}}
/** Only server-created runtimes may be supplied. Request fields never become owner identity. */
export function createSetupHandler({origin,ownerEmail,runtime,assets,readPublicHub,verifyPublished=async()=>false,now=Date.now}){
  const base=new URL(origin);if(base.protocol!=='https:'||base.origin!==origin||base.username||base.password)throw Error('Configure the exact HTTPS connector origin.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail))throw Error('Configure the owner email.');
  const configuration={ready:true,missing:[],ownerEmail,hubOrigin:origin};
  const locked={authenticated:false};
  async function envelope(session,id,extras={}){return {authenticated:true,csrfToken:session.csrfToken,configuration,setup:id?await runtime.service.status(session.context,id):null,projects:[],...extras};}
  return async request=>{
    const url=new URL(request.url);
    if(url.origin!==origin)return failure('wrong_origin',400);
    if(request.method==='GET'&&assets.has(url.pathname)&&!url.search){const asset=assets.get(url.pathname);return new Response(asset.body,{headers:{...securityHeaders,'Content-Type':asset.type}});}
    if(request.method==='GET'&&url.pathname==='/auth/return'&&url.search.length<=8192){const asset=assets.get('/auth/return');return new Response(asset.body,{headers:{...securityHeaders,'Content-Type':asset.type}});}
    if(url.pathname==='/.well-known/touchline.json'&&!url.search){try{const hub=await readPublicHub(runtime.store);if(!hub)return failure('not_ready',404);return createPublicHandler(hub,'')(request);}catch{return failure('storage_unavailable',503);}}
    const callback=/^\/setup\/callback\/(discovery|install)$/.exec(url.pathname);
    if(callback&&request.method==='GET'){
      let id;
      try{
        if(url.search.length>8192||Array.from(url.searchParams.keys()).some(key=>!['state','code','error','error_description'].includes(key)||url.searchParams.getAll(key).length!==1))reject('invalid_state');
        const session=await runtime.admin.session(cookie(request));
        const state=url.searchParams.get('state')??'';const candidate=state.split('.')[0];if(uuid.test(candidate))id=candidate;
        const input={state,...(url.searchParams.has('code')?{code:url.searchParams.get('code')}:{}),...(url.searchParams.has('error')?{error:url.searchParams.get('error')}:{})};
        const result=await runtime.service.callback(session.context,callback[1],input);id=result.id;
        return new Response(null,{status:303,headers:{...securityHeaders,Location:'/setup?setup='+encodeURIComponent(id)}});
      }catch{return new Response(null,{status:303,headers:{...securityHeaders,Location:'/setup?'+(id?'setup='+encodeURIComponent(id)+'&':'')+'notice=return-failed'}});}
    }
    if(url.pathname==='/setup'&&request.method==='GET'&&url.search.length<512){const asset=assets.get('/setup');return new Response(asset.body,{headers:{...securityHeaders,'Content-Type':asset.type}});}
    if(url.pathname==='/setup/deployment-return'&&request.method==='GET'&&url.search.length<=8192){const asset=assets.get('/setup');return new Response(asset.body,{headers:{...securityHeaders,'Content-Type':asset.type}});}
    if(!url.pathname.startsWith('/api/setup'))return failure('not_found',404);
    try{
      if(request.method==='GET'&&url.pathname==='/api/setup'){
        if(Array.from(url.searchParams.keys()).some(key=>key!=='setup'||url.searchParams.getAll(key).length!==1))reject('invalid_input');
        let session;try{session=await runtime.admin.session(cookie(request));}catch(error){if(error.code==='unauthorized')return json(locked);throw error;}
        const id=url.searchParams.get('setup');if(id&&!uuid.test(id))reject('invalid_input');return json(await envelope(session,id));
      }
      if(request.method!=='POST')return failure('method_not_allowed',405);
      if(url.search||request.headers.get('origin')!==origin||['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')))return failure('invalid_origin',403);
      const input=await body(request),token=cookie(request),csrf=request.headers.get('x-touchline-csrf')??'';
      if(url.pathname==='/api/setup/unlock'){
        exact(input,['code']);const unlocked=await runtime.admin.unlock(input.code),session=await runtime.admin.session(unlocked.sessionToken);
        return json(await envelope(session),200,{'Set-Cookie':sessionCookie(unlocked.sessionToken,Math.max(0,Math.floor((unlocked.expiresAt-now())/1000)))});
      }
      const context=await runtime.admin.authenticate(token,csrf,{requireCsrf:true});
      if(url.pathname==='/api/setup/logout'){exact(input,[]);await runtime.admin.logout(token,csrf);return json(locked,200,{'Set-Cookie':sessionCookie('',0)});}
      const session=await runtime.admin.session(token);
      if(url.pathname==='/api/setup/deployment-review'||url.pathname==='/api/setup/deployment-confirm'){
        const confirm=url.pathname.endsWith('deployment-confirm');exact(input,confirm?['reviewHash']:['deploymentOrigin']);
        if(!confirm&&input.deploymentOrigin!==origin)reject('wrong_deployment');
        const stored=await readPublicHub(runtime.store);if(!stored)reject('not_ready');
        const hub=validateHub(stored,origin),reviewHash=hubReview(hub);
        if(confirm&&input.reviewHash!==reviewHash)reject('stale_review');
        if(confirm&&!await verifyPublished(hub))reject('verification_failed');
        return json(await envelope(session,null,{deployment:{hub,reviewHash,verified:confirm}}));
      }
      if(url.pathname==='/api/setup/begin'){exact(input,[]);const setup=await runtime.service.begin(context);return json(await envelope(session,setup.id,{authorizeUrl:setup.authorizeUrl}));}
      const action=url.pathname.slice('/api/setup/'.length);
      if(!['projects','review','install','prepare','cancel'].includes(action))return failure('not_found',404);
      exact(input,action==='review'?['id','projectRef','hubName']:['install','prepare'].includes(action)?['id','reviewHash']:['id']);
      if(!uuid.test(input.id))reject('invalid_input');
      let projects=[],authorizeUrl;
      if(action==='projects')projects=await runtime.service.projects(context,input.id);
      if(action==='review')await runtime.service.review(context,input.id,{projectRef:input.projectRef,hubName:input.hubName,ownerEmail,hubOrigin:origin});
      if(action==='install')({authorizeUrl}=await runtime.service.authorizeInstall(context,input.id,input.reviewHash));
      if(action==='prepare')await runtime.service.prepare(context,input.id,input.reviewHash);
      if(action==='cancel')await runtime.service.cancel(context,input.id);
      return json(await envelope(session,input.id,{projects,...(authorizeUrl?{authorizeUrl}:{})}));
    }catch(error){const allowed=new Set(['unauthorized','invalid_csrf','invalid_input','invalid_bootstrap','bootstrap_consumed','bootstrap_expired','bootstrap_locked','bootstrap_retired','rate_limited','storage_unavailable','expired','stale_review','incompatible_project','incompatible_owner','invalid_scopes','project_not_authorized','approval_required','preparation_failed','operation_busy','authorization_failed','authorization_required','authorization_expired','verification_failed','inspection_failed','provider_unavailable','not_found','operation_cancelled','public_hub_conflict','wrong_deployment','not_ready','manual_revoke_required']);const code=allowed.has(error?.code)?error.code:'setup_failed';return failure(code,code==='unauthorized'?401:code==='invalid_csrf'?403:['storage_unavailable','setup_failed'].includes(code)?503:400);}
  };
}
