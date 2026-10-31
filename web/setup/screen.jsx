import {useEffect,useState,useSyncExternalStore} from 'react';
import {Button as ProjectionButton,Input,ThemeProvider} from '@hannasage/projection-ui/core';
import '@hannasage/projection-ui/styles';
import './style.css';
import {useAppearance,ThemeSwitcher} from '../../appearance.jsx';
import {DeploymentReturn} from './deployment-screen.jsx';
/** @param {import('react').ComponentProps<typeof ProjectionButton>} props */
function Button(props){return <ProjectionButton type="button" size="lg" {...props}/>;}
const stepNames = {
  '001_private_writes.sql':'Protect private learning records',
  '002_bind_existing_owner.sql':'Bind any existing verified owner',
  '003_classify_legacy_publications.sql':'Check existing publications without removing records',
  '004_session_access.sql':'Protect learning access with account sessions',
  'configure-owner':'Restrict learning access to your owner email',
  'configure-auth':'Configure email sign-in and return addresses',
  verify:'Check the prepared backend',
  'verify-published':'Check the published hub and backend',
};
/** @param {string} id */
function stepName(id){return Object.hasOwn(stepNames,id)?stepNames[/** @type {keyof typeof stepNames} */(id)]:`Install ${id}`;}
/** @param {{client:import('./client.js').SetupClient}} props */
export function SetupScreen({client}){
  const state=useSyncExternalStore(client.subscribe,client.getSnapshot);
  const appearance=useAppearance();
  const [code,setCode]=useState(''),[project,setProject]=useState(''),[name,setName]=useState('My learning hub');
  const setup=state.setup,review=setup?.review,phase=setup?.phase,disabled=state.busy;
  useEffect(()=>{const url=new URL(location.href);void client.load(url.pathname==='/setup'?(url.searchParams.get('setup')??undefined):undefined).then(()=>{if(url.searchParams.get('notice')==='return-failed')client.update({error:true,message:'The setup return could not finish. Refresh its status before continuing.'});});},[client]);
  useEffect(()=>{if(review){setProject(review.project.ref);setName(review.config.hubName);}},[review]);
  useEffect(()=>{if(setup?.id)try{history.replaceState(null,'','/setup?setup='+encodeURIComponent(setup.id));}catch{client.update({error:true,message:'The browser could not save this setup address. Keep this page open while you finish.'});}},[setup?.id,client]);
  const canReview=['choosing-project','reviewed','preparation-failed'].includes(phase);
  const terminal=['complete','cancelled','expired','authorization-failed'].includes(phase);
  const act=(/** @type {string} */ action,/** @type {Record<string,unknown>} */ extra={})=>void client.act(action,{id:setup?.id,...extra});
  return <ThemeProvider theme={appearance.theme} className="setup-app">
    <header className="setup-header"><a className="setup-wordmark" href="/setup" aria-label="Schola setup home">schola</a><span>Private hub setup</span><div className="setup-header-actions header-actions"><ThemeSwitcher/>{state.authenticated&&<Button disabled={disabled} onClick={()=>void client.act('logout')}>Lock setup</Button>}</div></header>
    <main className="setup-main">
      <div className="setup-heading"><h1>{location.pathname==='/setup/deployment-return'?'Confirm your deployed hub.':state.authenticated?'Choose where your learning lives.':'Prepare your private hub.'}</h1><p>{state.authenticated?'Review your destination before Schola prepares it. Your learning account stays separate.':'Unlock this owner-hosted connector to set up your Supabase project. This does not sign you in to your learning account.'}</p></div>
      <p className={'setup-status'+(state.error?' setup-error':'')} role="status" aria-live="polite">{state.message}</p>
      {location.pathname==='/setup/deployment-return'&&<DeploymentReturn client={client}/>}
      {state.authenticated&&location.pathname==='/setup/deployment-return'?null:!state.authenticated?<div className="setup-columns"><form className="setup-card" onSubmit={event=>{event.preventDefault();const value=code;setCode('');void client.unlock(value);}}><h2>Unlock owner setup</h2><p>Enter the one-time setup code you configured on your connector. It expires and can be used only once.</p><Input id="setup-code" label="One-time setup code" type="password" autoComplete="off" spellCheck={false} required maxLength={43} value={code} onChange={event=>setCode(event.target.value)} style={{fontSize:16,minHeight:48}}/><Button type="submit" variant="primary" disabled={disabled||!code}>{disabled?'Unlocking…':'Unlock setup'}</Button><p className="setup-muted">Lost or expired code? Generate a new one and update your connector settings.</p></form><section className="setup-card"><h2>Your backend. Your access.</h2><p>This connector needs its own PostgreSQL database and two Supabase setup app registrations.</p><p>Setup codes and provider secrets belong to the connector owner. Learning sign-in uses email after your hub is ready.</p><a href="/setup-guide">Read the owner setup guide</a></section></div>:<>
        {!state.configuration?.ready?<section className="setup-card"><h2>Finish connector configuration</h2><p>Set these values in your own deployment before connecting Supabase.</p><ul>{state.configuration?.missing.map(item=><li key={item}>{item}</li>)}</ul><a href="/setup-guide">Open the owner setup guide</a><Button disabled={disabled} onClick={()=>void client.load(setup?.id)}>Check configuration again</Button></section>:<>
          {(!setup||terminal)&&<section className="setup-card setup-start"><h2>{phase==='complete'?'Your hub is ready':phase==='cancelled'?'Setup cancelled':phase==='expired'?'Setup permission expired':'Connect your Supabase project'}</h2>{phase==='complete'?<><p>Use this address in the Schola app, then sign in with your owner email.</p><p className="setup-address">{review?.config.hubOrigin}</p><p>No learning account was signed in during setup.</p></>:<><p>First, grant permission to list and inspect your projects. You will review every proposed change before granting installation permission.</p><Button variant="primary" disabled={disabled} onClick={()=>void client.act('begin')}>Connect Supabase</Button><p className="setup-muted">This connects a backend. It does not use Supabase as your learning sign-in provider.</p></>}</section>}
          {setup&&!terminal&&<div className="setup-columns"><section className="setup-card"><h2>Your Supabase projects</h2><p>Choose a project from the organization you authorized.</p>{state.projects.length?<fieldset className="setup-projects" disabled={disabled||!canReview}><legend className="sr-only">Choose a Supabase project</legend>{state.projects.map(item=><label className={'setup-project'+(project===item.ref?' selected':'')} key={item.ref}><input type="radio" name="project" value={item.ref} checked={project===item.ref} onChange={()=>setProject(item.ref)}/><span><strong>{item.name}</strong><span className="setup-muted">{item.ref}</span></span></label>)}</fieldset>:<p>{phase==='choosing-project'?'Load your projects to choose a destination.':'Return from Supabase to continue this step.'}</p>}
          {canReview&&<><Button disabled={disabled} onClick={()=>act('projects')}>Refresh projects</Button><form className="setup-form" onSubmit={event=>{event.preventDefault();act('review',{projectRef:project,hubName:name});}}><Input id="hub-name" label="Name your hub" required maxLength={100} value={name} onChange={event=>setName(event.target.value)} style={{fontSize:16,minHeight:48}}/><p>Owner: <strong>{state.configuration?.ownerEmail}</strong><br/>Hub: <span className="setup-address">{state.configuration?.hubOrigin}</span></p><Button type="submit" variant="primary" disabled={disabled||!project||!name.trim()}>Review setup</Button><p className="setup-muted">Nothing is installed until you review the proposed changes.</p></form></>}
          </section><section className="setup-card"><h2>Setup review</h2>{review?<><p><strong>{review.config.hubName}</strong><br/>{review.project.name}<br/><span className="setup-address">{review.config.hubOrigin}</span></p><p>Owner email: <strong>{review.config.ownerEmail}</strong></p><p>{review.inspection.compatibility==='empty'?'This database is compatible with a new Schola installation.':'This project has a compatible Schola installation.'}</p><ol className="setup-steps">{setup.steps.map((/** @type {{id:string,status:string}} */ step)=><li key={step.id}><span>{stepName(step.id)}</span><strong>{step.status==='complete'?'Complete':'Pending'}</strong></li>)}</ol>
          {phase==='reviewed'&&<><p>The next permission lets Schola install the changes listed here.</p><Button variant="primary" disabled={disabled} onClick={()=>act('install',{reviewHash:review.reviewHash})}>Approve and grant installation permission</Button></>}
          {phase==='ready-to-prepare'&&<><p>Installation permission is granted. Start only if this is still your intended destination.</p><Button variant="primary" disabled={disabled} onClick={()=>void client.prepare(setup.id,review.reviewHash)}>Prepare this hub</Button></>}
          {phase==='preparation-failed'&&<p role="alert">Preparation stopped. Completed steps may remain installed. Review the project again before granting new permission.</p>}
          {['preparing','exchanging-discovery','exchanging-install'].includes(phase)&&<p>This step is running. Refresh its status before taking another action.</p>}
          </>:<p>Choose your project and review setup to see the proposed changes here.</p>}
          {setup.error&&<p className="setup-error" role="alert">{setup.error.code==='consent_denied'?'Permission was not granted. Nothing was installed.':'The last step did not finish. Refresh its status and follow the recovery options.'}</p>}
          <div className="setup-actions"><Button disabled={disabled} onClick={()=>void client.load(setup.id)}>Refresh status</Button><Button disabled={disabled} onClick={()=>act('cancel')}>Cancel setup</Button></div></section></div>}
          {setup?.revocationPending&&<p className="setup-error" role="alert">Temporary permission could not be revoked. Remove the Schola setup integrations in Supabase before closing this page.</p>}
        </>}
      </>}
      <footer className="setup-footer"><a href="/setup-guide">Prefer manual setup?</a><span>You can keep learning locally while you prepare a hub.</span></footer>
    </main>
  </ThemeProvider>;
}
