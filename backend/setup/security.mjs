import {createHash,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
export class SetupError extends Error {
 constructor(code,message,retryable=false){super(message);this.name='SetupError';this.code=code;this.retryable=retryable;}
}
export function fail(code,message,retryable=false){throw new SetupError(code,message,retryable);}
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const secret=()=>randomBytes(32).toString('base64url');
export function equal(left,right){if(typeof left!=='string'||typeof right!=='string')return false;const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);}
export function canonical(value){
 if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 fail('invalid_input','Setup data must contain finite JSON values.');
}
export function exact(value,required,optional=[]){if(!value||Object.getPrototypeOf(value)!==Object.prototype||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>![...required,...optional].includes(key)))fail('invalid_input','The setup request has invalid fields.');}
export function text(value,max=200){if(typeof value!=='string'||!value.trim()||value.length>max||[...value].some(char=>char.codePointAt(0)<32||char.codePointAt(0)===127))fail('invalid_input','A setup value is missing or invalid.');return value;}
export function httpsOrigin(value){text(value,2048);let url;try{url=new URL(value);}catch{fail('invalid_input','Use an HTTPS hub origin.');}if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)fail('invalid_input','Use an HTTPS hub origin without a path or credentials.');return value;}
export function createVault(key){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('Setup encryption needs a 32-byte server key.');
 const serverKey=Buffer.from(key);
 return Object.freeze({
  seal(value,binding){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',serverKey,iv);cipher.setAAD(Buffer.from(binding));const data=Buffer.concat([cipher.update(canonical(value),'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');},
  open(value,binding){try{if(typeof value!=='string'||value.length>32768)throw Error();const parts=value.split('.');if(parts.length!==3)throw Error();const [iv,tag,data]=parts.map(x=>Buffer.from(x,'base64url'));if(iv.length!==12||tag.length!==16)throw Error();const decipher=createDecipheriv('aes-256-gcm',serverKey,iv);decipher.setAAD(Buffer.from(binding));decipher.setAuthTag(tag);return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'));}catch{fail('invalid_credentials','Temporary setup credentials could not be read. Authorize setup again.');}}
 });
}
