import { resolve } from 'node:path';
export interface Config {
  account: string;
  passwordHash: string;
  sessionKey: Buffer;
  origin: string;
  storage: 'local' | 'oss';
  dataDir: string;
  stateDir: string;
  port: number;
  host: string;
  container: boolean;
  oss?: {
    bucket: string;
    region: string;
    prefix: string;
    accessKeyId: string;
    accessKeySecret: string;
  };
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Missing configuration: ${key}`);
    return value;
  };
  const account = required('PMEM_ACCOUNT');
  if (account.includes('\0') || account.length > 100) throw new Error('Invalid account');
  const passwordHash = required('PMEM_PASSWORD_HASH');
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(passwordHash))
    throw new Error('Invalid password hash: use the hash-password setup command');
  const key = required('PMEM_SESSION_KEY');
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('Session key must contain 64 hex characters');
  const url = new URL(required('PMEM_ORIGIN'));
  if (url.origin !== env.PMEM_ORIGIN || url.username || url.password)
    throw new Error('PMEM_ORIGIN must be an origin without a path');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('HTTPS is required outside loopback development');
  const storage = env.PMEM_STORAGE ?? 'local';
  if (storage !== 'local' && storage !== 'oss')
    throw new Error('PMEM_STORAGE must be local or oss');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const value: Config = {
    account,
    passwordHash,
    sessionKey: Buffer.from(key, 'hex'),
    origin: url.origin,
    storage,
    dataDir: resolve(env.PMEM_DATA_DIR ?? '.pmem/data'),
    stateDir: resolve(env.PMEM_STATE_DIR ?? '.pmem/state'),
    port,
    host: env.HOST ?? '127.0.0.1',
    container: env.PMEM_CONTAINER === '1',
  };
  if (storage === 'oss') {
    const prefix = required('PMEM_OSS_PREFIX');
    if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*\/$/.test(prefix) || prefix.includes('//'))
      throw new Error('OSS prefix must be a simple relative path ending in /');
    value.oss = {
      prefix,
      bucket: required('PMEM_OSS_BUCKET'),
      region: required('PMEM_OSS_REGION'),
      accessKeyId: required('PMEM_OSS_ACCESS_KEY_ID'),
      accessKeySecret: required('PMEM_OSS_ACCESS_KEY_SECRET'),
    };
  }
  return value;
}
