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
    const dialogs = Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"], .mosaic-modal')
    ).filter((d) => {
      const r = d.getBoundingClientRect();
      const s = getComputedStyle(d);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    const scopeRoot: ParentNode = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document;
    const selector = dialogs.length > 0
      ? 'button'
      : 'main button, header button, [role="dialog"] button, .mosaic-modal button';
    const buttons = Array.from(
      scopeRoot.querySelectorAll<HTMLButtonElement>(selector)
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
    const containerOverflows: string[] = [];
    const containers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.mosaic-main, .mosaic-panel, .mosaic-panel-white, .mosaic-kv, .mosaic-diagnostics-list'
      )
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    });
    for (const el of containers) {
      if (el.scrollWidth > el.clientWidth + 1) {
        containerOverflows.push(
          `${el.className || el.tagName} (${el.scrollWidth} > ${el.clientWidth})`
        );
      }
    }

    return { docOverflow, bodyOverflow, containerOverflows, oversized, undersized, overlaps };
  });

  expect(report.docOverflow, `${contextLabel}: documentElement horizontal overflow`).toBe(false);
  expect(report.bodyOverflow, `${contextLabel}: body horizontal overflow`).toBe(false);
  expect(report.containerOverflows, `${contextLabel}: inner container horizontal overflow`).toEqual([]);
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
      const norm = bg.trim().toLowerCase();
      if (!norm || norm === 'transparent') return 0;
      const toUnit = (raw: string): number => {
        const t = raw.trim();
        const num = Number.parseFloat(t.endsWith('%') ? t.slice(0, -1) : t);
        if (!Number.isFinite(num)) return 1;
        return t.endsWith('%') ? num / 100 : num;
      };
      const slash = norm.match(
        /^(?:oklch|oklab|lch|lab|color|hsla?|rgba?)\([^)]*\/\s*([\d.]+%?)\s*\)$/
      );
      if (slash) return toUnit(slash[1]);
      const legacy = norm.match(/^(?:rgba|hsla)\(([^)]+)\)$/);
      if (legacy) {
        const parts = legacy[1].split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 4) return toUnit(parts[3]);
      }
      return 1;
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
      if (!blur.includes('blur(') || /\bblur\(0(?:px)?\)/i.test(blur)) missingBlur.push(el.className);
      if (parseAlpha(s.backgroundColor) >= 1) opaqueSurfaces.push(`${el.className}: ${s.backgroundColor}`);
      if (
        (el.classList.contains('mosaic-panel') || el.classList.contains('mosaic-modal')) &&
        s.boxShadow === 'none'
      ) {
        missingShadow.push(el.className);
      }
    }

    const neonGradients: string[] = [];
    const allVisible = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
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
