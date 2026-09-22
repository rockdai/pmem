#!/usr/bin/env bash
set -euo pipefail
name="pmem-smoke-$RANDOM"
volume="$name-data"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; }
trap cleanup EXIT
hash=$(printf '%s' 'container-test-password' | docker run --rm -i pmem:ci node dist/server/cli.js hash-password)
key=$(docker run --rm pmem:ci node dist/server/cli.js key)
docker volume create "$volume" >/dev/null
docker run -d --name "$name" -e PMEM_ACCOUNT=test -e "PMEM_PASSWORD_HASH=$hash" -e "PMEM_SESSION_KEY=$key" -e PMEM_ORIGIN=http://localhost:3000 -e PMEM_STORAGE=local -v "$volume:/data" pmem:ci >/dev/null
for attempt in {1..30}; do
  if docker exec "$name" node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 1
done
docker exec -i "$name" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
const origin = 'http://localhost:3000';
const auth = await fetch(origin + '/api/v1/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ account: 'test', password: 'container-test-password' }) });
assert.equal(auth.status, 200);
const headers = { origin, cookie: auth.headers.get('set-cookie').split(';')[0], 'x-csrf-token': (await auth.json()).csrf, 'content-type': 'text/markdown' };
const response = await fetch(origin + '/api/v1/notes/00000000-0000-4000-8000-000000000001', { method: 'POST', headers, body: '# survives restart' });
assert.equal(response.status, 201);
assert.equal((await fetch(origin)).status, 200);
JS
docker restart "$name" >/dev/null
docker exec "$name" node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('/data/notes/00000000-0000-4000-8000-000000000001.md','utf8'),'# survives restart')"
printf 'Container local storage smoke test passed.\n'
