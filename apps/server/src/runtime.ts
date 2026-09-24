import { config } from './config';
import { LocalStore } from './local';
import { AliGateway, OssStore } from './oss';
export async function runtime(initialize = false) {
  const settings = config();
  if (settings.storage === 'local')
    return { settings, store: await LocalStore.create(settings.dataDir) };
  const oss = settings.oss!;
  const gateway = new AliGateway(oss.bucket, oss.region, oss.accessKeyId, oss.accessKeySecret);
  return {
    settings,
    store: await OssStore.open(gateway, settings.stateDir, oss.bucket, oss.prefix, {
      initialize,
      container: settings.container,
    }),
  };
}
