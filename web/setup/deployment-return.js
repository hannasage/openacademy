import {hubOrigin} from '../connection/discovery.js';
/** Vercel metadata is an untrusted hint. Only this origin is retained. @param {string} address */
export function deploymentOrigin(address){try{const url=new URL(address);if(url.pathname!=='/setup/deployment-return'||url.search.length>8192||url.searchParams.getAll('deployment-url').length!==1)return null;return hubOrigin(url.searchParams.get('deployment-url')??'');}catch{return null;}}
