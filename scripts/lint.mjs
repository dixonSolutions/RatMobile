#!/usr/bin/env node
// Syntax-checks every script and verifies that everything manifest.json and the HTML pages reference exists.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const errors = [];

for (const f of [...walk(ext), ...walk(join(root, 'scripts')), ...walk(join(root, 'tests'))].filter((f) => /\.m?js$/.test(f))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { errors.push(`${relative(root, f)}: ${e.stderr}`); }
}

const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const refs = [
  m.background.service_worker, m.options_page, m.side_panel.default_path, m.chrome_url_overrides.newtab,
  ...Object.values(m.icons), ...Object.values(m.action.default_icon),
  ...m.content_scripts.flatMap((c) => c.js),
  ...m.web_accessible_resources.flatMap((w) => w.resources).filter((r) => !r.includes('*')),
];
for (const r of refs) if (!existsSync(join(ext, r))) errors.push(`manifest references missing file: ${r}`);

for (const html of walk(ext).filter((f) => f.endsWith('.html'))) {
  for (const [, ref] of readFileSync(html, 'utf8').matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    if (!existsSync(join(dirname(html), ref))) errors.push(`${relative(root, html)} references missing ${ref}`);
  }
}
for (const js of walk(ext).filter((f) => f.endsWith('.js'))) {
  for (const [, ref] of readFileSync(js, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
    if (!existsSync(join(dirname(js), ref))) errors.push(`${relative(root, js)} imports missing ${ref}`);
  }
}

if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('lint ok');
