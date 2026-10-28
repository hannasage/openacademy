import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ThemeProvider, Button, Badge, Progress} from '@hannasage/projection-ui/core';
import {ThemeSwitcher, useAppearance} from './appearance.jsx';
import '@hannasage/projection-ui/styles';

/** @param {string} selector @returns {HTMLElement} */
function element(selector) {
  const result = document.querySelector(selector);
  if (!(result instanceof HTMLElement)) throw new Error(`Missing control: ${selector}`);
  return result;
}

// React owns the design-system frame. The existing local workflow owns its DOM subtree.
const content=[...document.body.children].filter(node=>node.tagName!=='SCRIPT');
const root=document.createElement('div');document.body.append(root);
function Frame() {
  const {theme} = useAppearance();
  return <ThemeProvider theme={theme}><div id="hub-host" /></ThemeProvider>;
}
flushSync(()=>createRoot(root).render(<Frame />));
const host=element('#hub-host');for(const node of content)host.append(node);
const actions=element('.header-actions');
flushSync(()=>createRoot(actions).render(<><Badge>Local workspace</Badge><ThemeSwitcher /><Button id="export" size="lg">Export progress</Button><Button id="restore" size="lg">Restore backup</Button><input id="import" type="file" accept="application/json" hidden /></>));
const resume=document.createElement('div');resume.className='projection-resume';element('.intro>div').append(resume);
flushSync(()=>createRoot(resume).render(<Button variant="primary" size="lg" onClick={()=>{element('[data-view="curriculum"]').click();element('#module-detail').scrollIntoView({behavior:'instant'});/** @type {HTMLElement | null} */(document.querySelector('#status'))?.focus({preventScroll:true});}}>Continue learning <span aria-hidden="true">↗</span></Button>));
const meter=document.createElement('div');meter.className='course-progress';element('.summary').after(meter);
const meterRoot=createRoot(meter);
window.updateProjectionProgress=(done,total)=>meterRoot.render(<Progress label={`${done} of ${total} modules complete`} value={done} max={total}/>);
await import('./app.js');
await import('./sync.js');
