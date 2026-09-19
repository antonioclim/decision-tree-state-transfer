import assert from 'node:assert/strict';
import test from 'node:test';
import { DeployedProvenanceIndex } from '../assets/code/confirmatory/f10-deployed-provenance.mjs';

function edge(n, source, overrides = {}) {
  return {
    id: `I03:edge:${n}`,
    token: 'I03:edge-token:1',
    parent_token: 'I03:token:1',
    child_token: 'I03:token:2',
    slot: 'left',
    source,
    ...overrides
  };
}

test('path-compression certificate remains constant-schema across a 256-link chain', () => {
  const index = new DeployedProvenanceIndex();
  const chain = [edge(1, null)];
  for (let i = 2; i <= 256; i += 1) chain.push(edge(i, chain.at(-1).id));
  for (const item of chain) index.currentEdges.set(item.id, item);
  const certificate = index._edgeCertificate(chain.at(-1));
  assert.equal(certificate.chain_length, 255);
  assert.equal(certificate.terminal_fresh_edge_id, chain[0].id);
  assert.match(certificate.chain_commitment, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(certificate)) < 1024);

  // Simulate pruning every source while retaining only the live subject plus proof.
  index.currentEdges.clear();
  index.edges.set(chain.at(-1).id, { payload: chain.at(-1), certificate });
  assert.deepEqual(index._edgeCertificate(chain.at(-1)), certificate);
});

test('tampered path-compression certificate is rejected fail-closed', () => {
  const index = new DeployedProvenanceIndex();
  const fresh = edge(1, null);
  const copied = edge(2, fresh.id);
  index.currentEdges.set(fresh.id, fresh);
  index.currentEdges.set(copied.id, copied);
  const certificate = index._edgeCertificate(copied);
  index.currentEdges.clear();
  index.edges.set(copied.id, {
    payload: copied,
    certificate: { ...certificate, certificate_digest: `sha256:${'0'.repeat(64)}` }
  });
  assert.throws(() => index._edgeCertificate(copied), /certificate seal mismatch/);
});

test('copy-chain compression rejects a semantic mutation', () => {
  const index = new DeployedProvenanceIndex();
  const fresh = edge(1, null);
  const mutated = edge(2, fresh.id, { slot: 'right' });
  index.currentEdges.set(fresh.id, fresh);
  index.currentEdges.set(mutated.id, mutated);
  assert.throws(() => index._edgeCertificate(mutated), /copy changed semantics/);
});

test('copy-chain compression rejects cycles', () => {
  const index = new DeployedProvenanceIndex();
  const a = edge(1, 'I03:edge:2');
  const b = edge(2, 'I03:edge:1');
  index.currentEdges.set(a.id, a);
  index.currentEdges.set(b.id, b);
  assert.throws(() => index._edgeCertificate(a), /cyclic edge copy chain/);
});
