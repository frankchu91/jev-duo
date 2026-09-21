import { describe, expect, it } from 'vitest';

import { VERSION } from '../../src/core/index.js';

describe('core', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.1.0');
  });
});
