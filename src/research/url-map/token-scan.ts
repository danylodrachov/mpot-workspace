/** Extract conservative URL/route-shaped strings from JS, JSON, XML and text payloads. */
export function scanUrlTokens(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const value = raw
      .trim()
      .replace(/^['"`]|['"`]$/g, '')
      .replace(/\\\//g, '/')
      .replace(/&amp;/gi, '&');
    if (!value || value.length > 4096) return;
    if (/^https?:\/\//i.test(value) || /^\/\//.test(value) || /^\/(?!\/)[^\s<>]+/.test(value)) out.add(value);
  };

  for (const match of text.matchAll(/https?:\\?\/\\?\/[^\s"'<>`\\]+/gi)) add(match[0]);
  for (const match of text.matchAll(/(?:"|'|`)(\/(?!\/)[A-Za-z0-9][^"'`<>\s]{0,4095})(?:"|'|`)/g)) add(match[1]);
  for (const match of text.matchAll(/(?:"|'|`)(\/\/[^"'`<>\s]{1,4095})(?:"|'|`)/g)) add(match[1]);

  return [...out];
}
