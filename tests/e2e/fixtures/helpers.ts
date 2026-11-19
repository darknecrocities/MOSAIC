import { expect, type Page } from '@playwright/test';

export type NavLabel =
  | 'Overview'
  | 'Discover Models'
  | 'My Models'
  | 'Run Model'
  | 'Hardware'
  | 'External Storage'
  | 'Settings';

export const ALL_NAV_LABELS: NavLabel[] = [
  'Overview',
  'Discover Models',
  'My Models',
  'Run Model',
  'Hardware',
  'External Storage',
  'Settings',
];

export async function navigateTo(page: Page, label: NavLabel): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  const btn = nav.getByRole('button', { name: label, exact: true });
  await btn.click();
  await expect(btn).toHaveAttribute('aria-current', 'page');
}

export async function openApp(page: Page): Promise<void> {
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  const rescanBtn = page.getByRole('button', {
    name: 'Rescan host hardware, external drives, and Ollama',
  });
  await expect(rescanBtn).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Loading MOSAIC Runtime' })).toBeHidden();
  const isTauri = await page.evaluate(() => Boolean(window.isTauri));
  if (isTauri) {
    await expect
      .poll(async () => {
        const cmds = (await getInvokeLog(page)).map((e) => e.cmd);
        return cmds.includes('get_app_state') && cmds.includes('list_installed_models');
      })
      .toBe(true);
  }
}

export async function clickRescan(page: Page): Promise<void> {
  const rescanBtn = page.getByRole('button', {
    name: 'Rescan host hardware, external drives, and Ollama',
  });
  await rescanBtn.click();
  await expect(rescanBtn).toBeEnabled();
}

export function cardByModel(page: Page, displayName: string) {
  return page.getByRole('article', { name: displayName, exact: true });
}

export async function invokeE2E<T = unknown>(
  page: Page,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<{ ok: boolean; value?: T; error?: string }> {
  return page.evaluate(
    async ({ command, payload }) => {
      const internals = window.__TAURI_INTERNALS__ as
        | { invoke: (c: string, a: Record<string, unknown>) => Promise<unknown> }
        | undefined;
      if (!internals) {
        return { ok: false, error: 'TAURI_INTERNALS missing' };
      }
      try {
        const res = await internals.invoke(command, payload);
        return { ok: true, value: res };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { command: cmd, payload: args }
  ) as Promise<{ ok: boolean; value?: T; error?: string }>;
}

export async function getInvokeLog(page: Page) {
  return page.evaluate(() => window.__MOSAIC_E2E__?.invokeLog ?? []);
}

export async function getEmittedEvents(page: Page) {
  return page.evaluate(() => window.__MOSAIC_E2E__?.emittedEvents ?? []);
}
