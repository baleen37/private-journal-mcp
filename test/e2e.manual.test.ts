import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const RUN = process.env.RUN_E2E === '1';
const run = promisify(execFile);
const MODEL = 'Xenova/multilingual-e5-small';

(RUN ? describe : describe.skip)('e2e (real model)', () => {
  jest.setTimeout(240_000);

  it('write -> search finds the entry semantically', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-cache-'));

    try {
      await run('npm', ['run', 'build'], {
        cwd: process.cwd(),
        env: { ...process.env },
      });

const script = `
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PrivateJournalServer } = require(${JSON.stringify(path.join(process.cwd(), 'dist/server.js'))});

(async () => {
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, 'private-journal', 'models')
    : undefined;
  await pipeline('feature-extraction', ${JSON.stringify(MODEL)});

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-'));
  try {
    const srv = new PrivateJournalServer({ dataPath: dir });
    await srv.handleWrite({ reflections: '오늘 검색 추천 시스템의 랭킹 모델을 개선했다' });
    await srv.handleWrite({ observations: '날씨가 맑았다' });
    const results = await srv.handleSearch({ query: '랭킹 모델 개선', limit: 2 });
    process.stdout.write(JSON.stringify(results));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;

      const { stdout } = await run(process.execPath, ['-e', script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          XDG_CACHE_HOME: cacheRoot,
        },
        maxBuffer: 10 * 1024 * 1024,
      });
      const results = JSON.parse(stdout);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].excerpt).toContain('랭킹');
    } finally {
      await fs.rm(cacheRoot, { recursive: true, force: true });
    }
  });
});
