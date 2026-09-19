import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(ROOT, 'working/f05/EVIDENCE_CONTRACT.json'), 'utf8'));
const finiteLoss = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

export function validateF02Record(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.partition !== 'DEV' || record.schema_version !== 1) throw new Error('F02 DEV record required');
  const kind = record.kind; const spec = CONTRACT.record_types[kind]; if (!spec) throw new Error('unknown F02 record kind');
  for (const key of ['kind', ...spec.required]) if (!Object.hasOwn(record, key)) throw new Error(`missing F02 field ${key}`);
  if (!spec.treatments.includes(record.treatment) || !spec.statuses.includes(record.status)) throw new Error('invalid treatment or status');
  for (const k of ['realisation','optimiser','checkpoint']) if (!Number.isSafeInteger(record[k]) || record[k] < 0) throw new Error(`invalid ${k}`);
  if (!Number.isSafeInteger(record.predictions) || record.predictions < 1) throw new Error('full future prediction denominator required');
  if (typeof record.scenario !== 'string' || !record.scenario || !record.resource || typeof record.resource !== 'object') throw new Error('invalid scenario/resource');
  if (!finiteLoss(record.loss)) throw new Error('every scientific treatment record needs finite full-horizon loss');
  if (kind === 'state') {
    if (record.status === 'TREATMENT_UNAVAILABLE' && record.loss !== 1) throw new Error('unavailable state treatment requires loss-one full horizon');
  } else {
    if (typeof record.eligible !== 'boolean') throw new Error('material eligibility required');
    if (record.status === 'COMPLETE' && !record.eligible) throw new Error('complete material record must be eligible');
    if (record.status !== 'COMPLETE' && record.eligible) throw new Error('ineligible material status contradicts eligibility');
    if (record.status === 'PARENT_UNAVAILABLE' && record.loss !== 1) throw new Error('unavailable material parent requires loss-one full horizon');
  }
  return true;
}
