import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth';
import { runtime } from './runtime';
const command = process.argv[2];
try {
  if (command === 'key') console.log(randomBytes(32).toString('hex'));
  else if (command === 'hash-password') {
    if (process.stdin.isTTY)
      throw new Error('Pass the password on stdin; do not use command-line arguments');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    console.log(
      await hashPassword(
        Buffer.concat(chunks)
          .toString('utf8')
          .replace(/\r?\n$/, ''),
      ),
    );
  } else if (command === 'init-oss') {
    try {
      process.loadEnvFile();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (process.env.PMEM_STORAGE !== 'oss')
      throw new Error('Set PMEM_STORAGE=oss before initialization');
    await runtime(true);
    console.log('OSS state identity verified. Ready to start.');
  } else throw new Error('Usage: setup key | hash-password (stdin) | init-oss');
} catch (e) {
  console.error(
    e instanceof Error && !('requestId' in e)
      ? e.message.split('\n')[0]
      : 'OSS initialization failed; verify permissions and state identity',
  );
  process.exitCode = 1;
}
