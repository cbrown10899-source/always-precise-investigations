/* Generate a VAPID keypair for Web Push.  Run:  node visitor-alerts/gen-vapid.mjs  */
import { webcrypto as crypto } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', kp.publicKey);      // 65-byte point
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);

console.log('\nVAPID_PUBLIC_KEY   =', b64url(pub));
console.log('VAPID_PRIVATE_KEY  =', jwk.d);
console.log('\nSet both on the Worker:');
console.log('  npx wrangler secret put VAPID_PRIVATE_KEY');
console.log('  npx wrangler secret put WATCH_PASSWORD');
console.log('and put VAPID_PUBLIC_KEY in wrangler.toml [vars].\n');
