#!/usr/bin/env node
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSetupRuntime} from './runtime.mjs';
const command=process.argv[2];
if(command==='initialize-secrets'||command==='rotate-bootstrap'){
 if(command==='initialize-secrets')process.stdout.write('TOUCHLINE_SETUP_ENCRYPTION_KEY='+randomBytes(32).toString('base64url')+'\n');
 process.stdout.write('TOUCHLINE_SETUP_BOOTSTRAP_KEY='+randomBytes(32).toString('base64url')+'\n');
 process.stdout.write('TOUCHLINE_SETUP_BOOTSTRAP_EXPIRES_AT='+new Date(Date.now()+24*60*60*1000).toISOString()+'\n');
}else if(command==='print-schema')process.stdout.write(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
else if(command==='cleanup'){
 let runtime;
 try{runtime=await createSetupRuntime(process.env,{verifyPublished:async()=>{throw Error('Deployment verification is not available in cleanup.');}});let count=0,pending=0;for(const id of await runtime.store.expiredIds()){const result=await runtime.service.expire(id);count++;if(result.revocationPending)pending++;}process.stdout.write(JSON.stringify({expired:count,manualRevocationRequired:pending})+'\n');if(pending)process.exitCode=2;}
 catch{process.stderr.write('Setup cleanup failed. Inspect the connector configuration and retry. No credentials were printed.\n');process.exitCode=1;}
 finally{await runtime?.close();}
}else{process.stderr.write('Use initialize-secrets, rotate-bootstrap, print-schema, or cleanup.\n');process.exitCode=1;}
