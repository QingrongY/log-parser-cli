/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMMON_LOG_PARSER_KNOWLEDGE = `
  BUSINESS DATA (variables) are dynamic, instance-specific values, e.g., timestamps, identifiers, named entities,
  addresses, paths, URLs, process names, PIDs, file names, port numbers.
  They come from unbounded domains and replacing them does not change the semantic meaning of the log.
  
  STRUCTURE (constants) are system-defined tokens such as event skeletons, module names, protocol keywords, static message text.
  STRUCTURE draws from finite sets and altering them would change what the log entry represents.
  
  Generic natural language descriptions are STRUCTURE, whereas specific values or entities named within them are BUSINESS DATA.
`;
