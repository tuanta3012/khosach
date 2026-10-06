import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version = packageJson.version;

if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error(`package.json version must be a stable semantic version (for example 1.2.3); received "${version}".`);
}

if (typeof packageJson.buildAab !== 'boolean') {
  throw new Error('package.json buildAab must be the boolean true or false.');
}

const existingTag = execFileSync('git', ['tag', '--list', `v${version}`], { encoding: 'utf8' }).trim();
if (existingTag) {
  throw new Error(`Release tag ${existingTag} already exists. Increase package.json version before creating another release.`);
}

const versionParts = version.split('.').map(Number);
if (versionParts.some((part) => !Number.isSafeInteger(part))) {
  throw new Error(`package.json version components must be safe integers; received "${version}".`);
}

const releasedVersions = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .map((tag) => tag.match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
  .filter((match) => match !== null)
  .map((match) => match.slice(1).map(Number));
const latestReleasedVersion = releasedVersions.reduce((latest, candidate) => {
  for (let index = 0; index < 3; index += 1) {
    if (candidate[index] > (latest[index] || 0)) return candidate;
    if (candidate[index] < (latest[index] || 0)) return latest;
  }
  return latest;
}, [0, 0, 0]);
const isNewerThanLatest = versionParts.some((part, index) => {
  for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
    if (versionParts[priorIndex] !== latestReleasedVersion[priorIndex]) return false;
  }
  return part > latestReleasedVersion[index];
});
if (!isNewerThanLatest) {
  throw new Error(
    `package.json version ${version} must be higher than the latest GitHub release tag v${latestReleasedVersion.join('.')}.`
  );
}

const versionCode = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
if (!Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
  throw new Error(`Generated Android versionCode is invalid: ${versionCode}.`);
}

console.log(`CODE=${versionCode}`);
console.log(`NAME=${version}`);
console.log(`BUILD_AAB=${packageJson.buildAab}`);
console.error(`Validated release: version=${version}, versionCode=${versionCode}, buildAab=${packageJson.buildAab}.`);
