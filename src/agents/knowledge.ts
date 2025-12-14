/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const COMMON_LOG_PARSER_KNOWLEDGE = `
- Concept Definitions:
  BUSINESS DATA (variables) are dynamic, instance-specific values including timestamps, numbers, identifiers,
  named entities, addresses, paths, URLs, process names, PIDs, file names, port numbers, and any other type of variable.
  They come from unbounded domains and replacing them does not change the semantic meaning of the event.
  
  STRUCTURE (constants) are system-defined tokens such as event skeletons, module names, protocol keywords, static message text.
  Generic natural language descriptions are STRUCTURE, whereas specific values or entities named within them are BUSINESS DATA.
  STRUCTURE draws from finite sets and altering them would change what the log entry represents.
  
- Task:
  Extract the template by keeping STRUCTURE unchanged as literal text, 
  and capturing all BUSINESS DATA by replacing each variable value with 
  ESC]9;var=<name>BEL (\u001b]9;var=<name>\u0007)
  while recording all original values in a variables map.
  
- Notes:
  Note 1: Do NOT modify any other characters in the log line. After substituting placeholders with values from the variables map, 
  the reconstructed line must exactly match the raw log.
  
  Note 2: When the same type of BUSINESS DATA appears multiple times within a single log entry, 
  use indexed variable names to avoid ambiguity (e.g., "ip1", "ip2").
  
  Note 3: Do NOT treat long texts as standalone messages. Preserve all message text as literal STRUCTURE, 
  and extract only the internal BUSINESS DATA contained within it.
`;

