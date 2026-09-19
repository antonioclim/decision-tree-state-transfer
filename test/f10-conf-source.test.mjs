import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SCENARIOS } from '../assets/code/confirmatory/generator.mjs';
import { ConfirmatoryStream, confSourceAddress, F10_CONF_NAMESPACE } from '../assets/code/confirmatory/f10-conf-source.mjs';

const sha = (x) => createHash('sha256').update(x, 'utf8').digest('hex');

test('F10 CONF source address is exactly the F09 namespace contract', () => {
  const scenario = 'LOCAL_TREE-STATIONARY-NONE';
  const address = confSourceAddress(scenario, 0);
  assert.equal(address, `${F10_CONF_NAMESPACE}|CONF|SOURCE|scenario=${scenario}|r=000`);
  const stream = new ConfirmatoryStream({ scenario, realisation: 0 });
  assert.equal(stream.key, sha(address).slice(0, 16));
});

test('all and only the frozen 14 scenarios are accepted', () => {
  assert.equal(SCENARIOS.length, 14);
  for (const scenario of SCENARIOS) assert.doesNotThrow(() => new ConfirmatoryStream({ scenario, realisation: 319 }));
  assert.throws(() => new ConfirmatoryStream({ scenario: 'UNDECLARED', realisation: 0 }));
});

test('CONF realisation range is exactly 0..319', () => {
  const scenario = SCENARIOS[0];
  assert.doesNotThrow(() => new ConfirmatoryStream({ scenario, realisation: 0 }));
  assert.doesNotThrow(() => new ConfirmatoryStream({ scenario, realisation: 319 }));
  assert.throws(() => new ConfirmatoryStream({ scenario, realisation: -1 }));
  assert.throws(() => new ConfirmatoryStream({ scenario, realisation: 320 }));
});

test('supplied source key must match the F09 address exactly', () => {
  const scenario = SCENARIOS[0];
  const stream = new ConfirmatoryStream({ scenario, realisation: 7 });
  assert.doesNotThrow(() => new ConfirmatoryStream({ scenario, realisation: 7, streamKey: stream.key }));
  assert.throws(() => new ConfirmatoryStream({ scenario, realisation: 7, streamKey: '0000000000000000' }));
});

test('same CONF identity replays binary64 features and labels exactly', () => {
  const a = new ConfirmatoryStream({ scenario: 'OBLIQUE-GRADUAL-SEVERE', realisation: 11 });
  const b = new ConfirmatoryStream({ scenario: 'OBLIQUE-GRADUAL-SEVERE', realisation: 11 });
  for (const t of [1, 2000, 9999, 10000, 10001, 12000, 20000, 22000, 26000]) assert.deepEqual(a.row(t), b.row(t));
});

test('CONF rows retain the Phase-9 eight-feature binary-label contract', () => {
  for (const scenario of ['LOCAL_TREE-ABRUPT-MILD', 'OBLIQUE-RECURRENT-SEVERE']) {
    const stream = new ConfirmatoryStream({ scenario, realisation: 3 });
    for (const t of [1, 10000, 10001, 20000, 20001, 26000]) {
      const row = stream.row(t);
      assert.equal(row.index, t);
      assert.equal(row.x.length, 8);
      assert.ok(row.x.every(Number.isFinite));
      assert.ok(row.y === 0 || row.y === 1);
    }
  }
});
