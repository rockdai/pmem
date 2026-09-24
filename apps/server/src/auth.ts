import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
export async function hashPassword(password: string) {
  if (password.length < 12 || Buffer.byteLength(password) > 1024)
    throw new Error('Password must be at least 12 characters and at most 1024 bytes');
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
export async function checkPassword(password: string, hash: string) {
  if (Buffer.byteLength(password) > 1024) return false;
  const [, salt, expected] = hash.split('$');
  return equal((await derive(password, Buffer.from(salt, 'hex'))).toString('hex'), expected);
}
export function equal(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function binding(key: Buffer, account: string, passwordHash: string) {
  return createHmac('sha256', key)
    .update(`pmem-auth-v1\0${account}\0${passwordHash}`)
    .digest('hex');
}
