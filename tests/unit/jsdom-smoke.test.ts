// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

describe('jsdom environment', () => {
  it('provides a DOM to tests that opt in', () => {
    const div = document.createElement('div');
    div.textContent = 'jev-duo';
    document.body.append(div);

    expect(div.tagName).toBe('DIV');
    expect(document.body.querySelector('div')?.textContent).toBe('jev-duo');
  });
});
