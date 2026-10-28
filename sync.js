import {createClient} from '@supabase/supabase-js';
/**
 * @template {keyof TouchlineElements} K
 * @overload
 * @param {K} selector
 * @returns {TouchlineElements[K]}
 */
/** @overload @param {string} selector @returns {HTMLElement} */
/** @param {string} selector @returns {HTMLElement} */
function $(selector) {
 const element = document.querySelector(selector);
 if (!(element instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
 return element;
}
/** @param {unknown} error */
const message = error => error instanceof Error ? error.message : String(error);
/** @type {import('@supabase/supabase-js').SupabaseClient<TouchlineDatabase> | undefined} */ let client;
/** @type {HubConnection | undefined} */ let connection;
/** @type {Record<string, number>} */ let revisions = {};
/** @type {string | null | undefined} */ let revisionKey;
function backend() {
 if (!client) throw new Error('Connect your backend first.');
 return client;
}
/** @param {import('@supabase/supabase-js').User | null | undefined} user */
function loadRevisions(user){revisionKey=user&&connection?'touchline-revisions:'+connection.url+':'+user.id:null;try{revisions=revisionKey?JSON.parse(localStorage.getItem(revisionKey)||'{}'):{};}catch{revisions={};}}
function persistRevisions(){if(revisionKey)localStorage.setItem(revisionKey,JSON.stringify(revisions));}
/** @param {string} s */
const say=(s,error=false)=>{ $('#cloud-status').textContent=s;$('#cloud-status').style.color=error?'#922f1e':''; };
/** @param {HubConnection} c */
function validateConnection(c){const url=new URL(c.url);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/')throw Error('Use your HTTPS Supabase project URL without a path.');if(!c.publishableKey||c.publishableKey.startsWith('sb_secret_'))throw Error('Use a publishable key, never a secret key.');if(c.publishableKey.startsWith('ey')){try{const body=JSON.parse(atob(c.publishableKey.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(body.role!=='anon')throw Error();}catch{throw Error('Only a publishable key or legacy anon key is allowed.');}}return c;}
/** @param {HubConnection} c */
async function connect(c){validateConnection(c);if(client)await backend().auth.signOut({scope:'local'});connection=c;revisions={};client=createClient(c.url,c.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});localStorage.setItem('touchline-backend',JSON.stringify(c));$('#cloud-url').value=c.url;$('#cloud-key').value=c.publishableKey;const {data}=await backend().auth.getUser();loadRevisions(data?.user);say(data?.user?'Signed in as '+data.user.email:'Backend connected. Sign in to access your records.');}
/** @param {() => Promise<void>} fn */
async function guarded(fn){try{if(!client)throw Error('Connect your backend first.');await fn();}catch(e){say(message(e),true);}}
async function list(){const {data,error}=await backend().from('learning_courses').select('id,curriculum,revision,updated_at').order('updated_at',{ascending:false});if(error)throw error;const root=$('#cloud-courses');root.replaceChildren();if(!data.length){root.textContent='No published courses yet. Publish your current course to make it available on iPhone and iPad.';return;}
for(const row of data){const section=document.createElement('article');section.className='journal-entry';const title=document.createElement('h3');title.textContent=row.curriculum.title;const meta=document.createElement('p');meta.textContent='Published '+new Date(row.updated_at).toLocaleString();const button=document.createElement('button');button.textContent='Download to this computer';button.onclick=()=>guarded(async()=>{const {data:latest,error}=await backend().from('learning_courses').select('*').eq('id',row.id).single();if(error)throw error;if(!confirm('Replace local progress for this curriculum with the published copy? Export local progress first if you need to preserve it.'))return;await window.touchline.importCloud({curriculum:latest.curriculum,state:latest.progress});revisions[row.id]=latest.revision;persistRevisions();say('Downloaded '+latest.curriculum.title);});section.append(title,meta,button);root.append(section);}}
$('#cloud-connection').onsubmit=async e=>{e.preventDefault();try{await connect({url:$('#cloud-url').value.trim().replace(/\/$/,''),publishableKey:$('#cloud-key').value.trim()});}catch(e){say(message(e),true);}};
$('#cloud-auth').onsubmit=e=>{e.preventDefault();guarded(async()=>{const {data,error}=await backend().auth.signInWithPassword({email:$('#cloud-email').value.trim(),password:$('#cloud-password').value});if(error)throw error;loadRevisions(data.user);$('#cloud-password').value='';say('Signed in. Your records are private to this account.');await list();});};
$('#cloud-signup').onclick=()=>guarded(async()=>{if(!$('#cloud-auth').reportValidity())return;const {data,error}=await backend().auth.signUp({email:$('#cloud-email').value.trim(),password:$('#cloud-password').value});if(error)throw error;$('#cloud-password').value='';say(data.session?'Owner account ready.':'Open the confirmation email, then return here to sign in.');});
$('#cloud-signout').onclick=()=>guarded(async()=>{const {error}=await backend().auth.signOut();if(error)throw error;revisions={};$('#cloud-courses').replaceChildren();say('Signed out. Local learning records remain on this computer.');});
$('#cloud-refresh').onclick=()=>guarded(list);
$('#cloud-upload').onclick=()=>guarded(async()=>{const {data:{user},error}=await backend().auth.getUser();if(error||!user)throw Error('Sign in before publishing.');const backup=await window.touchline.snapshot();const {data,error:saveError}=await backend().rpc('save_learning_course',{course_id:backup.curriculum.id,course_content:backup.curriculum,course_progress:backup.state,expected_revision:revisions[backup.curriculum.id]??-1});if(saveError)throw saveError;revisions[backup.curriculum.id]=data.revision;persistRevisions();say('Published. Refresh the native app to read this copy.');await list();});
$('#export-connection').onclick=()=>{try{const c=validateConnection({url:$('#cloud-url').value.trim().replace(/\/$/,''),publishableKey:$('#cloud-key').value.trim()});window.touchline.download({format:'touchline-connection',...c},'touchline-connection.json');}catch(e){say(message(e),true);}};
(async()=>{try{const saved=localStorage.getItem('touchline-backend');const c=saved?JSON.parse(saved):await(await fetch('/api/cloud-config')).json();if(c.url){connection=validateConnection(c);client=createClient(c.url,c.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});$('#cloud-url').value=c.url;$('#cloud-key').value=c.publishableKey;const {data}=await backend().auth.getUser();loadRevisions(data?.user);say(data?.user?'Signed in as '+data.user.email:'Backend ready. Sign in to access your records.');}}catch(e){say(message(e),true);}})();
