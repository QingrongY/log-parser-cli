import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PLACEHOLDER_PATTERN = /\u001b\]9;var=[^\u0007]+\u0007/g;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  for (let i = 0; i <= text.length; i += 1) {
    const c = text[i];
    const end = i === text.length;
    if (end || ((!inQuotes) && (c === '\n' || c === '\r'))) {
      pushField();
      pushRow();
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      continue;
    }
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (c === ',' && !inQuotes) {
      pushField();
      continue;
    }
    field += c;
  }
  const header = rows.shift() ?? [];
  return rows
    .filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

function loadStructured(datasetDir) {
  const structured = fs
    .readdirSync(datasetDir)
    .filter((f) => f.endsWith('_structured_corrected.csv') || f.endsWith('_structured.csv'))
    .sort((a, b) => (a.includes('_corrected') ? -1 : 0) - (b.includes('_corrected') ? -1 : 0))[0];
  if (!structured) return [];
  return parseCsv(fs.readFileSync(path.join(datasetDir, structured), 'utf8'));
}

function loadTemplates(datasetDir) {
  const tplFile = fs
    .readdirSync(datasetDir)
    .filter((f) => f.endsWith('_templates_corrected.csv') || f.endsWith('_templates.csv'))
    .sort((a, b) => (a.includes('_corrected') ? -1 : 0) - (b.includes('_corrected') ? -1 : 0))[0];
  if (!tplFile) return new Map();
  const map = new Map();
  parseCsv(fs.readFileSync(path.join(datasetDir, tplFile), 'utf8')).forEach((r) => {
    const id = r.EventId ?? r.EventID ?? r.eventId ?? '';
    if (id) map.set(id, r.EventTemplate ?? r.eventTemplate ?? '');
  });
  return map;
}

function loadRawLogLines(datasetDir) {
  const logs = fs
    .readdirSync(datasetDir)
    .filter((f) => f.toLowerCase().endsWith('.log'))
    .sort((a, b) => {
      const aHas2k = a.toLowerCase().includes('2k');
      const bHas2k = b.toLowerCase().includes('2k');
      if (aHas2k && !bHas2k) return -1;
      if (!aHas2k && bHas2k) return 1;
      return a.localeCompare(b);
    });
  if (logs.length === 0) return [];
  const raw = fs.readFileSync(path.join(datasetDir, logs[0]), 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.length > 0);
}

function loadFailures(reportsDir) {
  const failed = new Set();
  const failureFile = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('-failures.jsonl'))
    .sort()
    .at(-1);
  if (!failureFile) return failed;
  const full = path.join(reportsDir, failureFile);
  if (fs.statSync(full).size === 0) return failed;
  fs.readFileSync(full, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l)
    .forEach((line) => {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.lineIndex === 'number') failed.add(obj.lineIndex);
      } catch {
        // ignore
      }
    });
  return failed;
}

function loadMatches(reportsDir) {
  const matchesFile = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('-matches.csv'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.f)
    .at(0);
  if (!matchesFile) return [];
  return parseCsv(fs.readFileSync(path.join(reportsDir, matchesFile), 'utf8'));
}

function normalizePlaceholder(str) {
  if (!str) return '';
  return str.replace(PLACEHOLDER_PATTERN, '<*>').replace(/\s+/g, ' ').trim();
}

function csvEscape(v) {
  const s = v ?? '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildAlignment(dataset, benchRoot, datasetsRoot) {
  const datasetDir = path.join(datasetsRoot, dataset);
  const reportsDir = path.join(benchRoot, dataset, 'reports');
  if (!fs.existsSync(datasetDir) || !fs.existsSync(reportsDir)) return null;

  const rawLines = loadRawLogLines(datasetDir);
  const structured = loadStructured(datasetDir);
  const gtTemplates = loadTemplates(datasetDir);
  const failed = loadFailures(reportsDir);
  const matches = loadMatches(reportsDir);

  const lineBuckets = new Map();
  rawLines.forEach((line, idx) => {
    const arr = lineBuckets.get(line) ?? [];
    arr.push(idx);
    lineBuckets.set(line, arr);
  });

  const total = Math.max(rawLines.length, structured.length);
  const rows = new Array(total);
  for (let i = 0; i < total; i += 1) {
    const gt = structured[i] ?? {};
    const gtEventId = gt.EventId ?? gt.eventId ?? gt.eventid ?? '';
    const gtTemplate =
      gt.EventTemplate ?? gt.eventTemplate ?? gtTemplates.get(gtEventId) ?? '';
    const raw = rawLines[i] ?? '';
    const predStatus = failed.has(i) ? 'failed' : 'unparsed';
    rows[i] = {
      line: i + 1,
      raw,
      predStatus,
      predTemplate: '',
      predTemplateNormalized: '',
      predTemplateId: '',
      predVariables: '',
      gtEventId,
      gtTemplate,
    };
  }

  matches.forEach((m) => {
    const raw = m.raw_log ?? m.raw ?? '';
    const bucket = lineBuckets.get(raw);
    if (!bucket || bucket.length === 0) return;
    const lineIdx = bucket.shift();
    const target = rows[lineIdx];
    target.predStatus = 'matched';
    target.predTemplate = m.template_placeholder ?? m.template ?? '';
    target.predTemplateNormalized = normalizePlaceholder(target.predTemplate);
    target.predTemplateId = m.template_id ?? m.templateId ?? '';
    target.predVariables = m.variables ?? '';
  });

  return rows;
}

function writeAlignmentCsv(dataset, rows, outDir) {
  const header = [
    'line',
    'pred_template_id',
    'pred_template_normalized',
    'gt_event_id',
    'gt_event_template',
    'raw_log',
  ];
  const csvLines = [header.join(',')];
  rows.forEach((r) => {
    csvLines.push(
      [
        r.line,
        csvEscape(r.predTemplateId),
        csvEscape(r.predTemplateNormalized),
        csvEscape(r.gtEventId),
        csvEscape(r.gtTemplate),
        csvEscape(r.raw),
      ].join(','),
    );
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'alignment.csv'), csvLines.join('\n'));
}

function summarizeClusters(dataset, rows) {
  const clusters = new Map();
  rows.forEach((r) => {
    if (r.predStatus !== 'matched') return;
    const key = r.predTemplateId || r.predTemplateNormalized || '__UNKNOWN__';
    const entry =
      clusters.get(key) ?? {
        predTemplateId: r.predTemplateId,
        predTemplateNormalized: r.predTemplateNormalized,
        total: 0,
        gtCounts: new Map(),
        sampleLine: r.line,
      };
    entry.total += 1;
    entry.gtCounts.set(r.gtEventId, (entry.gtCounts.get(r.gtEventId) ?? 0) + 1);
    clusters.set(key, entry);
  });

  const summary = [];
  clusters.forEach((entry, key) => {
    const gtArr = Array.from(entry.gtCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topGt = gtArr[0]?.[0] ?? '';
    const topCount = gtArr[0]?.[1] ?? 0;
    const purity = entry.total === 0 ? 0 : topCount / entry.total;
    summary.push({
      dataset,
      clusterId: key,
      predTemplateId: entry.predTemplateId,
      predTemplateNormalized: entry.predTemplateNormalized,
      clusterSize: entry.total,
      distinctGt: gtArr.length,
      topGt,
      topGtCount: topCount,
      purity,
      sampleLine: entry.sampleLine,
      topGtCounts: gtArr.slice(0, 10).map(([g, c]) => `${g}:${c}`).join('|'),
    });
  });
  return summary;
}

function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const root = path.resolve(__dirname, '..');
  const benchRoot = path.join(root, 'artifacts');
  const datasetsRoot = path.join(root, 'datasets');
  if (!fs.existsSync(benchRoot)) {
    console.error('artifacts is missing; run the parser first.');
    process.exit(1);
  }

  const alignRoot = path.join(root, 'evaluation', 'alignments');
  const resultsRoot = path.join(root, 'evaluation', 'results');
  fs.mkdirSync(alignRoot, { recursive: true });
  fs.mkdirSync(resultsRoot, { recursive: true });

  const datasets = fs
    .readdirSync(benchRoot)
    .filter((d) => fs.statSync(path.join(benchRoot, d)).isDirectory())
    .sort();

  const clusterSummaries = [];
  datasets.forEach((dataset) => {
    const rows = buildAlignment(dataset, benchRoot, datasetsRoot);
    if (!rows) return;
    const outDir = path.join(alignRoot, dataset);
    writeAlignmentCsv(dataset, rows, outDir);
    clusterSummaries.push(...summarizeClusters(dataset, rows));
    console.log(`${dataset}: ${outDir}/alignment.csv`);
  });

  const now = new Date().toISOString().replace(/[:.]/g, '-');
  const clusterFile = path.join(resultsRoot, `${now}-clusters.csv`);
  const header = [
    'dataset',
    'cluster_id',
    'pred_template_id',
    'pred_template_normalized',
    'cluster_size',
    'distinct_gt',
    'top_gt',
    'top_gt_count',
    'purity',
    'sample_line',
    'top_gt_counts',
  ];
  const lines = [header.join(',')];
  clusterSummaries
    .sort((a, b) => b.clusterSize - a.clusterSize)
    .forEach((c) => {
      lines.push(
        [
          c.dataset,
          csvEscape(c.clusterId),
          csvEscape(c.predTemplateId),
          csvEscape(c.predTemplateNormalized),
          c.clusterSize,
          c.distinctGt,
          csvEscape(c.topGt),
          c.topGtCount,
          c.purity.toFixed(4),
          c.sampleLine,
          csvEscape(c.topGtCounts),
        ].join(','),
      );
    });
  fs.writeFileSync(clusterFile, lines.join('\n'));
  console.log('Cluster summary:', clusterFile);
}

main();
