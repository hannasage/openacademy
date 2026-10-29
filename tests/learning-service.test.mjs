import assert from 'node:assert/strict';
import test from 'node:test';
import {createLearningService, LearningServiceError} from '../web/services/learning.js';

const scope={kind:'cloud',hubId:'adcd44aa-85da-4548-84bc-1ada69c19099',backendOrigin:'https://example.supabase.co',accountId:'fa057912-c6e0-4d07-87bb-34973675f9ca'};
test('local operations encode identity and keep cloud scope explicit',async()=>{
 const calls=[];
 const service=createLearningService(async (url,options)=>{calls.push({url,options});return new Response(JSON.stringify({recordId:'r',state:{revision:3}}));});
 await service.listLibrary(scope);await service.getRecord('unsafe/segment',scope);
 const record={recordId:'r',state:{revision:2}};
 await service.saveRecord(record,2,scope);
 await service.importRecord({curriculum:{id:'course'},state:{}},scope,'active',{targetRecordId:'r',expectedRevision:3});
 assert.equal(calls[0].url,'/api/library?hubId='+scope.hubId+'&backendOrigin=https%3A%2F%2Fexample.supabase.co&accountId='+scope.accountId);
 assert.match(calls[1].url,/records\/unsafe%2Fsegment\?/);
 assert.deepEqual(JSON.parse(calls[2].options.body),{expectedRevision:2,record});
 assert.equal(calls[3].options.method,'POST');assert.equal(JSON.parse(calls[3].options.body).targetRecordId,'r');
 await service.listLibrary();assert.equal(calls.at(-1).url,'/api/library');
});
test('structured failures retain conflict and field information without returning success',async()=>{
 const service=createLearningService(async()=>new Response(JSON.stringify({error:'Newer record saved.',code:'revision_conflict',field:'state.revision',currentRevision:8,retryable:false}),{status:409}));
 await assert.rejects(service.getRecord('r'),error=>error instanceof LearningServiceError&&error.status===409&&error.code==='revision_conflict'&&error.currentRevision===8&&error.field==='state.revision'&&!error.retryable);
});
test('unreadable and unavailable responses fail clearly',async()=>{
 await assert.rejects(createLearningService(async()=>new Response('<html>unavailable</html>',{status:503})).listLibrary(),/could not be read/);
 await assert.rejects(createLearningService(async()=>{throw Error('Offline');}).listLibrary(),/Offline/);
});
