// The stamp both extension bundles carry (design addendum §3.3). Nothing defines `__JD_BUILD__` under
// vitest — the define lives in scripts/build.mjs and applies to the esbuild bundles only — so this is
// also the test that the `typeof` guard really is a guard: a bare read of an undeclared identifier
// throws a ReferenceError, and that would take the whole popup down.

import { describe, expect, it } from 'vitest';
import { BUILD_ID } from '../../../src/extension/build-id';

describe('BUILD_ID', () => {
  it("is 'dev' when nothing defined __JD_BUILD__", () => {
    expect(BUILD_ID).toBe('dev');
  });
});
