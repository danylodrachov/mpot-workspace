import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import type { InteractionExecutionRecord } from './types.ts';

// CD-N05: deterministic, structural-only HTML -> text corpus builder. This module never
// interprets casino facts, never normalizes values, and never populates template fields — it
// only removes noise (scripts, styles, images, tracking markup, duplicated global chrome, hidden
// boilerplate that was never revealed by a recorded interaction) and serializes what remains
// (headings, lists, tables, labels/values, form/select option text, semantic section text) into a
// compact, text-first markdown document. The actual LLM review/JSON-building step that reads this
// corpus is a later ticket (CD-N06) — this module only has to produce it correctly.

const MEDIA_SELECTOR = ['img', 'picture', 'svg', 'video', 'audio', 'canvas', 'source', 'track'].join(', ');

// Non-media noise: removed up front, before media-label preservation, so tracking/consent/
// script/link/meta/iframe markup never contributes accessible-label text either.
const NOISE_SELECTOR = ['script', 'style', 'noscript', 'template', 'link', 'meta', 'iframe'].join(', ');

// Global, duplicated-on-every-page chrome. Category/sub-category rails and in-page content
// navigation deliberately do NOT match this — only the semantic "this is sitewide chrome" tags/
// role, per CD-N05's "duplicated global header/navigation/footer/sidebars" instruction.
const GLOBAL_CHROME_SELECTOR = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';

// Generic keyword patterns only — never a casino hostname or a specific framework's component
// name, consistent with the rest of this codebase's detector conventions.
const TRACKING_PATTERN =
  /\b(gtm|ga4?|gtag|analytics|pixel|hotjar|segment|doubleclick|adsystem|criteo|clarity|matomo|mixpanel|amplitude|onetrust)\b/i;
const COOKIE_CONSENT_PATTERN = /\b(cookie|consent|gdpr|ccpa)\b/i;

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
// Tags whose text content is rendered as its own block (paragraph-separated) rather than merged
// inline with surrounding text.
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'aside',
  'blockquote',
  'pre',
  'dt',
  'dd',
  'dl',
  'form',
  'fieldset',
  'figure',
  'figcaption',
  'summary',
  'details',
  'label',
  'caption',
  'address',
]);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function attrIdentity($el: cheerio.Cheerio<Element>): string {
  const id = $el.attr('id') ?? '';
  const cls = $el.attr('class') ?? '';
  return `${id} ${cls}`.toLowerCase();
}

function isInlineStyleHidden(style: string | undefined): boolean {
  if (!style) return false;
  const normalized = style.toLowerCase();
  return /display\s*:\s*none/.test(normalized) || /visibility\s*:\s*hidden/.test(normalized);
}

// Whether `$el` (or an ancestor of it) matches one of the selectors an interaction actually
// revealed this run — the only reason a hidden/non-rendered element is ever kept.
function isWithinRevealedContainer($: cheerio.CheerioAPI, el: Element, revealedSelectors: string[]): boolean {
  if (revealedSelectors.length === 0) return false;
  const $el = $(el);
  for (const selector of revealedSelectors) {
    try {
      if ($el.is(selector) || $el.closest(selector).length > 0) return true;
    } catch {
      // Unparsable/unsupported selector (e.g. an unusual domPath fallback) — never matches.
    }
  }
  return false;
}

// CF-01: image nodes carry accessible meaning through their attributes, not their pixels. Before
// a media node is dropped, replace it with a plain text node holding its accessible label — first
// non-empty of aria-label, alt, title (in that priority order), whitespace-normalized. This never
// interprets the label text, and it never retains src/srcset/any image URL or binary data. A
// decorative image (empty/missing alt, no aria-label/title) contributes no text, matching the
// visible-content-only semantics the rest of this module already applies to other markup.
function mediaAccessibleLabel($el: cheerio.Cheerio<Element>): string {
  const ariaLabel = collapseWhitespace($el.attr('aria-label') ?? '');
  if (ariaLabel) return ariaLabel;
  const alt = collapseWhitespace($el.attr('alt') ?? '');
  if (alt) return alt;
  const title = collapseWhitespace($el.attr('title') ?? '');
  if (title) return title;
  return '';
}

// Replaces every remaining (i.e. not-already-pruned-as-chrome/hidden) media node with a text node
// carrying its accessible label, when it has one. Must run after chrome/tracking/consent/hidden
// removal (so a header/footer logo or a hidden image never contributes text) and before media
// nodes are removed outright.
function preserveMediaLabels($: cheerio.CheerioAPI): void {
  $(MEDIA_SELECTOR).each((_, node) => {
    if (node.type !== 'tag') return;
    const $el = $(node);
    const label = mediaAccessibleLabel($el);
    if (label) $el.replaceWith($('<span></span>').text(label));
  });
}

// CD-N05 structural cleanup pass, mutating `$` in place. Removes: script/style/noscript;
// images/picture/svg/video/audio/canvas; iframes (frame *content* capture is out of scope for
// this run — see module comment); tracking/analytics markup; duplicated global header/nav/
// footer/sidebar chrome; cookie/consent-management chrome; and hidden/non-rendered boilerplate
// that was not made visible through a recorded interaction (`revealedSelectors`).
function cleanDom($: cheerio.CheerioAPI, revealedSelectors: string[]): void {
  $(NOISE_SELECTOR).remove();
  $(GLOBAL_CHROME_SELECTOR).remove();

  $('*').each((_, node) => {
    if (node.type !== 'tag') return;
    const $el = $(node);
    if ($el.closest(NOISE_SELECTOR).length > 0) return; // already gone with an ancestor
    const identity = attrIdentity($el);
    if (TRACKING_PATTERN.test(identity) || COOKIE_CONSENT_PATTERN.test(identity)) {
      $el.remove();
    }
  });

  $('[hidden], [aria-hidden="true"]').each((_, node) => {
    if (isWithinRevealedContainer($, node, revealedSelectors)) return;
    $(node).remove();
  });

  $('[style]').each((_, node) => {
    if (!isInlineStyleHidden($(node).attr('style'))) return;
    if (isWithinRevealedContainer($, node, revealedSelectors)) return;
    $(node).remove();
  });

  // Media nodes last: chrome/tracking/consent/hidden markup is already gone, so only genuinely
  // visible-content images/svgs/etc remain to have their accessible label preserved before removal.
  preserveMediaLabels($);
  $(MEDIA_SELECTOR).remove();
}

function renderTable($: cheerio.CheerioAPI, $table: cheerio.Cheerio<Element>): string {
  const rows: string[][] = [];
  let hasHeaderRow = false;
  $table.find('tr').each((_, tr) => {
    const cells: string[] = [];
    let sawHeaderCell = false;
    $(tr)
      .find('> th, > td')
      .each((_, cell) => {
        if (cell.tagName?.toLowerCase() === 'th') sawHeaderCell = true;
        cells.push(collapseWhitespace($(cell).text()));
      });
    if (cells.length === 0) return;
    if (rows.length === 0 && sawHeaderCell) hasHeaderRow = true;
    rows.push(cells);
  });
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]): string[] => {
    const out = row.slice();
    while (out.length < width) out.push('');
    return out;
  };

  const lines: string[] = [];
  const header = pad(rows[0]!);
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  if (!hasHeaderRow) {
    // No <th> anywhere: still render the first row as the header separator for a readable
    // markdown table (row/column relationships are preserved either way), never invented text.
  }
  return lines.join('\n');
}

function renderSelect($: cheerio.CheerioAPI, $select: cheerio.Cheerio<Element>): string {
  const label = $select.attr('name') || $select.attr('id') || $select.attr('aria-label') || 'select';
  const options: string[] = [];
  $select.find('option').each((_, option) => {
    const text = collapseWhitespace($(option).text());
    if (text) options.push(text);
  });
  return options.length > 0 ? `Options (${label}): ${options.join(', ')}` : '';
}

// Depth-first structural serializer. Block-level tags flush the current inline text buffer into
// its own paragraph; inline tags (a, span, strong, em, etc.) merge into the surrounding text. This
// is a pure structural/text transform — it never interprets or normalizes the extracted text.
function renderNodes($: cheerio.CheerioAPI, nodes: AnyNode[]): string[] {
  const blocks: string[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const text = collapseWhitespace(buffer.join(' '));
    if (text) blocks.push(text);
    buffer = [];
  };

  const walk = (node: AnyNode): void => {
    if (node.type === 'text') {
      const text = collapseWhitespace((node as unknown as { data: string }).data ?? '');
      if (text) buffer.push(text);
      return;
    }
    if (node.type !== 'tag') return;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    if (!tag) return;
    const $el = $(el);

    if (tag === 'br') {
      buffer.push('\n');
      return;
    }
    if (tag === 'table') {
      flush();
      const rendered = renderTable($, $el);
      if (rendered) blocks.push(rendered);
      return;
    }
    if (HEADING_TAGS.has(tag)) {
      flush();
      const level = Number(tag[1]);
      const text = collapseWhitespace($el.text());
      if (text) blocks.push(`${'#'.repeat(level)} ${text}`);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      $el.children('li').each((_, li) => {
        const text = collapseWhitespace($(li).text());
        if (text) blocks.push(`- ${text}`);
      });
      return;
    }
    if (tag === 'select') {
      flush();
      const rendered = renderSelect($, $el);
      if (rendered) blocks.push(rendered);
      return;
    }

    if (BLOCK_TAGS.has(tag) || tag === 'tr' || tag === 'td' || tag === 'th' || tag === 'body' || tag === 'html') {
      flush();
      for (const child of el.children ?? []) walk(child);
      flush();
      return;
    }

    // Inline tag (a, span, strong, em, b, i, small, code, etc.): recurse without flushing so the
    // text merges into the surrounding paragraph.
    for (const child of el.children ?? []) walk(child);
  };

  for (const node of nodes) walk(node);
  flush();
  return blocks;
}

export interface PageCorpusInput {
  requestedUrl: string;
  finalUrl: string;
  title?: string;
  html: string;
  interactionExecutions?: InteractionExecutionRecord[];
}

// One markdown corpus file per page. Structure: page metadata, baseline visible evidence, then
// interaction-revealed evidence grouped by interaction ID (only interactions whose outcome was
// actually 'revealed_evidence' — CD-N04's own delta-based gate — ever produce a group here; a bare
// trace candidate or a no-op interaction never does).
export function buildPageCorpus(input: PageCorpusInput): string {
  const revealed = (input.interactionExecutions ?? []).filter(
    (execution) => execution.outcome === 'revealed_evidence',
  );

  // Baseline hidden/non-rendered boilerplate is always pruned regardless of any interaction's
  // revealed selector — the baseline capture is taken *before* any interaction ran (see
  // page-capture.ts), so anything hidden there was never actually visible in that state. Content
  // an interaction revealed is preserved separately below, grouped under its own interaction ID.
  const baseline$ = cheerio.load(input.html);
  cleanDom(baseline$, []);
  const baselineBlocks = renderNodes(baseline$, baseline$('body').length > 0 ? baseline$('body').toArray() : baseline$.root().toArray());

  const interactionSections: string[] = [];
  revealed.forEach((execution, index) => {
    const interactionId = `int-${index + 1}`;
    let revealedBlocks: string[] = [];
    if (execution.afterHtml) {
      const after$ = cheerio.load(execution.afterHtml);
      cleanDom(after$, []);
      const selector = execution.revealedContainerSelector || execution.domPath;
      let $container: cheerio.Cheerio<Element> | undefined;
      try {
        const found = after$(selector);
        if (found.length > 0) $container = found as unknown as cheerio.Cheerio<Element>;
      } catch {
        $container = undefined;
      }
      if ($container && $container.length > 0) {
        revealedBlocks = renderNodes(after$, $container.toArray());
      }
    }
    const header = `### Interaction ${interactionId} (${execution.actionClass} — ${execution.outcome})`;
    const locatorLine = `Locator: ${execution.domPath}${execution.name ? ` ("${execution.name}")` : ''}`;
    const body = revealedBlocks.length > 0 ? revealedBlocks.join('\n\n') : '_No additional text content captured for this interaction._';
    interactionSections.push(`${header}\n${locatorLine}\n\n${body}`);
  });

  const lines: string[] = [];
  lines.push(`# ${input.title && input.title.trim() ? input.title.trim() : '(untitled page)'}`);
  lines.push(`Requested URL: ${input.requestedUrl}`);
  lines.push(`Final URL: ${input.finalUrl}`);
  lines.push('');
  lines.push('## Baseline Evidence');
  lines.push('');
  lines.push(baselineBlocks.length > 0 ? baselineBlocks.join('\n\n') : '_No baseline text content detected._');

  if (interactionSections.length > 0) {
    lines.push('');
    lines.push('## Interaction-Revealed Evidence');
    lines.push('');
    lines.push(interactionSections.join('\n\n'));
  }

  return `${lines.join('\n')}\n`;
}
