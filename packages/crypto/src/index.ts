import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256(data: Buffer) { return createHash('sha256').update(data).digest('hex'); }
export function generateFileKey() { return randomBytes(32); }
export function encryptChunk(plaintext: Buffer, key: Buffer) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function decryptChunk(ciphertext:Buffer, key:Buffer, nonce:string, tag:string) {
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'base64')); decipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([decipher.update(ciphertext),decipher.final()]);
}
