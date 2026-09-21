import { expect, test } from '@playwright/test';

test('chromium launches and opens about:blank', async ({ page }) => {
  await page.goto('about:blank');
  expect(await page.title()).toBe('');
});
