/** @typedef {{ready:boolean,missing:string[],ownerEmail:string,hubOrigin:string}} Configuration */
/** @typedef {{authenticated:boolean,configuration:Configuration|null,setup:Record<string,any>|null,projects:Record<string,any>[],deployment:{hub:import('../connection/types').Hub,reviewHash:string,verified:boolean}|null,busy:boolean,error:boolean,message:string}} Snapshot */
const actions = new Set(['begin','projects','review','install','prepare','cancel','logout','deployment-review','deployment-confirm']);
const messages = {
  unauthorized:'Enter a new setup code from your connector owner to continue.',
  invalid_bootstrap:'This setup code is invalid, expired, or already used.',
  bootstrap_consumed:'This setup code was already used. Generate a new code and update your connector settings.',
  bootstrap_expired:'This setup code expired. Generate a new code and update your connector settings.',
  bootstrap_locked:'Too many unlock attempts. Wait 15 minutes before trying this setup code again.',
  rate_limited:'Wait before trying your setup code again.',
  invalid_csrf:'Refresh this page before continuing setup.',
  storage_unavailable:'The connector database is unavailable or needs its setup schema. Check the owner setup guide.',
  verification_failed:'The prepared hub could not be verified. Review the project again before retrying.',
  expired:'This setup session expired. Start setup again.',
  stale_review:'The project changed. Review it again before granting installation permission.',
  incompatible_project:'This project is not compatible. Choose another project or use the manual setup guide.',
  incompatible_owner:'This project has a different or unavailable owner. Use the manual setup guide; setup will not replace that identity.',
  invalid_scopes:'The Supabase setup app permissions do not match this step. Correct the app registration scopes before starting again.',
  project_not_authorized:'This project is outside the permission you granted. Choose another project.',
  approval_required:'Review the current changes and grant installation permission before preparing this hub.',
  preparation_failed:'Preparation did not finish. Check the recorded steps and review the project again before retrying.',
  operation_busy:'Another setup operation is running. Refresh its status before continuing.',
  manual_revoke_required:'Remove the earlier Touchline setup integrations in Supabase, then start a fresh setup.',
  wrong_deployment:'The returned deployment does not match your configured connector address. Open your configured address manually.',
  not_ready:'This deployment does not have a published hub yet. Finish private hub setup before checking it again.',
};
/** Browser client for the owner-only connector; it never imports learning or account services. */
export class SetupClient {
  /** @param {{fetch?:typeof fetch,navigate?:(url:string)=>void,requestTimeout?:number}} [dependencies] */
  constructor(dependencies={}) {this.fetch=dependencies.fetch??globalThis.fetch.bind(globalThis);this.navigate=dependencies.navigate??(url=>window.location.assign(url));this.requestTimeout=dependencies.requestTimeout??65000;}
  /** @type {Snapshot} */
  state={authenticated:false,configuration:null,setup:null,projects:[],deployment:null,busy:false,error:false,message:'Checking your setup session…'};
  csrf='';
  /** @type {Set<()=>void>} */
  listeners=new Set();
  getSnapshot=()=>this.state;
  /** @param {()=>void} listener */
  subscribe=listener=>{this.listeners.add(listener);return()=>this.listeners.delete(listener);};
  /** @param {Partial<Snapshot>} value */
  update(value){this.state={...this.state,...value};for(const listener of this.listeners)listener();}
  /** @param {string} [id] */
  load(id){return this.request('/api/setup'+(id?'?setup='+encodeURIComponent(id):''));}
  /** The code exists only in this request; callers clear their input after each attempt. @param {string} code */
  unlock(code){return this.request('/api/setup/unlock',{code});}
  /** @param {string} action @param {Record<string,unknown>} [payload] */
  act(action,payload={}){
    if(!actions.has(action)||!this.state.authenticated||!this.csrf){this.update({error:true,message:'Unlock owner setup before continuing.'});return Promise.resolve(false);}
    return this.request('/api/setup/'+action,payload);
  }
  /** Complete one recorded step at a time. A failed request stops without replay. @param {string} id @param {string} reviewHash */
  async prepare(id,reviewHash){
    for(let index=0;index<32;index++){
      const before=this.state.setup?.revision;
      if(!await this.act('prepare',{id,reviewHash}))return false;
      if(this.state.setup?.id!==id||this.state.setup?.phase!=='ready-to-prepare')return true;
      const after=this.state.setup.revision;
      if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||after<=before){this.update({error:true,message:'Preparation made no recorded progress. Refresh its status before continuing.'});return false;}
    }
    this.update({error:true,message:'Preparation reached its step limit. Refresh its status before continuing.'});return false;
  }
  /** @param {string} path @param {Record<string,unknown>} [body] */
  async request(path,body){
    if(this.state.busy)return false;
    this.update({busy:true,error:false,message:'Checking setup…'});
    const abort=new AbortController();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timeout;
    /** @type {Promise<never>} */
    const deadline=new Promise((_,reject)=>{timeout=setTimeout(()=>{abort.abort();reject(Error('request_timeout'));},this.requestTimeout);});
    try{
      const {response,raw}=await Promise.race([this.fetch(path,{method:body?'POST':'GET',signal:abort.signal,credentials:'same-origin',redirect:'error',cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json','X-Touchline-CSRF':this.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})}).then(async response=>{
        if(response.status===401){this.csrf='';this.update({authenticated:false,configuration:null,setup:null,projects:[],deployment:null});}
        return {response,raw:await response.text()};
      }),deadline]);
      if(raw.length>131072||!response.headers.get('Content-Type')?.startsWith('application/json'))throw Error('invalid_response');
      const result=JSON.parse(raw);
      if(!response.ok){
        const code=typeof result?.error?.code==='string'?result.error.code:'';
        this.update({error:true,message:Object.hasOwn(messages,code)?messages[/** @type {keyof typeof messages} */(code)]:'Setup could not complete this step. Refresh its status before trying again.'});
        return false;
      }
      if(typeof result?.authenticated!=='boolean')throw Error('invalid_response');
      if(result.authorizeUrl){const url=new URL(result.authorizeUrl);if(url.origin!=='https://api.supabase.com'||url.pathname!=='/v1/oauth/authorize'||url.username||url.password||url.hash)throw Error('invalid_redirect');}
      if(result.authenticated){
        if(typeof result.csrfToken!=='string'||!result.csrfToken||!result.configuration||typeof result.configuration.ready!=='boolean'||!Array.isArray(result.configuration.missing)||!Array.isArray(result.projects))throw Error('invalid_response');
        this.csrf=result.csrfToken;
        const projects=result.projects.length||path.endsWith('/projects')||result.setup?.id!==this.state.setup?.id?result.projects:this.state.projects;
        this.update({authenticated:true,configuration:result.configuration,setup:result.setup??null,projects,deployment:result.deployment??null,message:'Owner setup is unlocked.'});
      }else{this.csrf='';this.update({authenticated:false,configuration:null,setup:null,projects:[],deployment:null,message:'Enter your one-time setup code.'});}
      if(result.authorizeUrl)this.navigate(result.authorizeUrl);
      return true;
    }catch{this.update({error:true,message:'Setup could not be reached safely. Refresh its status before trying again.'});return false;}
    finally{clearTimeout(timeout);this.update({busy:false});}
  }
}
