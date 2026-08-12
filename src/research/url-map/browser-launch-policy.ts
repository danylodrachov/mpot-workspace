export interface BrowserLaunchModeOptions {
  headlessRequested: boolean;
  headedRequested: boolean;
  manualBootstrap: boolean;
}

/**
 * Discovery runs use a visible Chromium window by default.
 *
 * Headless mode is opt-in because some target sites return materially different
 * access-control responses to headless browsers. Manual bootstrap always requires
 * a visible browser because the operator may need to complete login or anti-bot
 * checks before discovery starts.
 */
export function resolveBrowserLaunchHeadless(options: BrowserLaunchModeOptions): boolean {
  if (options.headlessRequested && options.headedRequested) {
    throw new Error('--headless and --headed cannot be used together');
  }

  if (options.manualBootstrap && options.headlessRequested) {
    throw new Error('--manual-bootstrap requires a headed browser; remove --headless');
  }

  return options.headlessRequested;
}
