import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { createAutostart } from '../desktop/autostart.mjs';

const header = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 2]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'tokenstat-autostart-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const entry = join(config, 'autostart', 'app.tokenstat.desktop');
  await mkdir(join(root, 'release-old'));
  await mkdir(join(root, 'release-new'));
  const old = join(root, 'release-old', 'TokenStat-1.5.0-x86_64.AppImage');
  const next = join(root, 'release-new', 'TokenStat-1.6.0-x86_64.AppImage');
  for (const name of [old, next]) {
    await writeFile(name, header);
    await chmod(name, 0o700);
  }
  const make = (APPIMAGE, version, isPackaged = true) => createAutostart({ isPackaged, getVersion: () => version }, {
    platform: 'linux', env: { XDG_CONFIG_HOME: config, APPIMAGE, APPIMAGE_EXTRACT_AND_RUN: '1' },
  });
  async function legacyEntry() {
    assert.equal(await make(old, '1.5.0').setEnabled(true), true);
    const content = (await readFile(entry, 'utf8')).replace(/^X-TokenStat-Version=.*\n/mu, '');
    await writeFile(entry, content);
    return content;
  }
  return { root, entry, old, next, make, legacyEntry };
}

test('a normal packaged upgrade repairs an enabled legacy AppImage path and keeps custom fields', async (t) => {
  const { entry, old, next, make, legacyEntry } = await fixture(t);
  const original = await legacyEntry();
  const custom = original + 'Comment=Retain my startup description\nOnlyShowIn=KDE;\n';
  await writeFile(entry, custom);
  await rm(old);
  const upgraded = make(next, '1.6.0');
  assert.equal(await upgraded.getEnabled(), false);
  assert.equal(await upgraded.repairPath(), true);
  assert.equal(await upgraded.getEnabled(), true);
  const updated = await readFile(entry, 'utf8');
  assert(updated.includes(basename(next)));
  assert(!updated.includes(basename(old)));
  assert.match(updated, /X-TokenStat-Version=1\.6\.0/u);
  assert.match(updated, /Comment=Retain my startup description\nOnlyShowIn=KDE;/u);
  assert.match(updated, /NO_CLEANUP=1/u);
  assert.equal(await upgraded.repairPath(), false);
});

test('an enabled legacy entry with an unknown version follows a move after its old path disappears', async (t) => {
  const { entry, old, next, make } = await fixture(t);
  const previous = join(dirname(old), 'TokenStat.AppImage');
  await writeFile(previous, header);
  await chmod(previous, 0o700);
  assert.equal(await make(previous, '1.5.0').setEnabled(true), true);
  const original = (await readFile(entry, 'utf8')).replace(/^X-TokenStat-Version=.*\n/mu, '');
  await writeFile(entry, original);

  const upgraded = make(next, '1.6.0');
  assert.equal(await upgraded.repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), original);
  await rm(previous);
  assert.equal(await upgraded.getEnabled(), false);
  assert.equal(await upgraded.repairPath(), true);
  assert.equal(await upgraded.getEnabled(), true);
  const updated = await readFile(entry, 'utf8');
  const lines = updated.split('\n');
  assert(lines.find((line) => line.startsWith('Exec=')).includes(basename(next)));
  assert(lines.find((line) => line.startsWith('TryExec=')).endsWith(basename(next)));
  assert(lines.includes('X-TokenStat-Version=1.6.0'));
});

test('upgrades use a stable alias only when it resolves to the running AppImage', { skip: process.platform === 'win32' }, async (t) => {
  const { entry, old, next, make, legacyEntry } = await fixture(t);
  const alias = join(dirname(next), 'TokenStat.AppImage');
  const current = make(next, '1.6.0');
  await symlink(old, alias);
  await legacyEntry();
  assert.equal(await current.repairPath(), true);
  assert((await readFile(entry, 'utf8')).includes(basename(next)));

  await rm(alias);
  await symlink(next, alias);
  await legacyEntry();
  assert.equal(await current.repairPath(), true);
  let saved = await readFile(entry, 'utf8');
  assert(saved.includes('TokenStat.AppImage'));
  assert(!saved.includes(basename(next)));
  assert.equal(await current.repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), saved);

  // An older manually launched image must not retarget the user's current link.
  assert.equal(await make(old, '1.5.0').repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), saved);

  assert.equal(await current.setEnabled(false), false);
  assert.equal(await current.setEnabled(true), true);
  saved = await readFile(entry, 'utf8');
  assert(saved.includes('TokenStat.AppImage'));
});

test('disabled, foreign, custom and duplicate launch entries are left byte-for-byte unchanged', async (t) => {
  const { entry, next, make, legacyEntry } = await fixture(t);
  const original = await legacyEntry();
  const current = make(next, '1.6.0');
  for (const value of [
    original.replace('Hidden=false', 'Hidden=true'),
    original.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false'),
    original.replace('X-TokenStat-Owned=true', 'X-TokenStat-Owned=false'),
    original.replace('"--autostart"', '"--custom-launch"'),
    original + 'Exec="/bin/sh"\n',
  ]) {
    await writeFile(entry, value);
    assert.equal(await current.repairPath(), false);
    assert.equal(await readFile(entry, 'utf8'), value);
  }
});

test('non-AppImage, development, and older launches cannot retarget startup', async (t) => {
  const { entry, old, next, make, legacyEntry } = await fixture(t);
  const original = await legacyEntry();
  assert.equal(await make(next, '1.6.0', false).repairPath(), false);
  await writeFile(next, 'not an AppImage');
  assert.equal(await make(next, '1.6.0').repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), original);
  await writeFile(next, header);
  assert.equal(await make(next, '1.6.0').repairPath(), true);
  const upgraded = await readFile(entry, 'utf8');
  assert.equal(await make(old, '1.5.0').repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), upgraded);
});

test('an in-place upgrade records its newer version without moving a stable executable', async (t) => {
  const { root, entry, old, make } = await fixture(t);
  const stable = join(root, 'TokenStat.AppImage');
  await writeFile(stable, header);
  await chmod(stable, 0o700);
  await make(stable, '1.5.0').setEnabled(true);
  const original = await readFile(entry, 'utf8');
  assert.equal(await make(stable, '1.6.0').repairPath(), true);
  const upgraded = await readFile(entry, 'utf8');
  assert.equal(upgraded, original.replace('X-TokenStat-Version=1.5.0', 'X-TokenStat-Version=1.6.0'));
  await rm(stable);
  assert.equal(await make(old, '1.5.0').repairPath(), false);
  assert.equal(await readFile(entry, 'utf8'), upgraded);
});
