export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const result = await parseSchedule(req.body || {});
    return res.status(result.status).json(result.body);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Parse error: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────────────────
async function parseSchedule(body) {
  const { sourceType, text, pages, plainText } = body;
  const debugMode = body.debug === true;   // pass debug:true to get raw parse stats

  let start = null, end = null, unit = '—', period = null;
  const employeeMap = new Map();
  const collector   = { unknownStatusRows: [], invalidDateRows: [], duplicateNameKeys: [] };
  let rawBlocks = [], pdfResult = null;

  if (sourceType === 'pdf') {
    if (!pages || !Array.isArray(pages) || pages.length === 0)
      return { status: 400, body: { error: 'Missing pages data for PDF source.' } };

    const lines = reconstructLinesFromPages(pages);
    for (const line of lines) { const p = parsePeriodLine(line); if (p) { start = p.start; end = p.end; break; } }
    period = start && end ? { start, end } : null;
    unit   = extractPdfUnit(lines);

    pdfResult = parsePdfLayoutSchedule(pages, period, collector, debugMode);
    pdfResult.employees.forEach(emp => mergeIntoMap(emp, employeeMap, collector));

    if (debugMode) {
      return {
        status: 200,
        body: {
          debug:            true,
          unit, period:     start && end ? `${start} → ${end}` : null,
          pageCount:        pages.length,
          pdfExpectedCount: pdfResult.pdfExpectedCount,
          parsedCount:      Array.from(employeeMap.values()).length,
          pollutedNames:    pdfResult.pollutedNames,
          warnings:         pdfResult.warnings,
          unknownStatuses:  [...new Set(collector.unknownStatusRows.map(r => r.status))],
          pages:            pdfResult.debugPages,
        }
      };
    }

    if (pdfResult.pollutedNames.length > 0)
      return { status: 422, body: { error: `PDF parse error: ${pdfResult.pollutedNames.length} employee name(s) contained metadata noise.`, pollutedNames: pdfResult.pollutedNames.slice(0, 5) } };

    const pagesWithCols  = (pdfResult.debugPages || []).filter(p => p.dateColumnsFound >= 3);
    const pagesWithNoEmp = pagesWithCols.filter(p => p.employeeBlocksAccepted === 0);
    if (pagesWithCols.length > 0 && pagesWithNoEmp.length === pagesWithCols.length)
      return { status: 422, body: { error: 'PDF date columns detected but zero employee blocks accepted on every page.', warnings: pdfResult.warnings } };

    rawBlocks = pages.slice(0, 2).map((p, i) =>
      `Page ${i + 1} layout sample:\n` +
      p.items.slice(0, 60).map(it => `[x=${Math.round(it.x)},y=${Math.round(it.y)}] ${it.text}`).join('\n')
    );
  } else {
    if (!text || !text.trim()) return { status: 400, body: { error: 'Missing text for text source.' } };
    const lines = text.split('\n');
    for (const line of lines) { const p = parsePeriodLine(line); if (p) { start = p.start; end = p.end; break; } }
    for (const line of lines) { const m = line.match(/[Uu]nit\s*[:\-]?\s*([^\n|,]+)/); if (m) { unit = m[1].trim(); break; } }
    period    = start && end ? { start, end } : null;
    rawBlocks = splitIntoBlocks(text);
    for (const block of rawBlocks) { const emp = parseBlock(block, period, collector); if (emp) mergeIntoMap(emp, employeeMap, collector); }
    if (employeeMap.size === 0) { const htEmps = parseHorizontalTable(text, period, collector); if (htEmps) htEmps.forEach(e => mergeIntoMap(e, employeeMap, collector)); }
  }

  let parsedEmployees = Array.from(employeeMap.values());
  if (!start || !end) {
    const all = parsedEmployees.flatMap(e => ['D','N','AL','RO','X'].flatMap(k => e[k])).sort();
    if (all.length) { start = all[0]; end = all[all.length - 1]; period = { start, end }; }
  }

  if (sourceType === 'pdf' && pdfResult && pdfResult.pdfExpectedCount >= 10) {
    const threshold = Math.floor(pdfResult.pdfExpectedCount * 0.95);
    if (parsedEmployees.length < threshold)
      return { status: 422, body: { error: `PDF parsing incomplete: detected ~${pdfResult.pdfExpectedCount} employee rows, parsed ${parsedEmployees.length} (threshold 95%).`, expected: pdfResult.pdfExpectedCount, found: parsedEmployees.length, warnings: pdfResult?.warnings ?? [] } };
  }

  const sourceText    = sourceType === 'pdf' ? (plainText || '') : (text || '');
  const expectedNames = extractExpectedNames(sourceText);
  const expectedCount = expectedNames.length > 0 ? expectedNames.length : detectExpectedCountFallback(sourceText);

  if (parsedEmployees.length === 0 && process.env.OPENAI_API_KEY) {
    const sample = sourceType === 'pdf'
      ? reconstructLinesFromPages(pages).slice(0, 80).join('\n')
      : (text || '').split('\n').slice(0, 80).join('\n');
    let fmt = null;
    try { fmt = await callOpenAIFormatDetector(sample, { parsedCount: 0, expectedCount, periodDays: start && end ? Math.round((new Date(end+'T00:00:00') - new Date(start+'T00:00:00')) / 86400000) + 1 : null }); }
    catch (e) { console.error('Format detector error:', e.message); }
    return { status: 422, body: { error: 'Local parser could not read any employees.', formatDetection: fmt || null } };
  }

  const diagnostics = buildDiagnostics({ expectedNames, expectedCount, parsedEmployees, employeeMap, collector, period: start && end ? { start, end } : null });
  const hardError   = validateHard(diagnostics);
  if (hardError) return { status: 422, body: { error: hardError, diagnostics: slimDiagnostics(diagnostics) } };

  if (diagnostics.unknownStatusRows.length > 0) {
    if (!process.env.OPENAI_API_KEY)
      return { status: 422, body: { error: `${diagnostics.unknownStatusRows.length} unrecognized status code(s). Set OPENAI_API_KEY to enable runtime classification.`, unknownStatusRows: diagnostics.unknownStatusRows.slice(0, 10).map(r => ({ status: r.status, employee: r.employee, date: r.date })) } };
    let classifications;
    try { classifications = await callOpenAIStatusClassifier(diagnostics.unknownStatusRows); }
    catch (e) { return { status: 422, body: { error: 'OpenAI classifier failed: ' + e.message } }; }

    const classMap = {};
    for (const c of classifications) classMap[c.rawStatus.trim().toUpperCase()] = c;
    const THRESHOLD = 95, unresolved = [];
    for (const row of diagnostics.unknownStatusRows) {
      const key = row.status.trim().toUpperCase(), cl = classMap[key];
      if (!cl) { unresolved.push({ status: row.status, employee: row.employee, date: row.date, confidence: null, reason: 'Not returned by classifier' }); continue; }
      if ((cl.confidence || 0) < THRESHOLD) { unresolved.push({ status: row.status, employee: row.employee, date: row.date, confidence: cl.confidence ?? null, reason: cl.reason || 'Low confidence' }); continue; }
      if (cl.mappedCode === 'skip') continue;
      if (!['D','N','AL','RO','X'].includes(cl.mappedCode)) { unresolved.push({ status: row.status, employee: row.employee, date: row.date, confidence: cl.confidence ?? null, reason: 'Invalid mappedCode returned' }); continue; }
      const finalEmp = employeeMap.get(row.normalizedKey);
      if (finalEmp && row.date) finalEmp[cl.mappedCode].push(row.date);
      else unresolved.push({ status: row.status, employee: row.employee, date: row.date, confidence: cl.confidence ?? null, reason: 'Employee or date not found' });
    }
    if (unresolved.length > 0)
      return { status: 422, body: { error: `${unresolved.length} status code(s) unresolved (threshold: ${THRESHOLD}%). Add frequent ones to local mapStatus.`, unresolved: unresolved.slice(0, 20) } };
    parsedEmployees = Array.from(employeeMap.values());
    const rd = buildDiagnostics({ expectedNames, expectedCount, parsedEmployees, employeeMap, collector: { ...collector, unknownStatusRows: [] }, period: start && end ? { start, end } : null });
    const rh = validateHard(rd);
    if (rh) return { status: 422, body: { error: 'Post-classification validation failed: ' + rh } };
  }

  if (process.env.AI_VERIFY === 'true' && process.env.OPENAI_API_KEY && diagnostics.unknownStatusRows.length === 0) {
    try {
      const audit = await callOpenAIAudit(buildAuditPayload(rawBlocks, diagnostics));
      if (!audit.pass || audit.confidence < 80 || audit.recommendedAction === 'block_output')
        return { status: 422, body: { error: 'AI audit blocked output.', severity: audit.severity, issues: audit.issues, confidence: audit.confidence } };
    } catch (e) { console.error('AI_VERIFY non-blocking:', e.message); }
  }

  const employees = parsedEmployees.map(emp => ({
    name: emp.name, role: emp.role,
    D:  [...new Set(emp.D)].sort(),  N:  [...new Set(emp.N)].sort(),
    AL: [...new Set(emp.AL)].sort(), RO: [...new Set(emp.RO)].sort(),
    X:  [...new Set(emp.X)].sort()
  }));
  return { status: 200, body: { unit, start, end, employees } };
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF COORDINATE NORMALIZER  (handles 90° rotated PDFs)
// ─────────────────────────────────────────────────────────────────────────────

// True if items have a horizontal row of ≥5 date items (standard landscape layout)
function hasHorizontalDateRow(items, pageHeight) {
  const headerArea = items.filter(i => i.y < pageHeight * 0.55);
  const rowGroups  = groupItemsByY(headerArea, 6);
  for (const row of rowGroups)
    if (row.items.filter(i => extractMmDdFromText(i.text) !== null).length >= 5) return true;
  return false;
}

// True if dates cluster in a single vertical column (rotated 90° PDF)
function hasVerticalDateColumn(items) {
  const dateItems = items.filter(i => extractMmDdFromText(i.text) !== null);
  const byX = new Map();
  for (const item of dateItems) {
    const xKey = Math.round(item.x / 5) * 5;
    if (!byX.has(xKey)) byX.set(xKey, []);
    byX.get(xKey).push(item);
  }
  for (const its of byX.values()) {
    if (its.length >= 5) {
      const ys = its.map(i => i.y);
      if (Math.max(...ys) - Math.min(...ys) > 200) return true;
    }
  }
  return false;
}

// Detect and correct 90° rotation before parsing.
// Rotated: new_x = pageHeight − y,  new_y = x,  swap page dimensions.
function normalizePageItems(items, pageWidth, pageHeight) {
  if (hasHorizontalDateRow(items, pageHeight))
    return { items, width: pageWidth, height: pageHeight };
  if (hasVerticalDateColumn(items)) {
    const transformed = items.map(i => ({
      ...i,
      x:      Math.round((pageHeight - i.y) * 10) / 10,
      y:      Math.round(i.x               * 10) / 10,
      width:  i.height || 10,
      height: i.width  || 20,
    }));
    return { items: transformed, width: pageHeight, height: pageWidth };
  }
  return { items, width: pageWidth, height: pageHeight };
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF LAYOUT PARSER
// ─────────────────────────────────────────────────────────────────────────────
function parsePdfLayoutSchedule(pages, period, collector, debugMode) {
  const employeeMap    = new Map();
  let pdfExpectedCount = 0;
  const pollutedNames  = [], debugPages = [], warnings = [];

  for (const page of pages) {
    const { items, width: pageWidth, height: pageHeight, page: pageNum } = page;
    const pd = { page: pageNum, dateColumnsFound: 0, employeeBlocksDetected: 0, employeeBlocksAccepted: 0, namesExtracted: [], rejectedRows: [], warnings: [] };
    if (!items || items.length < 8) { debugPages.push(pd); continue; }

    const norm       = normalizePageItems(items, pageWidth, pageHeight);
    const normItems  = norm.items, normW = norm.width, normH = norm.height;

    const detection = detectPdfDateColumns(normItems, normW, normH, period);
    if (!detection || detection.columns.length < 3) { debugPages.push(pd); continue; }

    const { columns: dateColumns, headerY } = detection;
    pd.dateColumnsFound = dateColumns.length;

    const firstDateX    = Math.min(...dateColumns.map(c => c.x));
    const nameZoneXEnd  = firstDateX - 8;
    const nameZoneItems = normItems.filter(i => i.x < nameZoneXEnd && i.text.trim().length > 0);

    const { entries, blocksWithNameLike, rejectedRows } = buildEmployeeEntries(nameZoneItems, normH, headerY, debugMode);
    pd.employeeBlocksDetected = blocksWithNameLike;
    pd.employeeBlocksAccepted = entries.length;
    if (debugMode) pd.rejectedRows = rejectedRows.slice(0, 40);
    pdfExpectedCount += blocksWithNameLike;

    if (entries.length === 0 && dateColumns.length >= 3) {
      const w = `Page ${pageNum}: ${dateColumns.length} date columns but 0 accepted employee blocks.`;
      warnings.push(w); pd.warnings.push(w);
    }

    for (const entry of entries) {
      const { name, role, yStart, yEnd } = entry;
      if (!name || name.trim().length < 2) continue;
      if (isNameRejected(name) || hasNamePollution(name)) { pollutedNames.push(name); continue; }

      const bandItems = normItems.filter(i => i.y >= yStart && i.y < yEnd && i.x >= nameZoneXEnd);
      const key = normalizeName(name);
      let emp = employeeMap.get(key);
      if (!emp) { emp = { name: name.trim(), role: role || '', _rowCount: 0, D:[], N:[], AL:[], RO:[], X:[] }; employeeMap.set(key, emp); }
      else if (role && !emp.role) emp.role = role;

      let cellsMatched = 0;
      for (const col of dateColumns) {
        const cellItems = bandItems.filter(i => i.x >= col.x - col.xTol && i.x <= col.x + col.width + col.xTol);
        emp._rowCount++;
        if (cellItems.length === 0) continue;
        cellsMatched++;
        const rawText   = cellItems.sort((a, b) => a.y - b.y || a.x - b.x).map(i => i.text.trim()).filter(t => t.length > 0).join(' ');
        const assembled = reassembleStatusFragments(rawText);
        const code      = mapStatus(assembled);
        if (code) {
          emp[code].push(col.date);
        } else if (assembled && assembled !== '-' && !isKnownAnnotation(assembled)) {
          collector.unknownStatusRows.push({ line: rawText, status: assembled, employee: name, normalizedKey: key, date: col.date });
        }
      }
      if (debugMode && pd.namesExtracted.length < 15)
        pd.namesExtracted.push(`${name} [${role || '?'}] cells:${cellsMatched}/${dateColumns.length}`);
    }
    debugPages.push(pd);
  }

  return {
    employees: Array.from(employeeMap.values()).filter(e => e._rowCount > 0 || totalDates(e) > 0),
    pdfExpectedCount, pollutedNames, debugPages, warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE BLOCK DETECTOR  (state machine over name-zone rows)
// ─────────────────────────────────────────────────────────────────────────────

// Role keywords recognised everywhere (classifyRow + name assembly + metaRow scan)
const ROLE_PATTERN = /^(AHN|SN\s+I{1,2}|SN\s+II|CA|CLN|CLNSPC|WC|CI|Default|RN|LPN)$/i;
const ROLE_INLINE  = /\b(AHN|SN\s+I{1,2}|SN\s+II|CA|CLN|CLNSPC|WC|CI|Default|RN|LPN)\b/i;

function buildEmployeeEntries(nameZoneItems, pageHeight, headerY, debugMode) {
  const footerY   = pageHeight * 0.93;
  const bodyItems = nameZoneItems.filter(i => i.y > headerY + 5 && i.y < footerY);
  if (bodyItems.length === 0) return { entries: [], blocksWithNameLike: 0, rejectedRows: [] };

  const rowGroups = groupItemsByY(bodyItems, 6).sort((a, b) => a.y - b.y);
  if (rowGroups.length === 0) return { entries: [], blocksWithNameLike: 0, rejectedRows: [] };

  // ── row classifier ────────────────────────────────────────────────────────
  function classifyRow(text) {
    if (!text || !text.trim()) return 'empty';
    const t = text.trim();
    // Any row starting with workload pattern → metadata (handles "42/42 SPC", "60/24 ult", etc.)
    if (/^\d+(?:\/\d+){2,}/.test(t)) return 'metadata';
    if (isPhoneLine(t))         return 'metadata';
    if (isFteLine(t))           return 'metadata';
    if (ROLE_PATTERN.test(t))   return 'metadata';
    if (/^[Ss]kill\s*[:\-]/i.test(t)) return 'metadata';
    if (isFooterSummaryLine(t)) return 'footer';
    if (isLikelyEmployeeNameLine(t)) return 'name';
    return 'other';
  }

  const rows = rowGroups.map(rg => {
    const text = rg.items.sort((a, b) => a.x - b.x).map(i => i.text.trim()).filter(t => t.length > 0).join(' ').trim();
    return { y: rg.y, text, type: classifyRow(text) };
  });
  const rejectedRows = debugMode
    ? rows.filter(r => r.type !== 'name' && r.type !== 'empty').map(r => ({ text: r.text, reason: r.type }))
    : [];

  // ── state machine: idle → in_name → in_meta ──────────────────────────────
  const blocks = [];
  let state = 'idle', cur = null;
  for (const row of rows) {
    if (row.type === 'empty' || row.type === 'footer' || row.type === 'other') continue;
    if (row.type === 'name') {
      if (state === 'idle')      { cur = { nameRows: [row], metaRows: [] }; state = 'in_name'; }
      else if (state === 'in_name') { cur.nameRows.push(row); }
      else { blocks.push(cur); cur = { nameRows: [row], metaRows: [] }; state = 'in_name'; }
    } else if (row.type === 'metadata') {
      if (state === 'in_name' || state === 'in_meta') { cur.metaRows.push(row); state = 'in_meta'; }
    }
  }
  if (cur) blocks.push(cur);

  // ── convert blocks → entries ──────────────────────────────────────────────
  let blocksWithNameLike = 0;
  const entries = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.metaRows.length === 0) continue;
    blocksWithNameLike++;

    const yStart = block.nameRows[0].y - 4;
    const yEnd   = i < blocks.length - 1 ? blocks[i + 1].nameRows[0].y - 2 : pageHeight;

    // Assemble raw name text from all name rows
    let name = block.nameRows.map(r => r.text.trim()).join(' ')
      .replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/,\s*$/, '').replace(/^\d+\.\s*/, '').trim();

    // Extract role from name rows (inline match)
    let role = '';
    for (const nr of block.nameRows) {
      const rm = nr.text.match(ROLE_INLINE);
      if (rm) {
        role = rm[0].trim();
        name = name.replace(new RegExp('\\b' + role.replace(/\s+/g, '\\s+') + '\\b', 'i'), '').replace(/\s+/g, ' ').trim();
        break;
      }
    }
    // Fallback: look for role in meta rows
    if (!role) {
      for (const mr of block.metaRows) {
        const t = mr.text.trim();
        if (ROLE_PATTERN.test(t)) { role = t; break; }
        const sm = t.match(/^[Ss]kill\s*[:\-]?\s*([A-Za-z\s]+)/);
        if (sm) { role = sm[1].trim(); break; }
      }
    }

    // ── name cleanup ──────────────────────────────────────────────────────
    // Strip FTE value bleeding into name row (rotated PDFs)
    name = name.replace(/\b[01]\.\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
    // Detect trailing mixed-case partial role word (e.g. "Defa" from split "Default")
    const partialRole = name.match(/\s+([A-Z][a-z]{2,5})$/);
    if (partialRole) {
      const frag = partialRole[1];
      if (!role && /^Defa/i.test(frag)) role = 'Default';
      name = name.replace(/\s+[A-Z][a-z]{2,5}$/, '').trim();
    }

    if (!name || name.length < 2) continue;
    if (hasNamePollution(name) || isNameRejected(name)) continue;
    entries.push({ name: name.trim(), role, yStart, yEnd });
  }

  return { entries, blocksWithNameLike, rejectedRows };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE COLUMN DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
function extractMmDdFromText(text) {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) { const n = parseInt(t); if (n >= 1 && n <= 31) return { type: 'day', num: n }; }
  if (/^\d{1,2}\/\d{1,2}$/.test(t)) { const [mm, dd] = t.split('/'); return { type: 'mmdd', mm, dd }; }
  const e = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (e) { const mm = parseInt(e[1]), dd = parseInt(e[2]); if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return { type: 'mmdd', mm: e[1], dd: e[2] }; }
  return null;
}

function detectPdfDateColumns(items, pageWidth, pageHeight, period) {
  const headerItems = items.filter(i => i.y < pageHeight * 0.55);
  const rowGroups   = groupItemsByY(headerItems, 6);
  let bestRow = null, bestCount = 0;
  for (const row of rowGroups) {
    const n = row.items.filter(i => extractMmDdFromText(i.text) !== null).length;
    if (n > bestCount && n >= 5) { bestCount = n; bestRow = row; }
  }
  if (!bestRow) return null;

  const headerY        = bestRow.y;
  const candidateItems = bestRow.items
    .map(i => ({ item: i, parsed: extractMmDdFromText(i.text) }))
    .filter(c => c.parsed !== null)
    .sort((a, b) => a.item.x - b.item.x);

  const hasMmDd = candidateItems.some(c => c.parsed.type === 'mmdd');
  let columns = [];

  if (hasMmDd) {
    for (const { item, parsed } of candidateItems) {
      if (parsed.type !== 'mmdd' || !period) continue;
      const date = buildDate(parsed.mm, parsed.dd, period);
      if (date) columns.push({ date, x: item.x, width: item.width || 20 });
    }
  } else {
    const dayNums = candidateItems.filter(c => c.parsed.type === 'day').map(c => ({ num: c.parsed.num, x: c.item.x, width: c.item.width || 20 }));
    if (period) columns = mapDayNumbersToColumns(dayNums, period);
  }
  if (columns.length < 3) return null;

  const avgGap = columns.length > 1 ? (columns[columns.length - 1].x - columns[0].x) / (columns.length - 1) : 20;
  const xTol   = Math.min(avgGap * 0.4, 16);
  return { columns: columns.map(col => ({ ...col, xTol })), headerY };
}

function mapDayNumbersToColumns(dayNums, period) {
  const columns = [], periodEnd = new Date(period.end + 'T00:00:00');
  let searchFrom = new Date(period.start + 'T00:00:00');
  for (const { num, x, width } of dayNums) {
    let cur = new Date(searchFrom), found = false;
    for (let i = 0; i < 35; i++) {
      if (cur > periodEnd) break;
      if (cur.getDate() === num) {
        columns.push({ date: cur.toISOString().slice(0, 10), x, width });
        searchFrom = new Date(cur); searchFrom.setDate(searchFrom.getDate() + 1);
        found = true; break;
      }
      cur.setDate(cur.getDate() + 1);
    }
    if (!found) continue;
  }
  return columns;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROW / NAME CLASSIFIERS
// ─────────────────────────────────────────────────────────────────────────────
function isFooterSummaryLine(t) {
  if (!t) return false;
  t = t.trim();
  if (/totals?\s+by\s+task/i.test(t))                       return true;
  if (/shift\s+partition/i.test(t))                         return true;
  if (/^totals?$/i.test(t) || /^SPC$/i.test(t))            return true;
  if (/^\d{4}$/.test(t) && parseInt(t) <= 2359)            return true;
  if (/^\d{4}\s*[\/\-]\s*\d{4}$/.test(t))                  return true;
  if (/^page\s+\d/i.test(t))                               return true;
  if (/^report\s+date/i.test(t))                           return true;
  if (/^schedule\s+for/i.test(t))                          return true;
  if (/^printed/i.test(t))                                 return true;
  if (/^\d{1,4}$/.test(t) && parseInt(t) > 0 && parseInt(t) < 500) return true;
  return false;
}

function isLikelyEmployeeNameLine(text) {
  if (!text) return false;
  text = text.trim();
  if (text.length < 2 || text.length > 80)            return false;
  if (!/[A-Za-z]/.test(text))                         return false;
  if (/^\d+(?:\/\d+){2,}/.test(text))                 return false;
  if (isPhoneLine(text) || isFteLine(text))           return false;
  const rejected = [
    /^(employee|skill|schedule\s+for|page\s+\d|report\s+(date|by))/i,
    /^(printed|generated|period\s*[:\-=]|unit\s*[:\-=])/i,
    /^(total|subtotal|count)\s*[:\-=\s]/i,
    /^[A-Z]{1,4}\s*[-–]\s*[A-Z]{1,5}\s*[-–]/i,
    /^\d+\s+(of|\/)\s+\d+$/,
    /^(fte|phone|mobile|ext)\s*[:\-=]/i,
    /^\d+\.\d{2}$/,
  ];
  for (const p of rejected) if (p.test(text)) return false;
  if (ROLE_PATTERN.test(text)) return false;
  if ((text.match(/[A-Za-z]/g) || []).length < 2) return false;
  return true;
}

function isNameRejected(name) {
  if (!name) return true;
  const t = name.trim();
  if (isFooterSummaryLine(t) || /^\d+(?:\/\d+){2,}/.test(t) || isPhoneLine(t) || isFteLine(t)) return true;
  if (/^(totals?|subtotal|count|report|schedule\s+for|printed|page\s+\d)/i.test(t)) return true;
  const digits = (t.match(/\d/g) || []).length, letters = (t.match(/[A-Za-z]/g) || []).length;
  if (digits > 0 && letters > 0 && digits / (digits + letters) > 0.4) return true;
  return false;
}

function isKnownAnnotation(text) {
  if (!text) return true;
  const raw = text.trim();
  const u   = raw.toUpperCase();
  if (u === 'SPC')                    return true;
  if (/^\d{1,4}$/.test(u))           return true;
  if (/^[-–—\.]+$/.test(u))          return true;
  if (u === 'N/A' || u === 'NA')     return true;
  // Date-header labels bleeding into cells (e.g. "05/01 Fr")
  if (/^\d{1,2}\/\d{1,2}(\s+\w{2,3})?$/.test(raw)) return true;
  // Day-of-week abbreviations
  if (/^(Su|Mo|Tu|We|Th|Fr|Sa)$/i.test(raw))        return true;
  // Footer/report strings
  if (/^(report\s+date|printed|generated)/i.test(raw)) return true;
  return false;
}

function isPhoneLine(text) {
  text = text.trim();
  if (/^\+?\d[\d\s\-]{8,}$/.test(text)) return true;
  if (/\d{3,}[-.\s]\d{3,}/.test(text) && !/[A-Za-z]/.test(text)) return true;
  return false;
}

function isFteLine(text) {
  text = text.trim();
  if (/^[01]\.\d{2}$/.test(text)) return true;
  if (/^FTE\s*[:\-]/i.test(text)) return true;
  if (/^(Source\s+(count|data)|PDF\s+page|Total\s+worked)/i.test(text)) return true;
  return false;
}

function hasNamePollution(name) {
  if (!name) return true;
  // Strip FTE before checking — FTE bleeds into name row in rotated PDFs
  const clean = name.replace(/\b[01]\.\d{2}\b/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return true;
  if (/^\d+(?:\/\d+){2,}/.test(clean) || isPhoneLine(clean)) return true;
  if (/\d+\/\d+\/\d+/.test(clean)) return true;
  if ((clean.match(/\d/g) || []).length > 6) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
function reassembleStatusFragments(text) {
  let t = text.trim();
  const fixes = [
    [/\bA\s*N\s*N\s*U\s*A\s*L(?:\s*LEAVE)?\b/i, 'ANNUAL'],
    [/\bANUA\b/i,                                'ANNUAL'],
    [/\bRES\s*T\s*DAY\b/i,                       'REST DAY'],
    [/\bRETDA?\b/i,                              'REST DAY'],
    [/\bREQU?\s*EST\s*OFF\b/i,                   'REQUEST OFF'],
    [/\bREQ\s*OFF\b/i,                           'REQUEST OFF'],
    [/\bRees\s*Of\b/i,                           'REQUEST OFF'],
    [/\bREQU?\s*es\w*\s*Of\w*/i,                 'REQUEST OFF'],
    [/\bEDU\s+ON\b/i,                            'EDU ON'],
    [/\bEDU\s+OFF\b/i,                           'EDU OFF'],
    [/\bPUBLIC\s*HOL\w*/i,                       'REST'],
    [/\bVACA\s*TION\b/i,                         'ANNUAL'],
    [/\bHOL\s*I\s*DAY\b/i,                       'REST'],
  ];
  for (const [pat, rep] of fixes) t = t.replace(pat, rep);
  return t.trim();
}

function mapStatus(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s === '-') return null;
  const u = s.toUpperCase();

  if (/^D(\s|$|\d)/.test(u)  || u === 'DAY'   || /^DAY\s/.test(u))   return 'D';
  if (/^N(\s|$|\d)/.test(u)  || u === 'NIGHT' || /^NIGHT\s/.test(u)) return 'N';
  if (/^A\s*N\s*N\s*U\s*A\s*L/.test(u) || u === 'AL' || u === 'A/L' || /^LEAVE/.test(u) || /^VACATION/.test(u)) return 'AL';
  if (/^REQUEST/.test(u) || /^REQ\s/.test(u) || u === 'RO') return 'RO';
  if (/^REST/.test(u) || u === 'OFF' || /^OFF\s/.test(u)) return 'X';
  if (/^EDU\s*OFF/.test(u)) return 'X';
  if (/^EDU\s*ON/.test(u))  return 'D';
  if (/^EDU/.test(u) || /^STUDY/.test(u) || /^TRAINING/.test(u) || /^SEMINAR/.test(u)) return 'D';
  if (u === 'PH' || u === 'HD')                return 'X';
  if (u === 'SL' || u === 'EL' || u === 'ML') return 'AL';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE MAP HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function mergeIntoMap(emp, employeeMap, collector) {
  const key = normalizeName(emp.name);
  if (employeeMap.has(key)) {
    const ex = employeeMap.get(key);
    for (const code of ['D','N','AL','RO','X']) for (const d of emp[code]) if (!ex[code].includes(d)) ex[code].push(d);
    ex._rowCount += emp._rowCount || 0;
    if (emp._blockType === 'NUMBERED' && ex._blockType !== 'NUMBERED') { ex.name = emp.name; ex._blockType = 'NUMBERED'; }
    if (emp.role && !ex.role) ex.role = emp.role;
    collector.duplicateNameKeys.push(key);
  } else {
    employeeMap.set(key, emp);
  }
}

function totalDates(emp) { return ['D','N','AL','RO','X'].reduce((s, k) => s + emp[k].length, 0); }

function normalizeName(name) {
  return name.toUpperCase().replace(/\[[^\]]*\]/g,'').replace(/^\d+\.\s*/,'').replace(/[,.\-']/g,' ').replace(/\s+/g,' ').trim().split(' ').filter(t => t.length > 0).sort().join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
// DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────────
function buildDiagnostics({ expectedNames, expectedCount, parsedEmployees, employeeMap, collector, period }) {
  const parsedNamesSet = new Set(parsedEmployees.map(e => normalizeName(e.name)));
  const missingNames   = expectedNames.filter(n => !parsedNamesSet.has(n));
  const periodDays     = period ? Math.round((new Date(period.end+'T00:00:00') - new Date(period.start+'T00:00:00')) / 86_400_000) + 1 : null;
  const employeesWithLowRowCount = [];
  for (const emp of employeeMap.values()) {
    const thr = periodDays ? Math.max(3, Math.floor(periodDays * 0.1)) : 3;
    if ((emp._rowCount || 0) < thr) employeesWithLowRowCount.push(emp.name);
  }
  return { expectedCount, parsedCount: parsedEmployees.length, expectedNames, parsedNames: [...parsedNamesSet], missingNames, unknownStatusRows: collector.unknownStatusRows, invalidDateRows: collector.invalidDateRows, duplicateNameKeys: [...new Set(collector.duplicateNameKeys)], employeesWithLowRowCount, periodDays };
}

function slimDiagnostics(d) {
  return { expectedCount: d.expectedCount, parsedCount: d.parsedCount, missingNames: (d.missingNames||[]).slice(0,20), unknownStatusRows: (d.unknownStatusRows||[]).slice(0,20).map(r=>({status:r.status,employee:r.employee})), invalidDateRows: (d.invalidDateRows||[]).slice(0,10), duplicateNameKeys: (d.duplicateNameKeys||[]).slice(0,10), employeesWithLowRowCount: (d.employeesWithLowRowCount||[]).slice(0,10), periodDays: d.periodDays??null };
}

function validateHard(d) {
  if (!d.periodDays)    return 'Schedule period not found. Add a Period line, e.g.: Period: 04/26/2026 - 06/06/2026';
  if (d.parsedCount === 0) return 'No staff records found.';
  if (d.expectedCount > 0 && d.parsedCount < d.expectedCount) return `Parsing incomplete: expected ${d.expectedCount} staff, parsed ${d.parsedCount} staff.`;
  if (d.missingNames.length > 0) return `Missing staff: ${d.missingNames.join(', ')}.`;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function reconstructLinesFromPages(pages) {
  const lines = [];
  for (const page of pages) {
    const rowGroups = groupItemsByY(page.items || [], 6);
    for (const row of rowGroups)
      lines.push(row.items.sort((a,b) => a.x - b.x).map(i => i.text).join(' '));
  }
  return lines;
}

function extractPdfUnit(lines) {
  for (const line of lines.slice(0, 50)) {
    const t = line.trim();
    if (!t || t.length < 2) continue;
    const m = t.match(/[Uu]nit\s*[:\-]?\s*([A-Z][A-Za-z0-9\s\-]{1,30})/);
    if (m && !/^(employee|skill|page|report|schedule|total|printed)/i.test(m[1].trim())) return m[1].trim();
    if (/^[A-Z]{1,4}\s*[-–]\s*[A-Z]{1,5}\s*[-–]\s*[A-Z][A-Z0-9]*$/i.test(t)) return t;
    if (/^[A-Z]{1,4}-[A-Z]{1,5}-[A-Z][A-Z0-9]*$/i.test(t)) return t;
  }
  return '—';
}

function groupItemsByY(items, tolerance) {
  if (!items || items.length === 0) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y);
  const groups = [];
  let cur = { y: sorted[0].y, items: [sorted[0]] };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - cur.y <= tolerance) cur.items.push(sorted[i]);
    else { groups.push(cur); cur = { y: sorted[i].y, items: [sorted[i]] }; }
  }
  groups.push(cur);
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT-FORMAT PARSERS  (TXT / paste fallback)
// ─────────────────────────────────────────────────────────────────────────────
function isBlockHeader(line) {
  const t = line.trim();
  return /^\d{1,3}\.\s+[A-Z][A-Za-z]/.test(t) || /^QUICK\s+SECTION\s*[-–:]/i.test(t) || /^EMPLOYEE\s*:\s*\S/i.test(t);
}

function splitIntoBlocks(text) {
  const lines = text.split('\n'), blocks = []; let current = [];
  for (const line of lines) {
    if (isBlockHeader(line)) { if (current.length) { const b = current.join('\n').trim(); if (b.length > 5) blocks.push(b); } current = [line]; }
    else if (/^={4,}/.test(line.trim()) || /^-{4,}/.test(line.trim())) { if (current.length) { const b = current.join('\n').trim(); if (b.length > 5) blocks.push(b); current = []; } }
    else current.push(line);
  }
  if (current.length) { const b = current.join('\n').trim(); if (b.length > 5) blocks.push(b); }
  return blocks.length ? blocks : text.split(/\n?={4,}\n?/).map(b => b.trim()).filter(b => b.length > 5);
}

function parseBlock(blockText, period, collector) {
  if (!blockText || blockText.trim().length < 5) return null;
  const lines = blockText.split('\n').map(l => l.trimEnd());
  let empName = null, empRole = '', blockType = null, dataStart = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i].trim(); if (!line) continue;
    let m = line.match(/^QUICK\s+SECTION\s*[-–:]\s*(.+)/i);
    if (m) { empRole = extractBracketRole(m[1])||''; empName = cleanName(m[1]); blockType = 'QUICK'; dataStart = i+1; const sr = findSkillLine(lines,i+1,4); if(sr){empRole=sr.role;dataStart=sr.next;} break; }
    m = line.match(/^EMPLOYEE\s*:\s*(.+)/i);
    if (m) { empRole = extractBracketRole(m[1])||''; empName = cleanName(m[1]); blockType = 'EMPLOYEE'; dataStart = i+1; const sr = findSkillLine(lines,i+1,4); if(sr){empRole=sr.role;dataStart=sr.next;} break; }
    m = line.match(/^\d{1,3}\.\s+(.+)/);
    if (m) { empRole = extractBracketRole(m[1])||''; empName = cleanName(m[1]); blockType = 'NUMBERED'; dataStart = i+1; const sr = findSkillLine(lines,i+1,8); if(sr){empRole=sr.role;dataStart=sr.next;} break; }
  }
  if (!empName) return null;
  const emp = { name: empName, role: empRole, _blockType: blockType, _rowCount: 0, D:[], N:[], AL:[], RO:[], X:[] };
  for (let i = dataStart; i < lines.length; i++) parseDailyRow(lines[i].trim(), emp, period, collector);
  if (totalDates(emp) === 0 && emp._rowCount === 0) parseSectionMode(lines, dataStart, emp, period);
  return (emp._rowCount > 0 || totalDates(emp) > 0) ? emp : null;
}

function parseDailyRow(line, emp, period, collector) {
  if (!line) return;
  let m = line.match(/^(\d{1,2})\/(\d{1,2})(?:\s+\w{2,4})?\s*:\s*(.*)/);
  if (m) { emp._rowCount++; const date = buildDate(m[1],m[2],period); if(!date){collector.invalidDateRows.push(line);return;} const c = mapStatus(m[3]); if(c) emp[c].push(date); else if(m[3].trim()&&m[3].trim()!=='-') collector.unknownStatusRows.push({line,status:m[3].trim(),employee:emp.name,normalizedKey:normalizeName(emp.name),date}); return; }
  m = line.match(/^(\d{1,2})\/(\d{1,2})\s+(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(.*)/i);
  if (m) { emp._rowCount++; const date = buildDate(m[1],m[2],period); if(!date){collector.invalidDateRows.push(line);return;} const c = mapStatus(m[3]); if(c) emp[c].push(date); else if(m[3].trim()&&m[3].trim()!=='-') collector.unknownStatusRows.push({line,status:m[3].trim(),employee:emp.name,normalizedKey:normalizeName(emp.name),date}); return; }
  m = line.match(/^(\d{4})-(\d{2})-(\d{2})\s+(.*)/);
  if (m) { emp._rowCount++; const date=`${m[1]}-${m[2]}-${m[3]}`; const c=mapStatus(m[4]); if(c) emp[c].push(date); else if(m[4].trim()&&m[4].trim()!=='-') collector.unknownStatusRows.push({line,status:m[4].trim(),employee:emp.name,normalizedKey:normalizeName(emp.name),date}); }
}

function parseSectionMode(lines, startIdx, emp, period) {
  let mode = null;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    const lc = getSectionLabel(line); if (lc) { mode = lc; continue; }
    if (!mode) continue;
    const rng = line.match(/(\d{4}-\d{2}-\d{2})(?:\s*\([^)]*\))?\s*[-–>]+\s*(\d{4}-\d{2}-\d{2})/);
    if (rng) { expandRange(rng[1],rng[2]).forEach(d => emp[mode].push(d)); continue; }
    const iso = line.match(/\d{4}-\d{2}-\d{2}/g);
    if (iso) { iso.forEach(d => emp[mode].push(d)); continue; }
    if (period) { [...line.matchAll(/(\d{1,2})\/(\d{1,2})/g)].forEach(mm => { const d = buildDate(mm[1],mm[2],period); if(d) emp[mode].push(d); }); }
  }
}

function getSectionLabel(line) {
  const l = line.replace(/^[-•*\s]+/,'').toLowerCase();
  if (/^day\s*shift/.test(l))   return 'D';
  if (/^night\s*shift/.test(l)) return 'N';
  if (/^annual\s*leave/.test(l)||/^al\s*:/.test(l)||/^leave\s*:/.test(l)) return 'AL';
  if (/^request.?off/.test(l)||/^ro\s*:/.test(l)) return 'RO';
  if (/^other\s*(off|rest)/.test(l)||/^off\/rest/.test(l)) return 'X';
  return null;
}

function parseHorizontalTable(text, period, collector) {
  const lines = text.split('\n'); let headerIdx = -1, colDateMap = [], usePipe = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('|')) { const cells = line.split('|').map(c => c.trim()); const dated = cells.map((c,idx) => ({idx,d:parseHeaderDate(c,period)})).filter(x => x.d); if (dated.length >= 3) { headerIdx=i; colDateMap=dated; usePipe=true; break; } }
    const iso = line.match(/\d{4}-\d{2}-\d{2}/g)||[]; if (iso.length >= 3) { let col=1; colDateMap=iso.map(d=>({idx:col++,d})); headerIdx=i; break; }
  }
  if (headerIdx === -1 || colDateMap.length < 3) return null;
  const employees = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i]; if (!line.trim()) continue;
    const cells = usePipe ? line.split('|').map(c => c.trim()) : line.split(/\s{2,}|\t/).map(c => c.trim());
    if (cells.length < 2) continue;
    const nameCell = cleanName(cells[0]); if (!looksLikeName(nameCell)) continue;
    const emp = { name: nameCell, role: '', _rowCount: 0, D:[], N:[], AL:[], RO:[], X:[] };
    for (const { idx, d } of colDateMap) { const raw=(cells[idx]||'').trim(); emp._rowCount++; const c=mapStatus(raw); if(c) emp[c].push(d); else if(raw&&raw!=='-'&&!isKnownAnnotation(raw)) collector.unknownStatusRows.push({line,status:raw,employee:nameCell,normalizedKey:normalizeName(nameCell),date:d}); }
    if (emp._rowCount > 0) employees.push(emp);
  }
  return employees.length >= 2 ? employees : null;
}

function parseHeaderDate(cell, period) {
  if (!cell) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(cell)) return cell;
  const a = cell.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (a) return `${a[3]}-${a[1].padStart(2,'0')}-${a[2].padStart(2,'0')}`;
  const b = cell.match(/^(\d{1,2})\/(\d{1,2})$/); if (b && period) return buildDate(b[1],b[2],period);
  return null;
}

function looksLikeName(str) {
  if (!str||str.length<2||str.length>60) return false;
  if (/^\d+$/.test(str)||/^\d{1,2}\/\d{1,2}/.test(str)||/^\d{4}-\d{2}/.test(str)) return false;
  return (str.match(/[A-Za-z]/g)||[]).length >= 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// MISC HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function parsePeriodLine(line) {
  let m = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:-|–|—|to)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { start:`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`, end:`${m[6]}-${m[4].padStart(2,'0')}-${m[5].padStart(2,'0')}` };
  m = line.match(/(\d{4}-\d{2}-\d{2})\s+(?:-|–|—|to)\s+(\d{4}-\d{2}-\d{2})/);
  if (m) return { start: m[1], end: m[2] };
  return null;
}

function buildDate(month, day, period) {
  const mm = String(month).padStart(2,'0'), dd = String(day).padStart(2,'0');
  if (!period||!period.start) return `${new Date().getFullYear()}-${mm}-${dd}`;
  const { start, end } = period, sy = parseInt(start.slice(0,4), 10);
  for (const y of [sy, sy+1, sy-1]) { const c=`${y}-${mm}-${dd}`; if (c>=start&&c<=end) return c; }
  return `${sy}-${mm}-${dd}`;
}

function expandRange(from, to) {
  const dates=[], cur=new Date(from+'T00:00:00'), stop=new Date(to+'T00:00:00');
  while (cur<=stop) { dates.push(cur.toISOString().slice(0,10)); cur.setDate(cur.getDate()+1); }
  return dates;
}

function cleanName(str)          { return str.replace(/\s*\[[^\]]*\]/g,'').replace(/^\d+\.\s*/,'').trim(); }
function extractBracketRole(str) { const m=str.match(/\[([^\]]+)\]/); return m?m[1].trim():null; }

function findSkillLine(lines, startIdx, maxLook) {
  for (let i=startIdx; i<Math.min(lines.length,startIdx+maxLook); i++) {
    const line=lines[i].trim(); if(!line) continue;
    if (/^\d{1,2}\/\d{1,2}/.test(line)||/^\d{4}-\d{2}/.test(line)) return null;
    const m=line.match(/^(?:[Ss]kill|[Rr]ole)\s*:?\s*([^\n|]+)/); if(m) return{role:m[1].trim(),next:i+1};
  }
  return null;
}

function extractExpectedNames(text) {
  const keys = new Set();
  for (const m of text.matchAll(/^\s*\d{1,3}\.\s+([A-Z][A-Za-z\s,\-'\.]{2,})(?:\s*\[|$)/gm)) {
    const name = cleanName(m[1].trim());
    if (name&&name.length>=3&&/[A-Za-z]{2,}/.test(name)) keys.add(normalizeName(name));
  }
  return [...keys];
}

function detectExpectedCountFallback(text) {
  const quick=(text.match(/QUICK\s+SECTION/gi)||[]).length;
  const empLbl=(text.match(/^EMPLOYEE\s*:/gim)||[]).length;
  const seps=(text.match(/={4,}/g)||[]).length;
  if (quick>=3) return quick; if (empLbl>=3) return empLbl; if (seps>=3) return seps; return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — STATUS CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────
const STATUS_CLASSIFIER_SCHEMA = {
  type:'object',
  properties:{classifications:{type:'array',items:{type:'object',properties:{rawStatus:{type:'string'},mappedCode:{type:'string',enum:['D','N','AL','RO','X','skip']},confidence:{type:'number'},reason:{type:'string'}},required:['rawStatus','mappedCode','confidence','reason'],additionalProperties:false}}},
  required:['classifications'],additionalProperties:false
};

async function callOpenAIStatusClassifier(unknownRows) {
  const byStatus = new Map();
  for (const row of unknownRows) {
    const key = row.status.trim().toUpperCase();
    if (!byStatus.has(key)) byStatus.set(key, { rawStatus: row.status, examples: [] });
    const entry = byStatus.get(key);
    if (entry.examples.length < 3) entry.examples.push({ employee: row.employee, date: row.date });
  }
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},
    body:JSON.stringify({
      model:'gpt-4o-2024-08-06',
      messages:[
        {role:'system',content:'You are a hospital staff schedule status classifier. Classify each rawStatus into D(day), N(night), AL(annual leave), RO(request off), X(rest/off), or skip(not a shift status). Return ONLY valid JSON.'},
        {role:'user',content:JSON.stringify([...byStatus.values()],null,2)}
      ],
      response_format:{type:'json_schema',json_schema:{name:'status_classifications',strict:true,schema:STATUS_CLASSIFIER_SCHEMA}},
      max_tokens:1200
    })
  },22000);
  if (!resp.ok) { const e=await resp.json().catch(()=>({})); throw new Error(`OpenAI classifier ${resp.status}: ${e.error?.message||'unknown'}`); }
  return JSON.parse((await resp.json()).choices[0].message.content).classifications;
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — FORMAT DETECTOR
// ─────────────────────────────────────────────────────────────────────────────
const FORMAT_SCHEMA = {
  type:'object',
  properties:{detectedFormat:{type:'string',enum:['daily_rows_under_employee','horizontal_table','section_mode','unknown']},datePattern:{type:'string',enum:['MM/DD/YYYY','YYYY-MM-DD','MM/DD','day_numbers_only','unknown']},employeeHeaderPattern:{type:'string',enum:['numbered','QUICK_SECTION','EMPLOYEE_label','left_column_names','unknown']},parsingPlan:{type:'string'},confidence:{type:'number'}},
  required:['detectedFormat','datePattern','employeeHeaderPattern','parsingPlan','confidence'],additionalProperties:false
};

async function callOpenAIFormatDetector(sampleText, diagnostics) {
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},
    body:JSON.stringify({model:'gpt-4o-2024-08-06',messages:[{role:'system',content:'You are a schedule format detector. Return a format detection plan only. Do NOT produce employee data.'},{role:'user',content:'=== SAMPLE ===\n'+sampleText+'\n\n=== DIAGNOSTICS ===\n'+JSON.stringify(diagnostics,null,2)}],response_format:{type:'json_schema',json_schema:{name:'format_detection',strict:true,schema:FORMAT_SCHEMA}},max_tokens:500})
  },20000);
  if (!resp.ok) { const e=await resp.json().catch(()=>({})); throw new Error(`Format detector ${resp.status}: ${e.error?.message||'unknown'}`); }
  return JSON.parse((await resp.json()).choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — STRUCTURAL AUDIT  (only when AI_VERIFY=true)
// ─────────────────────────────────────────────────────────────────────────────
const AUDIT_SCHEMA = {
  type:'object',
  properties:{pass:{type:'boolean'},severity:{type:'string',enum:['none','low','medium','high']},issues:{type:'array',items:{type:'object',properties:{type:{type:'string',enum:['missing_employee','unknown_status','wrong_period','unsupported_format','low_confidence','other']},message:{type:'string'},evidence:{type:'string'}},required:['type','message','evidence'],additionalProperties:false}},recommendedAction:{type:'string',enum:['accept','block_output','needs_format_fallback']},detectedFormat:{type:'string',enum:['daily_rows_under_employee','horizontal_table','section_mode','unknown']},confidence:{type:'number'},suggestedMappings:{type:'array',items:{type:'object',properties:{rawStatus:{type:'string'},mappedCode:{type:'string',enum:['D','N','AL','RO','X','skip']},confidence:{type:'number'},reason:{type:'string'}},required:['rawStatus','mappedCode','confidence','reason'],additionalProperties:false}}},
  required:['pass','severity','issues','recommendedAction','detectedFormat','confidence','suggestedMappings'],additionalProperties:false
};

function buildAuditPayload(rawBlocks, diagnostics) {
  return { sampleBlocks:(rawBlocks||[]).slice(0,4).map(b=>String(b).slice(0,400)).join('\n---\n'), diagnostics:slimDiagnostics(diagnostics) };
}

async function callOpenAIAudit(payload) {
  const resp = await fetchWithTimeout('https://api.openai.com/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},
    body:JSON.stringify({model:'gpt-4o-2024-08-06',messages:[{role:'system',content:'You are a hospital staff schedule audit assistant. You do NOT produce employee data. You only return an audit report.'},{role:'user',content:'=== SAMPLE ===\n'+payload.sampleBlocks+'\n\n=== DIAGNOSTICS ===\n'+JSON.stringify(payload.diagnostics,null,2)}],response_format:{type:'json_schema',json_schema:{name:'audit_report',strict:true,schema:AUDIT_SCHEMA}},max_tokens:1200})
  },22000);
  if (!resp.ok) { const e=await resp.json().catch(()=>({})); throw new Error(`OpenAI audit ${resp.status}: ${e.error?.message||'unknown'}`); }
  return JSON.parse((await resp.json()).choices[0].message.content);
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl=new AbortController(), timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try { const resp=await fetch(url,{...options,signal:ctrl.signal}); clearTimeout(timer); return resp; }
  catch(err) { clearTimeout(timer); if(err.name==='AbortError') throw new Error(`OpenAI request timed out after ${timeoutMs}ms`); throw err; }
}
