import { readFileSync } from 'node:fs';

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function sourceError(source, line, message) {
  const location = line == null ? source : `${source}:${line}`;
  return new Error(`${location}: ${message}`);
}

/**
 * Parse a comma-separated text file without silently accepting malformed quoting.
 * The parser supports RFC 4180-style quoted fields and escaped double quotes.
 */
export function parseCsv(text, { source = '<csv>' } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('CSV input must be a string');
  }

  const input = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (input.trim().length === 0) {
    throw sourceError(source, null, 'CSV input is empty');
  }

  const records = [];
  let fields = [];
  let field = '';
  let line = 1;
  let recordStartLine = 1;
  let inQuotes = false;
  let afterClosingQuote = false;
  let fieldWasQuoted = false;
  let lastTokenWasRecordBreak = false;

  function finishField() {
    fields.push(field);
    field = '';
    fieldWasQuoted = false;
    afterClosingQuote = false;
  }

  function finishRecord() {
    finishField();
    records.push({ fields, line: recordStartLine });
    fields = [];
    recordStartLine = line + 1;
    lastTokenWasRecordBreak = true;
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        field += ch;
        if (ch === '\n') line++;
        if (ch === '\r' && input[i + 1] !== '\n') line++;
      }
      lastTokenWasRecordBreak = false;
      continue;
    }

    if (afterClosingQuote) {
      if (ch === ',') {
        finishField();
        lastTokenWasRecordBreak = false;
        continue;
      }
      if (ch === '\n') {
        finishRecord();
        line++;
        continue;
      }
      if (ch === '\r') {
        finishRecord();
        if (input[i + 1] === '\n') i++;
        line++;
        continue;
      }
      throw sourceError(source, line, 'unexpected character after a closing quote');
    }

    if (ch === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        throw sourceError(source, line, 'unexpected quote in an unquoted field');
      }
      inQuotes = true;
      fieldWasQuoted = true;
      lastTokenWasRecordBreak = false;
      continue;
    }

    if (ch === ',') {
      finishField();
      lastTokenWasRecordBreak = false;
      continue;
    }

    if (ch === '\n') {
      finishRecord();
      line++;
      continue;
    }

    if (ch === '\r') {
      finishRecord();
      if (input[i + 1] === '\n') i++;
      line++;
      continue;
    }

    field += ch;
    lastTokenWasRecordBreak = false;
  }

  if (inQuotes) {
    throw sourceError(source, recordStartLine, 'unterminated quoted field');
  }

  if (!lastTokenWasRecordBreak || field.length > 0 || fields.length > 0 || afterClosingQuote) {
    finishField();
    records.push({ fields, line: recordStartLine });
  }

  return records;
}

function normaliseLabelMap(labelMap) {
  const entries = labelMap instanceof Map
    ? [...labelMap.entries()]
    : Object.entries(labelMap ?? {});

  if (entries.length === 0) {
    throw new TypeError('labelMap must define the accepted target labels');
  }

  const classes = new Set();
  const map = new Map();
  for (const [label, value] of entries) {
    if (value !== 0 && value !== 1) {
      throw new TypeError(`labelMap value for ${JSON.stringify(label)} must be 0 or 1`);
    }
    map.set(String(label), value);
    classes.add(value);
  }

  if (!classes.has(0) || !classes.has(1)) {
    throw new TypeError('labelMap must map at least one label to each binary class, 0 and 1');
  }

  return map;
}

/**
 * Load a numeric binary-classification CSV with an explicitly named target column.
 * Unknown labels, malformed rows, blank cells and non-finite numeric values fail
 * before an experiment starts.
 */
/**
 * @param {string} filename
 * @param {{
 *   targetColumn?: string,
 *   labelMap?: Record<string, 0 | 1> | Map<string, 0 | 1>,
 *   includeIndex?: boolean,
 *   includeLabel?: boolean,
 * }} [options]
 */
export function loadNumericBinaryCsv(filename, {
  targetColumn,
  labelMap,
  includeIndex = false,
  includeLabel = false,
} = {}) {
  if (typeof targetColumn !== 'string' || targetColumn.length === 0) {
    throw new TypeError('targetColumn must be a non-empty string');
  }

  const records = parseCsv(readFileSync(filename, 'utf8'), { source: filename });
  const headerRecord = records[0];
  const header = headerRecord.fields;

  if (header.some((name) => name.length === 0)) {
    throw sourceError(filename, headerRecord.line, 'header contains an empty column name');
  }

  const duplicateHeaders = header.filter((name, index) => header.indexOf(name) !== index);
  if (duplicateHeaders.length > 0) {
    throw sourceError(
      filename,
      headerRecord.line,
      `header contains duplicate column name ${JSON.stringify(duplicateHeaders[0])}`,
    );
  }

  const targetIndex = header.indexOf(targetColumn);
  if (targetIndex === -1) {
    throw sourceError(filename, headerRecord.line, `missing target column ${JSON.stringify(targetColumn)}`);
  }

  if (header.length < 2) {
    throw sourceError(filename, headerRecord.line, 'at least one numeric feature column is required');
  }

  if (records.length === 1) {
    throw sourceError(filename, null, 'CSV contains a header but no data rows');
  }

  const labels = normaliseLabelMap(labelMap);
  const featureIndices = header.map((_, index) => index).filter((index) => index !== targetIndex);
  const featureNames = featureIndices.map((index) => header[index]);
  const rows = [];

  for (let dataIndex = 0; dataIndex < records.length - 1; dataIndex++) {
    const record = records[dataIndex + 1];
    const cells = record.fields;

    if (cells.length !== header.length) {
      throw sourceError(
        filename,
        record.line,
        `malformed row has ${cells.length} fields; expected ${header.length}`,
      );
    }

    const label = cells[targetIndex];
    if (!labels.has(label)) {
      throw sourceError(filename, record.line, `unexpected target label ${JSON.stringify(label)}`);
    }

    const x = featureIndices.map((columnIndex) => {
      const raw = cells[columnIndex];
      if (raw.trim().length === 0) {
        throw sourceError(
          filename,
          record.line,
          `blank numeric value in column ${JSON.stringify(header[columnIndex])}`,
        );
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw sourceError(
          filename,
          record.line,
          `non-finite numeric value ${JSON.stringify(raw)} in column ${JSON.stringify(header[columnIndex])}`,
        );
      }
      if (!DECIMAL_NUMBER.test(raw)) {
        throw sourceError(
          filename,
          record.line,
          `invalid decimal numeric value ${JSON.stringify(raw)} in column ${JSON.stringify(header[columnIndex])}`,
        );
      }
      return value;
    });

    const row = { x, y: labels.get(label) };
    if (includeIndex) row.index = dataIndex;
    if (includeLabel) row.label = label;
    rows.push(row);
  }

  return { rows, featureNames };
}
