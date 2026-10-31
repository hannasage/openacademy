import {useState} from 'react';
import {Button,Input} from '@hannasage/projection-ui/core';
import {setupAddress} from './entry-link.js';
/** The local app only opens the owner connector. It never receives setup credentials. */
export function SetupEntryCard(){
 const [address,setAddress]=useState('');const destination=setupAddress(address);
 return <section className="connection-card"><h3>Create my private hub</h3><p>Use your own Supabase project and owner-hosted connector. Configure the connector before connecting your backend.</p>
  <form className="setup-entry-form" action={destination??undefined} target="_blank" rel="noreferrer noopener" onSubmit={event=>{if(!destination)event.preventDefault();}}>
   <Input id="owner-connector-address" label="Owner connector address" type="url" placeholder="https://learn.example.org" value={address} onChange={event=>setAddress(event.target.value)} style={{fontSize:16,minHeight:48}} required/>
   <Button type="submit" variant="primary" size="lg" disabled={!destination}>Open owner setup</Button>
  </form><p className="muted">Opens a separate tab. Backend permission is granted there; email remains your learning sign-in.</p>
  <details><summary>Host a connector with Vercel</summary><p>The public Deploy with Vercel template is not available while Schola is private. Import your own repository into Vercel and follow <code>hosted/README.md</code> with your own PostgreSQL database.</p><Button type="button" size="lg" disabled>Deploy with Vercel · not available yet</Button></details>
  <details><summary>Use manual setup</summary><p>Follow <code>backend/README.md</code> in your Schola copy to configure owner access and publish a hub description. Then enter the hub address under “I already have a hub.”</p></details>
  <p className="muted">You can keep learning locally and connect later.</p>
 </section>;
}
