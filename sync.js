import {connection} from './web/connection/instance.js';
// The shared shell calls this module only after the learning bridge is bound.
// Consume account-return parameters once and remove them from browser history.
const returnUrl=window.location.href;
if(new URL(returnUrl).searchParams.has('touchline-return')) window.history.replaceState(null,'','/');
void connection.initialize(returnUrl);
