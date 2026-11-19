import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker } from './fixtures/domAudit';
import { cardByModel, getEmittedEvents, getInvokeLog, navigateTo, openApp } from './fixtures/helpers';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 1 — F5 Hardware & Python Insights @tier1 @F5', () => {
  test('T1-F5-01: Hardware screen renders unified memory without double counting @smoke @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await expect(page.getByText(/Apple M3/).first()).toBeVisible();
    await expect(page.getByText('10.0 GiB free of 16.0 GiB')).toBeVisible();
    await expect(page.getByText('Yes (CPU & GPU shared)')).toBeVisible();
    await expect(page.getByText(/Healthy \(protocol 1\.0\)/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F5-02: discrete GPU profile displays measured VRAM and non-unified RAM @m3-wiring @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-8gb-constrained');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    await expect(page.getByText('RTX 3050 Laptop')).toBeVisible();
    await expect(page.getByText(/4\.0 GiB/).first()).toBeVisible();
    await expect(page.getByText('No', { exact: true })).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F5-03: Hardware insights invoke analyze_hardware_insights and show Metal limit @m3-wiring @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Hardware');
    const btn = page.getByRole('button', { name: /Analyze Hardware/i });
    if (await btn.isVisible()) await btn.click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'analyze_hardware_insights')).toBe(true);
    await expect(page.getByText(/Metal|Wired Limit/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F5-04: Analyze Bottlenecks invokes analyze_benchmark_performance @m3-wiring @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: /Analyze Bottlenecks/i }).first().click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'analyze_benchmark_performance')).toBe(true);
    await expect(page.getByText(/storage_throughput|ExFAT/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F5-05: Export JSON, CSV, and HTML invoke export_benchmark_report @smoke @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: 'Export JSON' }).first().click();
    await page.getByRole('button', { name: 'Export CSV' }).first().click();
    await page.getByRole('button', { name: 'Export HTML' }).first().click();
    await expect.poll(async () => {
      const formats = (await getInvokeLog(page))
        .filter((e) => e.cmd === 'export_benchmark_report')
        .map((e) => (e.args as { format?: string }).format);
      return formats.includes('json') && formats.includes('csv') && formats.includes('html');
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F5-06: configurable benchmark parameters flow to run_model_benchmark @m3-wiring @tier1 @F5', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'My Models');
    await page.getByLabel(/Benchmark context/i).selectOption('8192');
    await page.getByLabel(/Repetitions/i).fill('3');
    await page.getByRole('button', { name: 'Benchmark llama3.2:3b' }).click();
    await expect.poll(async () => {
      const call = (await getInvokeLog(page)).find((e) => e.cmd === 'run_model_benchmark');
      const args = call?.args as { contextLength?: number; repetitions?: number } | undefined;
      return args?.contextLength === 8192 && args?.repetitions === 3;
    }).toBe(true);
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F6 External Storage & Ollama Supervision @tier1 @F6', () => {
  test('T1-F6-01: External Storage displays active One Touch library metadata @smoke @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await expect(page.getByText('/Volumes/One Touch/MOSAIC/ollama-models', { exact: true })).toBeVisible();
    await expect(page.getByText('95AE3673-713F-3C93-AAB0-FCBB496C45CD')).toBeVisible();
    await expect(page.getByText('Connected & Writable')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F6-02: Start Managed Ollama brings Ollama online after confirmation @m3-wiring @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Start Managed Ollama/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Start Managed Ollama' }).click();
    await expect(page.getByText('Ollama 0.40.9')).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F6-03: Stop Managed Ollama stops service and disables Run Model Send @m3-wiring @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Stop Managed Ollama/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop Managed Ollama' }).click();
    await expect(page.getByText('Ollama Stopped', { exact: true })).toBeVisible();
    await navigateTo(page, 'Run Model');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    tracker.assertClean();
  });

  test('T1-F6-04: Configure OLLAMA_MODELS requires confirmation and reports backup @smoke @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: 'Configure OLLAMA_MODELS' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Apply Configuration' }).click();
    await expect(page.getByText(/backup/i)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F6-05: Migrate Internal Models copies blobs to external library @smoke @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'degraded-python-ollama-stopped');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Migrate Internal Models/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Copy to External Drive' }).click();
    await expect(page.getByText(/Copied 4 file\(s\)/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F6-06: Prepare safe eject disconnects library and restores OnboardingGate @smoke @tier1 @F6', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'External Storage');
    await page.getByRole('button', { name: /Stop model and prepare drive for removal|Prepare Eject/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Eject Safely' }).click();
    await expect(page.getByText(/safe to remove/i)).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Connect & Select Your External Model Library/i }).first()
    ).toBeVisible();
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F7 Settings, Diagnostics & Phase 7 Cluster Runtime @tier1 @F7', () => {
  test('T1-F7-01: saving valid reserve and loopback endpoint persists to SQLite @smoke @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByLabel('OS Memory Safety Reserve (GiB)').fill('3.5');
    await page.getByRole('button', { name: 'Save Settings' }).click();
    await expect(page.getByText('Settings saved locally to SQLite.')).toBeVisible();
    const val = await page.evaluate(() => window.__MOSAIC_E2E__?.state.bootstrap.settings.safety_reserve_gib);
    expect(val).toBe(3.5);
    tracker.assertClean();
  });

  test('T1-F7-02: DiagnosticsLogPanel loads and displays SQLite diagnostic events @m3-wiring @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');
    const refreshBtn = page.getByRole('button', { name: /Refresh Diagnostics/i });
    if (await refreshBtn.isVisible()) await refreshBtn.click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'get_diagnostics')).toBe(true);
    await expect(page.getByText(/volume_manager/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F7-03: adding and probing local RPC worker displays reachable RTT @smoke @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Settings');
    await page.getByPlaceholder('Worker name (e.g. RTX-PC)').fill('Local-RPC');
    await page.getByPlaceholder('Host / LAN IP').fill('127.0.0.1');
    await page.getByRole('button', { name: 'Add Worker' }).click();
    await page.getByRole('button', { name: 'Probe Reachability' }).click();
    await expect(page.getByText(/Local-RPC/)).toBeVisible();
    await expect(page.getByText(/reachable \(2 ms\)/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F7-04: Compute Adaptive Cluster Plan renders 3-tier allocation and RPC nodes @smoke @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 235B-A22B MoE').getByRole('button', { name: 'View details' }).click();
    await page.getByRole('button', { name: 'Compute Adaptive / Cluster Plan' }).click();
    await expect(page.getByText('Pooled RPC Nodes')).toBeVisible();
    await expect(page.getByText(/RTX-Node-A/)).toBeVisible();
    await expect(page.getByText(/--rpc/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F7-05: Launch Cluster Runtime invokes llama-server with valid .gguf path @m3-wiring @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 235B-A22B MoE').getByRole('button', { name: 'View details' }).click();
    await page.getByRole('button', { name: 'Compute Adaptive / Cluster Plan' }).click();
    await page.getByLabel(/GGUF/i).fill('models/qwen3-30b-a3b-iq2_xs.gguf');
    await page.getByRole('button', { name: /Launch Cluster Runtime/i }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Launch Runtime' }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'launch_cluster_runtime')).toBe(true);
    tracker.assertClean();
  });

  test('T1-F7-06: Stop Cluster Runtime stops experimental llama-server @m3-wiring @tier1 @F7', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'cluster-3node');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 3 235B-A22B MoE').getByRole('button', { name: 'View details' }).click();
    await page.getByRole('button', { name: 'Compute Adaptive / Cluster Plan' }).click();
    await page.getByLabel(/GGUF/i).fill('models/qwen3-30b-a3b-iq2_xs.gguf');
    await page.getByRole('button', { name: /Launch Cluster Runtime/i }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Launch Runtime' }).click();
    await page.getByRole('button', { name: /Stop Cluster Runtime/i }).click();
    await expect.poll(async () => (await getInvokeLog(page)).some((e) => e.cmd === 'stop_cluster_runtime')).toBe(true);
    tracker.assertClean();
  });
});

test.describe('Tier 1 — F8 Adaptive Execution Profiles & Pull Cancel @tier1 @F8', () => {
  test('T1-F8-01: 30B MoE IQ2_XS shows explainable adaptive execution_plan on 16 GiB M3 @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    const card = cardByModel(page, 'Qwen3 30B-A3B MoE (IQ2_XS)');
    await expect(card).toBeVisible();
    await expect(card.getByText(/Borderline|Recommended/)).toBeVisible();
    await card.getByRole('button', { name: 'View details' }).click();
    await expect(page.getByRole('dialog').getByText(/q8_0|q4_0/)).toBeVisible();
    tracker.assertClean();
  });

  test('T1-F8-02: switching execution profile updates catalog evaluation @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel(/Execution profile/i).selectOption('constrained_memory');
    await expect.poll(async () => {
      return (await getInvokeLog(page)).some((e) => {
        const a = e.args as { executionProfile?: string; execution_profile?: string };
        return (e.cmd === 'list_catalog_with_fit' || e.cmd === 'evaluate_catalog') &&
          (a.executionProfile ?? a.execution_profile) === 'constrained_memory';
      });
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F8-03: switching KV cache precision reduces KV estimate @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await page.getByLabel(/KV cache/i).selectOption('q4_0');
    await expect.poll(async () => {
      return (await getInvokeLog(page)).some((e) => {
        const a = e.args as { kvCacheType?: string; kv_cache_type?: string };
        return (e.cmd === 'list_catalog_with_fit' || e.cmd === 'evaluate_catalog') &&
          (a.kvCacheType ?? a.kv_cache_type) === 'q4_0';
      });
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F8-04: Run Model forwards adaptive profile and 32768 context to start_chat_stream @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Run Model');
    await page.getByLabel(/Execution profile/i).selectOption('constrained_memory');
    await page.getByLabel(/KV cache/i).selectOption('q4_0');
    await page.getByLabel('Context length').selectOption('32768');
    await page.getByLabel('Prompt input').fill('Run adaptive 30B');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => {
      const call = (await getInvokeLog(page)).find((e) => e.cmd === 'start_chat_stream');
      const req = (call?.args as { request?: Record<string, unknown> })?.request;
      return req?.num_ctx === 32768 && req?.execution_profile === 'constrained_memory';
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F8-05: Download streams live byte progress and refreshes installed models @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);
    await navigateTo(page, 'Discover Models');
    await cardByModel(page, 'Qwen 2.5 0.5B').getByRole('button', { name: 'Download', exact: true }).click();
    await expect.poll(async () => {
      const evs = await getEmittedEvents(page);
      return evs.some((e) => e.event === 'mosaic://pull-progress' && (e.payload as { done?: boolean }).done === true);
    }).toBe(true);
    tracker.assertClean();
  });

  test('T1-F8-06: Cancel Pull button cancels active download and emits terminal done: true @m3-wiring @tier1 @F8', async ({ page }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'active-pull-stream');
    await openApp(page);
    await expect
      .poll(() => page.evaluate(() => window.__MOSAIC_E2E__?.hasEventListener('mosaic://pull-progress') ?? false))
      .toBe(true);
    await page.evaluate(() => {
      window.__MOSAIC_E2E__?.emitBackendEvent('mosaic://pull-progress', {
        model: 'llama3.2:3b', status: 'downloading', completed: 512_000_000, total: 2_020_000_000, done: false, error: null,
      });
    });
    await page.getByRole('button', { name: /Cancel Pull/i }).click();
    await expect.poll(async () => {
      const evs = await getEmittedEvents(page);
      return evs.some((e) => e.event === 'mosaic://pull-progress' && (e.payload as { done?: boolean; error?: string }).done === true);
    }).toBe(true);
    tracker.assertClean();
  });
});
