/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMMON_LOG_PARSER_KNOWLEDGE = `
- BUSINESS DATA (variables) are instance-specific values such as timestamps, numbers,
  user or device identifiers, names, IP or MAC addresses, paths, IDs, and JSON payloads. 
  They come from unbounded domains and replacing them does not change the semantic meaning of the event.
  Note1: Timestamps in any format (e.g., "Jun 15 12:12:34", ISO "2023-07-16 00:00:02", or AM/PM formats) must always be captured as a single variable "ts".
  Note2: When the same type of BUSINESS DATA appears multiple times in a single log entry, use numbered variable names to avoid duplication (e.g., "ip1", "ip2").
  Note3: Do not use "message" as a variable; preserve any messages as literal text and extract only internal BUSINESS DATA.
- STRUCTURE (constants) are system-defined tokens such as event skeletons,
  module names, protocol keywords, message, and syntactic separators (colons, brackets, pipes).
  They draw from finite sets and altering them would change what the log entry represents.
The final goal is to preserve STRUCTURE as literal text and capture BUSINESS DATA.`;
