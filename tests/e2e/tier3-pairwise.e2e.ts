import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker } from './fixtures/domAudit';
import {
  cardByModel,
  clickRescan,
  getEmittedEvents,
  getInvokeLog,
  navigateTo,
  openApp,
} from './fixtures/helpers';
import { ONE_TOUCH_VOLUME } from './fixtures/mockPayloads';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 3 — Cross-Feature Pairwise Journeys @tier3', () => {
  test('T3-01: attach One Touch -> select -> configure OLLAMA_MODELS -> start Ollama -> inspect Hardware @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await page.evaluate((vol) => {
      window.__MOSAIC_E2E__?.setVolumes([vol]);
      window.__MOSAIC_E2E__?.setOllamaReachable(false);
    }, ONE_TOUCH_VOLUME);
    await clickRescan(page);
    await page.getByRole('button', { name: /Use (as MOSAIC )?Library/i }).click();
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: 'Configure OLLAMA_MODELS' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply Configuration' }).click();
    await page.getByRole('button', { name: /Start Managed Ollama/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start Managed Ollama' }).click();
    await navigateTo(page, 'Hardware');
    await expect(page.getByText(/Apple M3/).first()).toBeVisible();
    await expect(page.getByText('Ollama 0.40.9')).toBeVisible();
    tracker.assertClean();
  });

  test('T3-02: refresh catalog -> pull 3B -> cancel pull -> pull 0.5B -> verify My Models @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      if (!window.__MOSAIC_E2E__) return;
      window.__MOSAIC_E2E__.state.installed = [];
    });
    await navigateTo(page, 'Discover Models');
    await page.getByRole('button', { name: /Refresh Catalog/i }).click();
    await cardByModel(page, 'Llama 3.2 3B').getByRole('button', { name: 'Download', exact: true }).click();
    await page.getByRole('button', { name: /Cancel Pull/i }).click();
    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(async () => {
      const evs = await getEmittedEvents(page);
      return evs.some((e) => e.event === 'mosaic://pull-progress' && (e.payload as { model?: string; status?: string }).model === 'qwen2.5:0.5b' && (e.payload as { status?: string }).status === 'success');
    }).toBe(true);
    await navigateTo(page, 'My Models');
    await expect(page.getByRole('heading', { name: 'qwen2.5:0.5b' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'llama3.2:3b' })).toHaveCount(0);
    tracker.assertClean();
  });

  test('T3-03: adaptive profile & KV precision flow from Discover Models into Run Model @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel(/Execution profile/i).selectOption('constrained_memory');
    await page.getByLabel(/KV cache/i).selectOption('q4_0');
    await cardByModel(page, 'Qwen3 30B-A3B MoE (IQ2_XS)').getByRole('button', { name: 'View details' }).click();
    await expect(page.getByRole('dialog').getByText(/q4_0/)).toBeVisible();
    await page.getByRole('button', { name: 'Close model details' }).click();
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Select installed model').selectOption('hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS');
    await page.getByLabel('Prompt input').fill('Verify adaptive IQ2_XS');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    tracker.assertClean();
  });

  test('T3-04: add/probe cluster worker -> plan 235B MoE -> launch & stop llama-server @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByPlaceholder('Worker name (e.g. RTX-PC)').fill('Local-RPC-3');
    await page.getByPlaceholder('Host / LAN IP').fill('127.0.0.1');
    await page.getByRole('button', { name: 'Add Worker' }).click();
    await page.getByRole('button', { name: 'Probe Reachability' }).click();
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 235B-A22B MoE').getByRole('button', { name: 'View details' }).click();
    await page.getByRole('button', { name: 'Compute Adaptive / Cluster Plan' }).click();
    await expect(page.getByText('Pooled RPC Nodes')).toBeVisible();
    await page.getByLabel(/GGUF/i).fill('models/qwen3-235b.gguf');
    await page.getByRole('button', { name: /Launch Cluster Runtime/i }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Launch Runtime' }).click();
    await page.getByRole('button', { name: /Stop Cluster Runtime/i }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'stop_cluster_runtime')).toBe(true);
    tracker.assertClean();
  });

  test('T3-05: inspect /api/show -> run benchmark -> analyze bottlenecks -> export -> diagnostics @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: /Inspect|Show Metadata/i }).nth(1).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: /Close/i }).click();
    await page.getByRole('button', { name: 'Benchmark mistral:7b-instruct-q4_K_M' }).click();
    await expect(page.getByText('Benchmark complete for mistral:7b-instruct-q4_K_M.')).toBeVisible();
    await page.getByRole('button', { name: /Analyze Bottlenecks/i }).first().click();
    await page.getByRole('button', { name: 'Export JSON' }).first().click();
    await page.getByRole('button', { name: 'Export HTML' }).first().click();
    await navigateTo(page, 'Settings');
    await expect(page.getByText(/volume_manager/)).toBeVisible();
    tracker.assertClean();
  });

  test('T3-06: stream chat -> stop generation -> resend prompt -> unload model @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('First interrupted prompt');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    await page.getByLabel('Prompt input').fill('Second completed prompt');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.').last()).toBeVisible();
    await page.getByRole('button', { name: 'Unload Model' }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'unload_model')).toBe(true);
    tracker.assertClean();
  });

  test('T3-07: active pull blocks safe eject until cancel_pull completes @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'active-pull-stream');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eject Safely' }).click();
    await expect(page.getByText('Stop active model downloads or inference before ejecting.')).toBeVisible();
    await page.evaluate(async () => {
      const inv = window.__TAURI_INTERNALS__?.invoke as (c: string, a: Record<string, unknown>) => Promise<unknown>;
      await inv('cancel_pull', { model: 'llama3.2:3b' });
    });
    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eject Safely' }).click();
    await expect(page.getByText(/safe to remove/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T3-08: degraded Python -> migrate internal models -> configure & start Ollama -> Discover @m3-wiring @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await expect(page.getByText(/Python analytics worker exited/i)).toBeVisible();
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Migrate Internal Models/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Copy to External Drive' }).click();
    await expect(page.getByText(/Copied 4 file\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Configure OLLAMA_MODELS' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply Configuration' }).click();
    await page.getByRole('button', { name: /Start Managed Ollama/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start Managed Ollama' }).click();
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    tracker.assertClean();
  });

  test('T3-09: invalid endpoint rejected while valid reserve tightens catalog budget @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByLabel('OS Memory Safety Reserve (GiB)').fill('5');
    await page.getByLabel('Ollama Loopback Endpoint').fill('http://192.168.1.99:11434');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByText(/endpoint must be loopback/i)).toBeVisible();
    await navigateTo(page, 'Discover Models');
    const budget = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.settings.safety_reserve_gib);
    expect(budget).toBe(5);
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    tracker.assertClean();
  });

  test('T3-10: launch model from My Models -> chat -> delete model -> verify removed from Run @smoke @tier3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Run', exact: true }).first().click();
    await page.getByLabel('Prompt input').fill('Quick check');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Local inference ok.')).toBeVisible();
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Delete llama3.2:3b' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete Model' }).click();
    await navigateTo(page, 'Run Model');
    await expect(page.getByLabel('Select installed model').locator('option', { hasText: 'llama3.2:3b' })).toHaveCount(0);
    tracker.assertClean();
  });
});
