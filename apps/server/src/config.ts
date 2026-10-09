import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
export interface Config {
  account: string;
  passwordHash: string;
  sessionKey: Buffer;
  origin: string;
  insecureHttp: boolean;
  storage: 'local' | 'oss';
  dataDir: string;
  stateDir: string;
  port: number;
  host: string;
  container: boolean;
  oss?: {
    bucket: string;
    region?: string;
    endpoint?: string;
    prefix: string;
    accessKeyId: string;
    accessKeySecret: string;
  };
}
export const pmemHome = () => join(homedir(), '.pmem');
export function expandPath(path: string, base = process.cwd()) {
  return path === '~'
    ? homedir()
    : path.startsWith('~/')
      ? resolve(homedir(), path.slice(2))
      : resolve(base, path);
}
export const defaultConfigPath = () => join(pmemHome(), 'pmem.json');
export async function loadConfig(path = defaultConfigPath()) {
  const file = expandPath(path);
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(
        `Configuration not found: ${file}. Create it using pmem.example.json; see pmem --help.`,
      );
    throw new Error(`Cannot read configuration: ${file} (${(e as NodeJS.ErrnoException).code})`);
  }
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    throw new Error(`Invalid JSON in configuration: ${file}`);
  }
  return config(input, dirname(file));
}
function object(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${name} must be a JSON object`);
  return input as Record<string, unknown>;
}
function string(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key] === undefined ? fallback : input[key];
  if (typeof value !== 'string' || !value || value.includes('\0'))
    throw new Error(`Invalid or missing configuration: ${key}`);
  return value;
}
function boolean(input: Record<string, unknown>, key: string): boolean {
  if (input[key] !== undefined && typeof input[key] !== 'boolean')
    throw new Error(`${key} must be a boolean`);
  return input[key] === true;
}
function ossEndpoint(input: unknown, bucket: string): string | undefined {
  if (input === undefined) return;
  const message =
    'oss.endpoint must be a hostname or HTTPS URL without credentials, path, query or fragment';
  if (
    typeof input !== 'string' ||
    input.trim() !== input ||
    !/^(?:https:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.-]*(?::[0-9]+)?\/?$/.test(input)
  )
    throw new Error(message);
  let endpoint: URL;
  try {
    endpoint = new URL(input.startsWith('https://') ? input : `https://${input}`);
  } catch {
    throw new Error(message);
  }
  const bucketPrefix = `${bucket.toLowerCase()}.`;
  if (
    endpoint.hostname.startsWith(bucketPrefix) &&
    /^(?:oss-[a-z0-9-]+|[a-z0-9-]+\.oss)\.aliyuncs\.com\.?$/.test(
      endpoint.hostname.slice(bucketPrefix.length),
    )
  )
    throw new Error(
      'oss.endpoint must be an OSS service endpoint without the oss.bucket hostname prefix',
    );
  return endpoint.origin;
}
export function config(input: unknown, base = pmemHome()): Config {
  const values = object(input, 'Configuration');
  const allowed = new Set([
    'account',
    'passwordHash',
    'sessionKey',
    'origin',
    'allowInsecureHttp',
    'storage',
    'dataDir',
    'stateDir',
    'port',
    'host',
    'oss',
  ]);
  if (Object.keys(values).some((key) => !allowed.has(key)))
    throw new Error('Unknown configuration field; use the keys in pmem.example.json');
  const account = string(values, 'account');
  if (account.length > 100) throw new Error('Invalid account');
  const passwordHash = string(values, 'passwordHash');
  if (!/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(passwordHash))
    throw new Error('Invalid passwordHash: use pmem hash-password');
  const key = string(values, 'sessionKey');
  if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('sessionKey must contain 64 hex characters');
  const port = values.port === undefined ? 3000 : values.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid port: expected an integer from 1 to 65535');
  const origin = string(values, 'origin', `http://localhost:${port}`);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Invalid origin');
  }
  if (url.origin !== origin || url.username || url.password)
    throw new Error('origin must be an origin without a path');
  const http = url.protocol === 'http:';
  const loopback = http && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowInsecureHttp = boolean(values, 'allowInsecureHttp');
  const insecureHttp = http && !loopback && allowInsecureHttp;
  if (url.protocol !== 'https:' && !loopback && !insecureHttp)
    throw new Error(
      'HTTPS is required outside loopback; set allowInsecureHttp: true to accept plaintext HTTP on a trusted network',
    );
  const storage = values.storage === undefined ? 'local' : values.storage;
  if (storage !== 'local' && storage !== 'oss') throw new Error('storage must be local or oss');
  const value: Config = {
    account,
    passwordHash,
    sessionKey: Buffer.from(key, 'hex'),
    origin,
    insecureHttp,
    storage,
    dataDir: expandPath(string(values, 'dataDir', 'data'), base),
    stateDir: expandPath(string(values, 'stateDir', 'state'), base),
    port,
    host: string(values, 'host', '127.0.0.1'),
    container: process.env.PMEM_CONTAINER === '1',
  };
  if (values.oss !== undefined || storage === 'oss') {
    const oss = object(values.oss, 'oss');
    if (
      Object.keys(oss).some(
        (key) =>
          ![
            'prefix',
            'bucket',
            'region',
            'endpoint',
            'accessKeyId',
            'accessKeySecret',
          ].includes(key),
      )
    )
      throw new Error('Unknown oss configuration field');
    const prefix = oss.prefix === undefined ? '' : oss.prefix;
    if (
      typeof prefix !== 'string' ||
      (prefix !== '' &&
        (!/^[a-zA-Z0-9_-][a-zA-Z0-9_/-]*\/$/.test(prefix) ||
          prefix.includes('//') ||
          prefix.trim() !== prefix))
    )
      throw new Error('OSS prefix must be empty or a simple relative path ending in /');
    const bucket = string(oss, 'bucket');
    const region = oss.region === undefined ? undefined : string(oss, 'region');
    const endpoint = ossEndpoint(oss.endpoint, bucket);
    if (!region && !endpoint) throw new Error('oss.region or oss.endpoint is required');
    value.oss = {
      prefix,
      bucket,
      region,
      endpoint,
      accessKeyId: string(oss, 'accessKeyId'),
      accessKeySecret: string(oss, 'accessKeySecret'),
    };
  }
  return value;
}
