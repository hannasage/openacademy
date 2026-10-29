import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildHosted} from '../hosted/build.mjs';
async function files(path,prefix=''){const result=[];for(const entry of await readdir(path,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isDirectory())result.push(...await files(join(path,entry.name),name+'/'));else result.push(name);}return result.sort();}
test('hosted output is an exact whitelist without local editor, curricula or private configuration',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'touchline-hosted-build-')),output=join(directory,'output');
 const result=await buildHosted({output});
 assert.deepEqual(await files(join(output,'static')),['assets/appearance/IBM-Plex-Sans-OFL.txt','assets/appearance/Syne-OFL.txt','assets/appearance/ibm-plex-sans-latin-variable.woff2','assets/appearance/syne-latin-variable.woff2','setup-assets/setup.css','setup-assets/setup.js'].sort());
 assert.deepEqual(await files(join(output,'functions/connector.func')),['.vc-config.json','backend/setup/handler.mjs','backend/setup/catalog.sql','backend/setup/catalog-evidence.json','backend/migrations/001_private_writes.sql','backend/migrations/002_bind_existing_owner.sql','backend/migrations/003_classify_legacy_publications.sql','backend/migrations/004_session_access.sql'].sort());
 for(const path of [...result.browserInputs,...result.serverInputs])assert.ok(!/(^|\/)(app\.js|web\.jsx|local_store\.py|curriculum\.json|\.env[^/]*|data\/)|web\/(accounts|publication)\//.test(path),path);
 assert.ok(result.browserInputs.includes('appearance.jsx'));
 assert.ok(result.serverInputs.includes('backend/setup/admin.mjs'));
 assert.ok(result.serverInputs.includes('backend/setup/postgres.mjs'));
 const config=JSON.parse(await readFile(join(output,'config.json'),'utf8'));assert.equal(config.version,3);assert.equal(config.routes.at(-1).dest,'/connector');
 await assert.rejects(buildHosted({output}),/EEXIST/);
 // Never inherit an operator's deployment credentials. Block all network paths too.
 const script=`import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';const require=createRequire(import.meta.url);const blocked=()=>{throw Error('Network access is forbidden in this test.');};for(const name of ['http','https']){require('node:'+name).request=blocked;require('node:'+name).get=blocked;}require('node:net').connect=blocked;require('node:net').createConnection=blocked;require('node:tls').connect=blocked;globalThis.fetch=blocked;const {default:handler}=await import(pathToFileURL(${JSON.stringify(join(output,'functions/connector.func/backend/setup/handler.mjs'))}).href);let status,text;await handler({url:'/setup',method:'GET',headers:{host:'learn.example.org'}},{writeHead(value){status=value;},end(value){text=value;}});process.stdout.write(JSON.stringify({status,text}));`;
 const resultResponse=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{env:{},encoding:'utf8'}));
 assert.equal(resultResponse.status,503);assert.match(resultResponse.text,/not configured/);
 console.log('Hosted build evidence: '+directory);
});
