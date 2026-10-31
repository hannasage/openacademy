import {createSetupRuntime,setupConfiguration} from '../backend/setup/runtime.mjs';
import {readPublicHub} from '../backend/setup/public-hub.mjs';
import {createSetupHandler,securityHeaders} from './setup-handler.mjs';
import {createNodeAdapter} from './node-adapter.mjs';
import {createPublishedVerifier} from './verify-published.mjs';
import setupHTML from './setup.html';
import accountReturnHTML from './account-return.html';
import guideHTML from './setup-guide.html';
import accountReturnScript from './account-return.js?text';
const assets=new Map([
 ['/setup',{body:setupHTML,type:'text/html; charset=utf-8'}],
 ['/setup-guide',{body:guideHTML,type:'text/html; charset=utf-8'}],
 ['/auth/return',{body:accountReturnHTML,type:'text/html; charset=utf-8'}],
 ['/account-return.js',{body:accountReturnScript,type:'application/javascript; charset=utf-8'}],
]);
let adapter;
async function initialize(){
 const configuration=setupConfiguration(process.env);
 if(!configuration.configured)throw Error('Configure this owner-hosted connector before use.');
 const verifyPublished=createPublishedVerifier(configuration.origin);
 const runtime=await createSetupRuntime(process.env,{verifyPublished});
 const handle=createSetupHandler({origin:configuration.origin,ownerEmail:configuration.ownerEmail,runtime,assets,readPublicHub,verifyPublished});
 return createNodeAdapter({origin:configuration.origin,handle});
}
export default async function handler(req,res){
 try{adapter??=initialize();await(await adapter)(req,res);}
 catch{adapter=undefined;res.writeHead(503,{...securityHeaders,'Content-Type':'text/plain; charset=utf-8'});res.end('This private connector is not configured. Follow hosted/README.md in your Schola repository.');}
}
