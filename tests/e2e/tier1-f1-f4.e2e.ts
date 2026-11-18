import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker } from './fixtures/domAudit';
import {
  ALL_NAV_LABELS,
  cardByModel,
  clickRescan,
  getInvokeLog,
  navigateTo,
  openApp,
} from './fixtures/helpers';
import { ONE_TOUCH_VOLUME } from './fixtures/mockPayloads';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 1 — F1 Onboarding & External Drive Gate @tier1 @F1', () => {
  test('T1-F1-01: disconnected profile displays OnboardingGate and disables internal fallback @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeVisible();
    await expect(page.getByText('No eligible external drive detected')).toBeVisible();
    await expect(page.getByText('No external drive configured')).toBeVisible();
    await expect(page.getByText(/internal disk fallback is disabled/i).first()).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F1-02: Inspect Hardware Profile button bypasses gate to Hardware view @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await page.getByRole('button', { name: 'Inspect Hardware Profile' }).click();
    await expect(page.getByRole('heading', { name: 'Hardware & Memory Profile' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeHidden();
    await expect(page.getByText(/Apple M3/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F1-03: readonly volume is disabled while writable volume unlocks Overview @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'readonly-drive');
    await openApp(page);
    await expect(page.getByText(/mounted read-only/i)).toBeVisible();
    const useButtons = page.getByRole('button', { name: /Use (as MOSAIC )?Library/i });
    await expect(useButtons.nth(0)).toBeDisabled();
    await expect(useButtons.nth(1)).toBeEnabled();
    await useButtons.nth(1).click();
    await expect(page.getByRole('heading', { name: 'External Model Library', exact: true })).toBeVisible();
    await expect(page.getByText('MosaicSSD (Ready)')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F1-04: Rescan refreshes state and installed models cleanly @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await clickRescan(page);
    await expect(page.getByText('One Touch (Ready)')).toBeVisible();
    await expect(page.getByText('Ollama 0.40.9')).toBeVisible();
    const cmds = (await getInvokeLog(page)).map((e) => e.cmd);
    expect(cmds).toContain('get_app_state');
    expect(cmds).toContain('list_installed_models');
    tracker.assertClean();
  });

  test('T1-F1-05: dynamically attached drive appears after Rescan @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await page.evaluate((vol) => window.__MOSAIC_E2E__?.setVolumes([vol]), ONE_TOUCH_VOLUME);
    await clickRescan(page);
    await expect(page.getByText('One Touch')).toBeVisible();
    await expect(page.getByText('ExFAT', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Use (as MOSAIC )?Library/i })).toBeEnabled();
    tracker.assertClean();
  });

  test('T1-F1-06: all 7 sidebar routes update aria-current and keep gate hidden @smoke @tier1 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    for (const label of ALL_NAV_LABELS) {
      await navigateTo(page, label);
      if (label !== 'External Storage') {
        await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeHidden();
      }
    }
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F2 Discovery, Batched Fit & Catalog Refresh @tier1 @F2', () => {
  test('T1-F2-01: Discover Models loads catalog including 30B MoE and 70B entries @smoke @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    await expect(cardByModel(page, 'Qwen3 30B-A3B MoE (IQ2_XS)')).toBeVisible();
    await expect(cardByModel(page, 'DeepSeek-R1 Distill 70B')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F2-02: search query and compatibility filter narrow visible cards @smoke @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel('Search models').fill('qwen');
    await page.getByLabel('Filter by compatibility status').selectOption('Recommended');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    await expect(cardByModel(page, 'DeepSeek-R1 Distill 70B')).toBeHidden();
    tracker.assertClean();
  });

  test('T1-F2-03: changing assumed context length re-evaluates batched catalog fit @smoke @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel('Assumed context length').selectOption('32768');
    await expect.poll(async () => {
      const log = await getInvokeLog(page);
      return log.some((e) => (e.cmd === 'list_catalog_with_fit' || e.cmd === 'evaluate_catalog') && (e.args as { contextLength?: number }).contextLength === 32768);
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F2-04: Refresh Catalog button invokes refresh_model_catalog @m3-wiring @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByRole('button', { name: /Refresh Catalog/i }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'refresh_model_catalog')).toBe(true);
    tracker.assertClean();
  });

  test('T1-F2-05: ModelDetailDrawer shows memory breakdown and MoE active params @smoke @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 30B-A3B MoE').getByRole('button', { name: 'View details' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Weight Memory')).toBeVisible();
    await expect(dialog.getByText('Safe Memory Budget')).toBeVisible();
    await expect(dialog.getByText(/3\.3B active/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F2-06: closing ModelDetailDrawer unmounts dialog cleanly @smoke @tier1 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'View details' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Close model details' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F3 My Models & /api/show Metadata @tier1 @F3', () => {
  test('T1-F3-01: My Models displays installed models with quantization and digest @smoke @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await expect(page.getByRole('heading', { name: 'llama3.2:3b' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'mistral:7b-instruct-q4_K_M' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ2_XS' })).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F3-02: Inspect metadata button invokes show_model_details modal @m3-wiring @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: /Inspect|Show Metadata/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/131072|Apache-2\.0/)).toBeVisible();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'show_model_details')).toBe(true);
    tracker.assertClean();
  });

  test('T1-F3-03: Run button launches Run Model pre-selected to chosen model @smoke @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Run', exact: true }).nth(1).click();
    await expect(page.getByRole('heading', { name: 'Run Model' })).toBeVisible();
    await expect(page.getByLabel('Select installed model')).toHaveValue('mistral:7b-instruct-q4_K_M');
    tracker.assertClean();
  });

  test('T1-F3-04: Benchmark action runs benchmark and appends report record @smoke @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Benchmark llama3.2:3b' }).click();
    await expect(page.getByText('Benchmark complete for llama3.2:3b.')).toBeVisible();
    await expect(page.getByText('46.4 tok/s')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F3-05: Delete model requires ConfirmModal and removes weight entry @smoke @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Delete llama3.2:3b' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Delete Model Weights')).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete Model' }).click();
    await expect(page.getByRole('heading', { name: 'llama3.2:3b' })).toBeHidden();
    tracker.assertClean();
  });

  test('T1-F3-06: cancelling delete modal preserves model without IPC call @smoke @tier1 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Delete llama3.2:3b' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'llama3.2:3b' })).toBeVisible();
    const deleted = (await getInvokeLog(page)).some((e) => e.cmd === 'delete_installed_model');
    expect(deleted).toBe(false);
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F4 Run Model Chat Streaming, Stop & Unload @tier1 @F4', () => {
  test('T1-F4-01: Run Model streams local tokens into assistant bubble @smoke @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('Explain KV cache');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F4-02: Stop button cancels active stream cleanly @m3-wiring @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('Stream long response');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    const stopped = (await getInvokeLog(page)).some((e) => e.cmd === 'stop_chat_stream');
    expect(stopped).toBe(true);
    tracker.assertClean();
  });

  test('T1-F4-03: Unload Model invokes unload_model for selected model @smoke @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByRole('button', { name: 'Unload Model' }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'unload_model')).toBe(true);
    tracker.assertClean();
  });

  test('T1-F4-04: context length and temperature flow into start_chat_stream @smoke @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Context length').selectOption('8192');
    await page.getByLabel('Temperature').fill('0.7');
    await page.getByLabel('Prompt input').fill('Check params');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => {
      const entry = (await getInvokeLog(page)).find((e) => e.cmd === 'start_chat_stream');
      const req = (entry?.args as { request?: { num_ctx?: number; temperature?: number } })?.request;
      return req?.num_ctx === 8192 && req?.temperature === 0.7;
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F4-05: switching installed model updates start_chat_stream model @smoke @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Select installed model').selectOption('mistral:7b-instruct-q4_K_M');
    await page.getByLabel('Prompt input').fill('Hello Mistral');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => {
      const entry = (await getInvokeLog(page)).find((e) => e.cmd === 'start_chat_stream');
      return (entry?.args as { request?: { model?: string } })?.request?.model === 'mistral:7b-instruct-q4_K_M';
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F4-06: conversation persists in memory across route switches @smoke @tier1 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('Persist check');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    await navigateTo(page, 'Overview');
    await navigateTo(page, 'Run Model');
    await expect(page.getByText('Persist check')).toBeVisible();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    tracker.assertClean();
  });
});
