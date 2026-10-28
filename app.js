'use strict';
export {};
/** @type {Curriculum[]} */ let curricula = [];
/** @type {Curriculum} */ let course;
/** @type {LearningState} */ let state;
/** @type {LocalRecord} */ let record;
/** @type {LibrarySummary[]} */ let library = [];
/** @type {CloudOrigin | null} */ let accountScope = null;
let lastLocalRecordId = '';
let recoveryConflict = false;
let recoveryAvailable = true;
let viewEpoch = 0;
let accountInvalidated = false;
/** @type {Map<string, string>} */ const memoryRecovery = new Map();
/** @type {Set<string>} */ const volatileRecovery = new Set();
/** @type {string} */ let selected;
let dirty = false;
/** @type {Promise<boolean> | null} */ let saving = null;
/** @type {number | undefined} */ let timer;
/** @type {string | null} */ let editing = null;
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
/** @param {string} id @returns {CurriculumModule} */
function moduleById(id) {
 const module = course.modules.find(item => item.id === id);
 if (!module) throw new Error(`Unknown module: ${id}`);
 return module;
}
/** @param {unknown} v */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
/** @param {CurriculumModule} m @returns {ModuleProgress} */
const progress = m => state.modules[m.id] || {status:'not-started', tasks:m.tasks.map(()=>false), notes:'', evidence:'', hours:0};
/** @param {CurriculumModule} m @returns {ModuleProgress} */
const editable = m => state.modules[m.id] ||= progress(m);
/** @param {string} text */
const notice = (text, error=false) => { $('#notice').textContent=text; $('#notice').className=error?'error':''; };
/** @overload @param {'/api/curricula'} url @returns {Promise<Curriculum[]>} */
/** @overload @param {'/api/curricula'} url @param {Curriculum} data @returns {Promise<Curriculum>} */
/** @overload @param {string} url @param {LearningState} [data] @returns {Promise<LearningState>} */
/** @param {string} url @param {Curriculum | LearningState} [data] @returns {Promise<Curriculum[] | Curriculum | LearningState>} */
async function request(url, data) {
 const r=await fetch(url, data===undefined?{}:{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const result=await r.json(); if(!r.ok) throw new Error(result.error || 'Request failed.'); return result;
}
/** @param {string} url @param {unknown} [data] @param {string} [method] @returns {Promise<LocalRecord>} */
async function recordRequest(url, data, method='PUT') {
 const response=await fetch(url, data===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
 const value=await response.json();
 if(!response.ok)throw Error(value.error||'The learning record could not be saved.');
 return value;
}
/** @param {CloudOrigin | null} [scope] */
function scopeQuery(scope=accountScope) { return scope?'?'+new URLSearchParams({hubId:scope.hubId,backendOrigin:scope.backendOrigin,accountId:scope.accountId}).toString():''; }
/** @param {number} epoch */
function requireEpoch(epoch){if(epoch!==viewEpoch)throw Error('The account changed during this operation. Retry from the current account.');}
function recoveryKey() { return 'touchline-recovery:'+record.recordId; }
function journal() {
 const key=recoveryKey(),value=JSON.stringify({version:1,baseRevision:state.revision,record});memoryRecovery.set(key,value);
 try { localStorage.setItem(key,value); recoveryAvailable=true;volatileRecovery.delete(key); }
 catch { recoveryAvailable=false;volatileRecovery.add(key); notice('Device recovery is unavailable. Keep this page open until saving succeeds, or export your work.',true); }
}
function clearJournal() { memoryRecovery.delete(recoveryKey());volatileRecovery.delete(recoveryKey());try { localStorage.removeItem(recoveryKey()); } catch { /* The saved server record is still durable. */ } }
function changed() {
 dirty=true; journal(); $('#save-state').textContent=recoveryConflict?'Recovery conflict':'Unsaved changes';
 clearTimeout(timer); if(!recoveryConflict)timer=setTimeout(save,500);
}
/** @returns {Promise<boolean>} */
async function save() {
 clearTimeout(timer); if(recoveryConflict||accountInvalidated)return false; if(saving)return saving;
 const epoch=viewEpoch;
 saving=(async()=>{
  while(dirty) {
   dirty=false; $('#save-state').textContent='Saving…';
   try {
    const snapshot=structuredClone(record);
    const response=await recordRequest('/api/records/'+record.recordId+scopeQuery(),{expectedRevision:snapshot.state.revision,record:snapshot});
    if(epoch!==viewEpoch)return false;
    state.revision=response.state.revision;
    if(dirty)journal();else clearJournal();
    $('#save-state').textContent='Saved on this computer'; $('#retry').hidden=true;
   } catch(error) {
    if(epoch!==viewEpoch)return false;
    dirty=true; journal(); notice(message(error)+(recoveryAvailable?' Your working copy is kept on this device.':' Export your work before closing this page.'),true);
    $('#save-state').textContent='Not saved'; $('#retry').hidden=false; return false;
   }
  }
  return true;
 })();
 const result=await saving; saving=null; return result;
}
function captureDraft() {
 if(accountInvalidated)return;
 const fields=$('#experiment-form').elements;
 record.draft.experiment={id:editing,date:record.draft.experiment?.date||new Date().toISOString().slice(0,10),module:fields.module.value,title:fields.title.value,hypothesis:fields.hypothesis.value,result:fields.result.value};
 changed();
}
function restoreDraft() {
 const draft=record.draft.experiment,form=$('#experiment-form');
 editing=draft?.id||null;
 for(const key of /** @type {const} */(['title','hypothesis','result']))form.elements[key].value=draft?.[key]||'';
 form.elements.module.value=draft?.module||selected;
 $('#experiment-form button').textContent=editing?'Save experiment changes':'Record experiment';
}
/** @param {LocalRecord} candidate @param {LocalRecord} current */
function usableRecovery(candidate,current) {
 if(candidate.format!=='touchline-record'||candidate.version!==2||candidate.recordId!==current.recordId||JSON.stringify(candidate.origin)!==JSON.stringify(current.origin)||JSON.stringify(candidate.curriculum)!==JSON.stringify(current.curriculum))return false;
 const ids=new Set(current.curriculum.modules.map(module=>module.id));
 if(!candidate.state||candidate.state.curriculumId!==current.curriculum.id||!candidate.state.modules||!Array.isArray(candidate.state.experiments)||!candidate.view||!ids.has(candidate.view.selectedModuleId)||!candidate.draft)return false;
 for(const [id,progress] of Object.entries(candidate.state.modules))if(!ids.has(id)||!progress||typeof progress.notes!=='string'||typeof progress.evidence!=='string'||!Array.isArray(progress.tasks)||typeof progress.hours!=='number')return false;
 const draft=candidate.draft.experiment;
 return draft===null||!!draft&&ids.has(draft.module)&&['date','title','hypothesis','result'].every(key=>typeof draft[/** @type {'date'|'title'|'hypothesis'|'result'} */(key)]==='string')&&(draft.id===null||typeof draft.id==='string');
}
function stats() {
 if(accountInvalidated)return;
 const p=course.modules.map(progress);
 window.updateProjectionProgress?.(p.filter(x=>x.status==='complete').length,p.length);
 $('#completed').textContent=`${p.filter(x=>x.status==='complete').length} / ${p.length}`;
 $('#hours').textContent=`${p.reduce((a,x)=>a+x.hours,0).toFixed(1).replace('.0','')} h`;
 $('#experiments-count').textContent=String(state.experiments.length);
 $('#duration').textContent=`${course.weeks} weeks`;
 $('#pace').textContent=`${state.weeklyHours} hours per week planned`;
}
function navigation() {
 if(accountInvalidated)return;
 let phase='';
 $('#modules').innerHTML=course.modules.map((m,i)=>{
  const heading=m.phase!==phase?`<p class="phase">${esc(m.phase)}</p>`:''; phase=m.phase;
  const p=progress(m);
  return `${heading}<button class="module ${selected===m.id?'selected':''} ${p.status==='complete'?'done':''}" data-module="${esc(m.id)}" ${selected===m.id?'aria-current="step"':''}><span class="module-number">${p.status==='complete'?'✓':String(i+1).padStart(2,'0')}</span><span>${esc(m.title)}<small>Weeks ${m.weekStart}–${m.weekEnd} · ${p.status==='complete'?'Complete':p.status==='active'?'In progress':m.hours+' h'}</small></span></button>`;
 }).join('');
 $('#modules').querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.module || '';record.view.selectedModuleId=selected;if(!record.draft.experiment)restoreDraft();changed();navigation();detail();});
 stats();
}
/** @param {CurriculumModule} m */
function dates(m) {
 if(!state.startDate)return '';
 const start=new Date(state.startDate+'T12:00:00'); start.setDate(start.getDate()+(m.weekStart-1)*7);
 const end=new Date(state.startDate+'T12:00:00'); end.setDate(end.getDate()+m.weekEnd*7-1);
 return `${start.toLocaleDateString(undefined,{month:'short',day:'numeric'})} – ${end.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}`;
}
function detail() {
 if(accountInvalidated)return;
 const m=moduleById(selected),p=progress(m);
 const missing=m.prerequisites.filter(id=>progress(moduleById(id)).status!=='complete');
 $('#module-detail').innerHTML=`<div class="detail-top"><p class="eyebrow">WEEKS ${m.weekStart}–${m.weekEnd} / ${esc(m.phase)}</p><span>${m.hours} hours · ${esc(dates(m))}</span></div><h2>${esc(m.title)}</h2><p class="question">${esc(m.question)}</p><p>${esc(m.outcome)}</p>${missing.length?'<p class="prerequisite">Build on the earlier modules before completing this one. You can explore any stage now.</p>':''}<div class="module-controls"><label>Progress<select id="status"><option value="not-started">Not started</option><option value="active">In progress</option><option value="complete">Complete with evidence</option></select></label><label>Hours spent<input id="study-hours" type="number" min="0" max="10000" step="0.25" value="${p.hours}"></label></div><section class="detail-section"><h3>The experiment</h3><div class="tasks">${m.tasks.map((t,i)=>`<label class="task"><input type="checkbox" data-task="${i}" ${p.tasks[i]?'checked':''}><span>${esc(t)}</span></label>`).join('')}</div></section><section class="math-note"><p class="eyebrow">THE IDEAS BEHIND THE CODE</p><p>${esc(m.math)}</p></section><section class="detail-section"><h3>Your two-week rhythm</h3>${m.weeks.map(w=>`<p>${esc(w)}</p>`).join('')}</section><section class="detail-section"><h3>Data for this project</h3><p>${esc(m.dataset)}</p></section><section class="detail-section"><h3>Read with a question</h3><p>${esc(m.reading)}</p><div class="resources">${m.resources.map(k=>{const r=course.resources[k];return `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.title)} <span aria-hidden="true">↗</span><small>${esc(r.use)}</small></a>`;}).join('')}</div></section><section class="detail-section"><h3>Show what you know</h3><p>${esc(m.evidence)}</p><div class="challenge"><span class="eyebrow">TRY THIS YOURSELF</span><p>${esc(m.challenge)}</p></div><label>Evidence and project location<textarea id="evidence" placeholder="Notebook path, repository link, results, and your independent explanation.">${esc(p.evidence)}</textarea></label><label>Learning notes<textarea id="notes" placeholder="What clicked? What is still unclear? What will you try next?">${esc(p.notes)}</textarea></label></section><section class="agent-section"><div><h3>Bring your AI tutor</h3><p>Copy this brief into your existing agent. It includes your current notes.</p></div><button id="tutor">Copy tutor prompt</button></section><textarea id="prompt-fallback" aria-label="Tutor prompt to copy" hidden readonly></textarea><button class="primary" id="save-module">Save progress</button>`;
 $('#status').value=p.status;
 $('#status').onchange=()=>{const targetControl=$('#status');const target=editable(m);if(targetControl.value==='complete'&&(!target.tasks.every(Boolean)||!target.evidence.trim())){notice('Complete the tasks and add evidence before marking this module complete.',true);targetControl.value=target.status;return;} target.status=/** @type {ModuleProgress['status']} */(targetControl.value);changed();navigation();};
 $('#study-hours').onchange=()=>{const targetControl=$('#study-hours');const n=Number(targetControl.value);if(!Number.isFinite(n)||n<0||n>10000){targetControl.value=String(progress(m).hours);notice('Enter study hours between 0 and 10000.',true);return;}editable(m).hours=n;changed();stats();};
 /** @type {NodeListOf<HTMLInputElement>} */(document.querySelectorAll('[data-task]')).forEach(el=>el.onchange=()=>{const p=editable(m);p.tasks[Number(el.dataset.task)]=el.checked;if(p.status==='not-started'||p.status==='complete'&&!el.checked)p.status='active';$('#status').value=p.status;changed();navigation();});
 for(const key of /** @type {const} */(['notes','evidence']))/** @type {HTMLTextAreaElement} */($('#'+key)).oninput=()=>{const field=/** @type {HTMLTextAreaElement} */($('#'+key));const p=editable(m);p[key]=field.value;if(p.status==='complete'&&!p.evidence.trim()){p.status='active';$('#status').value=p.status;navigation();}changed();};
 $('#save-module').onclick=async()=>{if(await save())notice('Your progress is saved on this computer.');};
 $('#tutor').onclick=async()=>{
  const p=progress(m);
  const prompt=`Act as my tutor for ${course.title}. Module: ${m.title}.\nGoal: ${m.outcome}\nConcepts: ${m.math}\nTask: ${m.tasks.find((_,i)=>!p.tasks[i])||m.challenge}\nMy notes: ${p.notes||'None yet.'}\nEvidence: ${p.evidence||'None yet.'}\nI am an experienced software engineer learning through applied projects. Ask what I predict before showing code. Give one small hint at a time. Ask me to calculate or implement a small example myself. Explain notation through the project. Help me test claims and inspect errors. Do not treat generated code as proof of my understanding. End with this independent challenge: ${m.challenge}`;
  try{await navigator.clipboard.writeText(prompt);notice('Tutor prompt copied. Paste it into your agent.');}catch{const field=$('#prompt-fallback');field.hidden=false;field.value=prompt;field.select();notice('Select and copy the tutor prompt below.');}
 };
}
function experiments(){
 if(accountInvalidated)return;
 $('#experiment-module').innerHTML=course.modules.map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
 restoreDraft();
 $('#experiment-list').innerHTML=state.experiments.length?state.experiments.slice().reverse().map(e=>`<article class="journal-entry"><div class="detail-top"><span>${esc(e.date)} · ${esc(moduleById(e.module).title)}</span><button data-edit="${esc(e.id)}">Edit experiment</button></div><h3>${esc(e.title)}</h3><p class="eyebrow">HYPOTHESIS & SETUP</p><p class="preserve">${esc(e.hypothesis)}</p><p class="eyebrow">RESULTS & NEXT STEP</p><p class="preserve">${esc(e.result||'Planned. Add results after the experiment.')}</p></article>`).join(''):'<div class="empty"><h3>Your first question belongs here.</h3><p>Record a hypothesis above before you train a model. Failed experiments count as learning.</p></div>';
 /** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-edit]')).forEach(b=>b.onclick=()=>{const e=state.experiments.find(x=>x.id===b.dataset.edit);if(!e)return;record.draft.experiment={...e};restoreDraft();changed();$('#experiment-form').scrollIntoView({behavior:'instant'});});
}
function guide(){
 if(accountInvalidated)return;
 $('#guide-view').innerHTML=`<p class="eyebrow">A REUSABLE HOME FOR YOUR LEARNING</p><h2>Your approach</h2><p>This plan is a working path, not a degree or an employment guarantee. Use independent work as the measure of progress.</p><div class="form-grid"><label>Start date<input id="start-date" type="date" value="${esc(state.startDate)}"></label><label>Planned hours per week<input id="weekly-hours" type="number" min="1" max="40" value="${state.weeklyHours}"></label></div><p>The course contains ${course.modules.reduce((a,m)=>a+m.hours,0)} estimated study hours. At your current pace, that is about ${Math.ceil(course.modules.reduce((a,m)=>a+m.hours,0)/state.weeklyHours)} weeks. Module week labels describe the original plan.</p><h3>Build → explain → test → reflect</h3><p>Use an agent to explore an idea, inspect an error, or critique your explanation. Predict outputs first. Complete the independent challenge yourself.</p><p>For the soccer course, reserve roughly 6 hours for building, 3 hours for mathematics, and 2 hours for review each week. Use extra time for weak foundations before adding more model types.</p><h3>New topics belong here too</h3><p>Download the curriculum template. Give it to your agent with a topic, starting skills, and time budget. Import the completed JSON file with a unique curriculum ID. Each curriculum keeps its own notes, hours, experiments, and progress.</p><button id="export-course">Export this curriculum</button><h3>Keep a portable copy</h3><p>Export progress regularly. A progress backup includes this curriculum and its learning records. Import the curriculum on a new installation before restoring its progress. The server also keeps the previous saved state on this computer.</p><h3>Next six months</h3>${(course.nextPhase||['Choose your next topic after reviewing the evidence from this course.']).map(x=>`<p>${esc(x)}</p>`).join('')}<p class="muted">Sources reviewed: ${esc(course.researchDate||'Not specified')}. The hub works locally. External readings require internet access. Tutor prompts use your existing agent; this application does not make AI API calls.</p>`;
 $('#start-date').onchange=()=>{state.startDate=$('#start-date').value;changed();};
 $('#weekly-hours').onchange=()=>{const field=$('#weekly-hours');const n=Number(field.value);if(n<1||n>40||!Number.isFinite(n)){field.value=String(state.weeklyHours);return;}state.weeklyHours=n;changed();stats();guide();};
 $('#export-course').onclick=()=>download(course,course.id+'-curriculum.json');
}
/** @param {unknown} value @param {string} name */
function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function render(){
 if(accountInvalidated)return;
 $('#experiment-form').hidden=false;
 $('#plan-title').textContent=course.title;$('#plan-subtitle').textContent=course.subtitle;$('#plan-description').textContent=course.description;$('#module-count').textContent=course.modules.length+' FIELD NOTES';
 $('#curriculum-select').value=record.recordId; navigation();detail();experiments();guide();
}
/** @param {string} id @param {boolean} [ignoreRecovery] */
async function loadCourse(id,ignoreRecovery=false){
 const next=library.find(item=>item.recordId===id||item.origin.kind==='local'&&item.curriculumId===id);
 if(!next)throw Error('Unknown learning record.');
 const epoch=viewEpoch;
 const serverRecord=await recordRequest('/api/records/'+next.recordId+scopeQuery());
 if(epoch!==viewEpoch)throw Error('The account changed while this record was loading.');
 if(!ignoreRecovery&&!accountInvalidated&&(dirty||saving))throw Error('Your work changed while the record was loading. Save it before switching.');
 record=serverRecord;accountInvalidated=false; dirty=false; recoveryConflict=false; clearTimeout(timer);
 let recovered=false;
 if(!ignoreRecovery)try {
  const raw=memoryRecovery.get(recoveryKey())||localStorage.getItem(recoveryKey());
  if(raw){const pending=JSON.parse(raw);if(pending.version===1&&usableRecovery(pending.record,serverRecord)){
   record=pending.record; dirty=true; recovered=true; recoveryConflict=pending.baseRevision!==serverRecord.state.revision;
  }else notice('A device recovery copy could not be read. The saved record is shown.',true);}
 }catch { recoveryAvailable=false; }
 course=record.curriculum; state=record.state; selected=record.view.selectedModuleId;
 if(record.origin.kind==='local')lastLocalRecordId=record.recordId;
 render();for(const id of ['export','restore','import','curriculum-select','add-curriculum','template'])/** @type {HTMLInputElement | HTMLSelectElement | HTMLButtonElement} */($('#'+id)).disabled=false;
 $('#retry').hidden=!recoveryConflict; $('#retry').textContent=recoveryConflict?'Use saved version':'Retry save';
 $('#save-state').textContent=recoveryConflict?'Recovery conflict':recovered?'Unsaved changes':'Saved on this computer';
 if(recoveryConflict)notice('This device has unsaved work based on an older version. Export progress to keep this working copy, then choose Use saved version. Nothing will overwrite the newer saved record.',true);
 else if(recovered){notice('Recovered your unsaved work from this device. Saving locally…');timer=setTimeout(save,500);}
 else notice('Ready. Your progress saves locally as you work.');
 try{localStorage.setItem('touchline-course',record.recordId);}catch{ /* The server record does not depend on browser storage. */ }
}
$('#retry').onclick=async()=>{
 if(!recoveryConflict){await save();return;}
 if(!confirm('Discard the recovered working copy and load the newer saved version? Export progress first if you want to keep this copy.'))return;
 try{clearJournal();await loadCourse(record.recordId,true);}catch(error){notice(message(error)+' Your current working copy is still available for export. Retry loading the saved version.',true);}
};
$('#restore').onclick=()=>$('#import').click();
$('#export').onclick=()=>download(record,course.id+'-progress.json');
$('#import').onchange=async()=>{
 const field=$('#import');const file=field.files?.[0];if(!file)return;
 const epoch=viewEpoch,targetId=record.recordId;
 const checkTarget=()=>{requireEpoch(epoch);if(accountInvalidated||record.recordId!==targetId)throw Error('The selected record changed. Select the intended record and restore again.');};
 try{
  if(file.size>2000000)throw Error('Backup must be smaller than 2 MB.');
  const backup=JSON.parse(await file.text());checkTarget();
  if(!backup||typeof backup!=='object'||Array.isArray(backup))throw Error('Expected a progress backup.');
  if(backup.format==='touchline-record'){if(backup.version!==2)throw Error('Unsupported record backup version. Use a version 2 record backup.');}
  else if(backup.format!==undefined&&backup.format!=='touchline-backup'||backup.recordId!==undefined)throw Error('Unsupported backup format.');
  else if(backup.format==='touchline-backup'&&backup.version!==undefined&&backup.version!==1)throw Error('Unsupported legacy backup version.');
  const incoming=backup.state||backup;
  if(incoming.curriculumId!==course.id)throw Error('Switch to the matching curriculum before restoring this backup.');
  if(!confirm('Replace progress for this curriculum with this backup? The previous saved progress will remain in the local backup file.'))return;
  if(!(await save()))return;checkTarget();
  const replacement=structuredClone(record); replacement.state=incoming;replacement.state.revision=state.revision;
  if(backup.format==='touchline-record'&&backup.version===2){replacement.view=backup.view;replacement.draft=backup.draft;replacement.status=backup.status;}
  else {replacement.draft={experiment:null};}
  await recordRequest('/api/records/'+targetId+scopeQuery(),{expectedRevision:state.revision,record:replacement});checkTarget();
  await loadCourse(targetId);checkTarget();notice('Backup restored.');
 }catch(error){notice(message(error),true);}finally{field.value='';}
};
$('#add-curriculum').onclick=()=>$('#curriculum-file').click();
$('#curriculum-file').onchange=async()=>{const field=$('#curriculum-file');const file=field.files?.[0];if(!file)return;try{if(file.size>2000000)throw Error('Curriculum must be smaller than 2 MB.');const input=JSON.parse(await file.text());const c=await request('/api/curricula',input.curriculum||input);curricula.push(c);await refreshLibrary();populateCourses();notice('Curriculum imported. Select it from Your curricula.');}catch(error){notice(message(error),true);}finally{field.value='';}};
$('#template').onclick=()=>download({id:'my-new-topic',version:1,title:'My new topic',subtitle:'MY LEARNING PLAN',description:'Replace this with your learning goal.',weeks:2,weeklyHours:5,resources:{reference:{title:'Example resource: replace this',url:'https://example.com',use:'Explain which section to use.'}},modules:[{id:'intro',title:'First project',phase:'Foundations',question:'What will you investigate?',outcome:'Describe the artifact you will build.',math:'Describe the concepts you will learn. This field can cover any subject.',tasks:['Build a small example.','Explain your result independently.','Record evidence and reflect.'],weeks:['Week 1: Explore and build.','Week 2: Test and explain.'],evidence:'Describe the evidence required for completion.',challenge:'Describe an independent task.',resources:['reference'],reading:'Name the relevant sections.',dataset:'Describe data or materials. Use Not applicable if none are needed.',hours:10,weekStart:1,weekEnd:2,prerequisites:[]}],nextPhase:['Choose a follow-on topic.']},'curriculum-template.json');
async function refreshLibrary() {
 const epoch=viewEpoch;
 const response=await fetch('/api/library'+scopeQuery());requireEpoch(epoch);const value=await response.json();requireEpoch(epoch);if(!response.ok)throw Error(value.error||'Could not load your library.');
 library=value.records;
}
function populateCourses(){
 $('#curriculum-select').innerHTML=library.map(item=>`<option value="${esc(item.recordId)}">${esc(item.title)}${item.origin.kind==='cloud'?' · Cloud copy':''}</option>`).join('');
 if(record)$('#curriculum-select').value=record.recordId;
}
$('#curriculum-select').onchange=async()=>{const field=$('#curriculum-select');const id=field.value;field.disabled=true;try{if(!(await save())){field.value=record.recordId;return;}await loadCourse(id);}catch(error){notice(message(error),true);field.value=record.recordId;}finally{field.disabled=false;}};
$('#experiment-form').oninput=captureDraft;
$('#experiment-module').onchange=captureDraft;
$('#experiment-form').onsubmit=e=>{
 e.preventDefault();if(accountInvalidated)return;const f=$('#experiment-form');
 const entry={id:editing||crypto.randomUUID(),date:record.draft.experiment?.date||new Date().toISOString().slice(0,10),module:f.elements.module.value,title:f.elements.title.value.trim(),hypothesis:f.elements.hypothesis.value.trim(),result:f.elements.result.value.trim()};
 if(!entry.title)return;
 if(editing){const index=state.experiments.findIndex(x=>x.id===editing);if(index<0){notice('The experiment being edited no longer exists. Export your draft before restoring the saved record.',true);return;}entry.date=state.experiments[index].date;state.experiments[index]=entry;}else state.experiments.push(entry);
 record.draft.experiment=null;editing=null;f.reset();changed();experiments();stats();notice('Experiment recorded. Saving locally…');
};
/** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-view]')).forEach(b=>b.onclick=()=>{/** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-view]')).forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});for(const v of ['curriculum','experiments','guide','sync'])$('#'+v+'-view').hidden=v!==b.dataset.view;if(b.dataset.view==='guide')guide();if(b.dataset.view==='curriculum')detail();});
window.addEventListener('beforeunload',e=>{if(dirty||saving||volatileRecovery.size){e.preventDefault();e.returnValue='';}});
const ready=(async()=>{try{
 curricula=await request('/api/curricula');await refreshLibrary();populateCourses();let id;
 try{id=localStorage.getItem('touchline-course');}catch{ /* Local selection is optional. */ }
 await loadCourse(id&&library.some(item=>item.recordId===id||item.origin.kind==='local'&&item.curriculumId===id)?id:library[0].recordId);
 for(const id of ['export','restore','import','curriculum-select','add-curriculum','template'])/** @type {HTMLInputElement | HTMLSelectElement | HTMLButtonElement} */($('#'+id)).disabled=false;
 return true;
}catch(error){notice(message(error)+' Reload the page to retry.',true);return false;}})();

window.touchline = {
 snapshot: async () => { const epoch=viewEpoch;if(!(await ready))throw Error('The local library is not ready.');requireEpoch(epoch); if(!(await save())) throw Error('Save local changes before publishing.');requireEpoch(epoch); return JSON.parse(JSON.stringify({curriculum:course,state})); },
 invalidateAccountScope: async () => {
  if(!(await ready))return;
  if(dirty||saving)journal();
  const oldSave=saving;
  viewEpoch++;const epoch=viewEpoch;accountInvalidated=true;accountScope=null;clearTimeout(timer);dirty=false;recoveryConflict=false;
  library=[];populateCourses();
  for(const selector of ['#modules','#module-detail','#experiment-list','#experiment-module','#guide-view'])$(selector).replaceChildren();
  $('#experiment-form').reset();$('#experiment-form').hidden=true;editing=null;
  $('#plan-title').textContent='Your local learning library';$('#plan-subtitle').textContent='';$('#plan-description').textContent='';$('#module-count').textContent='';
  for(const selector of ['#completed','#hours','#experiments-count','#duration','#pace'])$(selector).textContent='';
  $('#retry').hidden=true;
  for(const id of ['export','restore','import','curriculum-select','add-curriculum','template'])/** @type {HTMLInputElement | HTMLSelectElement | HTMLButtonElement} */($('#'+id)).disabled=true;
  notice('The account session ended. Cloud work is hidden while your local library loads.');
  try{
   // An already-started write may finish, but cannot update this new view.
   if(oldSave)await oldSave;requireEpoch(epoch);
   await refreshLibrary();requireEpoch(epoch);populateCourses();
   const next=library.find(item=>item.recordId===lastLocalRecordId)||library[0];
   if(!next)throw Error('No local learning record is available.');
   await loadCourse(next.recordId);requireEpoch(epoch);
   if(volatileRecovery.size)notice('Cloud work is hidden and held in this page only. Keep the page open and sign in again to recover or export it.',true);
  }catch(error){if(epoch!==viewEpoch)return;notice('Cloud work remains hidden. '+message(error)+' Reload to retry your local library.',true);}
 },
 setAccountScope: async origin => {
  const epoch=viewEpoch;
  if(!(await ready))throw Error('The local library is not ready.');
  requireEpoch(epoch);
  if(!accountInvalidated&&!(await save()))throw Error('Save or export local changes before changing accounts.');
  requireEpoch(epoch);
  const previousScope=accountScope,previousLibrary=library;accountScope=origin;
  try{await refreshLibrary();requireEpoch(epoch);
  populateCourses();
  const next=library.find(item=>item.recordId===record.recordId)||library.find(item=>item.recordId===lastLocalRecordId&&item.origin.kind==='local')||library.find(item=>item.origin.kind==='local');
  if(!next)throw Error('No local learning record is available.');
  await loadCourse(next.recordId);requireEpoch(epoch);
  }catch(error){if(epoch===viewEpoch){accountScope=previousScope;library=previousLibrary;populateCourses();}throw error;}
 },
 importCloud: async (backup,origin) => {
  const epoch=viewEpoch;
  if(!(await ready))throw Error('The local library is not ready.');
  requireEpoch(epoch);
  if(!origin)throw Error('Sign in before importing a cloud record.');
  if(!(await save()))throw Error('Save or export local changes first.');
  requireEpoch(epoch);
  if(JSON.stringify(accountScope)!==JSON.stringify(origin))await window.touchline.setAccountScope(origin);
  requireEpoch(epoch);await refreshLibrary();requireEpoch(epoch);
  const existing=library.find(item=>item.origin.kind==='cloud'&&item.curriculumId===backup.curriculum.id);
  if(existing&&!confirm('Replace this account’s downloaded cloud copy with the latest published version? Export progress first to keep local changes.'))return false;
  const imported=await recordRequest('/api/import'+scopeQuery(),{source:backup,origin,status:'active',...(existing?{targetRecordId:existing.recordId,expectedRevision:existing.revision}:{})},'POST');
  requireEpoch(epoch);await refreshLibrary();requireEpoch(epoch);populateCourses();await loadCourse(imported.recordId);requireEpoch(epoch);return true;
 },
 download
};
