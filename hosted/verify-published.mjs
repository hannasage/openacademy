import {discoverHub,validateHub,hubOrigin} from '../web/connection/discovery.js';
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** Only the configured deployment and the reviewed Supabase project can be fetched. */
export function createPublishedVerifier(origin,{request=fetch}={}){
  if(hubOrigin(origin)!==origin)throw Error('Configure the exact hub origin.');
  return async description=>{
    const expected=validateHub(description,origin);
    if(!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(expected.backend.url))return false;
    const actual=await discoverHub(origin,request);
    if(canonical(actual)!==canonical(expected))return false;
    const destination=expected.backend.url+'/auth/v1/health';
    const response=await request(destination,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{Accept:'application/json',apikey:expected.backend.publishableKey},signal:AbortSignal.timeout(15000)});
    if(!response.ok||response.redirected||(response.url&&response.url!==destination))return false;
    // Health status is sufficient; no unbounded or private response body is consumed.
    await response.body?.cancel();return true;
  };
}
