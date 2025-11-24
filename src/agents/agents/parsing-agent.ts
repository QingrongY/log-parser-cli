/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAgent } from '../base-agent.js';
import type {
  AgentContext,
  AgentResult,
  BaseAgentConfig,
  LogTemplateDefinition,
} from '../types.js';
import { buildParsingPrompt, PARSING_SYSTEM_PROMPT } from '../prompts/parsing.js';
import { extractJsonObject } from '../utils/json.js';
import { normalizeRegexPattern } from '../utils/regex.js';
import { ensureValidRegex } from '../utils/validation.js';

export interface ParsingAgentInput {
  samples: string[];
  variableHints?: string[];
}

export interface ParsingAgentOutput extends LogTemplateDefinition {
  sampleCount: number;
  promptUsed: string;
}

interface ParsingLlmResponse {
  template: string;
  variables: Record<string, string>;
  description?: string;
  example?: Record<string, unknown>;
}

interface LlmParsingResult {
  template: LogTemplateDefinition;
  prompt: string;
}

class ParsingFailureError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
  }
}

const PARSING_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['template', 'variables'],
  properties: {
    template: { type: 'string', minLength: 1 },
    variables: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
    description: { type: 'string' },
    example: { type: 'object' },
  },
};

export class ParsingAgent extends BaseAgent<ParsingAgentInput, ParsingAgentOutput> {
  constructor(config: Omit<BaseAgentConfig, 'kind'> = {}) {
    super({ kind: 'parsing', ...config });
  }

  protected async handle(
    input: ParsingAgentInput,
    context: AgentContext,
  ): Promise<AgentResult<ParsingAgentOutput>> {
    const samples = input.samples ?? [];
    if (samples.length === 0) {
      return {
        status: 'needs-input',
        issues: ['Parsing requires at least one raw log sample.'],
      };
    }

    if (!this.llmClient) {
      return {
        status: 'needs-input',
        issues: ['Gemini client not configured; cannot derive template automatically.'],
      };
    }

    const variableHints = (input.variableHints ?? []).map((hint) =>
      hint.trim().toLowerCase(),
    );

    const prompt = buildParsingPrompt({ logLine: samples[0], variableHints });

    try {
      const llmResult = await this.generateWithLlm(
        samples[0],
        variableHints,
        context,
        prompt,
      );
      return {
        status: 'success',
        output: {
          ...llmResult.template,
          sampleCount: samples.length,
          promptUsed: llmResult.prompt,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details =
        error instanceof ParsingFailureError ? error.details : undefined;
      this.logger.warn('LLM parsing failed', { message, details });
      return {
        status: 'retryable-error',
        issues: [`LLM parsing failed: ${message}`],
        diagnostics: { promptUsed: prompt, ...(details ?? {}) },
      };
    }
  }

  private async generateWithLlm(
    sample: string,
    variableHints: string[],
    context: AgentContext,
    prompt: string,
  ): Promise<LlmParsingResult> {
    const completion = await this.llmClient!.complete({
      prompt,
      systemPrompt: PARSING_SYSTEM_PROMPT,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: PARSING_RESPONSE_SCHEMA,
    });

    try {
      if (!completion.output?.trim()) {
        throw new ParsingFailureError('LLM returned empty response.', {
          llmRaw: safeSerialize(completion.raw),
        });
      }
      const parsed = extractJsonObject<ParsingLlmResponse>(completion.output);
      if (!parsed.template) {
        throw new ParsingFailureError('LLM response missing template with placeholders.', {
          llmOutput: completion.output,
        });
      }
      if (!parsed.variables || typeof parsed.variables !== 'object') {
        throw new ParsingFailureError('LLM response missing variables map.', {
          llmOutput: completion.output,
        });
      }
      const { pattern, variables } = buildRegexFromTemplate(sample, parsed.template, parsed.variables);
      const normalizedPattern = normalizeRegexPattern(pattern);
      ensureValidRegex(normalizedPattern);

      const template: LogTemplateDefinition = {
        pattern: normalizedPattern,
        variables,
        description: parsed.description ?? 'LLM-placeholder log template',
        source: context.templateLibraryId ?? context.sourceHint,
      metadata: {
        sample,
        variableHints,
        taggedSample: parsed.template,
        llmExample: parsed.example,
        llmModel: this.llmClient?.modelName,
        llmRaw: completion.output,
        llmTemplate: parsed.template,
        llmVariables: parsed.variables,
      },
      };

      return { template, prompt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const details =
        error instanceof ParsingFailureError ? error.details : undefined;
      throw new ParsingFailureError(message, {
        ...(details ?? {}),
        llmOutput: completion.output,
      });
    }
  }
}

type TaggedSegment =
  | { kind: 'text'; value: string }
  | { kind: 'var'; name: string; value: string };

const ESC = '\u001b';
const BEL = '\u0007';
const START_PREFIX = `${ESC}]9;slot=`;
const REGEX_SPECIAL = /[\\^$.*+?()[\]{}|]/g;

export const buildRegexFromTemplate = (
  sample: string,
  template: string,
  values: Record<string, string>,
): { pattern: string; variables: string[] } => {
  const segments = parseTemplateSegments(template, values);
  if (segments.length === 0) {
    throw new Error('LLM did not produce any placeholders.');
  }
  const hasVariables = segments.some((segment) => segment.kind === 'var');
  if (!hasVariables) {
    throw new Error('LLM output contained no variables.');
  }

  const reconstructed = segments
    .map((segment) => (segment.kind === 'var' ? segment.value : segment.value))
    .join('');
  if (reconstructed !== sample) {
    throw new Error('Template with values does not match the original log sample.');
  }

  const variables: string[] = [];
  const nameCounts = new Map<string, number>();
  const parts: string[] = [];

  for (const segment of segments) {
    if (segment.kind === 'text') {
      parts.push(escapeRegex(segment.value));
      continue;
    }
    const baseName = sanitizeVariableName(segment.name);
    const count = (nameCounts.get(baseName) ?? 0) + 1;
    nameCounts.set(baseName, count);
    const finalName = count === 1 ? baseName : `${baseName}${count}`;
    variables.push(finalName);
    const fragment = inferRegexForValue(segment.value);
    parts.push(`(?<${finalName}>${fragment})`);
  }

  return { pattern: parts.join(''), variables };
};

const parseTemplateSegments = (
  template: string,
  values: Record<string, string>,
): TaggedSegment[] => {
  const segments: TaggedSegment[] = [];
  let cursor = 0;

  const pushText = (end: number): void => {
    if (end > cursor) {
      segments.push({ kind: 'text', value: template.slice(cursor, end) });
    }
  };

  while (cursor < template.length) {
    const startIdx = template.indexOf(START_PREFIX, cursor);
    if (startIdx === -1) {
      pushText(template.length);
      break;
    }

    pushText(startIdx);
    const nameStart = startIdx + START_PREFIX.length;
    const nameEnd = template.indexOf(BEL, nameStart);
    if (nameEnd === -1) {
      // No terminator; treat the ESC as literal.
      segments.push({ kind: 'text', value: template.slice(startIdx, startIdx + 1) });
      cursor = startIdx + 1;
      continue;
    }

    const name = template.slice(nameStart, nameEnd);
    if (!name) {
      segments.push({ kind: 'text', value: template.slice(startIdx, nameEnd + 1) });
      cursor = nameEnd + 1;
      continue;
    }

    const value = values[name];
    if (value === undefined) {
      throw new Error(`LLM template placeholder "${name}" missing value in variables map.`);
    }

    segments.push({ kind: 'var', name, value });
    cursor = nameEnd + 1;
  }

  return segments;
};

const escapeRegex = (text: string): string => text.replace(REGEX_SPECIAL, '\\$&');

const sanitizeVariableName = (name: string): string => {
  const cleaned = name?.trim().toLowerCase().replace(/[^a-z0-9]/gi, '_');
  if (!cleaned) {
    throw new Error('Invalid variable name encountered in tags.');
  }
  return cleaned;
};

const SPECIAL_SYMBOL_MAP: Record<string, string> = {
  ' ': '\\s+',
  '\t': '\\t',
  '\r': '\\r',
  '\n': '\\n',
  '!': '\\!',
  '"': '\\"',
  '#': '\\#',
  '$': '\\$',
  '%': '\\%',
  '&': '\\&',
  "'": "\\'",
  '(': '\\(',
  ')': '\\)',
  '*': '\\*',
  '+': '\\+',
  ',': '\\,',
  '-': '\\-',
  '.': '\\.',
  '/': '\\/',
  ':': '\\:',
  ';': '\\;',
  '<': '\\<',
  '=': '\\=',
  '>': '\\>',
  '?': '\\?',
  '@': '\\@',
  '[': '\\[',
  '\\': '\\\\',
  ']': '\\]',
  '^': '\\^',
  '_': '_',
  '`': '\\`',
  '{': '\\{',
  '|': '\\|',
  '}': '\\}',
  '~': '\\~',
};

const inferRegexForValue = (value: string): string => {
  if (value.length === 0) {
    return '[^\\r\\n]*';
  }

  const parts: string[] = [];
  let inAlnumRun = false;

  const flushRun = (): void => {
    if (inAlnumRun) {
      parts.push('[A-Za-z0-9]+');
      inAlnumRun = false;
    }
  };

  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch)) {
      if (!inAlnumRun) {
        flushRun();
        inAlnumRun = true;
      }
      continue;
    }

    // Special symbol
    flushRun();
    parts.push(escapeSpecialChar(ch));
  }

  flushRun();
  return parts.join('');
};

const escapeSpecialChar = (ch: string): string => {
  if (SPECIAL_SYMBOL_MAP[ch] !== undefined) {
    return SPECIAL_SYMBOL_MAP[ch];
  }
  // Fallback to hex escape to keep regex safe for unexpected symbols.
  const code = ch.codePointAt(0);
  if (code === undefined) {
    return '';
  }
  if (code <= 0xff) {
    return `\\x${code.toString(16).padStart(2, '0')}`;
  }
  return `\\u${code.toString(16).padStart(4, '0')}`;
};

const safeSerialize = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
};
