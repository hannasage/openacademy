/** @param {unknown} value */
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] || c));
/** Keep evidence inside the portable result field. @param {string} text */
export function evidenceLinks(text) {
 return [...new Set(text.match(/https?:\/\/[^\s<>"']+/g)||[])].filter(raw=>{
  try{const url=new URL(raw);return !url.username&&!url.password;}catch{return false;}
 });
}
/** @param {Curriculum} course @param {Experiment[]} entries @param {string|null} selected */
export function journalList(course,entries,selected){
 /** @param {string} id */
 const title=id=>course.modules.find(module=>module.id===id)?.title||'Unknown lesson';
 return `<h2>${entries.length} ${entries.length===1?'experiment':'experiments'}</h2>${entries.length?entries.slice().reverse().map(entry=>`<article class="journal-entry"><button type="button" data-edit="${escape(entry.id)}" aria-pressed="${entry.id===selected}"><strong>${escape(entry.title)}</strong><span>${entry.result.trim()?'Results recorded':'Planned'} · ${escape(title(entry.module))}</span><span>${escape(entry.date)}</span><span class="sr-only">Edit experiment</span></button></article>`).join(''):'<p>Your first question belongs here. Record a hypothesis before you train a model.</p>'}<button type="button" id="new-experiment">New experiment</button>`;
}
/** @param {string} text */
export function evidenceMarkup(text){return evidenceLinks(text).map((url,index)=>`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Open evidence ${index+1}<span class="sr-only"> in a new tab</span> ↗</a>`).join('');}
