import {hubOrigin} from '../connection/discovery.js';
/** @param {string} value @returns {string|null} */
export function setupAddress(value){try{return hubOrigin(value.trim())+'/setup';}catch{return null;}}
