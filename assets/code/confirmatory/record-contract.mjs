import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../working/phase9/EVIDENCE_CONTRACT.json');
const contract = JSON.parse(fs.readFileSync(file, 'utf8'));

function check(schema, value, location) {
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) throw new Error(`${location}: wrong constant`);
  if (schema.enum && !schema.enum.some((v) => Object.is(value, v))) throw new Error(`${location}: outside enumerated values`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const valid = types.some((type) => {
      if (type === 'null') return value === null;
      if (type === 'integer') return Number.isSafeInteger(value);
      if (type === 'string') return typeof value === 'string';
      if (type === 'boolean') return typeof value === 'boolean';
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      throw new Error(`${location}: unsupported schema type ${type}`);
    });
    if (!valid) throw new Error(`${location}: incorrect primitive type`);
  }
  if (typeof value === 'number' && (!Number.isFinite(value) || (Object.hasOwn(schema, 'minimum') && value < schema.minimum))) throw new Error(`${location}: invalid numeric value`);
  if (typeof value === 'string' && ((schema.minLength && value.length < schema.minLength)
    || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new Error(`${location}: invalid string`);
  if (schema.properties) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${location}.${key}: required field absent`);
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(schema.properties, key)) check(schema.properties[key], value[key], `${location}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${location}.${key}: unrecognised field`);
    }
  }
}
/** Validates the immutable Phase 9 payload, not a scientific effect or a complete run. */
export function validateProtocolRecord(kind, payload) {
  if (!Object.hasOwn(contract.records, kind)) throw new Error(`unknown Phase 9 record type: ${kind}`);
  check(contract.records[kind], payload, kind); return true;
}
export function validateRuntimePayload(event) {
  const { kind, ...payload } = event;
  if (kind === 'update' && payload.runtime_schema_version === 3) {
    const { runtime_schema_version, update_outcome, failure_latched, mandatory_stage_committed,
      scored_through_index, treatment_applied, arm, deployed_state_available,
      completed_updates_before, exhausted_axis, ...legacy } = payload;
    const completed = mandatory_stage_committed;
    const failed = failure_latched;
    if (runtime_schema_version !== 3 || typeof failed !== 'boolean' || typeof completed !== 'boolean'
      || typeof treatment_applied !== 'boolean' || typeof arm !== 'string' || !arm
      || typeof deployed_state_available !== 'boolean' || deployed_state_available === failed
      || !Number.isSafeInteger(completed_updates_before) || completed_updates_before < 0
      || legacy.update_index !== completed_updates_before + Number(completed)
      || ![null, 'APW', 'CPU', 'RSS'].includes(exhausted_axis)
      || (exhausted_axis === 'CPU' && legacy.budget_axis !== 'PROCESS_CPU_NS')
      || update_outcome !== (failed ? 'ALGORITHMIC_FAILURE' : completed ? 'COMMITTED' : 'RETAINED_AFTER_BUDGET_EXHAUSTION')
      || (failed && (legacy.population_size !== 0 || scored_through_index !== null || exhausted_axis === null))
      || (failed && completed && exhausted_axis !== 'RSS')
      || (!failed && (exhausted_axis === 'RSS' || !Number.isSafeInteger(scored_through_index)
        || scored_through_index < 1 || scored_through_index > legacy.window_last_index))
      || (!failed && completed && scored_through_index !== legacy.window_last_index)
      || (!failed && !completed && !['APW', 'CPU'].includes(exhausted_axis))
      || (!completed && legacy.completed_rounds !== 0)
      || (exhausted_axis !== null && legacy.partial_scratch_discarded !== true)
      || !Number.isSafeInteger(legacy.budget_cap) || legacy.budget_cap < 0) throw new Error('invalid version-3 update metadata');
    // V3 permits an explicit zero allowance. Preserve the immutable Phase 9
    // schema and its production population size while checking every base field.
    validateProtocolRecord('update', { ...legacy, population_size: failed ? 150 : legacy.population_size,
      budget_cap: legacy.budget_cap === 0 ? 1 : legacy.budget_cap });
    const total = Object.values(legacy.apw_components).reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total) || total !== legacy.adaptation_apw_total
      || (legacy.budget_axis === 'APW_v1' && total > legacy.budget_cap)) throw new Error('invalid version-3 adaptation accounting');
    return true;
  }
  if (kind === 'update_unavailable' && payload.runtime_schema_version === 3) {
    const baseFields = ['attempt_id', 'protocol_sha256', 'run_id', 'event_sequence', 'revealed_through_index',
      'window_first_index', 'window_last_index', 'budget_axis', 'apw_components', 'adaptation_apw_total',
      'update_index', 'snapshot_sha256'];
    const extraFields = ['runtime_schema_version', 'budget_cap', 'reason', 'failure_latched', 'parent_unavailable',
      'treatment_applied', 'population_size', 'scored_through_index', 'deployed_state_available'];
    if (Object.keys(payload).sort().join(',') !== [...baseFields, ...extraFields].sort().join(',')
      || payload.failure_latched !== true || payload.population_size !== 0 || payload.treatment_applied !== false
      || payload.deployed_state_available !== false || payload.scored_through_index !== null
      || typeof payload.parent_unavailable !== 'boolean'
      || payload.reason !== (payload.parent_unavailable ? 'PARENT_UNAVAILABLE' : 'ALGORITHMIC_FAILURE_LATCHED')
      || !Number.isSafeInteger(payload.budget_cap) || payload.budget_cap < 0
      || payload.adaptation_apw_total !== 0) throw new Error('invalid version-3 unavailable update');
    for (const key of baseFields) check(contract.records.update.properties[key], payload[key], `update_unavailable.${key}`);
    if (Object.values(payload.apw_components).some((v) => v !== 0)) throw new Error('unavailable update spent adaptation work');
    return true;
  }
  if (kind === 'update' && payload.runtime_schema_version === 2) {
    const { runtime_schema_version, update_outcome, failure_latched, mandatory_stage_committed,
      scored_through_index, treatment_applied, arm, ...legacy } = payload;
    if (runtime_schema_version !== 2 || typeof failure_latched !== 'boolean' || typeof mandatory_stage_committed !== 'boolean'
      || typeof treatment_applied !== 'boolean' || typeof arm !== 'string' || !arm
      || (scored_through_index !== null && (!Number.isSafeInteger(scored_through_index) || scored_through_index < 1))
      || !['ALGORITHMIC_FAILURE', 'COMMITTED', 'RETAINED_AFTER_BUDGET_EXHAUSTION'].includes(update_outcome)
      || failure_latched !== (update_outcome === 'ALGORITHMIC_FAILURE')
      || mandatory_stage_committed !== (update_outcome === 'COMMITTED')
      || (update_outcome === 'COMMITTED' && scored_through_index !== legacy.window_last_index)) throw new Error('invalid version-2 update metadata');
    // V2 explicitly permits an empty failed population. The historical schema is unchanged.
    if (failure_latched && legacy.population_size !== 0) throw new Error('failed population must be empty');
    validateProtocolRecord('update', { ...legacy, population_size: failure_latched ? 150 : legacy.population_size });
    return true;
  }
  return validateProtocolRecord(kind, payload);
}
