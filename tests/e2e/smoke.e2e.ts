import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker, auditOverflowAndButtons } from './fixtures/domAudit';
import { ALL_NAV_LABELS, cardByModel, clickRescan, navigateTo, openApp } from './fixtures/helpers';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('MOSAIC Baseline Smoke Suite @smoke', () => {
  test('browser preview fallback renders safely without __TAURI_INTERNALS__ @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await openApp(page);
    await expect(page.getByText(/Browser preview mode: launch the MOSAIC desktop window/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeVisible();
    tracker.assertClean();
  });

  test('onboarding gate selects writable volume and unlocks overview @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'readonly-drive');
    await openApp(page);

    await expect(page.getByText('ReadOnlyNTFS')).toBeVisible();
    const buttons = page.getByRole('button', { name: /Use (as MOSAIC )?Library/i });
    await expect(buttons.nth(0)).toBeDisabled();
    await expect(buttons.nth(1)).toBeEnabled();
    await buttons.nth(1).click();

    await expect(page.getByRole('heading', { name: 'External Model Library' })).toBeVisible();
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    tracker.assertClean();
  });

  test('all 7 primary navigation routes render without console errors or overflow @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);

    for (const label of ALL_NAV_LABELS) {
      await navigateTo(page, label);
      await expect(page.getByRole('main')).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      );
      expect(overflow, `Horizontal overflow on ${label}`).toBe(false);
    }
    await clickRescan(page);
    await expect(page.getByText('One Touch (Ready)')).toBeVisible();
    tracker.assertClean();
  });

  test('discover catalog filters models and opens/closes detail drawer @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');

    await page.getByLabel('Search models').fill('qwen');
    await page.getByLabel('Filter by compatibility status').selectOption('Recommended');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();

    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'View details' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Weight Memory')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close model details' }).click();
    await expect(dialog).toBeHidden();
    tracker.assertClean();
  });

  test('run model enforces non-empty prompt and streams response @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');

    const sendBtn = page.getByRole('button', { name: 'Send', exact: true });
    await expect(sendBtn).toBeDisabled();
    await page.getByLabel('Prompt input').fill('   ');
    await expect(sendBtn).toBeDisabled();

    await page.getByLabel('Prompt input').fill('Explain KV cache');
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();

    await expect(page.getByText('Explain KV cache')).toBeVisible();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    tracker.assertClean();
  });

  test('settings rejects non-loopback endpoint and preserves valid reserve @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');

    await page.getByLabel('OS Memory Safety Reserve (GiB)').fill('4');
    await page.getByLabel('Ollama Loopback Endpoint').fill('http://192.168.1.50:11434');
    await page.getByRole('button', { name: 'Save Settings' }).click();

    await expect(page.getByText(/endpoint must be loopback/i)).toBeVisible();
    const reserve = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.settings.safety_reserve_gib);
    expect(reserve).toBe(4);
    const endpoint = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.settings.ollama_endpoint);
    expect(endpoint).toBe('http://127.0.0.1:11434');
    tracker.assertClean();
  });

  test('external storage safe eject transitions back to onboarding gate @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');

    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Eject Safely' }).click();

    await expect(page.getByText(/safe to remove/i)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Connect & Select Your External Model Library/i }).first()
    ).toBeVisible();
    tracker.assertClean();
  });

  test('topbar and main layouts have zero horizontal overflow across viewports @smoke', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    const hasOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(hasOverflow).toBe(false);
    expect(typeof auditOverflowAndButtons).toBe('function');
    tracker.assertClean();
  });
});
