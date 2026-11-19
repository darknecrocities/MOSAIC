import { expect, test } from '@playwright/test';
import { attachRuntimeErrorTracker, auditOverflowAndButtons } from './fixtures/domAudit';
import { cardByModel, clickRescan, navigateTo, openApp } from './fixtures/helpers';
import { installTauriMock } from './fixtures/tauriMock';

test.describe('Tier 5 — Adversarial Overflow, Modal Stack & Focus Hardening @tier5', () => {
  test('T5-01: long 30B-100B GGUF tags, external paths, and unbreakable diagnostics cause zero container overflow @tier5', async ({
    page,
  }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);

    await page.evaluate(() => {
      const e2e = window.__MOSAIC_E2E__;
      if (!e2e) return;
      const longTag =
        'hf.co/unsloth/Qwen_Qwen3_30B_A3B_Instruct_2507_GGUF_ExtraLongVariant:IQ2_XS';
      e2e.state.installed.unshift({
        name: longTag,
        size_bytes: 9_140_316_832,
        digest: 'sha256:99887766554433221100',
        modified_at: '2026-11-18T13:00:00Z',
        family: 'qwen3moe',
        parameter_size: '30.5B',
        quantization_level: 'IQ2_XS',
      });
      if (e2e.state.bootstrap.active_library) {
        e2e.state.bootstrap.active_library.directory_path =
          '/Volumes/VeryLongExternalDriveMountPoint_WithUnbrokenSegment_2026/MOSAIC/ollama-models/blobs';
        e2e.state.bootstrap.active_library.volume_identifier =
          '95AE3673-713F-3C93-AAB0-FCBB496C45CD-LONG-EXTERNAL-DRIVE-IDENTIFIER-001';
      }
      e2e.state.diagnostics.unshift({
        id: 999,
        severity: 'error',
        component: 'ollama_supervisor',
        message: `UnbreakableDiagnosticToken_${'X'.repeat(160)}_end`,
        created_at: '2026-11-18T13:05:00Z',
      });
    });

    await clickRescan(page);
    await navigateTo(page, 'My Models');
    await expect(
      page.getByRole('heading', {
        name: 'hf.co/unsloth/Qwen_Qwen3_30B_A3B_Instruct_2507_GGUF_ExtraLongVariant:IQ2_XS',
      })
    ).toBeVisible();
    await auditOverflowAndButtons(page, 'T5-01 My Models long tag');

    await navigateTo(page, 'External Storage');
    await auditOverflowAndButtons(page, 'T5-01 External Storage long path');

    await navigateTo(page, 'Settings');
    await expect(page.getByText(/UnbreakableDiagnosticToken_/)).toBeVisible();
    await auditOverflowAndButtons(page, 'T5-01 Settings long diagnostic');

    tracker.assertClean();
  });

  test('T5-02: stacked Escape closes ConfirmModal without dismissing parent ModelDetailDrawer and restores focus @tier5', async ({
    page,
  }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);

    await navigateTo(page, 'Discover Models');
    const detailBtn = cardByModel(page, 'DeepSeek-R1 Distill 70B').getByRole('button', {
      name: 'View details',
    });
    await detailBtn.focus();
    await detailBtn.click();

    const drawer = page.getByRole('dialog', { name: 'DeepSeek-R1 Distill 70B' });
    await expect(drawer).toBeVisible();
    const adaptiveBtn = drawer.getByRole('button', { name: /Adaptive Pull/i });
    await adaptiveBtn.click();
    const confirmDialog = page.getByRole('dialog', { name: 'Pull Exceeds Safe Memory Budget' });
    await expect(confirmDialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(confirmDialog).toHaveCount(0);
    await expect(drawer).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(detailBtn).toBeFocused();

    tracker.assertClean();
  });

  test('T5-03: statusbar wraps long library paths without horizontal overflow and Shift+Tab stays trapped from dialog text @tier5', async ({
    page,
  }) => {
    const tracker = attachRuntimeErrorTracker(page);
    await installTauriMock(page, 'connected-16gb-m3');
    await openApp(page);

    await page.evaluate(() => {
      const e2e = window.__MOSAIC_E2E__;
      if (e2e?.state.bootstrap.active_library) {
        e2e.state.bootstrap.active_library.directory_path =
          `/Volumes/ExternalDrive_${'Segment'.repeat(24)}/MOSAIC/ollama-models`;
      }
    });
    await clickRescan(page);
    await expect(page.getByText(/\/Volumes\/ExternalDrive_/)).toBeVisible();
    await auditOverflowAndButtons(page, 'T5-03 statusbar long library path');

    await navigateTo(page, 'My Models');
    await page.getByRole('button', { name: /^Delete / }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Delete Model Weights' });
    await expect(dialog).toBeVisible();
    await dialog.getByText(/Remove .* from your external Ollama model library/i).click();
    await page.keyboard.press('Shift+Tab');
    const trapped = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(trapped).toBe(true);

    tracker.assertClean();
  });
});
