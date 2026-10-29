import assert from 'node:assert/strict';
import test from 'node:test';
import {evidenceLinks,evidenceMarkup,journalList} from '../web/screens/journal.js';
test('evidence links stay portable and reject credentials or executable schemes',()=>{
 assert.deepEqual(evidenceLinks('Evidence: https://example.com/run\nhttps://example.com/run javascript:alert(1) https://user:password@example.com'),['https://example.com/run']);
 assert.match(evidenceMarkup('https://example.com/?x=1&y=2'),/x=1&amp;y=2/);
 assert.equal(evidenceMarkup('javascript:alert(1)'), '');
});
test('journal renders user text literally and distinguishes planned experiments',()=>{
 const html=journalList({modules:[{id:'one',title:'<Lesson>'}]},[{id:'test',title:'<script>',module:'one',date:'2026-01-01',result:''}],null);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/Planned/);assert.doesNotMatch(html,/<script>/);
});
