import {build} from 'esbuild';
import {mkdir,writeFile,copyFile,readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fonts=['ibm-plex-sans-latin-variable.woff2','syne-latin-variable.woff2','IBM-Plex-Sans-OFL.txt','Syne-OFL.txt'];
const migrations=['001_private_writes.sql','002_bind_existing_owner.sql','003_classify_legacy_publications.sql','004_session_access.sql'];
/** Builds an isolated deploy tree. It never reads environment values or local learning files. */
export async function buildHosted({output=join(root,'.vercel/output')}={}){
 output=resolve(output);
 // Refuse an existing output tree so a stale file cannot become public accidentally.
 await mkdir(dirname(output),{recursive:true});await mkdir(output);
 const staticRoot=join(output,'static/setup-assets'),functionRoot=join(output,'functions/connector.func');
 await mkdir(staticRoot,{recursive:true});await mkdir(join(output,'static/assets/appearance'),{recursive:true});await mkdir(join(functionRoot,'backend/setup'),{recursive:true});await mkdir(join(functionRoot,'backend/migrations'),{recursive:true});
 const browser=await build({absWorkingDir:root,entryPoints:['web/setup/entry.jsx'],bundle:true,format:'esm',minify:true,outfile:join(staticRoot,'setup.js'),external:['/setup-assets/*','/assets/appearance/*'],metafile:true});
 for(const file of fonts)await copyFile(join(root,'assets/appearance',file),join(output,'static/assets/appearance',file));
 const server=await build({absWorkingDir:root,entryPoints:['hosted/vercel-entry.mjs'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:join(functionRoot,'backend/setup/handler.mjs'),external:['pg-native'],metafile:true,loader:{'.html':'text'},banner:{js:"import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);"},plugins:[{name:'plain-return-script',setup(plugin){plugin.onResolve({filter:/account-return\.js\?text$/},()=>({path:join(root,'hosted/account-return.js'),namespace:'return-script'}));plugin.onLoad({filter:/.*/,namespace:'return-script'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));}}]});
 for(const file of migrations)await copyFile(join(root,'backend/migrations',file),join(functionRoot,'backend/migrations',file));
 for(const file of ['catalog.sql','catalog-evidence.json'])await copyFile(join(root,'backend/setup',file),join(functionRoot,'backend/setup',file));
 await writeFile(join(functionRoot,'.vc-config.json'),JSON.stringify({runtime:'nodejs22.x',handler:'backend/setup/handler.mjs',launcherType:'Nodejs',shouldAddHelpers:false,maxDuration:60},null,2)+'\n');
 await writeFile(join(output,'config.json'),JSON.stringify({version:3,routes:[{src:'/(?:setup-assets|assets/appearance)/.*',headers:{'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=0, must-revalidate'},continue:true},{handle:'filesystem'},{src:'/.*',dest:'/connector'}]},null,2)+'\n');
 return {output,browserInputs:Object.keys(browser.metafile.inputs),serverInputs:Object.keys(server.metafile.inputs)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const result=await buildHosted();console.log('Built the isolated Schola connector at '+result.output);}
