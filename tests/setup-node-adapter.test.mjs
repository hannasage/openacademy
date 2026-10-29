import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {createNodeAdapter} from '../hosted/node-adapter.mjs';
const origin='https://learn.example.org';
async function invoke(adapter,{path='/setup',host='learn.example.org',method='GET',body='',headers={}}={}){
 const request=Object.assign(Readable.from(body?[body]:[]),{url:path,method,headers:{host,...headers}});
 let status,responseHeaders,output;
 await adapter(request,{writeHead(value,items){status=value;responseHeaders=items;},end(value){output=String(value);}});
 return {status,headers:responseHeaders,body:output};
}
test('Node boundary uses configured origin and ignores forwarded host claims',async()=>{
 const requests=[],adapter=createNodeAdapter({origin,handle:async request=>{requests.push(request.url);return new Response('ok');}});
 assert.equal((await invoke(adapter,{headers:{'x-forwarded-host':'attacker.example.org'}})).status,200);
 assert.equal(requests[0],origin+'/setup');
 assert.equal((await invoke(adapter,{host:'attacker.example.org',headers:{'x-forwarded-host':'learn.example.org'}})).status,400);
 assert.equal((await invoke(adapter,{path:'//attacker.example.org/setup'})).status,400);
 assert.equal(requests.length,1);
});
test('Node boundary limits streamed bodies and never returns thrown secrets',async()=>{
 let calls=0;const adapter=createNodeAdapter({origin,handle:async()=>{calls++;throw Error('private database password');}});
 assert.equal((await invoke(adapter,{method:'POST',body:'x'.repeat(8193)})).status,413);assert.equal(calls,0);
 const response=await invoke(adapter);assert.equal(response.status,503);assert.ok(!response.body.includes('password'));assert.equal(response.headers['Cache-Control'],'no-store');
});
