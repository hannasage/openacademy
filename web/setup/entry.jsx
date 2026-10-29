import {createRoot} from 'react-dom/client';
import {SetupClient} from './client.js';
import {SetupScreen} from './screen.jsx';
const root=document.getElementById('setup-root');
if(root)createRoot(root).render(<SetupScreen client={new SetupClient()}/>);
