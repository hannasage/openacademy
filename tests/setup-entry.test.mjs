import assert from 'node:assert/strict';
import test from 'node:test';
import {setupAddress} from '../web/setup/entry-link.js';
test('local setup opens only an exact HTTPS origin at the fixed setup path',()=>{assert.equal(setupAddress(' https://learn.example.org '),'https://learn.example.org/setup');for(const value of ['','http://learn.example.org','javascript:alert(1)','https://user:pass@learn.example.org','https://learn.example.org/path','https://learn.example.org?return=https://other.example.org','https://learn.example.org#token'])assert.equal(setupAddress(value),null);});
