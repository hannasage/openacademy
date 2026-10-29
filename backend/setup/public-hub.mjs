import {validateHub} from '../../web/connection/discovery.js';
import {fail} from './security.mjs';
export async function readPublicHub(store){const row=await store.read('public-hub');return row?validateHub(row.description):null;}
export function mergePublicHub(current,input){const candidate=validateHub(input);if(current){const prior=validateHub(current);if(prior.hubOrigin!==candidate.hubOrigin||prior.backend.url!==candidate.backend.url)fail('hub_already_configured','This connector already serves a different hub. Use another deployment.');candidate.hubId=prior.hubId;}return candidate;}
export async function commitPublicHub(store,flow,input,now){return store.commitPublicHub(flow.id,flow.version,validateHub(input),now);}
