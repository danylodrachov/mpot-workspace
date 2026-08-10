import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface AttachedSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdPage: boolean;
  close(): Promise<void>;
}

export async function attachToLoggedInChrome(cdpUrl: string, targetOrigin: string): Promise<AttachedSession> {
  const browser = await chromium.connectOverCDP(cdpUrl);
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('CDP browser has no BrowserContext. Start Chrome with the supplied dedicated profile launcher.');
  }
  const context = contexts[0]!;
  const targetHost = new URL(targetOrigin).hostname.toLowerCase().replace(/^www\./, '');
  const matchingPage = context.pages().find((candidate) => {
    try {
      const host = new URL(candidate.url()).hostname.toLowerCase().replace(/^www\./, '');
      return host === targetHost || host.endsWith(`.${targetHost}`);
    } catch {
      return false;
    }
  });
  if (!matchingPage) {
    throw new Error(`No already-open page from ${targetHost} exists in the attached Chrome. Log in manually in the dedicated Chrome profile before running discovery.`);
  }
  const page = matchingPage;

  return {
    browser,
    context,
    page,
    createdPage: false,
    async close() {
      // Do not close the page or browser: this is the user's attached authenticated Chrome session.
    },
  };
}
