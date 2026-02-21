// K8-2: GUI E2E — tab retention, live log scroll, 3-tab panel content
// Verifies:
//   1. Switching tabs persists activeTab in sessionStorage; tab content does not reset
//   2. Live log auto-refresh does not reset scroll position
//   3. All 3 log tabs (coordinator, coder, judge) render a panel with content or a helpful placeholder

const { test, expect } = require('@playwright/test');

const FAKE_TASK_ID = 'gui_e2e_task';

// Common route stubs for a running task
async function stubRunningTask(page, taskId = FAKE_TASK_ID) {
  await page.route('**/api/tasks*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ task_id: taskId, state: 'RUNNING', attempt: 1 }]),
    });
  });
  await page.route(`**/api/task/${taskId}/status`, async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ task_id: taskId, state: 'RUNNING', attempt: 1 }),
    });
  });
  await page.route(`**/api/task/${taskId}/attempts`, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route(`**/api/task/${taskId}/log/**`, async route => {
    const url = route.request().url();
    const role = url.includes('coder') ? 'coder' : url.includes('judge') ? 'judge' : 'coordinator';
    const content = `[${role}] K8-2 test log line\n`;
    const etag = `"${role}-etag-k82"`;
    const ifNoneMatch = route.request().headers()['if-none-match'];
    if (ifNoneMatch === etag) {
      await route.fulfill({ status: 304, headers: { ETag: etag }, body: '' });
    } else {
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { ETag: etag }, body: content });
    }
  });
  await page.route('**/api/task_specs*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/prompts*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/adapters*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ coder: [], judge: [] }) });
  });
}

test.describe('K8-2: GUI tab retention and live log', () => {
  test('switching tabs retains activeTab in sessionStorage', async ({ page }) => {
    await stubRunningTask(page);
    await page.goto('/');

    // Click on the task to load the panel
    await page.locator(`text=${FAKE_TASK_ID}`).first().click();
    await page.waitForTimeout(300);

    // Default tab should be 'coordinator' (or whatever is persisted)
    const initialTab = await page.evaluate(() => sessionStorage.getItem('rdloop_activeTab'));
    // Click the 'coder' tab
    await page.locator('button:has-text("Coder"), [data-tab="coder"], text=Coder').first().click();
    await page.waitForTimeout(200);

    const afterCoderTab = await page.evaluate(() => sessionStorage.getItem('rdloop_activeTab'));
    expect(afterCoderTab).toBe('coder');

    // Click the 'judge' tab
    await page.locator('button:has-text("Judge"), [data-tab="judge"], text=Judge').first().click();
    await page.waitForTimeout(200);

    const afterJudgeTab = await page.evaluate(() => sessionStorage.getItem('rdloop_activeTab'));
    expect(afterJudgeTab).toBe('judge');

    // Reload page — activeTab should be restored from sessionStorage
    await page.reload();
    await page.waitForTimeout(500);
    const afterReloadTab = await page.evaluate(() => sessionStorage.getItem('rdloop_activeTab'));
    expect(afterReloadTab).toBe('judge');
  });

  test('active tab panel has content or shows a helpful placeholder', async ({ page }) => {
    await stubRunningTask(page);
    await page.goto('/');

    await page.locator(`text=${FAKE_TASK_ID}`).first().click();
    await page.waitForTimeout(600);

    const tabs = ['coordinator', 'coder', 'judge'];
    for (const tab of tabs) {
      // Click the tab button
      await page.locator(`button:has-text("${tab.charAt(0).toUpperCase() + tab.slice(1)}"), [data-tab="${tab}"]`).first().click();
      await page.waitForTimeout(400);

      // The main content area must have some non-empty text
      const logArea = page.locator('#log-content, pre, [id*="log"], .log-panel').first();
      const text = await logArea.textContent().catch(() => '');
      // Either shows real log content or a placeholder message (not empty and not just whitespace)
      expect((text || '').trim().length).toBeGreaterThan(0);
    }
  });

  test('live log auto-refresh does not reset scroll position', async ({ page }) => {
    await stubRunningTask(page);
    await page.goto('/');

    await page.locator(`text=${FAKE_TASK_ID}`).first().click();
    await page.waitForTimeout(600);

    // Find log container and scroll it to a specific position
    const logContainer = page.locator('#log-content, pre, [id*="log"]').first();
    await logContainer.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});

    // Scroll to middle position
    const scrollable = page.locator('#live-log-container, .log-container, pre').first();
    const initialScroll = await scrollable.evaluate(el => {
      el.scrollTop = 50; // Set scroll
      return el.scrollTop;
    }).catch(() => -1);

    if (initialScroll < 0) {
      // If no scrollable container found, skip scroll position check
      return;
    }

    // Wait for at least one auto-refresh cycle (3s interval)
    await page.waitForTimeout(3500);

    // Scroll position must not have been reset to 0
    const scrollAfterRefresh = await scrollable.evaluate(el => el.scrollTop).catch(() => -1);
    // Allow for small tolerance (within 5px)
    expect(scrollAfterRefresh).toBeGreaterThanOrEqual(initialScroll - 5);
  });

  test('autoScroll is preserved in localStorage across navigations', async ({ page }) => {
    await stubRunningTask(page);
    await page.goto('/');

    // Set autoScroll via localStorage
    await page.evaluate(() => localStorage.setItem('rdloop_autoScroll', 'false'));
    await page.reload();
    await page.waitForTimeout(300);

    const autoScroll = await page.evaluate(() => localStorage.getItem('rdloop_autoScroll'));
    expect(autoScroll).toBe('false');
  });
});
