/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Simple diversity sampler inspired by k-center / DPP heuristics.
 * Selects a small set of lines that are maximally different by token Jaccard distance.
 */
export const selectDiverseSamples = (
  logs: string[],
  count = 12,
  poolSize = 200,
): string[] => {
  const unique = Array.from(new Set(logs.filter((line) => typeof line === 'string' && line.trim())));
  if (unique.length <= count) {
    return unique;
  }

  const pool = thinPool(unique, poolSize);
  const tokenized = pool.map(tokenize);

  const selected: number[] = [];
  if (pool.length > 0) {
    selected.push(0);
  }

  while (selected.length < Math.min(count, pool.length)) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      if (selected.includes(i)) continue;
      const dist = minDistanceToSelected(tokenized, selected, i);
      if (dist > bestScore) {
        bestScore = dist;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) {
      break;
    }
    selected.push(bestIndex);
  }

  return selected.map((idx) => pool[idx]);
};

const thinPool = (logs: string[], poolSize: number): string[] => {
  if (logs.length <= poolSize) {
    return logs;
  }
  const step = Math.max(1, Math.floor(logs.length / poolSize));
  const result: string[] = [];
  for (let i = 0; i < logs.length && result.length < poolSize; i += step) {
    result.push(logs[i]);
  }
  return result;
};

const tokenize = (line: string): Set<string> => {
  return new Set(
    line
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean),
  );
};

const jaccardDistance = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
};

const minDistanceToSelected = (
  tokenized: Set<string>[],
  selected: number[],
  candidateIndex: number,
): number => {
  let min = Infinity;
  for (const idx of selected) {
    min = Math.min(min, jaccardDistance(tokenized[idx], tokenized[candidateIndex]));
  }
  return min === Infinity ? 0 : min;
};
