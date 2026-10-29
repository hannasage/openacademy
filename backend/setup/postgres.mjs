import pg from 'pg';
import {canonical,fail,SetupError} from './security.mjs';
import {mergePublicHub} from './public-hub.mjs';
function document(row){if(!row||typeof row.id!=='string'||row.id.length>200||!Number.isSafeInteger(row.version)||row.version<0)fail('invalid_document','The setup storage document is invalid.');const json=canonical(row);if(Buffer.byteLength(json)>262144)fail('invalid_document','The setup storage document is too large.');return json;}
export class PostgresStore {
 #pool;
 constructor(pool){if(!pool||typeof pool.query!=='function')throw Error('A PostgreSQL pool is required.');this.#pool=pool;}
 async #query(text,values){try{return await this.#pool.query(text,values);}catch{fail('storage_unavailable','The connector database is unavailable or needs its bootstrap schema.',true);}}
 async create(row){if(row.version!==0)fail('invalid_document','A new setup document must start at version zero.');const json=document(row),expires=row.id==='setup-admin'?null:row.expiresAt?new Date(row.expiresAt):null;const result=await this.#query('insert into touchline_connector.documents(id,version,body,expires_at) values($1,0,$2::jsonb,$3) on conflict(id) do nothing returning id',[row.id,json,expires]);return result.rowCount===1;}
 async read(id){if(typeof id!=='string'||id.length>200)fail('invalid_document','The setup storage key is invalid.');const result=await this.#query('select body from touchline_connector.documents where id=$1',[id]);return result.rows[0]?.body??null;}
 async compareAndSwap(id,version,next){if(next.id!==id||!Number.isSafeInteger(version)||next.version!==version+1)fail('invalid_document','The setup storage revision is invalid.');const json=document(next),expires=id==='setup-admin'?null:next.expiresAt?new Date(next.expiresAt):null;const result=await this.#query('update touchline_connector.documents set version=$3,body=$4::jsonb,expires_at=$5 where id=$1 and version=$2 returning id',[id,version,next.version,json,expires]);return result.rowCount===1;}
 async commitPublicHub(id,version,input,now){
  let client;
  try{
   client=await this.#pool.connect();await client.query('begin');
   const selected=await client.query('select body from touchline_connector.documents where id=$1 for update',[id]);const flow=selected.rows[0]?.body;
   if(!flow||flow.version!==version||flow.phase!=='preparing'||flow.expiresAt<=now)fail('operation_cancelled','This setup changed before its hub could be published.');
   const existing=await client.query("select body from touchline_connector.documents where id='public-hub' for update");const prior=existing.rows[0]?.body;
   const description=mergePublicHub(prior?.description,input),hub={id:'public-hub',version:prior?prior.version+1:0,description},next={...flow,version:version+1,publicHub:description};
   if(prior)await client.query("update touchline_connector.documents set version=$1,body=$2::jsonb where id='public-hub'",[hub.version,document(hub)]);
   else{const inserted=await client.query("insert into touchline_connector.documents(id,version,body) values('public-hub',0,$1::jsonb) on conflict(id) do nothing returning id",[document(hub)]);if(inserted.rowCount!==1)fail('operation_cancelled','Another setup published this hub first. Review its current configuration.');}
   await client.query('update touchline_connector.documents set version=$2,body=$3::jsonb where id=$1',[id,next.version,document(next)]);await client.query('commit');return {flow:next,description};
  }catch(error){if(client)try{await client.query('rollback');}catch{/* The failed transaction cannot be reused. The client is discarded below. */}if(error instanceof SetupError)throw error;fail('storage_unavailable','The public hub could not be stored. Review setup before retrying.',true);}
  finally{client?.release(true);}
 }
 async expiredIds(now=Date.now()){const result=await this.#query("select id from touchline_connector.documents where id<>'setup-admin' and expires_at<=$1 and body->>'phase' not in ('complete','cancelled','expired') order by expires_at limit 100",[new Date(now)]);return result.rows.map(row=>row.id);}
}
export function createPostgresStore(databaseUrl,{ca}={}){
 let url;try{url=new URL(databaseUrl);}catch{throw Error('Configure the connector PostgreSQL URL.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password||url.hash)throw Error('Configure a complete connector PostgreSQL URL.');
 // Never let URL SSL options override verification on the owner's production store.
 for(const key of url.searchParams.keys())if(!['sslmode'].includes(key))throw Error('Unsupported connector database URL option.');
 url.search='';
 const pool=new pg.Pool({connectionString:url.href,ssl:{rejectUnauthorized:true,...(ca?{ca}:{})},max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:10000,query_timeout:15000,statement_timeout:10000});
 let poolError=false;pool.on('error',()=>{poolError=true;});
 const store=new PostgresStore({connect:()=>pool.connect(),query:async(...args)=>{if(poolError){poolError=false;await pool.query('select 1');}return pool.query(...args);}});
 return {store,close:()=>pool.end()};
}
