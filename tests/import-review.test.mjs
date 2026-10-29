import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareImport} from '../web/screens/import-review.js';
const course={id:'one',weeklyHours:8};
test('curriculum-only imports start with empty progress while backups retain drafts',()=>{
 const source=prepareImport(course);
 assert.equal(source.state.curriculumId,'one');assert.deepEqual(source.state.experiments,[]);
 const backup={format:'touchline-record',version:2,curriculum:course,state:{curriculumId:'one'},draft:{experiment:{title:''}}};
 assert.deepEqual(prepareImport(backup),backup);
});
test('unsupported formats and ambiguous wrappers fail before preview',()=>{
 for(const source of [null,[],{format:'future',curriculum:course},{format:'touchline-record',version:3},{version:2,recordId:'foreign'}])assert.throws(()=>prepareImport(source));
});
test('legacy progress can only restore its matching selected curriculum',()=>{
 const target={curriculum:course};
 assert.equal(prepareImport({curriculumId:'one',version:1},target).curriculum.id,'one');
 assert.throws(()=>prepareImport({curriculumId:'other',version:1},target),/matching/);
});
