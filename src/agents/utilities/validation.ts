/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const ensureValidRegex = (pattern: string): void => {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern: ${message}`);
  }
};
