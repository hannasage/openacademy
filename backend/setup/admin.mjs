import {createHmac} from 'node:crypto';
import {fail,createVault,digest,secret,equal} from './security.mjs';
const SESSION_TTL=30*60*1000,MAX_ATTEMPTS=5;
const credential=/^[a-zA-Z0-9_-]{43}$/;
export class SetupAdmin {
 #store;#bootstrap;#expiry;#now;#key;
 constructor({store,bootstrapKey,bootstrapExpiresAt,key,now=Date.now}){
  if(!store||!['read','create','compareAndSwap'].every(method=>typeof store[method]==='function'))throw Error('A durable admin store is required.');
  if(!credential.test(bootstrapKey)||!Number.isFinite(bootstrapExpiresAt))throw Error('Configure a generated bootstrap key and its fixed expiry.');
  createVault(key);this.#key=Buffer.from(key);this.#store=store;this.#bootstrap=digest(bootstrapKey);this.#expiry=bootstrapExpiresAt;this.#now=now;
 }
 async #read(){try{return await this.#store.read('setup-admin');}catch{fail('storage_unavailable','Setup administration storage is unavailable.',true);}}
 async #write(before,next){try{return before?await this.#store.compareAndSwap('setup-admin',before.version,{...next,version:before.version+1}):await this.#store.create(next);}catch{fail('storage_unavailable','Setup administration storage is unavailable.',true);}}
 async #current(){for(let tries=0;tries<8;tries++){
  const row=await this.#read();if(row?.generation===this.#bootstrap)return row;
  if(row?.retired.includes(this.#bootstrap))fail('bootstrap_retired','This bootstrap key was retired. Use the current deployment configuration.');
  if(row&&row.retired.length>=64)fail('rotation_limit','The bootstrap rotation history needs an operator review.');
  const next={id:'setup-admin',version:0,generation:this.#bootstrap,retired:row?[...row.retired,row.generation]:[],expiresAt:this.#expiry,consumedAt:null,failures:0,blockedUntil:0,session:null};
  if(await this.#write(row,next))return {...next,version:row?row.version+1:0};
 }fail('storage_unavailable','Another setup request is updating administration. Retry.',true);}
 async initialize(){await this.#current();}
 #csrf(token){return createHmac('sha256',this.#key).update('touchline-setup-csrf:'+token).digest('base64url');}
 async unlock(code){for(let tries=0;tries<8;tries++){
  const row=await this.#current();if(row.consumedAt!==null)fail('bootstrap_consumed','This bootstrap key was already used. Rotate it in deployment settings to unlock again.');
  if(row.expiresAt<=this.#now())fail('bootstrap_expired','This bootstrap key expired. Generate and configure a new key.');
  if(row.blockedUntil>this.#now())fail('rate_limited','Wait before trying the bootstrap key again.',true);
  if(row.failures>=MAX_ATTEMPTS){if(await this.#write(row,{...row,failures:0,blockedUntil:0}))continue;continue;}
  if(typeof code!=='string'||!credential.test(code)||!equal(digest(code),this.#bootstrap)){
   if(await this.#write(row,{...row,failures:row.failures+1,blockedUntil:this.#now()+(row.failures+1>=MAX_ATTEMPTS?15*60*1000:Math.min(60000,1000*2**row.failures))}))fail('invalid_bootstrap','The bootstrap key is not valid.');continue;
  }
  const sessionToken=secret(),expiresAt=this.#now()+SESSION_TTL;
  if(await this.#write(row,{...row,consumedAt:this.#now(),session:{hash:digest(sessionToken),expiresAt}}))return {sessionToken,csrfToken:this.#csrf(sessionToken),expiresAt};
 }fail('storage_unavailable','Another unlock request is running. Retry.',true);}
 async session(sessionToken){if(typeof sessionToken!=='string'||!credential.test(sessionToken))fail('unauthorized','Unlock this connector to continue.');const row=await this.#current();if(!row.session||row.session.expiresAt<=this.#now()||!equal(row.session.hash,digest(sessionToken)))fail('unauthorized','The setup session ended. Rotate the bootstrap key to unlock again.');const csrfToken=this.#csrf(sessionToken);return {csrfToken,expiresAt:row.session.expiresAt,context:{verified:true,ownerId:'connector-owner',sessionId:row.session.hash,csrfToken,expiresAt:row.session.expiresAt}};}
 async authenticate(sessionToken,csrfToken,{requireCsrf=true}={}){const value=await this.session(sessionToken);if(requireCsrf&&!equal(value.csrfToken,csrfToken))fail('invalid_csrf','Refresh this setup page before continuing.');return value.context;}
 async logout(sessionToken,csrfToken){await this.authenticate(sessionToken,csrfToken);for(let tries=0;tries<8;tries++){const row=await this.#current();if(!row.session||!equal(row.session.hash,digest(sessionToken)))return;if(await this.#write(row,{...row,session:null}))return;}fail('storage_unavailable','Sign-out could not be saved. Retry.',true);}
}
export {SESSION_TTL};
