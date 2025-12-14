import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const PLACEHOLDER = '<*>';

const gzipSize = (text) => zlib.gzipSync(Buffer.from(text, 'utf8')).length;

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

function extractValues(template, raw) {
  const segments = template.split(PLACEHOLDER);
  if (segments.length <= 1) return [];

  const pattern = segments
    .map((segment) =>
      segment
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+'),
    )
    .join('(.*?)');
  const regex = new RegExp(`^${pattern}$`);
  const match = regex.exec(raw);
  if (!match) return null;
  return match.slice(1);
}

function gainFromValues(values) {
  if (!values || values.length <= 1) return 0;
  const indiv = values.reduce((acc, v) => acc + gzipSize(v), 0);
  const combined = gzipSize(values.join('\n'));
  if (indiv === 0) return 0;
  return (indiv - combined) / indiv;
}

function analyzeTemplate(cluster) {
  const { template, rows } = cluster;
  const placeholders = template.split(PLACEHOLDER).length - 1;

  const rawLogs = [];
  const extracted = [];
  let successCount = 0;

  rows.forEach((row) => {
    const raw = row.raw_log ?? row.raw ?? '';
    rawLogs.push(raw);
    if (placeholders <= 0) return;
    const vals = extractValues(template, raw);
    if (!vals || vals.length !== placeholders) {
      return;
    }
    successCount += 1;
    extracted.push(vals);
  });

  const varGains = [];
  if (placeholders > 0 && extracted.length > 1) {
    for (let i = 0; i < placeholders; i += 1) {
      const vals = extracted.map((arr) => arr[i]);
      varGains.push(gainFromValues(vals));
    }
  }

  const rawSize = gzipSize(rawLogs.join('\n'));
  const literalCost = gzipSize(template);
  const varsFlat = extracted.flat();
  const varsCost = varsFlat.length === 0 ? 0 : gzipSize(varsFlat.join('\n'));
  const templCost = literalCost + varsCost;
  const templateGain = rawSize === 0 ? 0 : (rawSize - templCost) / rawSize;

  const gtSet = new Set(rows.map((r) => r.gt_event_id || ''));

  const reasons = [];
  if (gtSet.size > 1) reasons.push(`multi_gt(${gtSet.size})`);
  varGains.forEach((g, idx) => {
    if (g < 0) reasons.push(`var${idx + 1}_low_gain(${g.toFixed(3)})`);
  });
  if (templateGain < -0.1) reasons.push(`template_gain_negative(${templateGain.toFixed(3)})`);
  if (placeholders > 0 && successCount < rows.length * 0.6) {
    reasons.push(`extraction_low_success(${successCount}/${rows.length})`);
  }

  return {
    placeholders,
    size: rows.length,
    distinctGt: gtSet.size,
    varGains,
    templateGain,
    reasons,
  };
}

function loadAlignment(file) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const clusters = new Map();
  rows.forEach((r) => {
    const tplId = r.pred_template_id || r.pred_template_normalized || '__NONE__';
    const tplKey = tplId || r.pred_template_normalized || '__NONE__';
    const entry =
      clusters.get(tplKey) ??
      {
        templateId: tplId,
        template: r.pred_template_normalized || '',
        rows: [],
      };
    entry.rows.push(r);
    clusters.set(tplKey, entry);
  });
  return { rows, clusters: Array.from(clusters.values()) };
}

const csvEscape = (value) => {
  const s = value ?? '';
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

function writeAugmented(dataset, rows, statsByKey, outPath) {
  const header = [
    'line',
    'pred_template_id',
    'pred_template_normalized',
    'gt_event_id',
    'gt_event_template',
    'raw_log',
    'overbroad_flag',
    'overbroad_reasons',
    'template_gain',
    'var_gains',
    'cluster_size',
    'distinct_gt',
  ];
  const lines = [header.join(',')];
  rows.forEach((r) => {
    const key = r.pred_template_id || r.pred_template_normalized || '__NONE__';
    const stats = statsByKey.get(key);
    const reasons = stats?.reasons ?? [];
    lines.push(
      [
        r.line,
        csvEscape(r.pred_template_id),
        csvEscape(r.pred_template_normalized),
        csvEscape(r.gt_event_id),
        csvEscape(r.gt_event_template),
        csvEscape(r.raw_log),
        reasons.length > 0 ? '1' : '0',
        csvEscape(reasons.join(';')),
        stats ? stats.templateGain.toFixed(3) : '',
        stats ? stats.varGains.map((g) => g.toFixed(3)).join('|') : '',
        stats?.size ?? '',
        stats?.distinctGt ?? '',
      ].join(','),
    );
  });
  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`${dataset}: wrote ${outPath}`);
}

function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDir, '..');
  const alignRoot = path.join(root, 'benchmark', 'ours', 'alignments');
  const datasets = fs
    .readdirSync(alignRoot)
    .filter((d) => fs.statSync(path.join(alignRoot, d)).isDirectory())
    .sort();

  const flagged = [];

  datasets.forEach((dataset) => {
    const file = path.join(alignRoot, dataset, 'alignment.csv');
    if (!fs.existsSync(file)) return;
    const { rows, clusters } = loadAlignment(file);
    const statsByKey = new Map();
    clusters.forEach((c) => {
      if (!c.template) return;
      const stats = analyzeTemplate(c);
      if (stats.reasons.length === 0) return;
      statsByKey.set(c.templateId || c.template || '__NONE__', { ...stats, size: c.rows.length });
      flagged.push({
        dataset,
        templateId: c.templateId,
        template: c.template,
        size: stats.size,
        distinctGt: stats.distinctGt,
        templateGain: Number(stats.templateGain.toFixed(3)),
        varGains: stats.varGains.map((g) => Number(g.toFixed(3))),
        reasons: stats.reasons,
      });
    });
    const augmentedPath = path.join(alignRoot, dataset, 'alignment_with_overbroad.csv');
    clusters.forEach((c) => {
      const stats = analyzeTemplate(c);
      statsByKey.set(c.templateId || c.template || '__NONE__', { ...stats, size: c.rows.length });
    });
    writeAugmented(dataset, rows, statsByKey, augmentedPath);
  });

  flagged
    .sort((a, b) => b.size - a.size)
    .slice(0, 50)
    .forEach((f) => {
      console.log(
        [
          `${f.dataset} | ${f.templateId} | size=${f.size} | gt=${f.distinctGt}`,
          `gain=${f.templateGain}`,
          `vars=[${f.varGains.join(', ')}]`,
          `reasons=${f.reasons.join(';')}`,
          `tpl=${f.template}`,
        ].join(' || '),
      );
    });

  console.log(`Flagged templates: ${flagged.length}`);
}

main();
