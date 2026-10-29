export type Hub = {
  format:'touchline-hub'; version:1; hubId:string; name:string; hubOrigin:string;
  backend:{type:'supabase';url:string;publishableKey:string};
  contracts:{snapshot:1;progress:1}; auth:{email:'otp';providers:('google'|'apple')[]};
};

import type {SupabaseClient} from '@supabase/supabase-js';
export type SessionRow={sessionId:string;label:string;createdAt:string|null;lastSeenAt:string|null;isCurrent:boolean};
export type CourseRow={id:string;curriculum:Curriculum;revision:number;updated_at:string};
export type AccountBridge={setAccountScope:(origin:CloudOrigin|null)=>Promise<void>;invalidateAccountScope:()=>Promise<void>;snapshot:()=>Promise<LearningBackup>;importCloud:(backup:LearningBackup,origin:CloudOrigin)=>Promise<boolean>;download:(value:unknown,name:string)=>void};
export type Dependencies={makeClient:(hub:Hub,token?:string)=>SupabaseClient;storage:Storage;transient:Storage;accounts:AccountBridge;request?:typeof fetch;now?:()=>number;appOrigin:string;navigate:(url:string)=>void};
export type ConnectionState={phase:'disconnected'|'review'|'signin'|'code'|'ready';hub:Hub|null;candidate:Hub|null;busy:boolean;error:boolean;message:string;email:string;resendAt:number;courses:CourseRow[];sessions:SessionRow[];accountId:string|null;currentSessionId:string|null;needsSignOut:boolean;needsVerificationRetry:boolean;unavailableCourses:number};
export type PendingOAuth={nonce:string;hubId:string;backendOrigin:string;callback:string;expiresAt:number};
