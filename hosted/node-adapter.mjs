import {securityHeaders} from './setup-handler.mjs';
/** Vercel's Node request is converted using only the configured origin. */
export function createNodeAdapter({origin,handle}){
 const fixed=new URL(origin);if(fixed.protocol!=='https:'||fixed.origin!==origin)throw Error('Configure an exact HTTPS origin.');
 return async(req,res)=>{
  try{
   if(req.headers.host!==fixed.host||typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||req.url.length>9000){res.writeHead(400,securityHeaders);res.end('Invalid hub request.');return;}
   const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(Array.isArray(value)){for(const item of value)headers.append(name,item);}else if(value!==undefined)headers.set(name,value);}
   const chunks=[];let length=0;
   if(!['GET','HEAD'].includes(req.method))for await(const chunk of req){length+=Buffer.byteLength(chunk);if(length>8192){res.writeHead(413,securityHeaders);res.end('Setup request is too large.');return;}chunks.push(Buffer.from(chunk));}
   const request=new Request(origin+req.url,{method:req.method,headers,...(chunks.length?{body:Buffer.concat(chunks)}:{})});
   const response=await handle(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(503,securityHeaders);res.end('The connector could not complete this request. Check its configuration and try again.');}
 };
}
