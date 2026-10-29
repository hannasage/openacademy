import {projectPublication} from '../publication.js';
const statuses=['active','paused','completed','saved'];
const revision=(/** @type {unknown} */ value)=>Number.isSafeInteger(value)&&Number(value)>=0;
/** Stable equality also rejects unexpected public fields instead of dropping them. @param {unknown} value @returns {string} */
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value);}
/** @param {unknown} value @param {string} id @returns {import('./types').Snapshot} */
export function validateSnapshot(value,id){
 const row=/** @type {Record<string, any>} */(value);
 if(!row||row.format_version!==1||row.id!==id||!revision(row.revision)||!statuses.includes(row.status)||typeof row.updated_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.updated_at)||!Number.isFinite(Date.parse(row.updated_at)))throw Error('The cloud snapshot is invalid. Its original data is unchanged.');
 const backup=projectPublication({curriculum:row.curriculum,state:row.progress});
 if(backup.curriculum.id!==id||canonical(backup.curriculum)!==canonical(row.curriculum)||canonical(backup.state)!==canonical(row.progress))throw Error('The cloud snapshot contains unsupported fields. Its original data is unchanged.');
 return {format:'touchline-snapshot',version:1,curriculum:backup.curriculum,progress:backup.state,status:row.status,revision:row.revision,publishedAt:new Date(row.updated_at).toISOString()};
}
/** Explicit publication only. Local records are never mutated by a cloud write. */
export class PublicationController {
 /** @param {import('./types').Dependencies} deps */
 constructor(deps){this.deps=deps;}
 /** @type {import('./types').State} */ state={busy:false,labels:{},records:[],focusRecordId:null,results:[],review:null,message:'',error:false,complete:false,libraryReview:null};
 listeners=new Set();epoch=0;
 getSnapshot=()=>this.state;
 /** @param {()=>void} listener */ subscribe=listener=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 /** @param {Partial<import('./types').State>} values */ update(values){this.state={...this.state,...values};for(const listener of this.listeners)listener();}
 clear(){this.epoch++;this.update({busy:false,labels:{},records:[],focusRecordId:null,results:[],review:null,message:'',error:false,complete:false,libraryReview:null});}
 /** @param {(context:import('./types').Context)=>Promise<void>} work */
 async run(work){
  if(this.state.busy)return false;
  const epoch=this.epoch;this.update({busy:true,error:false,complete:false});
  try{const context=await this.deps.authorize();const check=context.check;context.check=()=>{check();if(epoch!==this.epoch)throw Error('The account changed. Sign in before retrying.');};context.check();await work(context);context.check();return true;}
  catch(error){if(epoch===this.epoch)this.update({error:true,message:error instanceof Error?error.message:String(error)});return false;}
  finally{if(epoch===this.epoch)this.update({busy:false});}
 }
 /** @param {CloudOrigin} origin @param {string} id */ key(origin,id){return 'touchline-publication:v1:'+JSON.stringify([origin.hubId,origin.backendOrigin,origin.accountId,id]);}
 /** @param {CloudOrigin} origin @param {LocalRecord} record @returns {import('./types').Stored} */
 stored(origin,record){
  try{
   const raw=this.deps.storage.getItem(this.key(origin,record.recordId));if(!raw)return {version:1,binding:null,pending:null};
   const value=JSON.parse(raw),binding=value.binding,pending=value.pending;
   if(value.version!==1||Object.keys(value).sort().join(',')!=='binding,pending,version')throw Error();
   if(binding&&(binding.recordId!==record.recordId||binding.curriculumId!==record.curriculum.id||binding.hubId!==origin.hubId||binding.backendOrigin!==origin.backendOrigin||binding.accountId!==origin.accountId||!revision(binding.cloudRevision)||!revision(binding.publishedLocalRevision)))throw Error();
   if(pending){const request=pending.request;if(Object.keys(request).sort().join(',')!=='course_content,course_id,course_progress,course_status,expected_revision,request_id')throw Error();if(!revision(pending.localRevision)||request.course_id!==record.curriculum.id||!statuses.includes(request.course_status)||!Number.isSafeInteger(request.expected_revision)||request.expected_revision< -1||!/^[-0-9a-f]{36}$/.test(request.request_id))throw Error();const backup=projectPublication({curriculum:request.course_content,state:request.course_progress});if(canonical(backup.curriculum)!==canonical(request.course_content)||canonical(backup.state)!==canonical(request.course_progress))throw Error();}
   return value;
  }catch{throw Error('Publication recovery could not be read. New publication is disabled for this course; keep its local and cloud copies.');}
 }
 /** @param {CloudOrigin} origin @param {string} id @param {unknown} value */ persist(origin,id,value){try{this.deps.storage.setItem(this.key(origin,id),JSON.stringify(value));}catch{throw Error('Publication recovery could not be saved. Keep this page open and retry when device storage is available.');}}
 /** @param {import('./types').Result} result */ result(result){this.update({results:[...this.state.results.filter(item=>item.recordId!==result.recordId),result]});}
 refresh=()=>this.run(async context=>{const local=await this.deps.accounts.publicationRecords();context.check();const labels=Object.fromEntries(local.records.map(record=>{try{const saved=this.stored(context.origin,record);return [record.recordId,saved.pending?'Publication waiting for confirmation':saved.binding?(saved.binding.publishedLocalRevision===record.state.revision?'No local changes since publication':'Local changes'):'No publication recorded on this device'];}catch{return [record.recordId,'Publication recovery needs attention'];}}));this.update({...local,labels,message:'Choose the curricula to publish. Your focus does not limit your selection.'});});
 /** @param {string[]} recordIds */ publish=recordIds=>this.run(async context=>{
  const local=await this.deps.accounts.publicationRecords();context.check();this.update({...local,review:null});
  const selected=local.records.filter(record=>recordIds.includes(record.recordId));
  if(!selected.length)throw Error('Choose at least one curriculum.');
  for(const record of selected){context.check();const collision=selected.some(other=>other.recordId!==record.recordId&&other.curriculum.id===record.curriculum.id);if(collision){this.result({recordId:record.recordId,title:record.curriculum.title,curriculumId:record.curriculum.id,status:'failed',message:'Choose only one local copy of this curriculum for this hub.'});continue;}await this.write(context,record);}
  context.check();this.update({complete:selected.every(record=>this.state.results.find(result=>result.recordId===record.recordId)?.status==='published'),message:'Each curriculum keeps its own result. Unselected contents were not published.'});
  if(this.state.results.some(result=>selected.some(record=>record.recordId===result.recordId)&&result.status==='published'))await this.deps.completed?.();context.check();
 });
 /** @param {string} recordId */ retry=recordId=>this.publish([recordId]);
 /** @param {import('./types').Context} context @param {LocalRecord} record */
 async write(context,record){
  const base={recordId:record.recordId,curriculumId:record.curriculum.id,title:record.curriculum.title};this.result({...base,status:'publishing',message:'Publishing…'});
  try{
   const stored=this.stored(context.origin,record);
   if(!stored.pending){const backup=projectPublication({curriculum:record.curriculum,state:record.state});stored.pending={localRevision:record.state.revision,request:{course_id:record.curriculum.id,course_content:backup.curriculum,course_progress:backup.state,course_status:record.status,expected_revision:stored.binding?.cloudRevision??-1,request_id:crypto.randomUUID()}};this.persist(context.origin,record.recordId,stored);}
   context.check();const {data,error,status}=await context.transfer.rpc('publish_learning_course',stored.pending.request);context.check();
   if(error){await this.denied({...error,status});if(error.code==='22023'){stored.pending=null;this.persist(context.origin,record.recordId,stored);throw Error((error.message||'The publication was rejected.')+' Correct the local curriculum, then publish it again.');}throw error;}
   const snapshot=validateSnapshot(data,record.curriculum.id);
   if(snapshot.revision!==Math.max(stored.pending.request.expected_revision+1,0)||snapshot.status!==stored.pending.request.course_status||canonical(snapshot.curriculum)!==canonical(stored.pending.request.course_content)||canonical(snapshot.progress)!==canonical(stored.pending.request.course_progress))throw Error('The publication acknowledgement did not match the saved request. Retry to confirm its result.');
   const binding={recordId:record.recordId,hubId:context.origin.hubId,backendOrigin:context.origin.backendOrigin,accountId:context.origin.accountId,curriculumId:record.curriculum.id,cloudRevision:snapshot.revision,publishedLocalRevision:stored.pending.localRevision};
   this.persist(context.origin,record.recordId,{version:1,binding,pending:null});
   this.update({labels:{...this.state.labels,[record.recordId]:`Published revision ${snapshot.revision}`}});
   this.result({...base,status:'published',message:`Published revision ${snapshot.revision}. Later local edits stay here.`});
  }catch(error){context.check();const conflict=/** @type {{code?:string}} */(error)?.code==='40001';this.result({...base,status:conflict?'conflict':'failed',message:conflict?'A newer snapshot is online. Review it before replacing local work.':error instanceof Error?error.message:/** @type {{message?:string}} */(error)?.message||'Publication failed. Retry this course.'});}
 }
 /** @param {unknown} error */ async denied(error){const value=/** @type {{status?:number;code?:string}} */(error);if([401,403].includes(value?.status??0)||['42501','PGRST301','PGRST303'].includes(value?.code??'')){await this.deps.denied?.(error);throw Error('The account session ended. Sign in before retrying.');}}
 /** @param {import('./types').Context} context @param {string} id */ async cloud(context,id){const {data,error,status}=await context.transfer.from('learning_courses').select('*').eq('id',id).single();context.check();if(error){await this.denied({...error,status});throw error;}return validateSnapshot(data,id);}
 /** @param {string} id @param {string} [recordId] */ review=(id,recordId)=>this.run(async context=>{
  this.update({review:null});const snapshot=await this.cloud(context,id);
  const local=await this.deps.accounts.prepareCloudImport({curriculum:snapshot.curriculum,state:snapshot.progress},context.origin,snapshot.status,recordId);context.check();
  this.update({review:{snapshot,local:local.local,token:local.token,recordId},message:'Review the local and cloud copies before downloading.'});
 });
 cancelReview=()=>{if(!this.state.busy)this.update({review:null,message:'Your local work is unchanged.'});};
 exportReview=()=>{if(this.state.review?.local)this.deps.accounts.download(this.state.review.local,this.state.review.local.curriculum.id+'-local-backup.json');};
 downloadReviewed=()=>this.run(async context=>{
  const review=this.state.review;if(!review)throw Error('Review a cloud snapshot first.');
  const current=await this.cloud(context,review.snapshot.curriculum.id);
  if(canonical(current)!==canonical(review.snapshot)){this.update({review:null});throw Error('The cloud snapshot changed. Review the new version before downloading.');}
  const imported=await this.deps.accounts.commitCloudImport(review.token);context.check();
  const binding={recordId:imported.recordId,hubId:context.origin.hubId,backendOrigin:context.origin.backendOrigin,accountId:context.origin.accountId,curriculumId:current.curriculum.id,cloudRevision:current.revision,publishedLocalRevision:imported.revision};
  this.persist(context.origin,imported.recordId,{version:1,binding,pending:null});
  this.update({review:null,message:'Downloaded the reviewed snapshot. Your unfinished draft and other curricula are unchanged.'});
 });
 /** @param {CloudOrigin} origin @returns {null|{library:{version:1;revision:number;focusCurriculumId:string|null};expected_revision:number;request_id:string}} */
 libraryPending(origin){
  try{const raw=this.deps.storage.getItem(this.key(origin,'library'));const value=raw?JSON.parse(raw):null;if(!value)return null;
   if(Object.keys(value).sort().join(',')!=='expected_revision,library,request_id'||Object.keys(value.library).sort().join(',')!=='focusCurriculumId,revision,version'||value.library.version!==1||!Number.isSafeInteger(value.expected_revision)||value.expected_revision< -1||value.library.revision!==Math.max(value.expected_revision,0)||value.library.focusCurriculumId!==null&&!/^[a-z0-9][a-z0-9-]{0,59}$/.test(value.library.focusCurriculumId)||!/^[-0-9a-f]{36}$/.test(value.request_id))throw Error();return value;
  }catch{throw Error('Library publication recovery could not be read. New library publications are disabled; keep the existing cloud library.');}
 }
 reviewFocus=()=>this.run(async context=>{
  const pending=this.libraryPending(context.origin);
  if(pending){this.update({libraryReview:{localFocus:pending.library.focusCurriculumId,cloudFocus:null,revision:pending.expected_revision},message:'An interrupted library publication is waiting. Confirm to retry that exact focus change.'});return;}
  const local=await this.deps.accounts.publicationRecords();context.check();const focus=local.records.find(record=>record.recordId===local.focusRecordId);
  const {data,error,status}=await context.transfer.from('learning_library_snapshots').select('snapshot').maybeSingle();context.check();if(error){await this.denied({...error,status});throw error;}
  const previous=data?.snapshot;
  if(previous&&(Object.keys(previous).sort().join(',')!=='focusCurriculumId,revision,version'||!revision(previous.revision)||previous.version!==1||previous.focusCurriculumId!==null&&!/^[a-z0-9][a-z0-9-]{0,59}$/.test(previous.focusCurriculumId)))throw Error('The published library is invalid.');
  this.update({libraryReview:{localFocus:focus?.curriculum.id??null,cloudFocus:previous?.focusCurriculumId??null,revision:previous?.revision??-1},message:'Review the focus change. Curriculum contents will remain unchanged.'});
 });
 publishFocus=()=>this.run(async context=>{
  let pending=this.libraryPending(context.origin);
  if(!pending){const review=this.state.libraryReview;if(!review)throw Error('Review the library focus first.');pending={library:{version:1,revision:Math.max(review.revision,0),focusCurriculumId:review.localFocus},expected_revision:review.revision,request_id:crypto.randomUUID()};this.persist(context.origin,'library',pending);}
  const {data,error,status}=await context.transfer.rpc('save_learning_library',pending);context.check();
  if(error){await this.denied({...error,status});if(error.code==='40001'||error.code==='22023'){this.persist(context.origin,'library',null);this.update({libraryReview:null});}throw error;}
  if(!data||data.version!==1||data.revision!==Math.max(pending.expected_revision+1,0)||data.focusCurriculumId!==pending.library.focusCurriculumId||Object.keys(data).sort().join(',')!=='focusCurriculumId,revision,version')throw Error('The library publication response did not match. Retry the same request.');
  this.persist(context.origin,'library',null);this.update({libraryReview:null,message:'Library focus published. No curriculum contents were published by this action.'});
 });
}
