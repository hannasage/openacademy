'use strict';
export {};
/** @type {Curriculum[]} */ let curricula = [];
/** @type {Curriculum} */ let course;
/** @type {LearningState} */ let state;
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
function changed() { dirty=true; $('#save-state').textContent='Unsaved changes'; clearTimeout(timer); timer=setTimeout(save,500); }
/** @returns {Promise<boolean>} */
async function save() {
 clearTimeout(timer); if(saving) return saving;
 saving=(async()=>{
  while(dirty) {
   dirty=false; $('#save-state').textContent='Saving…';
   try { const response=await request(`/api/state?plan=${encodeURIComponent(course.id)}`, JSON.parse(JSON.stringify(state))); state.revision=response.revision; $('#save-state').textContent='Saved on this computer'; $('#retry').hidden=true; }
   catch(e) { dirty=true; notice(message(e),true); $('#save-state').textContent='Not saved'; $('#retry').hidden=false; return false; }
  }
  return true;
 })();
 const result=await saving; saving=null; return result;
}
function stats() {
 const p=course.modules.map(progress);
 window.updateProjectionProgress?.(p.filter(x=>x.status==='complete').length,p.length);
 $('#completed').textContent=`${p.filter(x=>x.status==='complete').length} / ${p.length}`;
 $('#hours').textContent=`${p.reduce((a,x)=>a+x.hours,0).toFixed(1).replace('.0','')} h`;
 $('#experiments-count').textContent=String(state.experiments.length);
 $('#duration').textContent=`${course.weeks} weeks`;
 $('#pace').textContent=`${state.weeklyHours} hours per week planned`;
}
function navigation() {
 let phase='';
 $('#modules').innerHTML=course.modules.map((m,i)=>{
  const heading=m.phase!==phase?`<p class="phase">${esc(m.phase)}</p>`:''; phase=m.phase;
  const p=progress(m);
  return `${heading}<button class="module ${selected===m.id?'selected':''} ${p.status==='complete'?'done':''}" data-module="${esc(m.id)}" ${selected===m.id?'aria-current="step"':''}><span class="module-number">${p.status==='complete'?'✓':String(i+1).padStart(2,'0')}</span><span>${esc(m.title)}<small>Weeks ${m.weekStart}–${m.weekEnd} · ${p.status==='complete'?'Complete':p.status==='active'?'In progress':m.hours+' h'}</small></span></button>`;
 }).join('');
 $('#modules').querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.module || '';navigation();detail();});
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
 $('#experiment-module').innerHTML=course.modules.map(m=>`<option value="${esc(m.id)}">${esc(m.title)}</option>`).join('');
 $('#experiment-module').value=selected;
 $('#experiment-list').innerHTML=state.experiments.length?state.experiments.slice().reverse().map(e=>`<article class="journal-entry"><div class="detail-top"><span>${esc(e.date)} · ${esc(moduleById(e.module).title)}</span><button data-edit="${esc(e.id)}">Edit experiment</button></div><h3>${esc(e.title)}</h3><p class="eyebrow">HYPOTHESIS & SETUP</p><p class="preserve">${esc(e.hypothesis)}</p><p class="eyebrow">RESULTS & NEXT STEP</p><p class="preserve">${esc(e.result||'Planned. Add results after the experiment.')}</p></article>`).join(''):'<div class="empty"><h3>Your first question belongs here.</h3><p>Record a hypothesis above before you train a model. Failed experiments count as learning.</p></div>';
 /** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-edit]')).forEach(b=>b.onclick=()=>{const e=state.experiments.find(x=>x.id===b.dataset.edit);if(!e)return;editing=e.id;for(const key of /** @type {const} */(['title','module','hypothesis','result']))$('#experiment-form').elements[key].value=e[key];$('#experiment-form button').textContent='Save experiment changes';$('#experiment-form').scrollIntoView({behavior:'instant'});});
}
function guide(){
 $('#guide-view').innerHTML=`<p class="eyebrow">A REUSABLE HOME FOR YOUR LEARNING</p><h2>Your approach</h2><p>This plan is a working path, not a degree or an employment guarantee. Use independent work as the measure of progress.</p><div class="form-grid"><label>Start date<input id="start-date" type="date" value="${esc(state.startDate)}"></label><label>Planned hours per week<input id="weekly-hours" type="number" min="1" max="40" value="${state.weeklyHours}"></label></div><p>The course contains ${course.modules.reduce((a,m)=>a+m.hours,0)} estimated study hours. At your current pace, that is about ${Math.ceil(course.modules.reduce((a,m)=>a+m.hours,0)/state.weeklyHours)} weeks. Module week labels describe the original plan.</p><h3>Build → explain → test → reflect</h3><p>Use an agent to explore an idea, inspect an error, or critique your explanation. Predict outputs first. Complete the independent challenge yourself.</p><p>For the soccer course, reserve roughly 6 hours for building, 3 hours for mathematics, and 2 hours for review each week. Use extra time for weak foundations before adding more model types.</p><h3>New topics belong here too</h3><p>Download the curriculum template. Give it to your agent with a topic, starting skills, and time budget. Import the completed JSON file with a unique curriculum ID. Each curriculum keeps its own notes, hours, experiments, and progress.</p><button id="export-course">Export this curriculum</button><h3>Keep a portable copy</h3><p>Export progress regularly. A progress backup includes this curriculum and its learning records. Import the curriculum on a new installation before restoring its progress. The server also keeps the previous saved state on this computer.</p><h3>Next six months</h3>${(course.nextPhase||['Choose your next topic after reviewing the evidence from this course.']).map(x=>`<p>${esc(x)}</p>`).join('')}<p class="muted">Sources reviewed: ${esc(course.researchDate||'Not specified')}. The hub works locally. External readings require internet access. Tutor prompts use your existing agent; this application does not make AI API calls.</p>`;
 $('#start-date').onchange=()=>{state.startDate=$('#start-date').value;changed();};
 $('#weekly-hours').onchange=()=>{const field=$('#weekly-hours');const n=Number(field.value);if(n<1||n>40||!Number.isFinite(n)){field.value=String(state.weeklyHours);return;}state.weeklyHours=n;changed();stats();guide();};
 $('#export-course').onclick=()=>download(course,course.id+'-curriculum.json');
}
/** @param {unknown} value @param {string} name */
function download(value,name){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function render(){
 $('#plan-title').textContent=course.title;$('#plan-subtitle').textContent=course.subtitle;$('#plan-description').textContent=course.description;$('#module-count').textContent=course.modules.length+' FIELD NOTES';
 $('#curriculum-select').value=course.id; navigation();detail();experiments();guide();
}
/** @param {string} id */
async function loadCourse(id){
 const next=curricula.find(c=>c.id===id);if(!next)throw new Error('Unknown curriculum.');const nextState=await request('/api/state?plan='+encodeURIComponent(id));course=next;state=nextState;
 selected=course.modules.find(m=>progress(m).status==='active')?.id||course.modules.find(m=>progress(m).status!=='complete')?.id||course.modules[0].id;
 dirty=false;editing=null;$('#experiment-form').reset();$('#experiment-form button').textContent='Record experiment';render();notice('Ready. Your progress saves locally as you work.');
 try{localStorage.setItem('touchline-course',id);}catch{ /* Local selection remains usable when storage is unavailable. */ }
}
$('#retry').onclick=save;
$('#restore').onclick=()=>$('#import').click();
$('#export').onclick=()=>download({format:'touchline-backup',curriculum:course,state},course.id+'-progress.json');
$('#import').onchange=async()=>{
 const field=$('#import');const file=field.files?.[0];if(!file)return;
 try{if(file.size>2000000)throw Error('Backup must be smaller than 2 MB.');const backup=JSON.parse(await file.text());const incoming=backup.state||backup;if(incoming.curriculumId!==course.id)throw Error('Switch to the matching curriculum before restoring this backup.');
 if(!confirm('Replace progress for this curriculum with this backup? The previous saved progress will remain in the local backup file.'))return;
 if(!(await save()))return;incoming.revision=state.revision;
 state=await request('/api/state?plan='+encodeURIComponent(course.id),incoming);render();notice('Backup restored.');
 }catch(error){notice(message(error),true);}finally{field.value='';}
};
$('#add-curriculum').onclick=()=>$('#curriculum-file').click();
$('#curriculum-file').onchange=async()=>{const field=$('#curriculum-file');const file=field.files?.[0];if(!file)return;try{if(file.size>2000000)throw Error('Curriculum must be smaller than 2 MB.');const input=JSON.parse(await file.text());const c=await request('/api/curricula',input.curriculum||input);curricula.push(c);populateCourses();notice('Curriculum imported. Select it from Your curricula.');}catch(error){notice(message(error),true);}finally{field.value='';}};
$('#template').onclick=()=>download({id:'my-new-topic',version:1,title:'My new topic',subtitle:'MY LEARNING PLAN',description:'Replace this with your learning goal.',weeks:2,weeklyHours:5,resources:{reference:{title:'Example resource: replace this',url:'https://example.com',use:'Explain which section to use.'}},modules:[{id:'intro',title:'First project',phase:'Foundations',question:'What will you investigate?',outcome:'Describe the artifact you will build.',math:'Describe the concepts you will learn. This field can cover any subject.',tasks:['Build a small example.','Explain your result independently.','Record evidence and reflect.'],weeks:['Week 1: Explore and build.','Week 2: Test and explain.'],evidence:'Describe the evidence required for completion.',challenge:'Describe an independent task.',resources:['reference'],reading:'Name the relevant sections.',dataset:'Describe data or materials. Use Not applicable if none are needed.',hours:10,weekStart:1,weekEnd:2,prerequisites:[]}],nextPhase:['Choose a follow-on topic.']},'curriculum-template.json');
function populateCourses(){$('#curriculum-select').innerHTML=curricula.map(c=>`<option value="${esc(c.id)}">${esc(c.title)}</option>`).join('');if(course)$('#curriculum-select').value=course.id;}
$('#curriculum-select').onchange=async()=>{const field=$('#curriculum-select');const id=field.value;field.disabled=true;try{if(!(await save())){field.value=course.id;return;}await loadCourse(id);}catch(error){notice(message(error),true);field.value=course.id;}finally{field.disabled=false;}};
$('#experiment-form').onsubmit=e=>{e.preventDefault();const f=$('#experiment-form');const entry={id:editing||crypto.randomUUID(),date:new Date().toISOString().slice(0,10),module:f.elements.module.value,title:f.elements.title.value.trim(),hypothesis:f.elements.hypothesis.value.trim(),result:f.elements.result.value.trim()};if(!entry.title)return;if(editing){const index=state.experiments.findIndex(x=>x.id===editing);entry.date=state.experiments[index].date;state.experiments[index]=entry;}else state.experiments.push(entry);editing=null;f.reset();$('#experiment-form button').textContent='Record experiment';changed();experiments();stats();notice('Experiment recorded. Saving locally…');};
/** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-view]')).forEach(b=>b.onclick=()=>{/** @type {NodeListOf<HTMLButtonElement>} */(document.querySelectorAll('[data-view]')).forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',String(x===b));});for(const v of ['curriculum','experiments','guide','sync'])$('#'+v+'-view').hidden=v!==b.dataset.view;if(b.dataset.view==='guide')guide();if(b.dataset.view==='curriculum')detail();});
window.addEventListener('beforeunload',e=>{if(dirty||saving){e.preventDefault();e.returnValue='';}});
(async()=>{try{curricula=await request('/api/curricula');populateCourses();let id;try{id=localStorage.getItem('touchline-course');}catch{ /* Local selection remains usable when storage is unavailable. */ }await loadCourse(id&&curricula.some(c=>c.id===id)?id:curricula[0].id);for(const id of ['export','restore','import','curriculum-select','add-curriculum','template'])/** @type {HTMLInputElement | HTMLSelectElement | HTMLButtonElement} */($('#'+id)).disabled=false;}catch(e){notice(message(e)+' Reload the page to retry.',true);}})();

window.touchline = {
 snapshot: async () => { if(!(await save())) throw Error('Save local changes before publishing.'); return JSON.parse(JSON.stringify({curriculum:course,state})); },
 importCloud: async backup => {
  if(!(await save())) throw Error('Save or export local changes first.');
  let existing=curricula.find(c=>c.id===backup.curriculum.id);
  if(!existing){existing=await request('/api/curricula',backup.curriculum);curricula.push(existing);populateCourses();}
  if(JSON.stringify(existing.modules.map(m=>[m.id,m.tasks]))!==JSON.stringify(backup.curriculum.modules.map(m=>[m.id,m.tasks]))) throw Error('The cloud curriculum has different tasks. Import it under a new curriculum ID before restoring progress.');
  const local=await request('/api/state?plan='+encodeURIComponent(existing.id));
  backup.state.revision=local.revision;
  await request('/api/state?plan='+encodeURIComponent(existing.id),backup.state);
  await loadCourse(existing.id);
 },
 download
};
