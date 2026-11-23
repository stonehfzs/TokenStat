import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultPreferences, normalizePreferences } from '../lib/preferences.mjs';
import { openStore } from '../lib/store.mjs';

test('visual effects default to full and survive older settings and backup restores', (t) => {
  const { visualEffects, ...legacy } = defaultPreferences;
  const lite = normalizePreferences({ visualEffects: 'lite' }, legacy);
  assert.equal(normalizePreferences({}, legacy).visualEffects, 'full');
  assert.equal(normalizePreferences({ locale: 'en' }, lite).visualEffects, 'lite');
  assert.throws(() => normalizePreferences({ visualEffects: 'unsupported' }, lite), /视觉特效设置无效/u);

  const directory = mkdtempSync(join(tmpdir(), 'tokenstat-visual-preferences-'));
  const store = openStore(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.setPreferences(lite);
  const saved = store.exportBackup();
  assert.equal(saved.preferences.visualEffects, 'lite');
  assert.equal(store.restoreBackup({ ...saved, preferences: legacy }).preferences, 0);
  assert.equal(store.getPreferences().visualEffects, 'lite');
  assert.equal(store.restoreBackup({ ...saved, preferences: defaultPreferences }, { dryRun: true }).preferences, 1);
  assert.equal(store.getPreferences().visualEffects, 'lite');
  assert.equal(store.restoreBackup({ ...saved, preferences: defaultPreferences }).preferences, 1);
  assert.equal(store.getPreferences().visualEffects, 'full');
});
