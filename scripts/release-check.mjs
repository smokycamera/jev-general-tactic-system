import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
if (pkg.private !== true || pkg.license !== 'UNLICENSED')
  throw new Error('Expected private development package');
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n');
for (const file of tracked)
  if (
    (/(^|\/)\.env($|\.)/.test(file) && file !== '.env.example') ||
    file.startsWith('.data/') ||
    file.startsWith('node_modules/')
  )
    throw new Error(`Do not publish local state: ${file}`);
console.log(`Release preflight passed for v${pkg.version}`);
