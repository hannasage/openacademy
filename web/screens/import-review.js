/** @param {unknown} value @param {LocalRecord} [target] @returns {LearningBackup|LocalRecord} */
export function prepareImport(value,target){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected a curriculum or progress backup.');
 const input=/** @type {Record<string,any>} */(value);
 if(input.format==='touchline-record'){
  if(input.version!==2)throw Error('Unsupported record backup version. Use a version 2 record backup.');
  return /** @type {LocalRecord} */(input);
 }
 if(input.format!==undefined&&input.format!=='touchline-backup'||input.recordId!==undefined)throw Error('Unsupported backup format.');
 if(input.format==='touchline-backup'&&input.version!==undefined&&input.version!==1)throw Error('Unsupported legacy backup version.');
 if(input.curriculum&&input.state){const {version,...source}=input;void version;return /** @type {LearningBackup} */(source);}
 if(target&&input.curriculumId){
  if(input.curriculumId!==target.curriculum.id)throw Error('Switch to the matching curriculum before restoring this backup.');
  return {curriculum:target.curriculum,state:/** @type {LearningState} */(input)};
 }
 const course=/** @type {Curriculum} */(input.curriculum||input);
 if(!course.id)throw Error('Expected a curriculum with an ID.');
 return {curriculum:course,state:{version:1,revision:0,curriculumId:course.id,weeklyHours:course.weeklyHours,startDate:'',modules:{},experiments:[]}};
}
/** @param {unknown} value */
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]||c));
/** @param {HTMLDialogElement} dialog @param {{source:LocalRecord,restore:boolean,filename:string,onCommit:(status:LibraryStatus)=>Promise<void>,onCancel?:()=>void}} options */
export function reviewImport(dialog,{source,restore,filename,onCommit,onCancel}){
 const previous=document.activeElement;
 dialog.innerHTML=`<div class="import-heading"><h1 id="import-title">${restore?'Restore this backup':'Follow a new curiosity.'}</h1><button type="button" data-close aria-label="Close import review">Close</button></div><p>${restore?'Review the backup before replacing this curriculum’s content and learning records.':'Add a curriculum to your library. Each plan keeps its own progress and experiments.'}</p><div class="import-grid"><section class="learning-card"><h2>${escape(source.curriculum.title)}</h2><p class="learning-metrics">${source.curriculum.weeks} weeks · ${source.curriculum.modules.length} modules · ${escape(filename)}</p><ol>${source.curriculum.modules.slice(0,4).map(module=>`<li>${escape(module.title)}</li>`).join('')}</ol>${source.curriculum.modules.length>4?`<details><summary>Show ${source.curriculum.modules.length-4} more modules</summary><ol start="5">${source.curriculum.modules.slice(4).map(module=>`<li>${escape(module.title)}</li>`).join('')}</ol></details>`:''}<p>${source.state.experiments.length} experiments · ${source.draft.experiment?'Includes an unfinished experiment':'No unfinished experiment'}</p></section><section class="learning-card"><h2>${restore?'Keep a recovery copy':'Progress stays separate'}</h2><p>${restore?'Export the current record before replacing it. The previous saved record also remains in the local backup file.':'Your current curriculum and focus stay unchanged. Starting another plan does not pause your focus.'}</p>${restore?'':`<fieldset><legend>How would you like to start?</legend><label><input type="radio" name="import-status" value="saved" checked> Save for later</label><label><input type="radio" name="import-status" value="active"> Start now as another active curriculum</label></fieldset>`}<p>Everything stays on this computer until you publish it.</p></section></div><p id="import-error" role="alert" hidden></p><div class="learning-actions">${restore?'<button type="button" id="export-before-restore">Export current record</button>':''}<button type="button" class="primary" id="confirm-import">${restore?'Replace this curriculum from backup':'Add to my library'}</button><button type="button" data-close>Cancel</button></div>`;
 let busy=false;
 const close=()=>{if(busy)return;dialog.close();onCancel?.();if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};
 dialog.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',close));
 dialog.oncancel=event=>{event.preventDefault();close();};
 const confirm=/** @type {HTMLButtonElement} */(dialog.querySelector('#confirm-import'));
 confirm.onclick=async()=>{
  if(busy)return;busy=true;dialog.querySelectorAll('button,input').forEach(control=>{/** @type {HTMLButtonElement} */(control).disabled=true;});
  const error=/** @type {HTMLElement} */(dialog.querySelector('#import-error'));error.hidden=true;
  try{
   const status=restore?source.status:/** @type {LibraryStatus} */(/** @type {HTMLInputElement} */(dialog.querySelector('[name=import-status]:checked')).value);
   await onCommit(status);busy=false;close();
  }catch(problem){error.textContent=problem instanceof Error?problem.message:String(problem);error.hidden=false;busy=false;dialog.querySelectorAll('button,input').forEach(control=>{/** @type {HTMLButtonElement} */(control).disabled=false;});}
 };
 dialog.showModal();
 return close;
}
