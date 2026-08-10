import type { Page } from 'playwright';
import { collectPassiveInteractivity } from './passive-interactivity.ts';
import type { AutomaticDialogTrace, PagePassiveTrace, VisitedPageRecord } from './types.ts';
import { sha256, stablePageBasename, writeJsonAtomic, writeTextAtomic } from './io.ts';
import path from 'node:path';
import type { PassiveNetworkObserver } from './url-discovery.ts';

export interface PageCaptureOptions {
  page: Page;
  requestedUrl: string;
  pageIndex: number;
  pagesDir: string;
  settleMs: number;
  navigationTimeoutMs: number;
  discoveredBy: VisitedPageRecord['discoveredBy'];
  networkObserver: PassiveNetworkObserver;
}

export async function capturePage(options: PageCaptureOptions): Promise<VisitedPageRecord> {
  const started = new Date();
  const dialogs: AutomaticDialogTrace[] = [];
  const onDialog = async (dialog: import('playwright').Dialog) => {
    dialogs.push({
      type: dialog.type(),
      message: dialog.message().slice(0, 500),
      defaultValue: dialog.defaultValue()?.slice(0, 500) || undefined,
      autoDismissedForCrawl: true,
    });
    try {
      await dialog.dismiss();
    } catch {
      // Dialog may already be gone; trace still records that it occurred.
    }
  };

  options.page.on('dialog', onDialog);
  try {
    const response = await options.page.goto(options.requestedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: options.navigationTimeoutMs,
    });
    await options.page.waitForTimeout(options.settleMs);
    await options.networkObserver.flush();

    const finalUrl = options.page.url();
    const title = await options.page.title().catch(() => undefined);
    const html = await options.page.content();
    const passive = await collectPassiveInteractivity(options.page);
    const basename = stablePageBasename(options.pageIndex, finalUrl || options.requestedUrl);
    const htmlPath = path.join(options.pagesDir, `${basename}.html`);
    const tracePath = path.join(options.pagesDir, `${basename}.trace.json`);
    const trace: PagePassiveTrace = {
      schemaVersion: '1.0',
      requestedUrl: options.requestedUrl,
      finalUrl,
      capturedAt: new Date().toISOString(),
      title,
      interactiveElements: passive.interactiveElements,
      visibleOverlays: passive.visibleOverlays,
      frames: passive.frames,
      automaticDialogs: dialogs,
      network: { ...options.networkObserver.counters },
      runtimeSignals: passive.runtimeSignals,
      notes: [
        'Passive-only profile: no element click, hover, keyboard activation, form fill, selection, pagination, load-more, or controlled scroll was executed.',
        ...passive.notes,
      ],
    };

    await writeTextAtomic(htmlPath, html);
    await writeJsonAtomic(tracePath, trace);

    const completed = new Date();
    return {
      requestedUrl: options.requestedUrl,
      finalUrl,
      status: 'visited',
      httpStatus: response?.status(),
      title,
      htmlPath,
      tracePath,
      htmlSha256: sha256(html),
      discoveredBy: options.discoveredBy,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
    };
  } catch (error) {
    const completed = new Date();
    return {
      requestedUrl: options.requestedUrl,
      finalUrl: options.page.url() || undefined,
      status: 'failed',
      discoveredBy: options.discoveredBy,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: completed.getTime() - started.getTime(),
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    options.page.off('dialog', onDialog);
  }
}
