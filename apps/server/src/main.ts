import { createApp } from './app';
import type { Config } from './config';
import { runtime } from './runtime';
export async function startServer(settings: Config) {
  const { store } = await runtime(settings);
  const app = await createApp(settings, store);
  try {
    await app.listen({ host: settings.host, port: settings.port });
  } catch (e) {
    await app.close();
    throw e;
  }
  console.log(`Personal Memory listening on port ${settings.port} (${settings.storage})`);
  if (settings.insecureHttp)
    console.warn(
      `WARNING: allowInsecureHttp: true: the password and session cookie travel in plaintext over ${settings.origin}. Use only on a trusted network.`,
    );
  return app;
}
