import { createApp } from './app';
import { runtime } from './runtime';
try {
  process.loadEnvFile();
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
try {
  const { settings, store } = await runtime();
  const app = await createApp(settings, store);
  await app.listen({ host: settings.host, port: settings.port });
  console.log(`Personal Memory listening on port ${settings.port} (${settings.storage})`);
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
} catch (error) {
  // SDK errors may include credentials/request bodies: log only a bounded diagnostic.
  console.error(
    'Startup failed:',
    error instanceof Error && !('requestId' in error)
      ? error.message.split('\n')[0]
      : 'OSS access failed; verify RAM permissions, connectivity and state volume',
  );
  process.exitCode = 1;
}
