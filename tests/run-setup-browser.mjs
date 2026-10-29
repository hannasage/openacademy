import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const directory=await mkdtemp(join(tmpdir(),'touchline-setup-browser-'));
await build({entryPoints:['web/setup/entry.jsx'],bundle:true,format:'esm',minify:true,outfile:join(directory,'setup.js'),external:['/setup-assets/*','/assets/appearance/*']});
await build({stdin:{contents:"import {createRoot} from 'react-dom/client';import {ThemeProvider,THEME_PRESETS} from '@hannasage/projection-ui/core';import '@hannasage/projection-ui/styles';import {SetupEntryCard} from './web/setup/entry-card.jsx';import './web/connection/connection.css';createRoot(document.getElementById('root')).render(<ThemeProvider theme={THEME_PRESETS['noir-bloom']}><SetupEntryCard/></ThemeProvider>);",resolveDir:process.cwd(),loader:'jsx'},jsx:'automatic',bundle:true,format:'esm',outfile:join(directory,'entry.js')});
const assets=new Map();
for(const [url,path,type] of [
 ['/setup','hosted/setup.html','text/html'],['/setup-guide','hosted/setup-guide.html','text/html'],['/auth/return','hosted/account-return.html','text/html'],['/account-return.js','hosted/account-return.js','application/javascript'],
 ['/setup-assets/setup.js',join(directory,'setup.js'),'application/javascript'],['/setup-assets/setup.css',join(directory,'setup.css'),'text/css'],
 ['/assets/appearance/syne-latin-variable.woff2','assets/appearance/syne-latin-variable.woff2','font/woff2'],['/assets/appearance/ibm-plex-sans-latin-variable.woff2','assets/appearance/ibm-plex-sans-latin-variable.woff2','font/woff2'],
])assets.set(url,{body:await readFile(path),contentType:type});
assets.set('/entry',{body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>',contentType:'text/html'});
for(const extension of ['js','css'])assets.set('/entry.'+extension,{body:await readFile(join(directory,'entry.'+extension)),contentType:extension==='js'?'application/javascript':'text/css'});
assets.set('/setup/deployment-return',assets.get('/setup'));
const origin='https://learn.example.org',id='12345678-1234-4123-8123-123456789abc';
const configuration={ready:true,missing:[],ownerEmail:'owner@example.org',hubOrigin:origin};
const project={ref:'a'.repeat(20),name:'Learning project',organizationId:'owner-org'};
const browser=await chromium.launch({headless:true});
try{
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  const context=await browser.newContext({viewport,reducedMotion:'reduce'}),page=await context.newPage();
  await page.emulateMedia({colorScheme:'dark'});
  const errors=[],external=[],calls=[];page.on('pageerror',error=>{errors.push(error.message);console.error('Setup page error:',error.message);});
  let authenticated=false,setup=null,projects=[],deployment=null;
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==origin){external.push(url.href);return route.abort();}
   if(assets.has(url.pathname))return route.fulfill(assets.get(url.pathname));
   if(url.pathname.startsWith('/api/setup')){
    const input=route.request().postDataJSON();calls.push({path:url.pathname,input});
    if(url.pathname.endsWith('/unlock'))authenticated=true;
    if(url.pathname.endsWith('/logout'))authenticated=false;
    if(url.pathname.endsWith('/projects'))projects=[project];
    if(url.pathname.endsWith('/review'))setup={...setup,phase:'reviewed',review:{reviewHash:'a'.repeat(64),project,config:{projectRef:project.ref,hubName:input.hubName,ownerEmail:configuration.ownerEmail,hubOrigin:origin},inspection:{compatibility:'empty'}},steps:[{id:'001_private_writes.sql',status:'pending'},{id:'configure-owner',status:'pending'},{id:'configure-auth',status:'pending'},{id:'verify',status:'pending'}]};
    if(url.pathname.endsWith('/install'))setup={...setup,phase:'ready-to-prepare'};
    if(url.pathname.endsWith('/prepare')){setup={...setup,phase:'preparation-failed',error:{code:'preparation_failed'}};return route.fulfill({status:400,json:{error:{code:'preparation_failed',message:'private-provider-error'}}});}
    if(url.pathname.endsWith('/cancel'))setup={...setup,phase:'cancelled'};
    if(url.pathname.endsWith('/deployment-review'))deployment={hub:{hubId:id,name:'Actual learning hub',hubOrigin:origin,backend:{url:'https://'+project.ref+'.supabase.co'}},reviewHash:'a'.repeat(64),verified:false};
    if(url.pathname.endsWith('/deployment-confirm'))deployment={...deployment,verified:true};
    return route.fulfill({json:authenticated?{authenticated,configuration,csrfToken:'test-csrf',setup,projects,deployment}:{authenticated}});
   }
   return route.fulfill({status:404,body:'Not found'});
  });
  await page.goto(origin+'/setup');
  await page.getByLabel('One-time setup code').fill('one-use-test-code');
  await page.getByRole('button',{name:'Change theme'}).click();await page.getByRole('radio',{name:'Light',exact:true}).check();await page.getByRole('button',{name:'Done',exact:true}).click();assert.equal(await page.getByLabel('One-time setup code').inputValue(),'one-use-test-code');assert.equal(calls.filter(call=>call.input).length,0);
  await page.getByRole('button',{name:'Unlock setup'}).click();
  await page.getByRole('button',{name:'Connect Supabase'}).waitFor();
  assert.ok(!await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage})).then(value=>value.includes('one-use-test-code')));
  setup={id,phase:'choosing-project',review:null,steps:[],error:null};
  await page.goto(origin+'/setup?setup='+id);await page.getByRole('button',{name:'Refresh projects'}).click();
  await page.getByRole('radio',{name:/Learning project/}).check();await page.getByLabel('Name your hub').fill('Soccer learning');await page.getByRole('button',{name:'Review setup',exact:true}).click();
  await page.getByRole('button',{name:'Approve and grant installation permission'}).waitFor();
  const writes=calls.filter(call=>call.input).length;
  for(const pair of ['Noir Bloom','Dusk Protocol']){await page.getByRole('button',{name:'Change theme'}).click();await page.getByRole('radio',{name:new RegExp(pair)}).check();for(const mode of ['Dark','Light','System']){await page.getByRole('radio',{name:mode,exact:true}).check();assert.equal(await page.getByLabel('Name your hub').inputValue(),'Soccer learning');assert.equal(await page.getByRole('radio',{name:/Learning project/}).isChecked(),true);}await page.getByRole('button',{name:'Done',exact:true}).click();}
  assert.equal(calls.filter(call=>call.input).length,writes);
  assert.equal(calls.filter(call=>call.path.endsWith('/prepare')).length,0);
  await page.screenshot({path:join(directory,'setup-review-'+viewport.width+'.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right>innerWidth).map(node=>({tag:node.tagName,cls:node.className,text:node.textContent,whiteSpace:getComputedStyle(node).whiteSpace,width:getComputedStyle(node).width,right:node.getBoundingClientRect().right})))));
  for(const box of await page.getByRole('button').evaluateAll(nodes=>nodes.map(node=>({label:node.textContent,height:node.getBoundingClientRect().height}))))assert.ok(box.height>=44,box.label+': '+box.height);
  await page.getByRole('button',{name:'Approve and grant installation permission'}).click();await page.getByRole('button',{name:'Prepare this hub'}).click();
  await page.getByRole('status').filter({hasText:'Preparation did not finish'}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('private-provider-error'));
  await page.getByRole('button',{name:'Refresh status'}).click();await page.getByRole('alert').filter({hasText:'Completed steps may remain installed'}).waitFor();
  assert.equal(await page.getByLabel('Name your hub').inputValue(),'Soccer learning');
  await page.getByRole('button',{name:'Cancel setup'}).click();await page.getByRole('heading',{name:'Setup cancelled'}).waitFor();
  await page.goto(origin+'/auth/return?code=secret-value&error_description=%3Cscript%3Ealert(1)%3C/script%3E#access_token=secret');
  await page.waitForURL(origin+'/auth/return');assert.ok(!(await page.locator('body').innerText()).includes('secret-value'));assert.equal(await page.locator('script[src="/account-return.js"]').count(),1);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  await page.screenshot({path:join(directory,'account-return-'+viewport.width+'.png'),fullPage:true});
  await page.goto(origin+'/entry');await page.getByRole('heading',{name:'Create my private hub'}).waitFor();
  const open=page.getByRole('button',{name:'Open owner setup'});assert.equal(await open.isDisabled(),true);
  await page.getByLabel('Owner connector address').fill('https://user:secret@connector.example.org');assert.equal(await open.isDisabled(),true);
  await page.getByLabel('Owner connector address').fill('https://connector.example.org');assert.equal(await open.isEnabled(),true);
  assert.equal(await page.locator('form').getAttribute('action'),'https://connector.example.org/setup');assert.equal(await page.locator('form').getAttribute('target'),'_blank');assert.match(await page.locator('form').getAttribute('rel'),/noopener/);
  await page.getByText('Host a connector with Vercel',{exact:true}).click();assert.equal(await page.getByRole('button',{name:/Deploy with Vercel/}).isDisabled(),true);
  await page.getByText('Use manual setup',{exact:true}).click();await page.getByText(/backend\/README.md/).waitFor();assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  setup=null;await page.goto(origin+'/setup/deployment-return?deployment-url='+encodeURIComponent(origin)+'&project-name=UNTRUSTED#secret');await page.waitForURL(origin+'/setup/deployment-return');await page.getByRole('button',{name:'Inspect this deployed hub'}).click();await page.getByText('Actual learning hub',{exact:true}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes('UNTRUSTED'));assert.equal(calls.filter(call=>call.path.endsWith('/deployment-confirm')).length,0);await page.getByRole('button',{name:'Confirm this hub and check readiness'}).click();await page.getByRole('status').filter({hasText:'passed its discovery'}).waitFor();
  await page.goto(origin+'/setup-guide');const guideType=await page.evaluate(()=>({body:parseFloat(getComputedStyle(document.body).fontSize),h1:parseFloat(getComputedStyle(document.querySelector('h1')).fontSize),h2:parseFloat(getComputedStyle(document.querySelector('h2')).fontSize)}));assert.ok(guideType.h1>=guideType.body*1.25);if(viewport.width===1440)console.log('Rendered guide typography:',JSON.stringify(guideType));
  await context.close();
 }
 // Text scaling must not hide controls or require horizontal scrolling.
 const context=await browser.newContext({viewport:{width:390,height:844}}),page=await context.newPage();
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin)return route.abort();if(assets.has(url.pathname))return route.fulfill(assets.get(url.pathname));return route.fulfill({json:{authenticated:false}});});
 await page.goto(origin+'/setup');await page.getByRole('heading',{name:'Unlock owner setup'}).waitFor();await page.addStyleTag({content:'html{font-size:200%}body{font-size:24px}.setup-card h2{font-size:36px}.setup-app input,.setup-app button{font-size:24px!important}'});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(node=>node.getBoundingClientRect().right>innerWidth).map(node=>({tag:node.tagName,cls:node.className,text:node.textContent,whiteSpace:getComputedStyle(node).whiteSpace,width:getComputedStyle(node).width,right:node.getBoundingClientRect().right})))));await page.getByLabel('One-time setup code').fill('test-code');assert.ok(await page.getByRole('button',{name:'Unlock setup'}).isEnabled());await page.screenshot({path:join(directory,'setup-larger-text.png'),fullPage:true});await context.close();
 await mkdir(join(directory,'complete'));console.log('Standalone setup browser checks passed. Evidence: '+directory);
}finally{await browser.close();}
