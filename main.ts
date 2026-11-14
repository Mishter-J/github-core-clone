// main.ts — entrypoint: `node main.ts` (Node 22, stdlib only).
// Binds an ephemeral port, registers it with the env, then long-polls the
// env's /done until the trial ends, and exits 0. No wall clock or unseeded
// randomness is used anywhere the env or a model can see: the store's clock
// is seeded from MAKEFUN_TRIAL_NOW, and ids come from deterministic counters.

import { createApp } from './app.ts';
import { Store } from './store.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<number> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  if (envUrl === '') {
    process.stderr.write('MAKEFUN_ENV_URL is not set\n');
    return 1;
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(process.env.MAKEFUN_TRIAL_NOW);
  const server = createApp(store, { token });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('could not bind an ephemeral port'));
    });
  });

  const base = envUrl.replace(/\/+$/, '');
  const register = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
  });
  if (!register.ok) {
    process.stderr.write(`register failed: HTTP ${register.status}\n`);
    server.close();
    return 1;
  }

  // Long-poll /done until the env says the trial is over. The poll itself is
  // transport, not scored output; the interval is a fixed constant.
  for (;;) {
    try {
      const response = await fetch(`${base}/done`, { method: 'GET' });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) break;
      }
    } catch {
      // A transient env hiccup: keep polling instead of dying mid-trial.
    }
    await sleep(500);
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
