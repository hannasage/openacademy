import {validateHub,DISCOVERY_PATH,uuid} from '../web/connection/discovery.js';
/**
 * Public deployment routes. The owner supplies an already public hub description
 * and the deployed application HTML. No administrative configuration is accepted.
 * @param {unknown} description
 * @param {string} applicationHTML
 */
export function createPublicHandler(description,applicationHTML){
  const hub=validateHub(description);
  const document=JSON.stringify(hub);
  return async function handle(/** @type {Request} */ request){
    const url=new URL(request.url);
    const headers={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
    if(url.origin!==hub.hubOrigin)return new Response('Wrong hub address.',{status:400,headers});
    if(request.method!=='GET')return new Response('Method not allowed.',{status:405,headers:{...headers,Allow:'GET'}});
    if(url.pathname===DISCOVERY_PATH && !url.search)return new Response(document,{headers:{...headers,'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}});
    if(url.pathname==='/auth/return'){
      const allowed=new Set(['touchline-return','code','error','error_code','error_description']);
      if(!uuid.test(url.searchParams.get('touchline-return')??'') || Array.from(url.searchParams.keys()).some(key=>!allowed.has(key)||url.searchParams.getAll(key).length!==1) || url.search.length>8192)return new Response('Invalid account return.',{status:400,headers});
      // The browser consumes the pending transaction before exchanging the code.
      // No untrusted query text is interpolated into HTML and no redirect is made.
      return new Response(applicationHTML,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
    }
    return new Response('Not found.',{status:404,headers});
  };
}
