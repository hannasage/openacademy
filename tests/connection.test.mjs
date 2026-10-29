import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
const module = await build({entryPoints:['web/connection/discovery.js'],bundle:true,write:false,format:'esm',platform:'node'});
const {validateHub,discoverHub} = await import('data:text/javascript;base64,'+Buffer.from(module.outputFiles[0].text).toString('base64'));
const hub=JSON.parse(await readFile('tests/fixtures/contracts/valid/hub-description.json','utf8'));
const response = (value=hub, init={}) => new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'},...init});
test('hub discovery validates public descriptions and omits credentials',async()=>{
 let request;
 const result=await discoverHub(hub.hubOrigin,async(url,options)=>{request={url,options};return response();});
 assert.deepEqual(result,hub);assert.equal(request.options.credentials,'omit');assert.equal(request.options.redirect,'error');
 assert.equal(request.url,hub.hubOrigin+'/.well-known/touchline.json');
});
test('discovery rejects secrets, hostile origins, versions, redirects and oversized responses',async()=>{
 for(const bad of [{...hub,secret:'hidden'},{...hub,version:2},{...hub,backend:{...hub.backend,publishableKey:'sb_secret_no'}},{...hub,auth:{email:'otp',providers:['supabase']}},{...hub,hubOrigin:'https://elsewhere.example'}]) {
  await assert.rejects(discoverHub(hub.hubOrigin,async()=>response(bad)));
 }
 for(const address of ['http://hub.example','https://user:pass@hub.example','https://hub.example/path','https://hub.example/?token=secret','https://hub.example/#token']) await assert.rejects(discoverHub(address,async()=>response()));
 await assert.rejects(discoverHub(hub.hubOrigin,async()=>response(hub,{status:302})));
 await assert.rejects(discoverHub(hub.hubOrigin,async()=>new Response(' '.repeat(40000),{headers:{'content-type':'application/json'}})));
 assert.throws(()=>validateHub({...hub,backend:{...hub.backend,url:'https://backend.example:99999'}}));
});

test('public hosted routes contain public fields only and never interpolate callback parameters',async()=>{
 const {createPublicHandler}=await import('../hosted/public-handler.js');
 assert.throws(()=>createPublicHandler({...hub,secret:'no'},'<main>App</main>'));
 const handler=createPublicHandler(hub,'<main>App</main>');
 const publicResponse=await handler(new Request(hub.hubOrigin+'/.well-known/touchline.json'));
 assert.deepEqual(await publicResponse.json(),hub);assert.equal(publicResponse.headers.get('access-control-allow-origin'),'*');
 const callback=await handler(new Request(hub.hubOrigin+'/auth/return?touchline-return=0bdb7cc4-f92d-4ac7-84b7-49928d888f2c&code=%3Cscript%3E'));
 assert.equal(await callback.text(),'<main>App</main>');assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
 assert.equal((await handler(new Request(hub.hubOrigin+'/auth/return?touchline-return=x&access_token=private'))).status,400);
 assert.equal((await handler(new Request('https://wrong.example/.well-known/touchline.json'))).status,400);
});

test('runtime hub validation agrees with every P02 hub fixture',async()=>{
 const cases=JSON.parse(await readFile('tests/fixtures/contracts/cases.json','utf8'));
 for(const item of cases.filter(item=>item.schema==='hub-description.v1.schema.json')){
  const value=JSON.parse(await readFile('tests/fixtures/contracts/'+item.file,'utf8'));
  if(item.valid && item.semanticValid!==false)assert.doesNotThrow(()=>validateHub(value),item.name);
  else assert.throws(()=>validateHub(value),item.name);
 }
 for(const origin of ['https://bad_host.example','https://trailing.example.','https://example.org:99999'])assert.throws(()=>validateHub({...hub,hubOrigin:origin}));
});
