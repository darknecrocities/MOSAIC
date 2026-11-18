import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker, auditOverflowAndButtons } from './fixtures/domAudit';
import {
  cardByModel,
  getEmittedEvents,
  invokeE2E,
  navigateTo,
  openApp,
} from './fixtures/helpers';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 2 — F5 Hardware & Insights Boundaries @tier2 @F5', () => {
  test('T2-F5-01: Python analytics unavailable degrades gracefully without crash @smoke @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await expect(page.getByText('Analytics degraded (core controls active)')).toBeVisible();
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F5-02: missing GPU telemetry reports unknown and zero fabricated VRAM @smoke @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await expect(page.getByText(/Python analytics worker exited/i)).toBeVisible();
    const gpus = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.system.gpus.length);
    expect(gpus).toBe(0);
    tracker.assertClean();
  });

  test('T2-F5-03: Apple Silicon unified memory never double-counts RAM + VRAM @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await expect(page.getByText('10.0 GiB free of 16.0 GiB')).toBeVisible();
    await expect(page.getByText('32.0 GiB')).toHaveCount(0);
    tracker.assertClean();
  });

  test('T2-F5-04: export_benchmark_report failure surfaces error notice in UI @m3-wiring @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) window.__MOSAIC_E2E__.state.exportReportFails = true;
    });
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Export JSON' }).first().click();
    await expect(page.getByText(/Failed to export benchmark report/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F5-05: HTML benchmark export escapes unsafe script tags @m3-wiring @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      const rep = window.__MOSAIC_E2E__?.state.reports[0];
      if (rep) rep.model_name = '<script>alert(1)</script>';
    });
    const res = await invokeE2E<{ format: string; content: string }>(page, 'export_benchmark_report', {
      reportId: 'rep-seed-001',
      format: 'html',
    });
    expect(res.ok).toBe(true);
    expect(res.value?.content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.value?.content).not.toContain('<script>');
    tracker.assertClean();
  });

  test('T2-F5-06: Hardware and Benchmark panels avoid overflow at 900x700 @tier2 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await auditOverflowAndButtons(page, 'Hardware 900x700');
    await navigateTo(page, 'My Models');
    await auditOverflowAndButtons(page, 'My Models 900x700');
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F6 External Storage & Ollama Boundaries @tier2 @F6', () => {
  test('T2-F6-01: safe eject blocked during active pull stream @smoke @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'active-pull-stream');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eject Safely' }).click();
    await expect(page.getByText('Stop active model downloads or inference before ejecting.')).toBeVisible();
    const connected = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.library_connected);
    expect(connected).toBe(true);
    tracker.assertClean();
  });

  test('T2-F6-02: safe eject blocked during active inference stream @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) window.__MOSAIC_E2E__.state.activeInferenceSession = 'session-busy';
    });
    const res = await invokeE2E(page, 'prepare_safe_eject');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Stop active model downloads or inference/i);
    tracker.assertClean();
  });

  test('T2-F6-03: start_managed_ollama and configure_ollama_storage require confirmed: true @m3-wiring @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    const r1 = await invokeE2E(page, 'start_managed_ollama', { confirmed: false });
    const r2 = await invokeE2E(page, 'configure_ollama_storage', { confirmed: false });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    tracker.assertClean();
  });

  test('T2-F6-04: missing Ollama binary shows Ollama Missing badge and disables start @m3-wiring @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) {
        window.__MOSAIC_E2E__.state.bootstrap.ollama.installed = false;
        window.__MOSAIC_E2E__.state.bootstrap.ollama.api_reachable = false;
      }
    });
    await page.getByRole('button', { name: 'Rescan host hardware, external drives, and Ollama' }).click();
    await expect(page.getByText('Ollama Missing')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F6-05: migration disabled and rejected when free space < 1.1x total @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'low-space-drive');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await expect(page.getByRole('button', { name: /Migrate Internal Models/i })).toBeDisabled();
    const res = await invokeE2E(page, 'execute_internal_migration', { confirmed: true });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Insufficient free space/i);
    tracker.assertClean();
  });

  test('T2-F6-06: migration hidden when source absent and rejects confirmed: false @tier2 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await expect(page.getByRole('button', { name: /Migrate Internal Models/i })).toHaveCount(0);
    const res = await invokeE2E(page, 'execute_internal_migration', { confirmed: false });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Explicit confirmation is required/i);
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F7 Settings, Diagnostics & Cluster Security Boundaries @tier2 @F7', () => {
  test('T2-F7-01: non-loopback, HTTPS, and metadata Ollama endpoints rejected @smoke @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    for (const badUrl of ['http://0.0.0.0:11434', 'http://192.168.1.50:11434', 'http://169.254.169.254', 'https://127.0.0.1:11434']) {
      const res = await invokeE2E(page, 'update_setting', { key: 'ollama_endpoint', value: badUrl });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/loopback/i);
    }
    tracker.assertClean();
  });

  test('T2-F7-02: setting allowlist rejects unknown keys and clamps reserve to [0.5, 16] @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    const bad = await invokeE2E(page, 'update_setting', { key: 'arbitrary_cmd', value: 'rm' });
    expect(bad.ok).toBe(false);
    const low = await invokeE2E<{ safety_reserve_gib: number }>(page, 'update_setting', { key: 'safety_reserve_gib', value: 0.1 });
    expect(low.value?.safety_reserve_gib).toBe(0.5);
    const high = await invokeE2E<{ safety_reserve_gib: number }>(page, 'update_setting', { key: 'safety_reserve_gib', value: 99 });
    expect(high.value?.safety_reserve_gib).toBe(16);
    tracker.assertClean();
  });

  test('T2-F7-03: cluster worker blocks unopted LAN, SSRF metadata, and port < 1024 @smoke @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByPlaceholder('Host / LAN IP').fill('192.168.1.50');
    await page.getByRole('button', { name: 'Add Worker' }).click();
    await expect(page.getByText(/requires explicit LAN opt-in/i)).toBeVisible();

    const ssrf = await invokeE2E(page, 'add_cluster_worker', {
      request: { name: 'ssrf', host: '169.254.169.254', port: 50052, vram_gib: 8, ram_gib: 8, backend: 'ggml_rpc', allow_lan: true },
    });
    expect(ssrf.ok).toBe(false);
    const lowPort = await invokeE2E(page, 'add_cluster_worker', {
      request: { name: 'p80', host: '127.0.0.1', port: 80, vram_gib: 8, ram_gib: 8, backend: 'ggml_rpc', allow_lan: false },
    });
    expect(lowPort.ok).toBe(false);
    tracker.assertClean();
  });

  test('T2-F7-04: cluster runtime rejects non-.gguf suffix and path traversal @m3-wiring @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    for (const badPath of ['models/weights.bin', '../../etc/passwd.gguf', '/abs/path/a.gguf']) {
      const res = await invokeE2E(page, 'launch_cluster_runtime', { ggufRelPath: badPath, runtimeFlags: [], confirmed: true });
      expect(res.ok).toBe(false);
    }
    tracker.assertClean();
  });

  test('T2-F7-05: cluster runtime rejects disallowed extra_flags and shell chars @m3-wiring @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    const r1 = await invokeE2E(page, 'launch_cluster_runtime', { ggufRelPath: 'models/q.gguf', runtimeFlags: ['--exec'], confirmed: true });
    const r2 = await invokeE2E(page, 'launch_cluster_runtime', { ggufRelPath: 'models/q.gguf', runtimeFlags: ['-ngl', '10; rm -rf'], confirmed: true });
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    tracker.assertClean();
  });

  test('T2-F7-06: get_diagnostics caps limit at 200 and handles empty logs @m3-wiring @tier2 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'disconnected');
    await openApp(page);
    await page.evaluate(() => {
      if (window.__MOSAIC_E2E__) window.__MOSAIC_E2E__.state.diagnostics = [];
    });
    const res = await invokeE2E<unknown[]>(page, 'get_diagnostics', { limit: 500 });
    expect(res.ok).toBe(true);
    expect(res.value).toEqual([]);
    tracker.assertClean();
  });
});

test.describe('Tier 2 — F8 Adaptive Fit & Pull Cancellation Boundaries @tier2 @F8', () => {
  test('T2-F8-01: 8 GiB profile marks 30B-70B Not recommended while fitting 0.5B-1B @m3-wiring @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-8gb-constrained');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Qwen 2.5 0.5B').getByText('Recommended')).toBeVisible();
    await expect(cardByModel(page, 'DeepSeek-R1 Distill 70B').getByText('Not recommended')).toBeVisible();
    tracker.assertClean();
  });

  test('T2-F8-02: switching profile from max_quality to constrained_memory lowers 30B memory @m3-wiring @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    const maxQ = await invokeE2E<Array<{ model: { ollama_name: string }; fit: { total_estimated_bytes: number } }>>(
      page, 'list_catalog_with_fit', { contextLength: 32768, executionProfile: 'max_quality', kvCacheType: 'f16' }
    );
    const constrained = await invokeE2E<Array<{ model: { ollama_name: string }; fit: { total_estimated_bytes: number } }>>(
      page, 'list_catalog_with_fit', { contextLength: 32768, executionProfile: 'constrained_memory', kvCacheType: 'q4_0' }
    );
    const mMax = maxQ.value?.find((x) => x.model.ollama_name.includes('IQ2_XS'))?.fit.total_estimated_bytes ?? 0;
    const mCon = constrained.value?.find((x) => x.model.ollama_name.includes('IQ2_XS'))?.fit.total_estimated_bytes ?? 0;
    expect(mCon).toBeLessThan(mMax);
    tracker.assertClean();
  });

  test('T2-F8-03: live 1.1x disk space check disables 3B and blocks dynamic space drop @smoke @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'low-space-drive');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await expect(cardByModel(page, 'Llama 3.2 3B').getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    await page.evaluate(() => window.__MOSAIC_E2E__?.setFreeBytes('LOW-SPACE-01', 1_000_000_000));
    const pullRes = await invokeE2E(page, 'pull_model', { model: 'llama3.2:1b', estimatedBytes: 1_320_000_000 });
    expect(pullRes.ok).toBe(false);
    expect(pullRes.error).toMatch(/insufficient free space on external drive/i);
    tracker.assertClean();
  });

  test('T2-F8-04: cancel_pull guarantees terminal done: true and clears progress banner @m3-wiring @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'active-pull-stream');
    await openApp(page);
    const res = await invokeE2E<boolean>(page, 'cancel_pull', { model: 'llama3.2:3b' });
    expect(res.value).toBe(true);
    const lastEv = (await getEmittedEvents(page)).filter((e) => e.event === 'mosaic://pull-progress').pop();
    expect((lastEv?.payload as { done?: boolean; error?: string })?.done).toBe(true);
    expect((lastEv?.payload as { error?: string })?.error).toBe('Pull cancelled by user.');
    tracker.assertClean();
  });

  test('T2-F8-05: duplicate concurrent pull for same model is rejected @m3-wiring @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'active-pull-stream');
    await openApp(page);
    const dup = await invokeE2E(page, 'pull_model', { model: 'llama3.2:3b', estimatedBytes: 2_020_000_000 });
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/Pull already active/i);
    tracker.assertClean();
  });

  test('T2-F8-06: malformed model identifier rejected by pull_model before streaming @tier2 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    for (const bad of ['../evil:latest', '--inject']) {
      const res = await invokeE2E(page, 'pull_model', { model: bad, estimatedBytes: 100 });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/security validation failed/i);
    }
    const evs = (await getEmittedEvents(page)).filter((e) => e.event === 'mosaic://pull-progress');
    expect(evs).toHaveLength(0);
    tracker.assertClean();
  });
});
