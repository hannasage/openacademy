import {useEffect,useState,useSyncExternalStore} from 'react';
import {Button as ProjectionButton,Input,Badge} from '@hannasage/projection-ui/core';
import {connection} from './instance.js';
import './connection.css';
/** @param {import('react').ComponentProps<typeof ProjectionButton>} props */
function Button(props){return <ProjectionButton size="lg" type="button" {...props}/>;}
/** @param {string|null} value */
const dateLabel=value=>value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unknown';
/** @param {{hub:import('./types').Hub}} props */
function HubCard({hub}) {
  return <aside className="connection-card"><h3>{hub.name}</h3><p className="hub-address">{hub.hubOrigin}</p>
    <p>Learning backend</p><p className="hub-address">{hub.backend.url}</p>
    <p className="muted">This is a private deployment. Signing in grants access only when this hub allows your account.</p>
  </aside>;
}
export function ConnectionScreen(){
  const state=useSyncExternalStore(connection.subscribe,connection.getSnapshot);
  const [address,setAddress]=useState(''),[email,setEmail]=useState(''),[code,setCode]=useState('');
  const [now,setNow]=useState(Date.now());
  const [copyMessage,setCopyMessage]=useState('');
  useEffect(()=>{if(state.phase!=='code')return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[state.phase]);
  const wait=Math.max(0,Math.ceil((state.resendAt-now)/1000));
  const disabled=state.busy;
  async function copyHub(){
    try{await navigator.clipboard.writeText(state.hub?.hubOrigin??'');setCopyMessage('Hub link copied. Sign in separately on the new device.');}
    catch{setCopyMessage('The link could not be copied. Select and copy the hub address above.');}
  }
  return <div className="connection-screen">
    <div className="connection-heading"><h2>{state.phase==='disconnected'?'Connect once. Keep learning everywhere.':state.phase==='review'?'Confirm your hub':state.phase==='code'?'Check your email.':state.phase==='ready'?'Your devices and published learning':'Sign in to your hub'}</h2>
      <p>{state.phase==='disconnected'?'Open your hub link to find its connection details. You can keep learning locally and connect later.':state.phase==='code'?`Enter the sign-in code sent to ${state.email}.`:'Your learning stays on your own deployment.'}</p></div>
    <p id="cloud-status" className={'connection-status'+(state.error?' connection-error':'')} role="status" aria-live="polite">{state.message}</p>
    {state.needsVerificationRetry && <Button size="lg" disabled={disabled} onClick={()=>void connection.retryVerification()}>Retry connection</Button>}
    {state.needsSignOut && <Button size="lg" disabled={disabled} onClick={()=>void connection.signOut()}>Retry sign-out</Button>}
    {state.phase==='disconnected' && <div className="connection-columns"><form className="connection-card" onSubmit={event=>{event.preventDefault();void connection.find(address);}}><h3>I already have a hub</h3><p>Enter the address from your other device. You will confirm the destination before signing in.</p>
      <Input style={{fontSize:16,minHeight:48}} id="hub-address" label="Hub address" type="url" placeholder="https://learn.example.org" required value={address} onChange={event=>setAddress(event.target.value)} />
      <Button type="submit" variant="primary" size="lg" disabled={disabled}>{disabled?'Finding hub…':'Find my hub'}</Button></form>
      <section className="connection-card"><h3>Create my private hub</h3><p>Use your own Supabase project. An existing hub needs its public address and email sign-in configured.</p><p>If you do not have a hub address yet, keep learning locally and connect later.</p><p className="muted">Your local curricula remain available while you prepare a hub.</p></section></div>}
    {state.phase==='review' && state.candidate && <div className="connection-columns"><HubCard hub={state.candidate}/><section className="connection-card"><h3>Is this your destination?</h3><p>Confirm the hub and backend addresses before sending an email code or opening a provider.</p><Button variant="primary" size="lg" disabled={disabled} onClick={()=>void connection.confirm()}>Confirm this hub</Button><Button disabled={disabled} onClick={()=>void connection.useDifferentHub()}>Use a different hub</Button></section></div>}
    {state.phase==='signin' && state.hub && <div className="connection-columns"><form className="connection-card" onSubmit={event=>{event.preventDefault();void connection.requestCode(email);}}><h3>Sign in</h3><Input style={{fontSize:16,minHeight:48}} id="cloud-email" label="Email" type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/><Button type="submit" variant="primary" size="lg" disabled={disabled||state.needsSignOut}>Email me a sign-in code</Button><p>A one-time code. No new password to remember.</p>
      {state.hub.auth.providers.length>0 && <div className="connection-providers">{state.hub.auth.providers.map(provider=><Button key={provider} disabled={disabled||state.needsSignOut} onClick={()=>void connection.startProvider(provider)}>Continue with {provider==='google'?'Google':'Apple'}</Button>)}<p className="muted">Additional sign-in methods enabled by this hub.</p></div>}
      <Button disabled={disabled} onClick={()=>void connection.useDifferentHub()}>Use a different hub</Button></form><HubCard hub={state.hub}/></div>}
    {state.phase==='code' && <form className="connection-card connection-code" onSubmit={event=>{event.preventDefault();void connection.verifyCode(code).then(ok=>{if(ok)setCode('');});}}><Input style={{fontSize:16,minHeight:48}} label="Sign-in code" id="email-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" maxLength={10} required value={code} onChange={event=>setCode(event.target.value)}/><Button type="submit" variant="primary" size="lg" disabled={disabled}>Verify and open my hub</Button><Button disabled={disabled||wait>0} onClick={()=>void connection.requestCode(state.email)}>{wait>0?`Send a new code in ${wait}s`:'Send a new code'}</Button><Button disabled={disabled} onClick={()=>{setCode('');connection.useAnotherEmail();}}>Use another email</Button><p className="muted">Expired code? Request another. A connection failure leaves your local progress unchanged.</p></form>}
    {state.phase==='ready' && state.hub && <>
      <div className="connection-columns"><section className="connection-card"><h3>{state.hub.name}</h3><p className="hub-address">{state.hub.hubOrigin}</p><Badge>Owner account</Badge><div className="connection-actions"><Button disabled={disabled} onClick={()=>void copyHub()}>Copy hub link</Button><Button id="cloud-signout" disabled={disabled} onClick={()=>void connection.signOut()}>Sign out this browser</Button></div><p>The link identifies this hub. Each new device must sign in before it can read your records.</p>{copyMessage && <p role="status">{copyMessage}</p>}</section>
      <section className="connection-card"><h3>Publish your learning</h3><p>Publishing saves a reading copy. Local edits stay here until you publish again.</p><Button id="cloud-upload" variant="primary" disabled={disabled} onClick={()=>void connection.publish()}>Publish current curriculum</Button><Button id="cloud-refresh" disabled={disabled} onClick={()=>void connection.refresh()}>Refresh published learning</Button></section></div>
      <section className="connection-card"><h3>Account sessions</h3><p className="muted">Last checked means the last successful contact from Touchline, not live device activity.</p><ul className="connection-list">{state.sessions.map(session=><li key={session.sessionId}><div><strong>{session.label}</strong>{session.isCurrent&&<span> · This browser</span>}<p>Signed in: {dateLabel(session.createdAt)}<br/>Last checked: {dateLabel(session.lastSeenAt)}</p></div><Button disabled={disabled} onClick={()=>void connection.revoke(session.sessionId)}>{session.isCurrent?'Revoke this session':'Revoke access'}</Button></li>)}</ul><p>An offline device keeps downloaded copies until it next learns that its access was revoked.</p></section>
      <section className="connection-card"><h3>Published curricula</h3>{state.unavailableCourses>0 && <p role="status">{state.unavailableCourses} published records cannot be displayed. Their original data stays in your hub for repair.</p>}<div id="cloud-courses">{state.courses.length?state.courses.map(course=><article key={course.id} className="connection-course"><h4>{course.curriculum.title}</h4><p>Published {dateLabel(course.updated_at)}</p><Button disabled={disabled} onClick={()=>void connection.download(course.id)}>Download to this computer</Button></article>):<p>No published curricula yet. Publish your current curriculum to make a reading copy available.</p>}</div></section>
    </>}
  </div>;
}
