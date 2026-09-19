import { createHash } from 'node:crypto';

export function keyFromAddress(address) {
  if (typeof address !== 'string' || address.length === 0) throw new TypeError('empty random address');
  return createHash('sha256').update(address, 'utf8').digest('hex').slice(0, 16);
}

export function drawAddress(key, role, index, draw) {
  if (!/^[a-f0-9]{16}$/.test(key) || typeof role !== 'string' || role.length === 0) {
    throw new TypeError('invalid random key or role');
  }
  if (![index, draw].every((x) => Number.isSafeInteger(x) && x >= 0)) {
    throw new TypeError('random indices must be non-negative safe integers');
  }
  return JSON.stringify(['DT-P9-DRAW-v1', key, role, index, draw]);
}

export function openUniformFromDigest(digest) {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new TypeError('expected SHA-256 bytes');
  const j = Number(digest.readBigUInt64BE(0) >> 11n);
  // The exact protocol value lies in (0,1). Binary64 rounds its largest value
  // to 1; saturate only that endpoint to the largest representable value < 1.
  return Math.min((j + 0.5) / 2 ** 53, 1 - 2 ** -53);
}

export function uniformAt(key, role, index, draw) {
  return openUniformFromDigest(createHash('sha256').update(drawAddress(key, role, index, draw)).digest());
}

export function roleRandom(key, role, index, ledger = null) {
  let draw = 0;
  return {
    uniform() {
      ledger?.charge('rng_variate');
      return uniformAt(key, role, index, draw++);
    },
    integer(n) {
      if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('empty random choice');
      return Math.floor(this.uniform() * n);
    },
    choice(values) { return values[this.integer(values.length)]; },
    get draws() { return draw; },
  };
}
