/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMMON_LOG_PARSER_KNOWLEDGE = `
- BUSINESS DATA (variables) are dynamic, instance-specific values including timestamps, numbers,
  identifiers, named entities, addresses, paths, URLs, processes, files, and structured payloads such as JSON or XML. 
  They come from unbounded domains and replacing them does not change the semantic meaning of the event.
  Note1: Year, month, day, time, ampm in any format (e.g., "Jun  5 12:12:34", ISO "2023-07-16 00:00:02", or AM/PM formats) must always be captured as a single variable "timestamp" (use timestamp1, timestamp2... if multiple).
  Note2: When the same type of BUSINESS DATA appears multiple times in a single log entry, use numbered variable names to avoid duplication (e.g., "ip1", "ip2").
  Note3: Do not treat long texts as messages; preserve any messages as literal text and extract only internal BUSINESS DATA.
- STRUCTURE (constants) are system-defined tokens such as event skeletons, methods, 
  module names, protocol keywords, static message text, and syntactic separators (colons, brackets, pipes).
  Generic natural language descriptions are STRUCTURE, whereas specific values or entities named within them are BUSINESS DATA.
  They draw from finite sets and altering them would change what the log entry represents.
The final goal is to preserve STRUCTURE as literal text and capture BUSINESS DATA.
- Template format rules:
  * For placeholder-based tasks, insert ESC]9;var=<name>BEL (\u001b]9;var=<name>\u0007) in place of variable values and provide the actual values in a variables map. Do NOT output regex in this mode.
  * Do NOT change any other characters in the log line; after replacing placeholders with provided values, the line must match the raw log exactly.`;
