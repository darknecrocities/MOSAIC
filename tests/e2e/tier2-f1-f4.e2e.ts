import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker, auditOverflowAndButtons } from './fixtures/domAudit';
import {
  cardByModel,
  clickRescan,
  getEmittedEvents,
  getInvokeLog,
  invokeE2E,
  navigateTo,
  openApp,
} from './fixtures/helpers';
import { ONE_TOUCH_VOLUME } from './fixtures/mockPayloads';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 2 — F1 Onboarding & Drive Gate Boundaries @tier2 @F1', () => {
  test('T2-F1-01: disconnected drive gates Discover, My Models, and Run Model @smoke @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await navigateTo(page, 'Run Model');
    await expect(page.getByLabel('Prompt input')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    tracker.assertClean();
  });

  test('T2-F1-02: readonly volume button is disabled and direct IPC rejects @smoke @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'readonly-drive');
    await openApp(page);
    await expect(page.getByRole('button', { name: /Use (as MOSAIC )?Library/i }).first()).toBeDisabled();
    const res = await invokeE2E(page, 'select_external_library', { volumeIdentifier: 'RO-NTFS-01' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not writable/i);
    tracker.assertClean();
  });

  test('T2-F1-03: disconnected host excludes internal and DMG volumes from gate @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await expect(page.getByText('No eligible external drive detected')).toBeVisible();
    await expect(page.getByRole('button', { name: /Use (as MOSAIC )?Library/i })).toHaveCount(0);
    tracker.assertClean();
  });

  test('T2-F1-04: mid-session drive disconnect locks actions and restores gate @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => window.__MOSAIC_E2E__?.setVolumes([]));
    await clickRescan(page);
    await expect(page.getByRole('heading', { name: /Connect & Select Your External Model Library/i })).toBeVisible();
    const connected = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.library_connected);
    expect(connected).toBe(false);
    tracker.assertClean();
  });

  test('T2-F1-05: ExFAT advisory displays clearly without blocking selection @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await page.evaluate((vol) => window.__MOSAIC_E2E__?.setVolumes([vol]), ONE_TOUCH_VOLUME);
    await clickRescan(page);
    await expect(page.getByText(/ExFAT external drive detected/i)).toBeVisible();
    await page.getByRole('button', { name: /Use (as MOSAIC )?Library/i }).click();
    await expect(page.getByRole('heading', { name: 'External Model Library', exact: true })).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F1-06: OnboardingGate buttons obey bounded width <= 280px at 900x700 @m3-wiring @tier2 @F1', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await installTauriMock(page, 'readonly-drive');
    await openApp(page);
    await auditOverflowAndButtons(page, 'OnboardingGate 900x700');
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F2 Discovery & Fit Boundaries @tier2 @F2', () => {
  test('T2-F2-01: Not recommended model omits one-click Download on 8 GiB host @smoke @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-8gb-constrained');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    const card = cardByModel(page, 'DeepSeek-R1 Distill 70B');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: 'View details' })).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F2-02: failed catalog refresh preserves curated catalog snapshot @m3-wiring @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) window.__MOSAIC_E2E__.state.catalogRefreshFails = true;
    });
    await navigateTo(page, 'Discover Models');
    await page.getByRole('button', { name: /Refresh Catalog/i }).click();
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    await expect(page.getByText(/network unreachable|failed/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F2-03: extreme context length 32768 updates KV cache and fit status @smoke @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel('Assumed context length').selectOption('32768');
    await cardByModel(page, 'Mistral 7B Instruct').getByRole('button', { name: 'View details' }).click();
    await expect(page.getByRole('dialog').getByText(/KV Cache \(32768 ctx\)/)).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F2-04: missing model architecture metadata classifies as Unknown @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      window.__MOSAIC_E2E__?.state.catalogEntries.push({
        ollama_name: 'custom-unknown:latest',
        display_name: 'Custom Unknown Model',
        provider: 'Local',
        quantization: 'Q4_K_M',
        summary: 'Missing layer metadata entry.',
        license_name: 'MIT',
        license_url: 'https://ollama.com',
      });
    });
    await navigateTo(page, 'Discover Models');
    const card = cardByModel(page, 'Custom Unknown Model');
    await expect(card).toBeVisible();
    await expect(card.getByText('Unknown', { exact: true }).first()).toBeVisible();
    await expect(card.getByText(/Insufficient model weight or parameter metadata/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F2-05: unmatched search query shows clean empty-state message @smoke @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel('Search models').fill('nonexistent-xyz-999');
    await expect(page.getByText('No models match the selected search query or compatibility filter.')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F2-06: Discover Models and drawer render without overflow at 900x700 @m3-wiring @tier2 @F2', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await auditOverflowAndButtons(page, 'Discover 900x700');
    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'View details' }).click();
    await auditOverflowAndButtons(page, 'ModelDetailDrawer 900x700');
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F3 My Models & /api/show Boundaries @tier2 @F3', () => {
  test('T2-F3-01: empty installed inventory renders clean empty notice @smoke @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await expect(page.getByText('No downloaded models detected in the configured Ollama library.')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F3-02: /api/show failure handles Ollama offline error gracefully @m3-wiring @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => window.__MOSAIC_E2E__?.setOllamaReachable(false));
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: /Inspect|Show Metadata/i }).first().click();
    await expect(page.getByText(/Failed to query \/api\/show|unreachable/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F3-03: delete_installed_model rejects confirmed: false @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    const res = await invokeE2E(page, 'delete_installed_model', { model: 'llama3.2:3b', confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Explicit confirmation is required/i);
    tracker.assertClean();
  });

  test('T2-F3-04: malformed model names rejected on show, delete, and benchmark @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    for (const bad of ['../secret:latest', '--flag', 'llama3.2; rm -rf /']) {
      const r1 = await invokeE2E(page, 'show_model_details', { model: bad });
      const r2 = await invokeE2E(page, 'delete_installed_model', { model: bad, confirmed: true });
      const r3 = await invokeE2E(page, 'run_model_benchmark', { model: bad });
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
      expect(r3.ok).toBe(false);
    }
    tracker.assertClean();
  });

  test('T2-F3-05: second Benchmark button disables while benchmark is active @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      const orig = window.__TAURI_INTERNALS__?.invoke as (c: string, a: Record<string, unknown>) => Promise<unknown>;
      if (!window.__TAURI_INTERNALS__) return;
      window.__TAURI_INTERNALS__.invoke = (c: string, a: Record<string, unknown>) => {
        if (c === 'run_model_benchmark') return new Promise((resolve) => setTimeout(() => resolve(orig(c, a)), 1000));
        return orig(c, a);
      };
    });
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Benchmark llama3.2:3b' }).click();
    await expect(page.getByRole('button', { name: 'Benchmark mistral:7b-instruct-q4_K_M' })).toBeDisabled();
    await expect(page.getByText('Benchmark complete for llama3.2:3b.')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F3-06: long HuggingFace IQ2_XS tag wraps cleanly at 900x700 @tier2 @F3', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await expect(page.getByRole('heading', { name: 'hf.co/bartowski/Qwen_Qwen3-30B-A3B-GGUF:IQ2_XS' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F4 Run Model Streaming Boundaries @tier2 @F4', () => {
  test('T2-F4-01: cooperative stop_chat_stream emits terminal done: true event @m3-wiring @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('Stop test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(async () => {
      const chatEvs = (await getEmittedEvents(page)).filter((e) => e.event === 'mosaic://chat-token');
      const last = chatEvs[chatEvs.length - 1]?.payload as { done?: boolean; error?: string | null } | undefined;
      return last?.done === true && last.error === null;
    }).toBe(true);
    tracker.assertClean();
  });

  test('T2-F4-02: mid-stream HTTP 500 error emits done: true and shows notice @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) window.__MOSAIC_E2E__.state.streamHttpError = 'Ollama HTTP 500';
    });
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('Trigger error');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Ollama HTTP 500')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F4-03: empty and whitespace prompts block start_chat_stream @smoke @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel('Prompt input').fill('   ');
    await page.getByLabel('Prompt input').press('Enter');
    const sent = (await getInvokeLog(page)).some((e) => e.cmd === 'start_chat_stream');
    expect(sent).toBe(false);
    tracker.assertClean();
  });

  test('T2-F4-04: Ollama offline disables prompt input, Send, and Unload @smoke @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await expect(page.getByLabel('Prompt input')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Unload Model' })).toBeDisabled();
    tracker.assertClean();
  });

  test('T2-F4-05: switching models does not churn mosaic://chat-token listeners @m3-wiring @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      let count = 0;
      const orig = window.__TAURI_INTERNALS__?.invoke as (c: string, a: Record<string, unknown>) => Promise<unknown>;
      if (!window.__TAURI_INTERNALS__) return;
      (window as Window & { __chatListenCount?: number }).__chatListenCount = 0;
      window.__TAURI_INTERNALS__.invoke = (c: string, a: Record<string, unknown>) => {
        if (c === 'plugin:event|listen' && a.event === 'mosaic://chat-token') {
          count += 1;
          (window as Window & { __chatListenCount?: number }).__chatListenCount = count;
        }
        return orig(c, a);
      };
    });
    await navigateTo(page, 'Run Model');
    const select = page.getByLabel('Select installed model');
    await select.selectOption('mistral:7b-instruct-q4_K_M');
    await select.selectOption('llama3.2:3b');
    const extraListens = await page.evaluate(() => (window as Window & { __chatListenCount?: number }).__chatListenCount ?? 0);
    expect(extraListens).toBe(0);
    tracker.assertClean();
  });

  test('T2-F4-06: Run Model view has bounded buttons and zero overflow at 900x700 @tier2 @F4', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await auditOverflowAndButtons(page, 'Run Model 900x700');
    tracker.assertClean();
  });
});
