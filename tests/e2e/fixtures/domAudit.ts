import { expect, type Page } from '@playwright/test';

export interface RuntimeErrorTracker {
  errors: string[];
  assertClean: () => void;
}

export interface DomAuditOptions {
  checkGlass?: boolean;
  checkSlopBadges?: boolean;
}

export function attachRuntimeErrorTracker(page: Page): RuntimeErrorTracker {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  return {
    errors,
    assertClean: () => {
      expect(errors, `Unexpected runtime errors: ${errors.join('; ')}`).toEqual([]);
    },
  };
}

export async function auditOverflowAndButtons(page: Page, contextLabel: string): Promise<void> {
  const report = await page.evaluate(() => {
    const docOverflow = document.documentElement.scrollWidth > window.innerWidth;
    const bodyOverflow = document.body.scrollWidth > window.innerWidth;
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('main button, header button, [role="dialog"] button')
    ).filter((btn) => {
      if (btn.classList.contains('mosaic-nav-btn')) return false;
      const r = btn.getBoundingClientRect();
      const s = getComputedStyle(btn);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });

    const oversized: string[] = [];
    const undersized: string[] = [];
    const rects = buttons.map((b) => {
      const r = b.getBoundingClientRect();
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40);
      if (r.width > 280) oversized.push(`${label} (${Math.round(r.width)}px)`);
      if (r.height < 40) undersized.push(`${label} (${Math.round(r.height)}px)`);
      return { label, rect: r };
    });

    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i].rect;
        const b = rects[j].rect;
        const xOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const yOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (xOverlap > 1 && yOverlap > 1) {
          overlaps.push(`${rects[i].label} <-> ${rects[j].label}`);
        }
      }
    }
    return { docOverflow, bodyOverflow, oversized, undersized, overlaps };
  });

  expect(report.docOverflow, `${contextLabel}: documentElement horizontal overflow`).toBe(false);
  expect(report.bodyOverflow, `${contextLabel}: body horizontal overflow`).toBe(false);
  expect(report.oversized, `${contextLabel}: buttons > 280px`).toEqual([]);
  expect(report.undersized, `${contextLabel}: buttons < 40px`).toEqual([]);
  expect(report.overlaps, `${contextLabel}: overlapping buttons`).toEqual([]);
}

export async function auditRouteVisuals(
  page: Page,
  contextLabel: string,
  options: DomAuditOptions = { checkGlass: true, checkSlopBadges: true }
): Promise<void> {
  await auditOverflowAndButtons(page, contextLabel);

  const visual = await page.evaluate(() => {
    const parseAlpha = (bg: string): number => {
      if (bg === 'transparent') return 0;
      const m = bg.match(/rgba?\(([^)]+)\)/i);
      if (!m) return 1;
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };

    const glassEls = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.mosaic-panel, .mosaic-panel-white, .mosaic-glass, .mosaic-topbar, .mosaic-sidebar, .mosaic-modal'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });

    const missingBlur: string[] = [];
    const opaqueSurfaces: string[] = [];
    const missingShadow: string[] = [];
    for (const el of glassEls) {
      const s = getComputedStyle(el);
      const blur = s.backdropFilter || (s as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || '';
      if (!blur.includes('blur(')) missingBlur.push(el.className);
      if (parseAlpha(s.backgroundColor) >= 1) opaqueSurfaces.push(`${el.className}: ${s.backgroundColor}`);
      if (
        (el.classList.contains('mosaic-panel') || el.classList.contains('mosaic-modal')) &&
        s.boxShadow === 'none'
      ) {
        missingShadow.push(el.className);
      }
    }

    const neonGradients: string[] = [];
    const allVisible = Array.from(document.querySelectorAll<HTMLElement>('body *')).slice(0, 300);
    for (const el of allVisible) {
      const bgImg = getComputedStyle(el).backgroundImage;
      if (
        bgImg &&
        bgImg !== 'none' &&
        /(#7c3aed|#a855f7|#ff00ff|124,\s*58,\s*237|168,\s*85,\s*247)/i.test(bgImg)
      ) {
        neonGradients.push(el.className || el.tagName);
      }
    }

    const topbarBadges = Array.from(document.querySelectorAll('header .mosaic-badge')).filter(
      (b) => b.getBoundingClientRect().width > 0
    ).length;

    const slopBadges: string[] = [];
    const SLOP_RE = /^(measured|Local-first|Running locally through Ollama|cli_service|macos_app_or_cli)$/i;
    for (const badge of Array.from(document.querySelectorAll<HTMLElement>('.mosaic-badge'))) {
      if (badge.getBoundingClientRect().width === 0) continue;
      const text = (badge.textContent || '').trim();
      if (SLOP_RE.test(text) || text.length > 36) {
        slopBadges.push(text);
      }
    }

    return {
      glassCount: glassEls.length,
      missingBlur,
      opaqueSurfaces,
      missingShadow,
      neonGradients,
      topbarBadges,
      slopBadges,
    };
  });

  if (options.checkGlass !== false) {
    expect(visual.glassCount, `${contextLabel}: expected glass surfaces`).toBeGreaterThan(0);
    expect(visual.missingBlur, `${contextLabel}: missing backdrop blur`).toEqual([]);
    expect(visual.opaqueSurfaces, `${contextLabel}: opaque non-glass surface`).toEqual([]);
    expect(visual.missingShadow, `${contextLabel}: missing specular shadow`).toEqual([]);
    expect(visual.neonGradients, `${contextLabel}: neon purple gradient detected`).toEqual([]);
  }
  if (options.checkSlopBadges !== false) {
    expect(visual.topbarBadges, `${contextLabel}: topbar badge count <= 2`).toBeLessThanOrEqual(2);
    expect(visual.slopBadges, `${contextLabel}: slop or >36-char badges`).toEqual([]);
  }
}
