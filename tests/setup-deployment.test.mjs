import assert from 'node:assert/strict';
import test from 'node:test';
import {deploymentOrigin} from '../web/setup/deployment-return.js';
import {deployTemplate,deployButtonURL} from '../hosted/deploy-template.mjs';
test('deployment return retains only a valid origin and ignores readiness, dashboard and repository claims',()=>{
 const url='https://owner.example.org/setup/deployment-return?deployment-url='+encodeURIComponent('https://learn.example.org')+'&project-name=READY&repository-url=javascript:evil&production-deploy-hook-url=secret';
 assert.equal(deploymentOrigin(url),'https://learn.example.org');
 for(const value of ['javascript:alert(1)','http://learn.example.org','https://user:secret@learn.example.org','https://learn.example.org/path','https://learn.example.org?token=secret','https://learn.example.org#token'])assert.equal(deploymentOrigin('https://owner.example.org/setup/deployment-return?deployment-url='+encodeURIComponent(value)),null);
 assert.equal(deploymentOrigin(url+'&deployment-url=https://other.example.org'),null);
});
test('deployment template stays publication-gated and declares names without secret defaults',()=>{
 assert.equal(deployButtonURL('https://owner.example.org'),null);assert.equal(deployTemplate.publicationApproved,false);
 const url=new URL(deployButtonURL('https://owner.example.org',{...deployTemplate,publicationApproved:true}));
 assert.equal(url.origin,'https://vercel.com');assert.equal(url.searchParams.get('redirect-url'),'https://owner.example.org/setup/deployment-return');assert.equal(url.searchParams.get('env'),deployTemplate.environment.join(','));
 assert.equal(url.searchParams.has('production-deploy-hook'),false);assert.equal(url.searchParams.has('envDefaults'),false);
});
