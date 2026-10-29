import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Button as ProjectionButton} from '@hannasage/projection-ui/core';
import {connection} from '../connection/instance.js';
import './publications.css';
/** @param {import('react').ComponentProps<typeof ProjectionButton>} props */
function Button(props){return <ProjectionButton size="lg" type="button" {...props}/>;}
const publications=connection.publications;
/** @param {string} value */
const dateLabel=value=>new Date(value).toLocaleString();
function ConflictReview(){
 const state=useSyncExternalStore(publications.subscribe,publications.getSnapshot);
 const dialog=useRef(/** @type {HTMLDialogElement|null} */(null));
 const opener=useRef(/** @type {HTMLButtonElement|null} */(null)),opened=useRef(false);
 useEffect(()=>{
  const remember=/** @param {MouseEvent} event */event=>{if(!dialog.current?.open&&event.target instanceof Element){const button=event.target.closest('button');if(button)opener.current=button;}};
  document.addEventListener('click',remember,true);return()=>document.removeEventListener('click',remember,true);
 },[]);
 useEffect(()=>{
  if(state.review){dialog.current?.showModal();opened.current=true;}
  else {dialog.current?.close();if(opened.current&&!state.busy){if(opener.current?.isConnected&&!opener.current.disabled)opener.current.focus();opened.current=false;}}
 },[state.review,state.busy]);
 const review=state.review;
 return <dialog ref={dialog} className="publication-review" aria-labelledby="publication-review-title" onCancel={event=>{event.preventDefault();if(!state.busy)publications.cancelReview();}}>
  {review&&<div className="publication-review-body"><h2 id="publication-review-title">{review.recordId?'A newer snapshot is online.':'Download a published snapshot.'}</h2>
   <p>Review {review.snapshot.curriculum.title} before downloading. Other curricula keep their own progress.</p>
   <div className="publication-comparison"><p>Local · {review.local?`${review.local.state.experiments.length} experiments · Revision ${review.local.state.revision}`:'No downloaded copy for this account'}</p><p>Cloud · {review.snapshot.progress.experiments.length} experiments · Published {dateLabel(review.snapshot.publishedAt)}</p></div>
   {review.local&&<Button disabled={state.busy} onClick={()=>publications.exportReview()}>Export my local backup</Button>}
   <Button variant="primary" disabled={state.busy} onClick={()=>void publications.downloadReviewed()}>Download cloud version</Button>
   <p>{review.local?'Downloading replaces this curriculum and its progress. Your unfinished draft and selected lesson stay here. Export a backup first to keep the current progress.':'This creates a separate copy for this hub and account. Existing local curricula stay unchanged.'}</p>
   {state.error&&<p role="alert">{state.message}</p>}
   <Button disabled={state.busy} onClick={()=>publications.cancelReview()}>Cancel and keep working</Button>
  </div>}
 </dialog>;
}
export function PublicationScreen(){
 const state=useSyncExternalStore(publications.subscribe,publications.getSnapshot);
 const [selected,setSelected]=useState(/** @type {string[]} */([]));
 useEffect(()=>{void publications.refresh();},[]);
 const selectedIds=selected.filter(id=>state.records.some(record=>record.recordId===id));
 return <section className="publication-screen">
  {state.complete?<section className="publication-success"><h3>Ready for your next device.</h3><p>Your selected curricula, progress, notes and recorded experiments are saved to your private backend.</p><p>On iPhone or iPad, open Library and refresh to download these snapshots. Reading remains available offline after download.</p><Button variant="primary" onClick={()=>publications.update({complete:false})}>Back to Devices</Button></section>:null}
  <section className="connection-card publication-selection" aria-labelledby="publication-title"><h3 id="publication-title">Choose what to publish</h3><p>Your current focus does not limit what you can publish. New edits and unfinished drafts stay on this computer.</p>
   <div className="publication-records">{state.records.map(record=>{
    const result=state.results.find(item=>item.recordId===record.recordId);
    const completed=Object.values(record.state.modules).filter(module=>module.status==='complete').length;
    return <article className="publication-record" key={record.recordId} data-publication-record={record.recordId}>
     <label className="publication-choice"><input type="checkbox" disabled={state.busy} checked={selectedIds.includes(record.recordId)} onChange={event=>setSelected(values=>event.target.checked?[...values,record.recordId]:values.filter(id=>id!==record.recordId))}/><span>{record.curriculum.title}</span></label>
     <p>{record.recordId===state.focusRecordId?'Current focus':record.status.charAt(0).toUpperCase()+record.status.slice(1)} · {completed} / {record.curriculum.modules.length} modules · {record.origin.kind==='local'?'Local curriculum':'Downloaded copy'} · {state.labels[record.recordId]??'Local changes'}</p>
     {result&&<div className="publication-result" role="status"><strong>{result.status==='published'?'Published':result.status==='conflict'?'Review needed':result.status==='failed'?'Not published':'Publishing…'}</strong><p>{result.message}</p>
      {result.status==='failed'&&<Button disabled={state.busy} onClick={()=>void publications.retry(record.recordId)}>Retry {record.curriculum.title}</Button>}
      {result.status==='conflict'&&<Button disabled={state.busy} onClick={()=>void publications.review(record.curriculum.id,record.recordId)}>Review {record.curriculum.title}</Button>}
     </div>}
    </article>;
   })}</div>
   {!state.records.length&&<p>{state.busy?'Loading your curricula…':'No curricula are ready. Refresh after opening your local library.'}</p>}
   <div className="connection-actions"><Button id="cloud-upload" variant="primary" disabled={state.busy||!selectedIds.length} onClick={()=>void publications.publish(selectedIds)}>Publish selected · {selectedIds.length}</Button><Button disabled={state.busy} onClick={()=>void publications.refresh()}>Refresh local curricula</Button></div>
   <p>Each curriculum reports its own result. A conflict in one does not block the others.</p>
   <p className={state.error?'connection-error':''} role="status">{state.message}</p>
  </section>
  <section className="connection-card"><h3>Publish your library focus</h3><p>Course status travels with each selected publication. This action updates only the focus for your other devices; it does not publish curriculum contents.</p><p>The focused curriculum must already be published and active.</p><Button disabled={state.busy} onClick={()=>void publications.reviewFocus()}>Review library focus</Button>{state.libraryReview&&<div className="publication-focus-review"><p>On this computer: {state.libraryReview.localFocus??'No focus'}</p><p>Published focus: {state.libraryReview.cloudFocus??'No focus or interrupted request'}</p><Button disabled={state.busy} onClick={()=>void publications.publishFocus()}>Publish this focus</Button></div>}</section>
  <ConflictReview/>
 </section>;
}
