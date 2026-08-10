import type { Frame, Page } from 'playwright';
import type {
  FrameTrace,
  InteractiveElementTrace,
  RuntimeSignals,
  VisibleOverlayTrace,
} from './types.ts';

const MAX_ELEMENTS_PER_FRAME = 5_000;
const MAX_NAME_LENGTH = 240;

async function collectFrameElements(frame: Frame): Promise<{
  interactive: InteractiveElementTrace[];
  overlays: VisibleOverlayTrace[];
  runtime: Omit<RuntimeSignals, 'iframeCount' | 'frameworkMarkers'> & { frameworkMarkers: string[] };
}> {
  return frame.evaluate(({ maxElements, maxNameLength }) => {
    const isVisible = (el: Element): boolean => {
      if (!(el instanceof HTMLElement)) return true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const clean = (value: string | null | undefined): string | undefined => {
      const out = value?.replace(/\s+/g, ' ').trim();
      return out ? out.slice(0, maxNameLength) : undefined;
    };

    const domPath = (el: Element): string => {
      if ((el as HTMLElement).id) return `#${(el as HTMLElement).id}`;
      const testId = el.getAttribute('data-testid');
      if (testId) return `[data-testid="${testId.slice(0, 120)}"]`;
      const parts: string[] = [];
      let current: Element | null = el;
      for (let depth = 0; current && depth < 5; depth += 1) {
        let part = current.tagName.toLowerCase();
        const role = current.getAttribute('role');
        if (role) part += `[role="${role}"]`;
        const node: Element = current;
        const parent: Element | null = node.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child: Element) => child.tagName === node.tagName);
          if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };

    const selector = [
      'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'details',
      '[role]', '[tabindex]', '[onclick]', '[onchange]', '[oninput]', '[onsubmit]',
      '[aria-haspopup]', '[aria-expanded]', '[aria-controls]', '[contenteditable="true"]',
      '[data-toggle]', '[data-bs-toggle]', '[data-target]', '[data-action]',
    ].join(',');

    const candidateSet = new Set<Element>(Array.from(document.querySelectorAll(selector)));
    const heuristicClass = /(?:^|[-_\s])(btn|button|click|tab|accordion|dropdown|select|modal|drawer|toggle|expand|collapse|load-more|pagination|next|prev)(?:$|[-_\s])/i;
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, maxElements * 4)) {
      if (candidateSet.size >= maxElements) break;
      if (!(el instanceof HTMLElement)) continue;
      const identity = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
      if (getComputedStyle(el).cursor === 'pointer' || heuristicClass.test(identity)) candidateSet.add(el);
    }
    const elements = [...candidateSet].slice(0, maxElements);
    const interactive = elements.map((el) => {
      const html = el as HTMLElement;
      const role = el.getAttribute('role') ?? undefined;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type') ?? undefined;
      const href = el instanceof HTMLAnchorElement ? el.href : el.getAttribute('href') ?? undefined;
      const action = el instanceof HTMLFormElement ? el.action : el.getAttribute('action') ?? undefined;
      const name = clean(
        el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        el.getAttribute('alt') ??
        (el instanceof HTMLInputElement ? el.placeholder : undefined) ??
        el.textContent,
      );
      const eventAttributeHints = ['onclick', 'onchange', 'oninput', 'onsubmit', 'onkeydown', 'onkeyup']
        .filter((attr) => el.hasAttribute(attr));
      const hints = new Set<string>();
      if (tag === 'button' || role === 'button') hints.add('button');
      if (role === 'tab' || el.getAttribute('aria-selected') != null) hints.add('tab');
      if (tag === 'summary' || tag === 'details' || el.getAttribute('aria-expanded') != null) hints.add('expandable_or_accordion');
      if (tag === 'select' || role === 'combobox' || role === 'listbox') hints.add('dropdown_or_listbox');
      if (el.getAttribute('aria-haspopup') === 'dialog') hints.add('possible_modal_trigger');
      if (el.getAttribute('aria-haspopup') === 'menu') hints.add('menu_trigger');
      if (tag === 'form' || type === 'submit' || el.getAttribute('onsubmit') != null) hints.add('form_control');
      if (/load\s*more|show\s*more|more\s*games|ver\s*mais|mostrar\s*mais|mehr\s*anzeigen/i.test(name ?? '')) hints.add('load_more_candidate');
      if (/next|previous|prev|próxim|anterior|weiter|zurück/i.test(name ?? '')) hints.add('pagination_candidate');
      if (tag === 'a' && href) hints.add('navigation_link');
      const cursorPointer = getComputedStyle(el).cursor === 'pointer';
      if (cursorPointer && hints.size === 0) hints.add('custom_pointer_control');

      return {
        frameUrl: location.href,
        domPath: domPath(el),
        tag,
        role,
        type,
        name,
        href,
        action,
        visible: isVisible(el),
        disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
        tabindex: html.tabIndex >= 0 ? html.tabIndex : undefined,
        ariaExpanded: el.getAttribute('aria-expanded') ?? undefined,
        ariaControls: el.getAttribute('aria-controls') ?? undefined,
        ariaHaspopup: el.getAttribute('aria-haspopup') ?? undefined,
        ariaModal: el.getAttribute('aria-modal') ?? undefined,
        contentEditable: html.isContentEditable,
        cursorPointer,
        eventAttributeHints,
        detectorHints: [...hints],
      };
    });

    const overlaySelector = '[role="dialog"], dialog, [aria-modal="true"], [popover]';
    const overlays = Array.from(document.querySelectorAll(overlaySelector))
      .filter(isVisible)
      .slice(0, 500)
      .map((el) => ({
        frameUrl: location.href,
        domPath: domPath(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? undefined,
        name: clean(el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.textContent),
        ariaModal: el.getAttribute('aria-modal') ?? undefined,
        open: el instanceof HTMLDialogElement ? el.open : undefined,
      }));

    const textCandidates = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]'))
      .slice(0, maxElements)
      .map((el) => clean(el.textContent) ?? '');

    const frameworkMarkers: string[] = [];
    if (document.querySelector('#__NEXT_DATA__')) frameworkMarkers.push('next_data');
    if (document.querySelector('[data-reactroot], [data-reactid], #root, #__next')) frameworkMarkers.push('react_like_root');
    if (document.querySelector('[ng-version], app-root')) frameworkMarkers.push('angular');
    if (document.querySelector('[data-v-app], #app')) frameworkMarkers.push('vue_like_root');
    if (document.querySelector('script[type="application/ld+json"]')) frameworkMarkers.push('json_ld');

    return {
      interactive,
      overlays,
      runtime: {
        documentReadyState: document.readyState,
        scriptCount: document.scripts.length,
        moduleScriptCount: document.querySelectorAll('script[type="module"]').length,
        lazyImageCount: document.querySelectorAll('img[loading="lazy"], img[data-src], img[data-lazy-src]').length,
        lazySourceCount: document.querySelectorAll('source[data-src], source[data-srcset]').length,
        loadingIndicatorCandidates: document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, .loading, .skeleton').length,
        paginationCandidates: textCandidates.filter((t) => /next|previous|prev|próxim|anterior|weiter|zurück/i.test(t)).length,
        loadMoreCandidates: textCandidates.filter((t) => /load\s*more|show\s*more|more\s*games|ver\s*mais|mostrar\s*mais|mehr\s*anzeigen/i.test(t)).length,
        frameworkMarkers,
      },
    };
  }, { maxElements: MAX_ELEMENTS_PER_FRAME, maxNameLength: MAX_NAME_LENGTH });
}

export async function collectPassiveInteractivity(page: Page): Promise<{
  interactiveElements: InteractiveElementTrace[];
  visibleOverlays: VisibleOverlayTrace[];
  frames: FrameTrace[];
  runtimeSignals: RuntimeSignals;
  notes: string[];
}> {
  const interactiveElements: InteractiveElementTrace[] = [];
  const visibleOverlays: VisibleOverlayTrace[] = [];
  const notes: string[] = [];
  const frameworkMarkers = new Set<string>();
  let scriptCount = 0;
  let moduleScriptCount = 0;
  let lazyImageCount = 0;
  let lazySourceCount = 0;
  let loadingIndicatorCandidates = 0;
  let paginationCandidates = 0;
  let loadMoreCandidates = 0;
  let documentReadyState: string | undefined;

  for (const frame of page.frames()) {
    try {
      const result = await collectFrameElements(frame);
      interactiveElements.push(...result.interactive);
      visibleOverlays.push(...result.overlays);
      scriptCount += result.runtime.scriptCount;
      moduleScriptCount += result.runtime.moduleScriptCount;
      lazyImageCount += result.runtime.lazyImageCount;
      lazySourceCount += result.runtime.lazySourceCount;
      loadingIndicatorCandidates += result.runtime.loadingIndicatorCandidates;
      paginationCandidates += result.runtime.paginationCandidates;
      loadMoreCandidates += result.runtime.loadMoreCandidates;
      for (const marker of result.runtime.frameworkMarkers) frameworkMarkers.add(marker);
      if (frame === page.mainFrame()) documentReadyState = result.runtime.documentReadyState;
    } catch (error) {
      notes.push(`Frame scan failed for ${frame.url()}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const frames: FrameTrace[] = page.frames().map((frame) => ({
    url: frame.url(),
    name: frame.name() || undefined,
    parentUrl: frame.parentFrame()?.url(),
    isMainFrame: frame === page.mainFrame(),
  }));

  return {
    interactiveElements,
    visibleOverlays,
    frames,
    runtimeSignals: {
      documentReadyState,
      scriptCount,
      moduleScriptCount,
      iframeCount: Math.max(0, frames.length - 1),
      lazyImageCount,
      lazySourceCount,
      loadingIndicatorCandidates,
      paginationCandidates,
      loadMoreCandidates,
      frameworkMarkers: [...frameworkMarkers].sort(),
    },
    notes,
  };
}
