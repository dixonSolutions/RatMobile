// Self-hosted CRX: install from an update feed, then auto-update to a newer build signed with the same key.
// Skipped when no signing key is available (e.g. forks without the secret).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { launch, freshProfile, sleep, trackDir, EXT_ID, ROOT, TEST_ROOT } from './harness.mjs';
import { serve } from './server.mjs';

const hasKey = !!process.env.RATMOBILE_KEY || existsSync(process.env.RATMOBILE_KEY_FILE || join(homedir(), '.config/ratmobile/key.pem'));
const base = TEST_ROOT;
const feed = trackDir(join(base, 'feed'));
trackDir(join(base, 'v1'));
trackDir(join(base, 'v2'));
let srv;

function build(version, out) {
  execFileSync(process.execPath, ['scripts/build.mjs'], {
    cwd: ROOT,
    env: { ...process.env, RATMOBILE_VERSION: version, RATMOBILE_BASE_URL: srv.url, RATMOBILE_DIST: out },
    stdio: 'ignore',
  });
  cpSync(out, feed, { recursive: true });
}

async function extensionWorker(context, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const w = context.serviceWorkers().find((x) => x.url().startsWith(`chrome-extension://${EXT_ID}/`));
    if (w) return w;
    await sleep(250);
  }
  return null;
}

before(async () => {
  rmSync(feed, { recursive: true, force: true });
  mkdirSync(feed, { recursive: true });
  srv = await serve(feed);
});
after(() => srv?.close());

for (const mode of ['external_update_url', 'external_crx']) {
  test(`CRX installs via ${mode} and auto-updates from updates.xml`, { skip: !hasKey && 'no signing key' }, async () => {
    build('0.9.0', join(base, 'v1'));
    const profile = freshProfile(`update-${mode}`);
    mkdirSync(join(profile, 'External Extensions'), { recursive: true });
    writeFileSync(
      join(profile, 'External Extensions', `${EXT_ID}.json`),
      JSON.stringify(mode === 'external_update_url' ? { external_update_url: `${srv.url}/updates.xml` } : { external_crx: join(feed, 'ratmobile.crx'), external_version: '0.9.0' }),
    );
    const b = await launch({ profile, extensionDir: null });
    try {
      const sw = await extensionWorker(b.context);
      assert.ok(sw, 'extension did not install from the CRX');
      const info = await sw.evaluate(async () => ({ v: chrome.runtime.getManifest().version, enabled: (await chrome.management.getSelf()).enabled }));
      assert.deepEqual(info, { v: '0.9.0', enabled: true });

      build('0.9.1', join(base, 'v2'));
      const res = await sw.evaluate(() => chrome.runtime.requestUpdateCheck());
      assert.equal(res.status, 'update_available');
      let v = null;
      for (let i = 0; i < 60 && v !== '0.9.1'; i++) {
        await sleep(500);
        const w = await extensionWorker(b.context, 1000);
        v = w ? await w.evaluate(() => chrome.runtime.getManifest().version).catch(() => null) : null;
      }
      assert.equal(v, '0.9.1', 'did not auto-update');
      assert.ok(srv.hits.includes('/ratmobile-0.9.1.crx'));
    } finally {
      await b.close();
    }
  });
}
