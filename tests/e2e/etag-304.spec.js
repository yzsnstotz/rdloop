// K4-1: ETag / 304 — Live log DOM non-flash acceptance tests
// Verifies:
//   1. First request returns 200 with an ETag header
//   2. Second request with If-None-Match matching that ETag returns 304
//   3. When a 304 is received, the DOM log container does NOT mutate
//
// Uses page.route() to intercept /api/task/*/log/* so no live server task is needed.

const { test, expect } = require('@playwright/test');

const FAKE_TASK_ID = 'test_etag_task';
const LOG_NAME = 'coordinator.log';
const LOG_URL_PATTERN = `**/api/task/${FAKE_TASK_ID}/log/${LOG_NAME}`;
const FAKE_LOG_CONTENT = '[coordinator] K4-1 ETag test log line\n';
const FAKE_ETAG = '"test-etag-abc123"';

// Intercept the tasks list so the page can load without a real server backend
async function stubTasksAndLog(page, opts = {}) {
  const { return304OnSecond = false } = opts;
  let callCount = 0;

  // Stub task list to empty (no sidebar tasks needed)
  await page.route('**/api/tasks*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  // Stub log endpoint
  await page.route(LOG_URL_PATTERN, async route => {
    callCount++;
    const req = route.request();
    const ifNoneMatch = req.headers()['if-none-match'];

    if (return304OnSecond && callCount > 1 && ifNoneMatch === FAKE_ETAG) {
      // Return 304 Not Modified — no body
      await route.fulfill({ status: 304, headers: { ETag: FAKE_ETAG } });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: { ETag: FAKE_ETAG },
        body: FAKE_LOG_CONTENT,
      });
    }
  });

  // Stub other API endpoints used during page init
  await page.route('**/api/task_specs*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/prompts*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
  await page.route('**/api/adapters*', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ coder: [], judge: [] }) });
  });

  return () => callCount;
}

test.describe('K4-1: ETag / 304 live log', () => {
  test('first log request returns 200 with ETag header', async ({ page }) => {
    const receivedEtags = [];

    await page.route(LOG_URL_PATTERN, async route => {
      const resp = await route.fetch();
      receivedEtags.push(resp.headers()['etag']);
      await route.fulfill({ response: resp });
    });

    // Intercept network at the fetch level — monitor actual API response
    const responsePromise = page.waitForResponse(LOG_URL_PATTERN);

    // Navigate and trigger a log fetch by selecting the task
    await page.route('**/api/tasks*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }]),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/status`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/attempts`, async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
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

    await page.goto('/');
    // Click on the task to load logs
    await page.locator(`text=${FAKE_TASK_ID}`).first().click();

    const resp = await responsePromise;
    expect(resp.status()).toBe(200);
    const etag = resp.headers()['etag'];
    expect(etag).toBeTruthy();
    expect(etag.length).toBeGreaterThan(0);
  });

  test('second request with matching If-None-Match receives 304', async ({ page }) => {
    // Use route interception to simulate the round-trip ETag negotiation
    let firstEtag = null;
    let secondStatus = null;

    await page.route(LOG_URL_PATTERN, async route => {
      const req = route.request();
      const ifNoneMatch = req.headers()['if-none-match'];

      if (!firstEtag) {
        // First call — return 200 with ETag
        firstEtag = FAKE_ETAG;
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: { ETag: FAKE_ETAG },
          body: FAKE_LOG_CONTENT,
        });
      } else if (ifNoneMatch === FAKE_ETAG) {
        // Second call with matching If-None-Match — return 304
        secondStatus = 304;
        await route.fulfill({ status: 304, headers: { ETag: FAKE_ETAG }, body: '' });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: { ETag: FAKE_ETAG },
          body: FAKE_LOG_CONTENT,
        });
      }
    });

    await page.route('**/api/tasks*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }]),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/status`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/attempts`, async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
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

    await page.goto('/');
    await page.locator(`text=${FAKE_TASK_ID}`).first().click();

    // Wait for the first log fetch to be stored
    await page.waitForTimeout(500);
    // Wait for the auto-refresh (3s interval) to fire the second request with If-None-Match
    await page.waitForTimeout(3500);

    // The 304 response should have been received
    expect(secondStatus).toBe(304);
  });

  test('304 response does not cause DOM mutations in log container', async ({ page }) => {
    let callCount = 0;

    await page.route(LOG_URL_PATTERN, async route => {
      callCount++;
      const req = route.request();
      const ifNoneMatch = req.headers()['if-none-match'];

      if (callCount === 1) {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: { ETag: FAKE_ETAG },
          body: FAKE_LOG_CONTENT,
        });
      } else if (ifNoneMatch === FAKE_ETAG) {
        // Subsequent: 304
        await route.fulfill({ status: 304, headers: { ETag: FAKE_ETAG }, body: '' });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'text/plain',
          headers: { ETag: FAKE_ETAG },
          body: FAKE_LOG_CONTENT,
        });
      }
    });

    await page.route('**/api/tasks*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }]),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/status`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task_id: FAKE_TASK_ID, state: 'RUNNING', attempt: 1 }),
      });
    });
    await page.route(`**/api/task/${FAKE_TASK_ID}/attempts`, async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
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

    await page.goto('/');
    await page.locator(`text=${FAKE_TASK_ID}`).first().click();
    // Wait for initial log render
    await page.waitForTimeout(500);

    // Install MutationObserver on the log display area and count mutations after 304
    const mutationCount = await page.evaluate(() => {
      return new Promise((resolve) => {
        // Find log container — the pre/code element where log text appears
        const logEl = document.getElementById('log-content') ||
                      document.querySelector('pre') ||
                      document.querySelector('[id*="log"]');
        if (!logEl) { resolve(-1); return; }

        let mutations = 0;
        const obs = new MutationObserver((recs) => { mutations += recs.length; });
        obs.observe(logEl, { childList: true, subtree: true, characterData: true });

        // After 4 seconds (enough for at least one 304 refresh cycle), resolve
        setTimeout(() => {
          obs.disconnect();
          resolve(mutations);
        }, 4000);
      });
    });

    // When 304 is received, the app must NOT update the DOM (zero mutations after initial render)
    expect(mutationCount).toBe(0);
    // Verify the auto-refresh did fire (callCount >= 2 means second request happened)
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
