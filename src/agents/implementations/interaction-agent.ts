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
} from '../types.js';

export interface InteractionAgentInput {
  prompt: string;
  options?: string[];
}

export interface InteractionAgentOutput {
  response: string;
  selectedOption?: string;
}

export interface InteractionAgentConfig extends Omit<BaseAgentConfig, 'kind'> {
  autoResponder?: (input: InteractionAgentInput, context: AgentContext) =>
    | Promise<InteractionAgentOutput>
    | InteractionAgentOutput;
}

export class InteractionAgent extends BaseAgent<
  InteractionAgentInput,
  InteractionAgentOutput
> {
  private readonly autoResponder?: InteractionAgentConfig['autoResponder'];

  constructor(config: InteractionAgentConfig = {}) {
    super({ kind: 'interaction', ...config });
    this.autoResponder = config.autoResponder;
  }

  protected async handle(
    input: InteractionAgentInput,
    context: AgentContext,
  ): Promise<AgentResult<InteractionAgentOutput>> {
    if (this.autoResponder) {
      const manualResponse = await this.autoResponder(input, context);
      return {
        status: 'success',
        output: manualResponse,
      };
    }

    return {
      status: 'needs-input',
      issues: [
        'Awaiting user input. Attach an autoResponder or UI handler to InteractionAgent.',
      ],
    };
  }
}
