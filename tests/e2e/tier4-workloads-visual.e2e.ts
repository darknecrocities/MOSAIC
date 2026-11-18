import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker, auditRouteVisuals } from './fixtures/domAudit';
import {
  ALL_NAV_LABELS,
  cardByModel,
  clickRescan,
  getEmittedEvents,
  getInvokeLog,
  navigateTo,
  openApp,
} from './fixtures/helpers';
import { ONE_TOUCH_VOLUME } from './fixtures/mockPayloads';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 4 — Real-World Workloads & Liquid Glassmorphism Visual Audit @tier4', () => {
  test('T4-01: 16 GiB M3 running 30B MoE IQ2_XS on One Touch + benchmark + insights + eject @m3-wiring @tier4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);

    await navigateTo(page, 'Hardware');
    await expect(page.getByText('10.0 GiB free of 16.0 GiB')).toBeVisible();
    await navigateTo(page, 'Discover Models');
    await page.getByLabel(/Execution profile/i).selectOption('constrained_memory');
    await page.getByLabel(/KV cache/i).selectOption('q4_0');
    await expect(cardByModel(page, 'Qwen3 30B-A3B MoE (IQ2_XS)')).toBeVisible();

    await navigateTo(page, 'Run Model');
    await page.getByLabel('Select installed model').selectOption('hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ2_XS');
    await page.getByLabel('Context length').selectOption('8192');
    await page.getByLabel('Prompt input').fill('Summarize MoE quantization benefits');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.')).toBeVisible();

    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Benchmark hf.co/unsloth/Qwen3-30B-A3B-GGUF:IQ2_XS' }).click();
    await page.getByRole('button', { name: /Analyze Bottlenecks/i }).first().click();
    await page.getByRole('button', { name: 'Export HTML' }).first().click();
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eject Safely' }).click();
    await expect(page.getByText(/safe to remove/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T4-02: 8 GiB constrained notebook gates 30B-70B, cancels 3B pull, runs 0.5B @m3-wiring @tier4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-8gb-constrained');
    await openApp(page);
    await navigateTo(page, 'Discover Models');

    await expect(cardByModel(page, 'DeepSeek-R1 Distill 70B').getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(cardByModel(page, 'Qwen 2.5 0.5B').getByText('Recommended')).toBeVisible();
    await cardByModel(page, 'Llama 3.2 3B').getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByRole('button', { name: /Cancel Pull/i }).click();

    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(async () => {
      const evs = await getEmittedEvents(page);
      return evs.some((e) => e.event === 'mosaic://pull-progress' && (e.payload as { model?: string; status?: string }).model === 'qwen2.5:0.5b' && (e.payload as { status?: string }).status === 'success');
    }).toBe(true);

    await navigateTo(page, 'Run Model');
    await page.getByLabel('Select installed model').selectOption('qwen2.5:0.5b');
    await page.getByLabel('Prompt input').fill('Constrained run');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    tracker.assertClean();
  });

  test('T4-03: 3-node GGML_RPC lab cluster probes, plans 235B MoE, guards .bin, launches .gguf @m3-wiring @tier4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByPlaceholder('Worker name (e.g. RTX-PC)').fill('Local-RPC-3');
    await page.getByPlaceholder('Host / LAN IP').fill('127.0.0.1');
    await page.getByRole('button', { name: 'Add Worker' }).click();
    await page.getByRole('button', { name: 'Probe Reachability' }).click();
    await expect(page.getByText(/reachable \(4 ms\)/)).toBeVisible();

    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 235B-A22B MoE').getByRole('button', { name: 'View details' }).click();
    await page.getByRole('button', { name: 'Compute Adaptive / Cluster Plan' }).click();
    await expect(page.getByText('Pooled RPC Nodes')).toBeVisible();

    await page.getByLabel(/GGUF/i).fill('models/bad.bin');
    await page.getByRole('button', { name: /Launch Cluster Runtime/i }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: /Launch|Confirm/i }).click();
    await expect(page.getByText(/InvalidPath|gguf/i)).toBeVisible();

    await page.getByLabel(/GGUF/i).fill('models/qwen3-235b.gguf');
    await page.getByRole('button', { name: /Launch Cluster Runtime/i }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: /Launch|Confirm/i }).click();
    await page.getByRole('button', { name: /Stop Cluster Runtime/i }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'stop_cluster_runtime')).toBe(true);
    tracker.assertClean();
  });

  test('T4-04: migrate internal Ollama store to One Touch -> configure -> start -> /api/show @m3-wiring @tier4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Migrate Internal Models/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Copy to External Drive' }).click();
    await expect(page.getByText(/Copied 4 file\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Configure OLLAMA_MODELS' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply Configuration' }).click();
    await page.getByRole('button', { name: /Start Managed Ollama/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Start|Confirm/i }).click();
    await expect(page.getByText('Ollama 0.40.9')).toBeVisible();
    tracker.assertClean();
  });

  test('T4-05: unexpected USB disconnect locks Run Model and recovers cleanly on reconnect @tier4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await expect(page.getByLabel('Prompt input')).toBeEnabled();

    await page.evaluate(() => window.__MOSAIC_E2E__?.setVolumes([]));
    await clickRescan(page);
    await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeVisible();
    await expect(page.getByLabel('Prompt input')).toBeDisabled();

    await page.evaluate((vol) => window.__MOSAIC_E2E__?.setVolumes([vol]), ONE_TOUCH_VOLUME);
    await clickRescan(page);
    await expect(page.getByLabel('Prompt input')).toBeEnabled();
    await expect(page.getByText('One Touch (Ready)')).toBeVisible();
    tracker.assertClean();
  });

  test('T4-06: 7-view + modal programmatic Liquid Glassmorphism, button geometry & anti-slop audit @m3-wiring @tier4 @visual', async ({ browser }) => {
    for (const vp of [{ width: 900, height: 700 }, { width: 1280, height: 820 }]) {
      const gateCtx = await browser.newContext({ viewport: vp });
      const gatePage = await gateCtx.newPage();
      const gateTracker = attachRuntimeErrorTracker(gatePage);
      await installTauriMock(gatePage, 'readonly-drive');
      await openApp(gatePage);
      await auditRouteVisuals(gatePage, `OnboardingGate ${vp.width}x${vp.height}`);
      gateTracker.assertClean();
      await gateCtx.close();

      const mainCtx = await browser.newContext({ viewport: vp });
      const mainPage = await mainCtx.newPage();
      const mainTracker = attachRuntimeErrorTracker(mainPage);
      await installTauriMock(mainPage, 'connected-16gb-m3');
      await openApp(mainPage);
      for (const routeLabel of ALL_NAV_LABELS) {
        await navigateTo(mainPage, routeLabel);
        await auditRouteVisuals(mainPage, `${routeLabel} ${vp.width}x${vp.height}`);
      }

      await navigateTo(mainPage, 'Discover Models');
      await cardByModel(mainPage, 'Qwen 2.5 0.5B').getByRole('button', { name: 'View details' }).click();
      await auditRouteVisuals(mainPage, `ModelDetailDrawer ${vp.width}x${vp.height}`);
      await mainPage.getByRole('button', { name: 'Close model details' }).click();

      await navigateTo(mainPage, 'My Models');
      await mainPage.getByRole('button', { name: 'Delete llama3.2:3b' }).click();
      await auditRouteVisuals(mainPage, `ConfirmModal ${vp.width}x${vp.height}`);
      await mainPage.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
      mainTracker.assertClean();
      await mainCtx.close();
    }
  });
});
