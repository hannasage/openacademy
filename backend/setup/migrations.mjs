import {readFile} from 'node:fs/promises';
import {digest} from './security.mjs';
const names=Object.freeze(['001_private_writes.sql','002_bind_existing_owner.sql','003_classify_legacy_publications.sql','004_session_access.sql']);
export async function loadMigrations(){return Object.freeze(await Promise.all(names.map(async name=>{const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');return Object.freeze({id:name,sha256:digest(sql),sql});})));}
export {names as migrationNames};
