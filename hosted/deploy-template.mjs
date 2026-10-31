import {hubOrigin} from '../web/connection/discovery.js';
// Publication is a separate owner decision. The app does not offer this URL yet.
export const deployTemplate=Object.freeze({
 publicationApproved:false,
 repositoryURL:'https://github.com/hannasage/touchline',
 returnPath:'/setup/deployment-return',
 environment:['TOUCHLINE_SETUP_ORIGIN','TOUCHLINE_SETUP_OWNER_EMAIL','TOUCHLINE_SETUP_DATABASE_URL','TOUCHLINE_SETUP_ENCRYPTION_KEY','TOUCHLINE_SETUP_BOOTSTRAP_KEY','TOUCHLINE_SETUP_BOOTSTRAP_EXPIRES_AT','TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_ID','TOUCHLINE_SUPABASE_DISCOVERY_CLIENT_SECRET','TOUCHLINE_SUPABASE_INSTALL_CLIENT_ID','TOUCHLINE_SUPABASE_INSTALL_CLIENT_SECRET'],
 optionalEnvironment:['TOUCHLINE_SETUP_DATABASE_CA'],
});
/** Owners supply their own return origin. No shared callback or secret defaults exist. */
export function deployButtonURL(returnOrigin,template=deployTemplate){
 if(!template.publicationApproved)return null;
 const origin=hubOrigin(returnOrigin),repository=new URL(template.repositoryURL);
 if(repository.protocol!=='https:'||repository.hostname!=='github.com'||repository.username||repository.password||repository.search||repository.hash||!/^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repository.pathname))throw Error('Use the reviewed public source repository.');
 const url=new URL('https://vercel.com/new/clone');
 url.searchParams.set('repository-url',repository.href);
 url.searchParams.set('redirect-url',origin+'/setup/deployment-return');
 url.searchParams.set('env',template.environment.join(','));
 url.searchParams.set('envDescription','Owner-hosted Schola setup configuration. Supply your own connector database and Supabase app registrations.');
 return url.href;
}
