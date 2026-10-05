#!/usr/bin/env node
// Bumps the app version everywhere and creates the release tag.
// Usage: npm run release -- 0.2.0        (prepares commit + tag)
//        npm run release -- 0.2.0 --push (also pushes, which triggers the Release workflow)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const [version, flag] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Uso: npm run release -- <versão> [--push]   (ex.: npm run release -- 0.2.0)');
  process.exit(1);
}

const sh = (cmd) => execSync(cmd, { stdio: 'inherit' });
const dirty = execSync('git status --porcelain').toString().trim();
if (dirty) {
  console.error('Há alterações não commitadas. Faça commit antes de gerar uma versão.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [a, b, c] = pkg.version.split('.').map(Number);
const [x, y, z] = version.split('.').map(Number);
if (x < a || (x === a && (y < b || (y === b && z <= c)))) {
  console.error(`A nova versão (${version}) precisa ser maior que a atual (${pkg.version}).`);
  process.exit(1);
}

pkg.version = version;
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = version;
if (lock.packages?.['']) lock.packages[''].version = version;
writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

const cargoPath = 'src-tauri/Cargo.toml';
writeFileSync(cargoPath, readFileSync(cargoPath, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`));
const cargoLock = 'src-tauri/Cargo.lock';
writeFileSync(
  cargoLock,
  readFileSync(cargoLock, 'utf8').replace(/(name = "edit-master"\nversion = )".*"/, `$1"${version}"`),
);

sh(`git add package.json package-lock.json ${cargoPath} ${cargoLock}`);
sh(`git commit -m "Versão ${version}"`);
sh(`git tag v${version}`);
if (flag === '--push') {
  sh('git push');
  sh(`git push origin v${version}`);
  console.log(`\nv${version} enviada. Acompanhe a publicação na aba Actions do GitHub.`);
} else {
  console.log(`\nPronto. Para publicar: git push && git push origin v${version}`);
}
