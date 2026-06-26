import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

describe('bin/private-journal-mcp launcher', () => {
  it('bootstraps production dependencies before loading dist', async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-bin-'));
    await fs.mkdir(path.join(fixture, 'bin'));
    await fs.mkdir(path.join(fixture, 'dist'));
    await fs.mkdir(path.join(fixture, 'fake-bin'));

    await fs.copyFile(
      path.join(process.cwd(), 'bin', 'private-journal-mcp'),
      path.join(fixture, 'bin', 'private-journal-mcp'),
    );
    await fs.writeFile(
      path.join(fixture, 'package.json'),
      JSON.stringify({ name: 'fixture', dependencies: {} }),
      'utf8',
    );
    await fs.writeFile(path.join(fixture, 'package-lock.json'), '{}', 'utf8');
    await fs.writeFile(
      path.join(fixture, 'dist', 'index.js'),
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "for (const dep of ['@modelcontextprotocol/sdk', '@huggingface/transformers', 'zod']) {",
        "  if (!fs.existsSync(path.join(__dirname, '..', 'node_modules', dep))) {",
        "    throw new Error(`missing ${dep}`);",
        '  }',
        '}',
        'exports.main = async () => {',
        "  console.log('dist main ran');",
        '};',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(fixture, 'fake-bin', 'npm'),
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        "const path = require('path');",
        "fs.writeFileSync(path.join(process.cwd(), 'npm-called'), process.argv.slice(2).join(' '));",
        "for (const dep of ['@modelcontextprotocol/sdk', '@huggingface/transformers', 'zod']) {",
        "  fs.mkdirSync(path.join(process.cwd(), 'node_modules', dep), { recursive: true });",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.chmod(path.join(fixture, 'fake-bin', 'npm'), 0o755);

    const result = spawnSync('node', [path.join(fixture, 'bin', 'private-journal-mcp'), 'sync'], {
      cwd: fixture,
      env: {
        ...process.env,
        PATH: `${path.join(fixture, 'fake-bin')}${path.delimiter}${process.env.PATH}`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dist main ran');
    await expect(fs.readFile(path.join(fixture, 'npm-called'), 'utf8')).resolves.toBe(
      'ci --omit=dev --ignore-scripts',
    );
  });
});
