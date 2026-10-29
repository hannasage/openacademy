import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeRecord, focusRecord} from '../web/screens/model.js';
import {createLearningService} from '../web/services/learning.js';

test('a selected curriculum does not silently become the focus', () => {
 const records=[{recordId:'a',status:'active'},{recordId:'b',status:'active'}];
 assert.equal(focusRecord(records,null),null);
 assert.equal(focusRecord(records,'a'),records[0]);
 assert.equal(focusRecord([{recordId:'a',status:'paused'}],'a'),null);
});
test('screen metrics come from the record and preserve its selected lesson', () => {
 const value={curriculum:{modules:[{id:'a'},{id:'b'}]},view:{selectedModuleId:'b'},state:{modules:{a:{status:'complete',hours:2},b:{status:'active',hours:1.5}},experiments:[{title:'Observed result'}]}};
 assert.deepEqual(summarizeRecord(value),{done:1,total:2,hours:3.5,experiments:1,lesson:value.curriculum.modules[1]});
});
test('focus changes send the explicit library revision and account scope',async()=>{
 let request;const service=createLearningService(async(path,options)=>{request={path,options};return {ok:true,json:async()=>({version:1,revision:4,focusRecordId:'record'})};});
 await service.saveFocus('record',3,null);
 assert.equal(request.path,'/api/library');
 assert.deepEqual(JSON.parse(request.options.body),{focusRecordId:'record',expectedRevision:3});
});
