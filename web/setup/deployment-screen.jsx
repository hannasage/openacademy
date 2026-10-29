import {useEffect,useState,useSyncExternalStore} from 'react';
import {Button} from '@hannasage/projection-ui/core';
import {deploymentOrigin} from './deployment-return.js';
/** @param {{client:import('./client.js').SetupClient}} props */
export function DeploymentReturn({client}){
 const state=useSyncExternalStore(client.subscribe,client.getSnapshot);
 const [origin]=useState(()=>deploymentOrigin(location.href));
 const [cleared,setCleared]=useState(true);
 useEffect(()=>{try{history.replaceState(null,'','/setup/deployment-return');}catch{setCleared(false);}},[]);
 const matches=origin&&origin===state.configuration?.hubOrigin;
 const review=state.deployment;
 return <section className="setup-card"><h2>Check your deployed hub</h2><p>A Vercel return does not confirm that your hub is ready. Check the actual hub before using its address.</p>
  {!cleared&&<p role="alert">The browser could not clear the return address. Close this tab and open your configured connector address manually.</p>}
  {!origin&&<p role="alert">The return did not include a valid HTTPS deployment address. Open your configured connector address manually.</p>}
  {origin&&<p className="setup-address">Returned address: {origin}</p>}
  {!state.authenticated?<p>Unlock owner setup below to check this deployment.</p>:!matches?<><p role="alert">This address does not match your configured connector. No returned address was checked.</p><p className="setup-address">Open your configured address manually: {state.configuration?.hubOrigin}</p></>:review?<><p><strong>{review.hub.name}</strong><br/><span className="setup-address">{review.hub.hubOrigin}</span></p><p className="setup-address">Backend: {review.hub.backend.url}<br/>Hub identity: {review.hub.hubId}</p>{review.verified?<p role="status">This hub passed its discovery and backend checks. Enter its address in Touchline, then sign in separately by email.</p>:<Button type="button" size="lg" variant="primary" disabled={state.busy||!cleared} onClick={()=>void client.act('deployment-confirm',{reviewHash:review.reviewHash})}>Confirm this hub and check readiness</Button>}</>:<Button type="button" size="lg" variant="primary" disabled={state.busy||!cleared} onClick={()=>void client.act('deployment-review',{deploymentOrigin:origin})}>Inspect this deployed hub</Button>}
 </section>;
}
