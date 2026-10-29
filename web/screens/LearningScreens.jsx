import {useState,useSyncExternalStore} from 'react';
import {Button,Badge,Progress} from '@hannasage/projection-ui/core';
import {screens,summarizeRecord,focusRecord} from './model.js';
import {shell} from '../shell/bridge.js';

const labels={active:'Active',paused:'Paused',completed:'Completed',saved:'Saved for later'};
/** @param {{record:LocalRecord}} props */
function Metrics({record}) {
 const value=summarizeRecord(record);
 return <p className="learning-metrics">{value.done} / {value.total} modules complete · {value.hours} hours logged · {value.experiments} experiments</p>;
}
/** @param {{record:LocalRecord,focus:boolean,busy:boolean}} props */
function CourseCard({record,focus,busy}) {
 const value=summarizeRecord(record);
 return <article className="learning-card" data-record-card={record.recordId}>
  <div className="learning-title-row"><h2>{record.curriculum.title}</h2><Badge>{focus?'Current focus':labels[record.status]}</Badge></div>
  <Metrics record={record}/><p>Next: {value.lesson.title}</p>
  <div className="learning-actions">
   <Button variant="primary" disabled={busy} onClick={()=>void screens.open(record.recordId)}>Continue learning</Button>
   {record.status==='active'&&<Button disabled={busy} onClick={()=>void screens.focus(focus?null:record.recordId)}>{focus?'Clear focus':'Make this my focus'}</Button>}
   <label className="course-status">Curriculum status<select value={record.status} disabled={busy} onChange={event=>void screens.status(record.recordId,/** @type {LibraryStatus} */(event.target.value))}>
    {Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}
   </select></label>
  </div>
 </article>;
}
/** @param {{loading:boolean,error:string,busy:boolean}} props */
function Feedback({loading,error,busy}) {
 return <>{loading&&<p role="status">Loading your learning library…</p>}{error&&<div role="alert" className="learning-error"><p>{error}</p><Button disabled={busy} onClick={()=>void screens.refresh()}>Retry library</Button></div>}</>;
}
export function LibraryScreen() {
 const state=useSyncExternalStore(screens.subscribe,screens.getSnapshot);
 const [filter,setFilter]=useState('all');
 const rows=state.rows.filter(row=>filter==='all'||row.summary.status===filter);
 return <div className="learning-screen">
  <h1>Room for more than one curiosity.</h1><p className="learning-intro">Choose one focus for your home screen. Every curriculum keeps its own next lesson, notes, and experiments.</p>
  <div className="learning-actions library-filters" aria-label="Filter curricula">
   {Object.entries({all:'All',...labels}).map(([key,label])=><Button key={key} variant="ghost" aria-pressed={filter===key} onClick={()=>setFilter(key)}>{label} · {state.rows.filter(row=>key==='all'||row.summary.status===key).length}</Button>)}
   <Button disabled={state.busy||state.loading} onClick={screens.import}>Import curriculum</Button>
  </div>
  <Feedback {...state}/>
  {!state.loading&&rows.length===0&&<div className="learning-card"><h2>{state.rows.length?'No curricula in this group.':'Your next topic starts here.'}</h2><p>{state.rows.length?'Choose another group to return to your learning.':'Import a curriculum to start learning. Each plan keeps its own progress.'}</p><Button onClick={screens.import}>Import curriculum</Button></div>}
  {rows.map(row=>row.record?<CourseCard key={row.summary.recordId} record={row.record} focus={state.focusRecordId===row.summary.recordId} busy={state.busy}/>:<article className="learning-card" key={row.summary.recordId} data-record-card={row.summary.recordId}><h2>{row.summary.title}</h2><p>This curriculum is unavailable. Your saved files remain unchanged.</p></article>)}
  <div className="learning-card learning-guidance"><h2>Keep the plan realistic</h2><p>One focus helps you make progress. Other active curricula stay available, and changing focus never pauses another plan.</p></div>
 </div>;
}
export function HomeScreen() {
 const state=useSyncExternalStore(screens.subscribe,screens.getSnapshot);
 const records=state.rows.flatMap(row=>row.record?[row.record]:[]);
 const focus=focusRecord(records,state.focusRecordId),value=focus?summarizeRecord(focus):null;
 const others=records.filter(record=>record.status==='active'&&record.recordId!==focus?.recordId);
 const latest=focus?.state.experiments.at(-1);
 return <div className="learning-screen">
  <div className="learning-title-row"><h1>Make room for your next idea.</h1><Button disabled={state.loading||state.busy} onClick={screens.import}>Import curriculum</Button></div>
  <p className="learning-intro">One focus helps you make progress. Keep other curricula active and switch whenever you need.</p>
  <Feedback {...state}/>
  {!state.loading&&<div className="home-grid">
   <article className="learning-card focus-card">
    {focus&&value?<><div className="learning-title-row"><h2>{focus.curriculum.title}</h2><Badge>Current focus</Badge></div><p>{focus.curriculum.weeks} weeks · {focus.state.weeklyHours} hours per week planned</p><p>{focus.curriculum.description}</p><Progress label="Focused curriculum progress" value={value.done} max={value.total}/><Metrics record={focus}/><Button variant="primary" disabled={state.busy} onClick={()=>void screens.open(focus.recordId)}>Continue: {value.lesson.title}</Button></>:<><h2>Choose where to put your attention.</h2><p>You can keep several curricula active. Choose one focus when you want a clear place to return.</p><Button variant="primary" onClick={()=>void shell.navigate('library')}>Choose a focus</Button></>}
   </article>
   <article className="learning-card"><h2>Your next session</h2>{focus&&value?<><h3>{value.lesson.title}</h3><p>{value.lesson.question}</p><p>{value.lesson.tasks.find((_,index)=>!focus.state.modules[value.lesson.id]?.tasks[index])||value.lesson.challenge}</p><p className="learning-metrics">{value.lesson.hours} hours planned for this module</p></>:<p>Your focused curriculum will show a question and a task here.</p>}</article>
   <article className="learning-card"><h2>Latest experiment</h2><p>{latest?.title||'Start with a question you can test.'}</p><p className="learning-metrics">{latest?(latest.result?'Results recorded':'Hypothesis recorded'):'Keep hypotheses and results in your experiment journal.'}</p>{focus&&<Button disabled={state.busy} onClick={async()=>{await screens.open(focus.recordId);if(!screens.getSnapshot().error&&shell.getSnapshot().view==='curriculum')await shell.navigate('experiments');}}>Open experiment journal</Button>}</article>
   <article className="learning-card"><h2>Also in progress</h2>{others.length?others.map(record=><div key={record.recordId}><h3>{record.curriculum.title}</h3><Metrics record={record}/></div>):<p>Your other active curricula will appear here.</p>}<Button onClick={()=>void shell.navigate('library')}>Browse all curricula · {state.rows.length}</Button></article>
  </div>}
 </div>;
}
