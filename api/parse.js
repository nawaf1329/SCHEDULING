export const config = {
  api: {
    bodyParser: { sizeLimit: '5mb' },
  },
};

const OPENAI_TIMEOUT_MS = 25_000;
const AI_MAPPING_MIN_CONFIDENCE = 95;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini-2024-07-18';

/* ═══════════════════════════════════════════════
   ENTRY POINT
═══════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body || {};

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Missing schedule text' });
  }

  try {
    const result = await parseSchedule(text);
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Parser error:', err);
    return res.status(500).json({ error: 'Parse error: ' + err.message });
  }
}

/* ═══════════════════════════════════════════════
   MAIN ORCHESTRATOR
═══════════════════════════════════════════════ */
async function parseSchedule(text) {
  const lines = normalizeText(text).split('\n');

  /* 1 ── PERIOD */
  let start = null;
  let end = null;

  for (const line of lines) {
    const p = parsePeriodLine(line);
    if (p) {
      start = p.start;
      end = p.end;
      break;
    }
  }

  let period = start && end ? { start, end } : null;

  /* 2 ── UNIT */
  let unit = '—';

  for (const line of lines) {
    const m = line.match(/[Uu]nit\s*[:\-]?\s*([^\n|,]+)/);
    if (m) {
      unit = m[1].trim();
      break;
    }
  }

  /* 3 ── EXPECTED NAMES */
  const expectedNames = extractExpectedNames(text);
  const expectedFromIndex = expectedNames.length;

  const expectedCount =
    expectedFromIndex > 0
      ? expectedFromIndex
      : detectExpectedCountFallback(text);

  /* 4 ── DIAGNOSTICS COLLECTOR */
  const collector = {
    unknownStatusRows: [],
    invalidDateRows: [],
    duplicateNameKeys: [],
  };

  /* 5 ── LOCAL PARSER */
  const rawBlocks = splitIntoBlocks(text);
  const employeeMap = new Map();

  for (const block of rawBlocks) {
    const emp = parseBlock(block, period, collector);
    if (!emp) continue;
    mergeIntoMap(emp, employeeMap, collector);
  }

  /* 6 ── HORIZONTAL TABLE FALLBACK */
  if (employeeMap.size === 0) {
    const htEmps = parseHorizontalTable(text, period, collector);
    if (htEmps) {
      htEmps.forEach((emp) => mergeIntoMap(emp, employeeMap, collector));
    }
  }

  let parsedEmployees = Array.from(employeeMap.values());

  /* 7 ── INFER PERIOD FROM PARSED ISO DATES ONLY */
  if (!start || !end) {
    const all = parsedEmployees
      .flatMap((e) => ['D', 'N', 'AL', 'RO', 'X'].flatMap((k) => e[k]))
      .sort();

    if (all.length) {
      start = start || all[0];
      end = end || all[all.length - 1];
      period = { start, end };
    }
  }

  /* 8 ── FORMAT DETECTOR BEFORE HARD VALIDATION */
  if (parsedEmployees.length === 0 && process.env.OPENAI_API_KEY) {
    let fmt = null;

    try {
      fmt = await callOpenAIFormatDetector(text, {
        parsedCount: 0,
        expectedCount,
        periodDays: start && end ? countDaysInclusive(start, end) : null,
      });
    } catch (e) {
      console.error('Format detector failed:', e.message);
    }

    return {
      status: 422,
      body: {
        error: 'Local parser could not read any employees.',
        formatDetection: fmt || null,
      },
    };
  }

  /* 9 ── DIAGNOSTICS */
  let diagnostics = buildDiagnostics({
    expectedNames,
    expectedCount,
    parsedEmployees,
    employeeMap,
    collector,
    period: start && end ? { start, end } : null,
  });

  /* 10 ── HARD VALIDATION */
  let hardError = validateHard(diagnostics);

  if (hardError) {
    return {
      status: 422,
      body: {
        error: hardError,
        diagnostics: slimDiagnostics(diagnostics),
      },
    };
  }

  /* 11 ── UNKNOWN STATUS AUTO-RESOLUTION THROUGH AI */
  if (diagnostics.unknownStatusRows.length > 0) {
    if (!process.env.OPENAI_API_KEY) {
      return {
        status: 422,
        body: {
          error:
            `${diagnostics.unknownStatusRows.length} unrecognized status row(s) found. ` +
            'OPENAI_API_KEY is required to resolve them automatically.',
          unknownStatusRows: diagnostics.unknownStatusRows
            .slice(0, 10)
            .map((r) => ({
              status: r.status,
              employee: r.employee,
              date: r.date,
            })),
        },
      };
    }

    let audit;

    try {
      audit = await callOpenAIAudit(
        buildAuditPayload(text, rawBlocks, diagnostics)
      );
    } catch (e) {
      return {
        status: 422,
        body: {
          error:
            'AI audit timed out or failed. Cannot output result with unresolved status rows.',
          details: e.message,
        },
      };
    }

    if (
      !audit.pass ||
      audit.confidence < 80 ||
      audit.recommendedAction === 'block_output'
    ) {
      return {
        status: 422,
        body: {
          error: 'AI audit blocked this output.',
          severity: audit.severity,
          issues: audit.issues,
          recommendedAction: audit.recommendedAction,
          confidence: audit.confidence,
        },
      };
    }

    const mappingValidation = validateSuggestedMappings(
      audit.suggestedMappings || [],
      diagnostics.unknownStatusRows
    );

    if (!mappingValidation.ok) {
      return {
        status: 422,
        body: {
          error: mappingValidation.error,
          unknownStatusRows: diagnostics.unknownStatusRows
            .slice(0, 10)
            .map((r) => ({
              status: r.status,
              employee: r.employee,
              date: r.date,
            })),
          suggestedMappings: audit.suggestedMappings || [],
        },
      };
    }

    const stillUnresolved = applyMappingsToUnknowns({
      unknownRows: diagnostics.unknownStatusRows,
      mappingDict: mappingValidation.mappingDict,
      employeeMap,
    });

    collector.unknownStatusRows = stillUnresolved;
    parsedEmployees = Array.from(employeeMap.values());

    diagnostics = buildDiagnostics({
      expectedNames,
      expectedCount,
      parsedEmployees,
      employeeMap,
      collector,
      period: start && end ? { start, end } : null,
    });

    hardError = validateHard(diagnostics);

    if (hardError) {
      return {
        status: 422,
        body: {
          error: hardError,
          diagnostics: slimDiagnostics(diagnostics),
        },
      };
    }

    if (diagnostics.unknownStatusRows.length > 0) {
      return {
        status: 422,
        body: {
          error:
            `${diagnostics.unknownStatusRows.length} status row(s) remain unresolved after AI mapping.`,
          unknownStatusRows: diagnostics.unknownStatusRows
            .slice(0, 10)
            .map((r) => ({
              status: r.status,
              employee: r.employee,
              date: r.date,
            })),
        },
      };
    }
  }

  /* 12 ── OPTIONAL AI VERIFY MODE */
  if (
    process.env.AI_VERIFY === 'true' &&
    process.env.OPENAI_API_KEY &&
    diagnostics.unknownStatusRows.length === 0
  ) {
    try {
      const audit = await callOpenAIAudit(
        buildAuditPayload(text, rawBlocks, diagnostics)
      );

      if (
        !audit.pass ||
        audit.confidence < 80 ||
        audit.recommendedAction === 'block_output'
      ) {
        return {
          status: 422,
          body: {
            error: 'AI audit blocked this output.',
            severity: audit.severity,
            issues: audit.issues,
            confidence: audit.confidence,
          },
        };
      }
    } catch (e) {
      console.error('AI_VERIFY audit skipped:', e.message);
    }
  }

  /* 13 ── FINAL OUTPUT */
  const employees = parsedEmployees
    .map((emp) => ({
      name: emp.name,
      role: emp.role || '',
      D: [...new Set(emp.D)].sort(),
      N: [...new Set(emp.N)].sort(),
      AL: [...new Set(emp.AL)].sort(),
      RO: [...new Set(emp.RO)].sort(),
      X: [...new Set(emp.X)].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    status: 200,
    body: {
      unit,
      start,
      end,
      employees,
    },
  };
}

/* ═══════════════════════════════════════════════
   MERGE
═══════════════════════════════════════════════ */
function mergeIntoMap(emp, employeeMap, collector) {
  const key = normalizeName(emp.name);

  if (!key) return;

  if (employeeMap.has(key)) {
    const existing = employeeMap.get(key);

    for (const code of ['D', 'N', 'AL', 'RO', 'X']) {
      for (const d of emp[code]) {
        if (!existing[code].includes(d)) {
          existing[code].push(d);
        }
      }
    }

    existing._rowCount += emp._rowCount || 0;

    if (emp._blockType === 'NUMBERED' && existing._blockType !== 'NUMBERED') {
      existing.name = emp.name;
      existing._blockType = 'NUMBERED';
    }

    if (emp.role && !existing.role) {
      existing.role = emp.role;
    }

    collector.duplicateNameKeys.push(key);
  } else {
    employeeMap.set(key, emp);
  }
}

/* ═══════════════════════════════════════════════
   DIAGNOSTICS
═══════════════════════════════════════════════ */
function buildDiagnostics({
  expectedNames,
  expectedCount,
  parsedEmployees,
  employeeMap,
  collector,
  period,
}) {
  const parsedNamesSet = new Set(
    parsedEmployees.map((e) => normalizeName(e.name)).filter(Boolean)
  );

  const missingNames = expectedNames.filter((n) => !parsedNamesSet.has(n));

  const periodDays = period
    ? countDaysInclusive(period.start, period.end)
    : null;

  const rowCountByEmployee = {};
  const employeesWithLowRowCount = [];

  for (const emp of employeeMap.values()) {
    rowCountByEmployee[emp.name] = emp._rowCount || 0;

    const threshold = periodDays
      ? Math.max(3, Math.floor(periodDays * 0.1))
      : 3;

    if ((emp._rowCount || 0) < threshold && totalDates(emp) === 0) {
      employeesWithLowRowCount.push(emp.name);
    }
  }

  return {
    expectedCount,
    parsedCount: parsedEmployees.length,
    expectedNames,
    parsedNames: [...parsedNamesSet],
    missingNames,
    unknownStatusRows: collector.unknownStatusRows,
    invalidDateRows: collector.invalidDateRows,
    duplicateNameKeys: [...new Set(collector.duplicateNameKeys)],
    employeesWithLowRowCount,
    periodDays,
    rowCountByEmployee,
  };
}

function slimDiagnostics(d) {
  return {
    expectedCount: d.expectedCount,
    parsedCount: d.parsedCount,
    missingNames: (d.missingNames || []).slice(0, 20),
    unknownStatusRows: (d.unknownStatusRows || [])
      .slice(0, 20)
      .map((r) => ({
        status: r.status,
        employee: r.employee,
        date: r.date,
      })),
    invalidDateRows: (d.invalidDateRows || []).slice(0, 10),
    duplicateNameKeys: (d.duplicateNameKeys || []).slice(0, 10),
    employeesWithLowRowCount: (d.employeesWithLowRowCount || []).slice(0, 10),
    periodDays: d.periodDays || null,
  };
}

/* ═══════════════════════════════════════════════
   VALIDATOR
═══════════════════════════════════════════════ */
function validateHard(d) {
  if (!d.periodDays) {
    return 'Schedule period not found. Add a Period line, e.g.: Period: 04/26/2026 - 06/06/2026';
  }

  if (d.parsedCount === 0) {
    return 'No staff records found. Check that the file contains employee names and daily schedule rows.';
  }

  if (d.expectedCount > 0 && d.parsedCount < d.expectedCount) {
    return `Parsing incomplete: expected ${d.expectedCount} staff, parsed ${d.parsedCount} staff.`;
  }

  if (d.missingNames.length > 0) {
    return `Missing staff: ${d.missingNames.join(', ')}.`;
  }

  if (d.invalidDateRows.length > 0) {
    return `Invalid date rows found: ${d.invalidDateRows
      .slice(0, 3)
      .join(' | ')}`;
  }

  return null;
}

/* ═══════════════════════════════════════════════
   BLOCK SPLITTER
═══════════════════════════════════════════════ */
function isBlockHeader(line) {
  const t = line.trim();

  return (
    /^\d{1,3}\.\s+[A-Z][A-Za-z]/.test(t) ||
    /^QUICK\s+SECTION\s*[-–—:]/i.test(t) ||
    /^EMPLOYEE\s*:\s*\S/i.test(t)
  );
}

function splitIntoBlocks(text) {
  const lines = normalizeText(text).split('\n');
  const blocks = [];
  let current = [];

  for (const line of lines) {
    if (isBlockHeader(line)) {
      if (current.length > 0) {
        const b = current.join('\n').trim();
        if (b.length > 5) blocks.push(b);
      }

      current = [line];
    } else if (/^={4,}/.test(line.trim()) || /^-{4,}/.test(line.trim())) {
      if (current.length > 0) {
        const b = current.join('\n').trim();
        if (b.length > 5) blocks.push(b);
        current = [];
      }
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const b = current.join('\n').trim();
    if (b.length > 5) blocks.push(b);
  }

  if (blocks.length === 0) {
    return normalizeText(text)
      .split(/\n?={4,}\n?/)
      .map((b) => b.trim())
      .filter((b) => b.length > 5);
  }

  return blocks;
}

/* ═══════════════════════════════════════════════
   BLOCK PARSER
═══════════════════════════════════════════════ */
function parseBlock(blockText, period, collector) {
  if (!blockText || blockText.trim().length < 5) return null;

  const lines = normalizeText(blockText)
    .split('\n')
    .map((l) => l.trimEnd());

  let empName = null;
  let empRole = '';
  let blockType = null;
  let dataStart = 0;

  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i].trim();

    if (!line) continue;

    let m = line.match(/^QUICK\s+SECTION\s*[-–—:]\s*(.+)/i);

    if (m) {
      empRole = extractBracketRole(m[1]) || '';
      empName = cleanName(m[1]);
      blockType = 'QUICK';
      dataStart = i + 1;

      const sr = findSkillLine(lines, i + 1, 4);

      if (sr) {
        empRole = sr.role;
        dataStart = sr.next;
      }

      break;
    }

    m = line.match(/^EMPLOYEE\s*:\s*(.+)/i);

    if (m) {
      empRole = extractBracketRole(m[1]) || '';
      empName = cleanName(m[1]);
      blockType = 'EMPLOYEE';
      dataStart = i + 1;

      const sr = findSkillLine(lines, i + 1, 4);

      if (sr) {
        empRole = sr.role;
        dataStart = sr.next;
      }

      break;
    }

    m = line.match(/^\d{1,3}\.\s+(.+)/);

    if (m) {
      empRole = extractBracketRole(m[1]) || '';
      empName = cleanName(m[1]);
      blockType = 'NUMBERED';
      dataStart = i + 1;

      const sr = findSkillLine(lines, i + 1, 8);

      if (sr) {
        empRole = sr.role;
        dataStart = sr.next;
      }

      break;
    }
  }

  if (!empName) return null;

  const emp = {
    name: empName,
    role: empRole,
    _blockType: blockType,
    _rowCount: 0,
    D: [],
    N: [],
    AL: [],
    RO: [],
    X: [],
  };

  for (let i = dataStart; i < lines.length; i++) {
    parseDailyRow(lines[i].trim(), emp, period, collector);
  }

  if (totalDates(emp) === 0 && emp._rowCount === 0) {
    parseSectionMode(lines, dataStart, emp, period);
  }

  return emp._rowCount > 0 || totalDates(emp) > 0 ? emp : null;
}

/* ═══════════════════════════════════════════════
   DAILY ROW PARSER
═══════════════════════════════════════════════ */
function parseDailyRow(line, emp, period, collector) {
  if (!line) return;

  let m = line.match(
    /^(\d{1,2})\/(\d{1,2})(?:\s+\w{2,10})?\s*:\s*(.*)/
  );

  if (m) {
    emp._rowCount++;

    const date = buildDate(m[1], m[2], period);

    if (!date) {
      collector.invalidDateRows.push(line);
      return;
    }

    const rawStatus = m[3] || '';
    const c = mapStatus(rawStatus);

    if (c) {
      emp[c].push(date);
    } else {
      pushUnknownStatus(rawStatus, line, emp, date, collector);
    }

    return;
  }

  m = line.match(
    /^(\d{1,2})\/(\d{1,2})\s+(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(.*)/i
  );

  if (m) {
    emp._rowCount++;

    const date = buildDate(m[1], m[2], period);

    if (!date) {
      collector.invalidDateRows.push(line);
      return;
    }

    const rawStatus = m[3] || '';
    const c = mapStatus(rawStatus);

    if (c) {
      emp[c].push(date);
    } else {
      pushUnknownStatus(rawStatus, line, emp, date, collector);
    }

    return;
  }

  m = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.*)/);

  if (m) {
    emp._rowCount++;

    const date = `${m[1]}-${m[2]}-${m[3]}`;
    const rawStatus = m[4] || '';
    const c = mapStatus(rawStatus);

    if (c) {
      emp[c].push(date);
    } else {
      pushUnknownStatus(rawStatus, line, emp, date, collector);
    }
  }
}

function pushUnknownStatus(rawStatus, line, emp, date, collector) {
  const status = String(rawStatus || '').trim();

  if (!status || status === '-') return;

  collector.unknownStatusRows.push({
    line,
    status,
    employee: emp.name,
    normalizedKey: normalizeName(emp.name),
    date,
  });
}

/* ═══════════════════════════════════════════════
   HORIZONTAL TABLE PARSER
═══════════════════════════════════════════════ */
function parseHorizontalTable(text, period, collector) {
  const lines = normalizeText(text).split('\n');

  let headerIdx = -1;
  let colDateMap = [];
  let usePipe = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('|')) {
      const cells = line.split('|').map((c) => c.trim());

      const dated = cells
        .map((c, idx) => ({ idx, date: parseHeaderDate(c, period) }))
        .filter((x) => x.date);

      if (dated.length >= 3) {
        headerIdx = i;
        colDateMap = dated;
        usePipe = true;
        break;
      }
    }

    const iso = line.match(/\d{4}-\d{2}-\d{2}/g) || [];

    if (iso.length >= 3) {
      let col = 1;
      colDateMap = iso.map((date) => ({ idx: col++, date }));
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1 || colDateMap.length < 3) return null;

  const employees = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!line.trim()) continue;

    const cells = usePipe
      ? line.split('|').map((c) => c.trim())
      : line.split(/\s{2,}|\t/).map((c) => c.trim());

    if (cells.length < 2) continue;

    const nameCell = cleanName(cells[0]);

    if (!looksLikeName(nameCell)) continue;

    const emp = {
      name: nameCell,
      role: '',
      _blockType: 'HORIZONTAL',
      _rowCount: 0,
      D: [],
      N: [],
      AL: [],
      RO: [],
      X: [],
    };

    for (const { idx, date } of colDateMap) {
      const raw = (cells[idx] || '').trim();

      emp._rowCount++;

      const c = mapStatus(raw);

      if (c) {
        emp[c].push(date);
      } else if (raw && raw !== '-') {
        collector.unknownStatusRows.push({
          line,
          status: raw,
          employee: nameCell,
          normalizedKey: normalizeName(nameCell),
          date,
        });
      }
    }

    if (emp._rowCount > 0) {
      employees.push(emp);
    }
  }

  return employees.length >= 2 ? employees : null;
}

function parseHeaderDate(cell, period) {
  if (!cell) return null;

  const clean = cell.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;

  const a = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (a) {
    return `${a[3]}-${a[1].padStart(2, '0')}-${a[2].padStart(2, '0')}`;
  }

  const b = clean.match(/^(\d{1,2})\/(\d{1,2})$/);

  if (b && period) {
    return buildDate(b[1], b[2], period);
  }

  return null;
}

function looksLikeName(str) {
  if (!str || str.length < 2 || str.length > 80) return false;
  if (/^\d+$/.test(str)) return false;
  if (/^\d{1,2}\/\d{1,2}/.test(str)) return false;
  if (/^\d{4}-\d{2}/.test(str)) return false;

  return (str.match(/[A-Za-z]/g) || []).length >= 2;
}

/* ═══════════════════════════════════════════════
   SECTION MODE
═══════════════════════════════════════════════ */
function parseSectionMode(lines, startIdx, emp, period) {
  let mode = null;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) continue;

    const label = getSectionLabel(line);

    if (label) {
      mode = label;
      continue;
    }

    if (!mode) continue;

    const rng = line.match(
      /(\d{4}-\d{2}-\d{2})(?:\s*\([^)]*\))?\s*[-–—>]+\s*(\d{4}-\d{2}-\d{2})/
    );

    if (rng) {
      expandRange(rng[1], rng[2]).forEach((d) => emp[mode].push(d));
      continue;
    }

    const iso = line.match(/\d{4}-\d{2}-\d{2}/g);

    if (iso) {
      iso.forEach((d) => emp[mode].push(d));
      continue;
    }

    if (period) {
      const mmdd = [...line.matchAll(/(\d{1,2})\/(\d{1,2})/g)];

      mmdd.forEach((m) => {
        const d = buildDate(m[1], m[2], period);
        if (d) emp[mode].push(d);
      });
    }
  }
}

function getSectionLabel(line) {
  const l = line.replace(/^[-•*\s]+/, '').toLowerCase();

  if (/^day\s*shift/.test(l)) return 'D';
  if (/^night\s*shift/.test(l)) return 'N';

  if (
    /^annual\s*leave/.test(l) ||
    /^al\s*:/.test(l) ||
    /^leave\s*:/.test(l)
  ) {
    return 'AL';
  }

  if (/^request.?off/.test(l) || /^ro\s*:/.test(l)) return 'RO';

  if (/^other\s*(off|rest)/.test(l) || /^off\/rest/.test(l)) return 'X';

  return null;
}

/* ═══════════════════════════════════════════════
   STATUS MAPPING
═══════════════════════════════════════════════ */
function mapStatus(raw) {
  if (!raw) return null;

  const s = String(raw).trim();

  if (!s || s === '-' || s === '—' || s === '–') return null;

  const u = s.toUpperCase().replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

  if (/^D(\s|$|\d)/.test(u) || u === 'DAY' || /^DAY\s/.test(u)) return 'D';

  if (/^N(\s|$|\d)/.test(u) || u === 'NIGHT' || /^NIGHT\s/.test(u)) return 'N';

  if (
    /^ANNUAL/.test(u) ||
    u === 'AL' ||
    u === 'A/L' ||
    /^LEAVE/.test(u) ||
    /^VACATION/.test(u)
  ) {
    return 'AL';
  }

  if (
    /^REQUEST/.test(u) ||
    /^REQ\s/.test(u) ||
    u === 'RO' ||
    u === 'R/O'
  ) {
    return 'RO';
  }

  if (
    /^REST/.test(u) ||
    u === 'OFF' ||
    /^OFF\s/.test(u) ||
    /^PUBLIC HOLIDAY/.test(u) ||
    u === 'PH'
  ) {
    return 'X';
  }

  if (
    /^EDU/.test(u) ||
    /^STUDY/.test(u) ||
    /^TRAINING/.test(u) ||
    /^SEMINAR/.test(u)
  ) {
    return 'D';
  }

  return null;
}

/* ═══════════════════════════════════════════════
   AI AUDIT
═══════════════════════════════════════════════ */
function buildAuditPayload(text, rawBlocks, diagnostics) {
  const lines = normalizeText(text).split('\n');
  const first80 = lines.slice(0, 80).join('\n');

  const firstSep = text.indexOf('====');
  const preamble = firstSep > 0 ? text.slice(0, firstSep) : text.slice(0, 3000);

  const indexRows = (preamble.match(/^\s*\d{1,3}\.\s+.+/gm) || [])
    .slice(0, 80)
    .join('\n');

  const sampleBlocks = rawBlocks
    .slice(0, 4)
    .map((b) => b.slice(0, 500))
    .join('\n---\n');

  return {
    first80Lines: first80,
    employeeIndex: indexRows || 'Not found',
    sampleBlocks,
    diagnostics: slimDiagnostics(diagnostics),
  };
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    severity: {
      type: 'string',
      enum: ['none', 'low', 'medium', 'high'],
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: [
              'missing_employee',
              'unknown_status',
              'wrong_period',
              'unsupported_format',
              'low_confidence',
              'other',
            ],
          },
          message: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['type', 'message', 'evidence'],
        additionalProperties: false,
      },
    },
    recommendedAction: {
      type: 'string',
      enum: ['accept', 'block_output', 'needs_format_fallback'],
    },
    detectedFormat: {
      type: 'string',
      enum: [
        'daily_rows_under_employee',
        'horizontal_table',
        'section_mode',
        'unknown',
      ],
    },
    confidence: { type: 'number' },
    suggestedMappings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rawStatus: { type: 'string' },
          mappedCode: {
            type: 'string',
            enum: ['D', 'N', 'AL', 'RO', 'X', 'skip'],
          },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['rawStatus', 'mappedCode', 'confidence', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'pass',
    'severity',
    'issues',
    'recommendedAction',
    'detectedFormat',
    'confidence',
    'suggestedMappings',
  ],
  additionalProperties: false,
};

async function callOpenAIAudit(payload) {
  const body = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are a hospital staff schedule audit assistant. ' +
          'You receive parser diagnostics and schedule text samples. ' +
          'You do NOT produce, modify, or return employee schedule arrays. ' +
          'You only return an audit report. ' +
          'If unknownStatusRows exist, provide suggestedMappings for each rawStatus only when you are highly confident. ' +
          'Use D=day shift, N=night shift, AL=annual leave, RO=request off, X=rest/off, skip=intentional non-shift annotation. ' +
          'Never invent employees. Never create schedule dates.',
      },
      {
        role: 'user',
        content:
          '=== FIRST 80 LINES ===\n' +
          payload.first80Lines +
          '\n\n=== EMPLOYEE INDEX ===\n' +
          payload.employeeIndex +
          '\n\n=== SAMPLE BLOCKS ===\n' +
          payload.sampleBlocks +
          '\n\n=== PARSER DIAGNOSTICS ===\n' +
          JSON.stringify(payload.diagnostics, null, 2),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'audit_report',
        strict: true,
        schema: AUDIT_SCHEMA,
      },
    },
    max_tokens: 1400,
    temperature: 0,
  };

  return callOpenAIJson(body, 'OpenAI audit');
}

/* ═══════════════════════════════════════════════
   AI FORMAT DETECTOR
═══════════════════════════════════════════════ */
const FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    detectedFormat: {
      type: 'string',
      enum: [
        'daily_rows_under_employee',
        'horizontal_table',
        'section_mode',
        'unknown',
      ],
    },
    datePattern: {
      type: 'string',
      enum: ['MM/DD/YYYY', 'YYYY-MM-DD', 'MM/DD', 'unknown'],
    },
    employeeHeaderPattern: {
      type: 'string',
      enum: ['numbered', 'QUICK_SECTION', 'EMPLOYEE_label', 'unknown'],
    },
    parsingPlan: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: [
    'detectedFormat',
    'datePattern',
    'employeeHeaderPattern',
    'parsingPlan',
    'confidence',
  ],
  additionalProperties: false,
};

async function callOpenAIFormatDetector(text, diagnostics) {
  const first80 = normalizeText(text).split('\n').slice(0, 80).join('\n');

  const body = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You are a schedule format detector. ' +
          'Return only a format detection plan. ' +
          'Do NOT produce employees, schedules, dates arrays, or parsed output.',
      },
      {
        role: 'user',
        content:
          '=== SCHEDULE SAMPLE ===\n' +
          first80 +
          '\n\n=== DIAGNOSTICS ===\n' +
          JSON.stringify(diagnostics, null, 2),
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'format_detection',
        strict: true,
        schema: FORMAT_SCHEMA,
      },
    },
    max_tokens: 600,
    temperature: 0,
  };

  return callOpenAIJson(body, 'OpenAI format detector');
}

async function callOpenAIJson(body, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      throw new Error(`${label} ${resp.status}: ${e.error?.message || 'unknown error'}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error(`${label}: empty response`);
    }

    return JSON.parse(content);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${label} timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════
   AI MAPPING VALIDATION
═══════════════════════════════════════════════ */
function validateSuggestedMappings(suggestedMappings, unknownRows) {
  const allowedCodes = new Set(['D', 'N', 'AL', 'RO', 'X', 'skip']);

  const unknownKeys = new Set(
    unknownRows.map((r) => normalizeStatusKey(r.status))
  );

  const mappingDict = {};
  const conflicts = [];

  for (const m of suggestedMappings || []) {
    const key = normalizeStatusKey(m.rawStatus);
    const code = m.mappedCode;
    const confidence = Number(m.confidence);

    if (!unknownKeys.has(key)) {
      continue;
    }

    if (!allowedCodes.has(code)) {
      return {
        ok: false,
        error: `Invalid AI mapping code for status "${m.rawStatus}".`,
      };
    }

    if (!Number.isFinite(confidence) || confidence < AI_MAPPING_MIN_CONFIDENCE) {
      return {
        ok: false,
        error:
          `AI confidence too low for status "${m.rawStatus}" ` +
          `(${confidence}/100). Required ${AI_MAPPING_MIN_CONFIDENCE}/100.`,
      };
    }

    if (mappingDict[key] && mappingDict[key].mappedCode !== code) {
      conflicts.push(m.rawStatus);
    }

    mappingDict[key] = {
      mappedCode: code,
      confidence,
      reason: m.reason || '',
    };
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error: `Conflicting AI mappings found for: ${conflicts.join(', ')}`,
    };
  }

  const missing = [...unknownKeys].filter((key) => !mappingDict[key]);

  if (missing.length > 0) {
    return {
      ok: false,
      error: `AI did not resolve all unknown statuses: ${missing.join(', ')}`,
    };
  }

  return {
    ok: true,
    mappingDict,
  };
}

function applyMappingsToUnknowns({ unknownRows, mappingDict, employeeMap }) {
  const stillUnresolved = [];

  for (const row of unknownRows) {
    const key = normalizeStatusKey(row.status);
    const mapping = mappingDict[key];

    if (!mapping) {
      stillUnresolved.push(row);
      continue;
    }

    const code = mapping.mappedCode;

    if (code === 'skip') {
      continue;
    }

    const emp = employeeMap.get(row.normalizedKey);

    if (!emp || !row.date) {
      stillUnresolved.push(row);
      continue;
    }

    emp[code].push(row.date);
  }

  return stillUnresolved;
}

/* ═══════════════════════════════════════════════
   PERIOD / DATE
═══════════════════════════════════════════════ */
function parsePeriodLine(line) {
  let m = line.match(
    /(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|–|—|to)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i
  );

  if (m) {
    return {
      start: `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`,
      end: `${m[6]}-${m[4].padStart(2, '0')}-${m[5].padStart(2, '0')}`,
    };
  }

  m = line.match(
    /(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to)\s*(\d{4}-\d{2}-\d{2})/i
  );

  if (m) {
    return {
      start: m[1],
      end: m[2],
    };
  }

  return null;
}

function buildDate(month, day, period) {
  if (!period || !period.start || !period.end) {
    return null;
  }

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const sy = parseInt(period.start.slice(0, 4), 10);

  for (const y of [sy, sy + 1, sy - 1]) {
    const candidate = `${y}-${mm}-${dd}`;

    if (candidate >= period.start && candidate <= period.end) {
      return candidate;
    }
  }

  return null;
}

function countDaysInclusive(startIso, endIso) {
  const start = new Date(startIso + 'T00:00:00Z');
  const end = new Date(endIso + 'T00:00:00Z');

  return Math.round((end - start) / 86_400_000) + 1;
}

/* ═══════════════════════════════════════════════
   EXPECTED NAMES
═══════════════════════════════════════════════ */
function extractExpectedNames(text) {
  const keys = new Set();

  const matches = [
    ...normalizeText(text).matchAll(
      /^\s*\d{1,3}\.\s+([A-Z][A-Za-z\s,\-'\.]{2,})(?:\s*(?:\[|\(|-|$))/gm
    ),
  ];

  for (const m of matches) {
    const name = cleanName(m[1].trim());

    if (name && name.length >= 3 && /[A-Za-z]{2,}/.test(name)) {
      keys.add(normalizeName(name));
    }
  }

  return [...keys];
}

function detectExpectedCountFallback(text) {
  const quick = (text.match(/QUICK\s+SECTION/gi) || []).length;
  const empLbl = (text.match(/^EMPLOYEE\s*:/gim) || []).length;
  const seps = (text.match(/={4,}/g) || []).length;

  if (quick >= 3) return quick;
  if (empLbl >= 3) return empLbl;
  if (seps >= 3) return seps;

  return 0;
}

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/\u00A0/g, ' ');
}

function expandRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const stop = new Date(to + 'T00:00:00Z');

  while (cur <= stop) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return dates;
}

function cleanName(str) {
  return String(str || '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s+-\s+(SN|AHN|CA|RN|NA|NURSE|STAFF).*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBracketRole(str) {
  const square = String(str || '').match(/\[([^\]]+)\]/);
  if (square) return square[1].trim();

  const round = String(str || '').match(/\(([^)]+)\)/);
  if (round) return round[1].trim();

  return null;
}

function findSkillLine(lines, startIdx, maxLook) {
  for (let i = startIdx; i < Math.min(lines.length, startIdx + maxLook); i++) {
    const line = lines[i].trim();

    if (!line) continue;

    if (/^\d{1,2}\/\d{1,2}/.test(line) || /^\d{4}-\d{2}/.test(line)) {
      return null;
    }

    const m = line.match(/^(?:[Ss]kill|[Rr]ole)\s*:?\s*([^\n|]+)/);

    if (m) {
      return {
        role: m[1].trim(),
        next: i + 1,
      };
    }
  }

  return null;
}

function normalizeName(name) {
  return String(name || '')
    .toUpperCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/[,.\-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 0)
    .sort()
    .join('|');
}

function normalizeStatusKey(status) {
  return String(status || '')
    .toUpperCase()
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function totalDates(emp) {
  return ['D', 'N', 'AL', 'RO', 'X'].reduce(
    (sum, key) => sum + emp[key].length,
    0
  );
}
