import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const target = process.argv[2];

if (target !== 'apk' && target !== 'aab') {
  throw new Error(`Unknown Android build target "${target}". Use "apk" or "aab".`);
}

if (typeof packageJson.buildAab !== 'boolean') {
  throw new Error('package.json buildAab must be the boolean true or false.');
}

const configuredTarget = packageJson.buildAab ? 'aab' : 'apk';
if (target !== configuredTarget) {
  console.error(`Build target mismatch: package.json buildAab=${packageJson.buildAab}. Set buildAab=${target === 'aab'} to build ${target.toUpperCase()}.`);
  process.exitCode = 1;
}
