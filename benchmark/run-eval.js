import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// LogHub-style evaluation aligned with logpai/logparser: GA = pairwise F1, PA = perfect-cluster accuracy.

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

function loadGroundTruth(datasetDir) {
  const structured = fs
    .readdirSync(datasetDir)
    .filter((f) => f.endsWith('_structured_corrected.csv') || f.endsWith('_structured.csv'))
    .sort((a, b) => (a.includes('_corrected') ? -1 : 0) - (b.includes('_corrected') ? -1 : 0))[0];
  if (!structured) return null;
  const records = parseCsv(fs.readFileSync(path.join(datasetDir, structured), 'utf8'));
  return records.map((r) => r.EventId ?? r.EventID ?? r.eventId ?? r.eventid ?? '');
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
  if (!fs.existsSync(reportsDir)) return new Set();
  const failureFile = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('-failures.jsonl'))
    .sort()
    .at(-1);
  if (!failureFile) return new Set();
  const full = path.join(reportsDir, failureFile);
  if (fs.statSync(full).size === 0) return new Set();
  const failed = new Set();
  fs.readFileSync(full, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l)
    .forEach((line) => {
      try {
        const obj = JSON.parse(line);
        if (typeof obj.lineIndex === 'number') failed.add(obj.lineIndex);
      } catch {
        // ignore malformed
      }
    });
  return failed;
}

function loadMatches(reportsDir) {
  if (!fs.existsSync(reportsDir)) return null;
  const matchesFile = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('-matches.csv'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((r) => r.f)
    .at(0);
  if (!matchesFile) return null;
  return parseCsv(fs.readFileSync(path.join(reportsDir, matchesFile), 'utf8'));
}

const PLACEHOLDER_PATTERN = /⟪[^⟫]+⟫/g;
function normalizePlaceholder(str) {
  if (!str) return '';
  return str.replace(PLACEHOLDER_PATTERN, '<*>').replace(/\s+/g, ' ').trim();
}

function accuracyMetrics(truth, pred) {
  const comb2 = (n) => (n < 2 ? 0 : (n * (n - 1)) / 2);

  const truthCounts = new Map();
  truth.forEach((id) => truthCounts.set(id, (truthCounts.get(id) ?? 0) + 1));
  let realPairs = 0;
  truthCounts.forEach((c) => {
    if (c > 1) realPairs += comb2(c);
  });

  const predCounts = new Map();
  pred.forEach((id) => predCounts.set(id, (predCounts.get(id) ?? 0) + 1));
  let parsedPairs = 0;
  predCounts.forEach((c) => {
    if (c > 1) parsedPairs += comb2(c);
  });

  let accuratePairs = 0;
  let accurateEvents = 0;
  predCounts.forEach((_, predId) => {
    const idxs = [];
    pred.forEach((pid, i) => {
      if (pid === predId) idxs.push(i);
    });
    const gtCounts = new Map();
    idxs.forEach((i) => {
      const gt = truth[i];
      gtCounts.set(gt, (gtCounts.get(gt) ?? 0) + 1);
    });
    const gtKeys = Array.from(gtCounts.keys());
    if (gtKeys.length === 1) {
      const gtId = gtKeys[0];
      const clusterSize = idxs.length;
      const gtTotal = truthCounts.get(gtId) ?? 0;
      if (clusterSize === gtTotal) accurateEvents += clusterSize;
    }
    gtCounts.forEach((c) => {
      if (c > 1) accuratePairs += comb2(c);
    });
  });

  const precision = parsedPairs === 0 ? 0 : accuratePairs / parsedPairs;
  const recall = realPairs === 0 ? 0 : accuratePairs / realPairs;
  const f1 = precision === 0 && recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const accuracy = truth.length === 0 ? 0 : accurateEvents / truth.length;
  return { precision, recall, f1, accuracy };
}

function buildPredictedIds(total, matches, failed, rawLines) {
  const pred = new Array(total).fill('__UNPARSED__');
  const tplIds = new Array(total).fill('');

  // Map raw log text to queues of line indices for alignment.
  const buckets = new Map();
  rawLines.forEach((line, idx) => {
    const key = line.trimEnd();
    const arr = buckets.get(key) ?? [];
    arr.push(idx);
    buckets.set(key, arr);
  });

  matches.forEach((row, idx) => {
    const raw = (row.raw_log ?? row.raw ?? '').trimEnd();
    const bucket = buckets.get(raw);
    if (!bucket || bucket.length === 0) {
      return;
    }
    const lineIdx = bucket.shift();
    if (failed.has(lineIdx)) {
      pred[lineIdx] = '__FAILED__';
      return;
    }
    const tplId = row.template_id ?? row.templateId ?? '';
    const fallback = normalizePlaceholder(row.template_placeholder ?? row.template ?? '');
    pred[lineIdx] = tplId || fallback || `template#${idx}`;
    tplIds[lineIdx] = tplId;
  });

  // Mark remaining failed lines explicitly.
  failed.forEach((i) => {
    if (i >= 0 && i < total) {
      pred[i] = '__FAILED__';
    }
  });

  // Any still unparsed remain as '__UNPARSED__'.
  return { pred, tplIds };
}

function collapsePureClusters(truth, pred) {
  // Collapses over-split pure clusters: if a predicted cluster contains only one GT id,
  // merge all clusters with the same GT id into one pseudo cluster keyed by that GT.
  const gtByPred = new Map();
  pred.forEach((p, idx) => {
    const gt = truth[idx];
    const set = gtByPred.get(p) ?? new Set();
    set.add(gt);
    gtByPred.set(p, set);
  });

  const mapping = new Map(); // pred cluster -> merged cluster label
  pred.forEach((p, idx) => {
    const gts = gtByPred.get(p) ?? new Set();
    if (gts.size === 1) {
      const onlyGt = Array.from(gts)[0];
      mapping.set(p, `__PURE__#${onlyGt}`);
    } else {
      mapping.set(p, p); // keep mixed clusters as-is
    }
  });

  const mergedPred = pred.map((p) => mapping.get(p) ?? p);

  return { mergedPred };
}

function purityMetric(baseIds, otherIds) {
  // Weighted average of the dominant-other ratio per base cluster.
  const baseToOtherCounts = new Map();
  baseIds.forEach((base, idx) => {
    const other = otherIds[idx];
    const counts = baseToOtherCounts.get(base) ?? new Map();
    counts.set(other, (counts.get(other) ?? 0) + 1);
    baseToOtherCounts.set(base, counts);
  });

  let topSum = 0;
  let totalSum = 0;
  baseToOtherCounts.forEach((counts) => {
    let total = 0;
    let top = 0;
    counts.forEach((c) => {
      total += c;
      if (c > top) top = c;
    });
    topSum += top;
    totalSum += total;
  });
  return totalSum === 0 ? 0 : topSum / totalSum;
}

function evaluateDataset(dataset, benchRoot, datasetsRoot) {
  const datasetDir = path.join(datasetsRoot, dataset);
  const reportsDir = path.join(benchRoot, dataset, 'reports');
  if (!fs.existsSync(datasetDir)) return { dataset, error: 'dataset missing' };
  if (!fs.existsSync(reportsDir)) return { dataset, error: 'reports missing' };

  const truth = loadGroundTruth(datasetDir);
  if (!truth) return { dataset, error: 'ground truth missing' };
  const rawLines = loadRawLogLines(datasetDir);
  const failed = loadFailures(reportsDir);
  const matches = loadMatches(reportsDir);
  if (!matches) return { dataset, error: 'matches missing' };

  const total = truth.length;
  const { pred } = buildPredictedIds(total, matches, failed, rawLines);
  const matchedCount = pred.filter((p) => p !== '__UNPARSED__' && p !== '__FAILED__').length;
  const coverage = total === 0 ? 0 : matchedCount / total;

  const { precision, recall, f1, accuracy } = accuracyMetrics(truth, pred);
  const gtPurity = purityMetric(truth, pred);
  const predPurity = purityMetric(pred, truth);

  // Over-split friendly metrics: collapse pure clusters.
  const { mergedPred } = collapsePureClusters(truth, pred);
  const friendly = accuracyMetrics(truth, mergedPred);

  return {
    dataset,
    total,
    matched: matchedCount,
    failed: failed.size,
    coverage,
    GA: f1,
    GA_precision: precision,
    GA_recall: recall,
    PA: accuracy,
    predPurity,
    gtPurity,
    GA_friendly: friendly.f1,
    GA_friendly_precision: friendly.precision,
    GA_friendly_recall: friendly.recall,
    PA_friendly: friendly.accuracy,
  };
}

function main() {
  // Resolve project root relative to this script to avoid CWD issues.
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, '..');
  const benchRoot = path.join(root, 'benchmark', 'results');
  const datasetsRoot = path.join(root, 'datasets');
  if (!fs.existsSync(benchRoot)) {
    console.error(`${benchRoot} is missing; run the parser first.`);
    process.exit(1);
  }
  const resultsDir = path.join(root, 'benchmark', 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const datasets = fs
    .readdirSync(benchRoot)
    .filter((d) => fs.statSync(path.join(benchRoot, d)).isDirectory())
    .sort();

  const results = datasets.map((d) => evaluateDataset(d, benchRoot, datasetsRoot));
  const valid = results.filter((r) => !r.error);
  const maxNameLen = Math.max(...datasets.map((d) => d.length), 'Macro'.length);
  const fmtName = (name) => `${name.padEnd(maxNameLen)}\t`;
  const macro = valid.reduce(
    (acc, r) => {
      acc.GA += r.GA;
      acc.GA_precision += r.GA_precision;
      acc.GA_recall += r.GA_recall;
      acc.PA += r.PA;
      acc.predPurity += r.predPurity;
      acc.gtPurity += r.gtPurity;
      acc.coverage += r.coverage;
      acc.GA_friendly += r.GA_friendly;
      acc.GA_friendly_precision += r.GA_friendly_precision;
      acc.GA_friendly_recall += r.GA_friendly_recall;
      acc.PA_friendly += r.PA_friendly;
      acc.count += 1;
      acc.totalLines += r.total;
      acc.failedLines += r.failed;
      return acc;
    },
    {
      GA: 0,
      GA_precision: 0,
      GA_recall: 0,
      PA: 0,
      predPurity: 0,
      gtPurity: 0,
      coverage: 0,
      GA_friendly: 0,
      GA_friendly_precision: 0,
      GA_friendly_recall: 0,
      PA_friendly: 0,
      count: 0,
      totalLines: 0,
      failedLines: 0,
    },
  );
  if (macro.count > 0) {
    macro.GA /= macro.count;
    macro.GA_precision /= macro.count;
    macro.GA_recall /= macro.count;
    macro.PA /= macro.count;
    macro.predPurity /= macro.count;
    macro.gtPurity /= macro.count;
    macro.coverage /= macro.count;
    macro.GA_friendly /= macro.count;
    macro.GA_friendly_precision /= macro.count;
    macro.GA_friendly_recall /= macro.count;
    macro.PA_friendly /= macro.count;
    macro.microFailedRate = macro.totalLines === 0 ? 0 : macro.failedLines / macro.totalLines;
  }

  const now = new Date().toISOString();
  const outfile = path.join(resultsDir, `${now.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(outfile, JSON.stringify({ generatedAt: now, datasets: results, macro }, null, 2));

  console.log('GA = pairwise F1 (LogPAI), PA = perfect-cluster accuracy.');
  results.forEach((r) => {
    if (r.error) {
      console.log(`${fmtName(r.dataset)}ERROR ${r.error}`);
      return;
    }
    console.log(
      `${fmtName(r.dataset)}GA=${r.GA.toFixed(3)} (P=${r.GA_precision.toFixed(3)}, R=${r.GA_recall.toFixed(
        3,
      )}) PA=${r.PA.toFixed(3)} predPure=${r.predPurity.toFixed(
        3,
      )} gtPure=${r.gtPurity.toFixed(
        3,
      )} | friendly GA=${r.GA_friendly.toFixed(3)} (P=${r.GA_friendly_precision.toFixed(
        3,
      )}, R=${r.GA_friendly_recall.toFixed(3)}) PA=${r.PA_friendly.toFixed(3)} cov=${r.coverage.toFixed(3)}`,
    );
  });
  if (macro.count > 0) {
    console.log(
      `${fmtName('Macro')}GA=${macro.GA.toFixed(3)} (P=${macro.GA_precision.toFixed(3)}, R=${macro.GA_recall.toFixed(
        3,
      )}) PA=${macro.PA.toFixed(3)} predPure=${macro.predPurity.toFixed(
        3,
      )} gtPure=${macro.gtPurity.toFixed(
        3,
      )} | friendly GA=${macro.GA_friendly.toFixed(3)} (P=${macro.GA_friendly_precision.toFixed(
        3,
      )}, R=${macro.GA_friendly_recall.toFixed(3)}) PA=${macro.PA_friendly.toFixed(
        3,
      )} cov=${macro.coverage.toFixed(3)} avgFailedRate=${macro.microFailedRate.toFixed(3)}`,
    );
  }
  console.log('Wrote', outfile);
}

main();
