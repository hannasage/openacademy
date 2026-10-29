/** @param {LocalRecord} record */
export function summarizeRecord(record) {
 const values=Object.values(record.state.modules);
 return {done:values.filter(value=>value.status==='complete').length,total:record.curriculum.modules.length,
  hours:values.reduce((sum,value)=>sum+value.hours,0),experiments:record.state.experiments.length,
  lesson:record.curriculum.modules.find(value=>value.id===record.view.selectedModuleId)||record.curriculum.modules[0]};
}
/** @param {LocalRecord[]} records @param {string|null} id */
export function focusRecord(records,id) {return records.find(record=>record.recordId===id&&record.status==='active')||null;}
/** @typedef {{rows:{summary:LibrarySummary,record:LocalRecord|null}[],focusRecordId:string|null,loading:boolean,busy:boolean,error:string}} ScreenState */
/** @typedef {{open:(id:string)=>Promise<void>,focus:(id:string|null)=>Promise<void>,status:(id:string,status:LibraryStatus)=>Promise<void>,refresh:()=>Promise<void>,import:()=>void}} ScreenActions */
/** @type {ScreenState} */let state={rows:[],focusRecordId:null,loading:true,busy:false,error:''};
/** @type {Set<()=>void>} */const listeners=new Set();
/** @type {ScreenActions} */let actions={open:async()=>{},focus:async()=>{},status:async()=>{},refresh:async()=>{},import:()=>{}};
export const screens={
 getSnapshot:()=>state,
 /** @param {()=>void} listener */subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},
 /** @param {Partial<ScreenState>} value */update(value){state={...state,...value};for(const listener of listeners)listener();},
 /** @param {ScreenActions} value */bind(value){actions=value;},
 /** @param {string} id */open:id=>actions.open(id),
 /** @param {string|null} id */focus:id=>actions.focus(id),
 /** @param {string} id @param {LibraryStatus} status */status:(id,status)=>actions.status(id,status),
 refresh:()=>actions.refresh(),import:()=>actions.import(),
};
