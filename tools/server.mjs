#!/usr/bin/env node
// Starts the review server (tools/app.mjs).
//   node tools/server.mjs [--port 4321] [--open]
// Env: PORT, HOST (default 127.0.0.1; the Docker image sets 0.0.0.0), REVIEW_USER / REVIEW_PASS
// (basic auth, default eezy / eezy), DATA_DIR (where decisions are stored; see createApp).
import { exec } from 'node:child_process';
import { createApp } from './app.mjs';

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || Number(process.env.PORT) || 4321;
const HOST = process.env.HOST || '127.0.0.1';

// In production the password comes from a secret. Kamal injects an empty string when the
// repository secret is missing, so refuse to boot rather than run with a blank password.
if (process.env.NODE_ENV === 'production' && !process.env.REVIEW_PASS) {
  console.error('REVIEW_PASS is not set; refusing to start in production.');
  process.exit(1);
}

const app = createApp({
  user: process.env.REVIEW_USER || 'eezy',
  pass: process.env.REVIEW_PASS || 'eezy',
  dataDir: process.env.DATA_DIR || null,
});

const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`design-system-review → ${url}`);
  if (argv.includes('--open')) exec(`open ${url}`);
});

// Kamal stops the old container with SIGTERM; close cleanly so in-flight requests finish.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
