import {createClient} from '@supabase/supabase-js';
import {accounts} from '../services/accounts.js';
import {ConnectionController} from './controller.js';
/** @type {Storage} */
const storage = {
  get length(){return localStorage.length;},
  clear:()=>localStorage.clear(),
  key:index=>localStorage.key(index),
  getItem:key=>localStorage.getItem(key),
  setItem:(key,value)=>localStorage.setItem(key,value),
  removeItem:key=>localStorage.removeItem(key),
};
export const connection = new ConnectionController({
  makeClient:(hub,token)=>createClient(hub.backend.url,hub.backend.publishableKey,token ? {accessToken:async()=>token,global:{headers:{Authorization:'Bearer '+token}}} : {auth:{storage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false,flowType:'pkce',storageKey:'touchline-auth:'+hub.hubId+':'+hub.backend.url}}),
  storage,
  transient:{
    get length(){return sessionStorage.length;},clear:()=>sessionStorage.clear(),key:index=>sessionStorage.key(index),
    getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>sessionStorage.setItem(key,value),removeItem:key=>sessionStorage.removeItem(key),
  },
  accounts:accounts.service,
  appOrigin:window.location.origin,
  navigate:url=>window.location.assign(url),
});
