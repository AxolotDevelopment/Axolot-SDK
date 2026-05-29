import * as crypto from 'node:crypto';

export interface Token {
  type: 'tag' | 'text' | 'ignored';
  content: string;
}

/**
 * Tokenizes an HTML string into tags, text nodes, and ignored tags (scripts, styles, pre, svg, comments).
 * This ensures translations are only applied to visible text content and does not corrupt markup.
 */
export function tokenizeHtml(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html.startsWith('<!--', i)) {
      // HTML comments
      const end = html.indexOf('-->', i + 4);
      const endIndex = end === -1 ? len : end + 3;
      tokens.push({ type: 'ignored', content: html.slice(i, endIndex) });
      i = endIndex;
    } else if (
      html.startsWith('<script', i) ||
      html.startsWith('<style', i) ||
      html.startsWith('<svg', i) ||
      html.startsWith('<pre', i)
    ) {
      // Tags whose inner content must not be translated
      const tagMatch = html.slice(i).match(/^<(script|style|svg|pre)\b[^>]*>/i);
      if (tagMatch) {
        const tagName = tagMatch[1]!.toLowerCase();
        const startTagEnd = i + tagMatch[0].length;
        const closingTag = `</${tagName}>`;
        const end = html.toLowerCase().indexOf(closingTag, startTagEnd);
        const endIndex = end === -1 ? len : end + closingTag.length;
        
        tokens.push({ type: 'ignored', content: html.slice(i, endIndex) });
        i = endIndex;
      } else {
        const end = html.indexOf('>', i);
        const endIndex = end === -1 ? len : end + 1;
        tokens.push({ type: 'tag', content: html.slice(i, endIndex) });
        i = endIndex;
      }
    } else if (html[i] === '<') {
      // Standard tags
      const end = html.indexOf('>', i);
      const endIndex = end === -1 ? len : end + 1;
      tokens.push({ type: 'tag', content: html.slice(i, endIndex) });
      i = endIndex;
    } else {
      // Text nodes
      const end = html.indexOf('<', i);
      const endIndex = end === -1 ? len : end;
      tokens.push({ type: 'text', content: html.slice(i, endIndex) });
      i = endIndex;
    }
  }
  return tokens;
}

/**
 * Generates an MD5 hash of a trimmed, lowercase, space-stripped text string.
 * This ensures consistency with DB hash mappings.
 */
export function generateHash(text: string): string {
  const cleanText = text.trim().toLowerCase().replace(/\s+/g, '');
  return crypto.createHash('md5').update(cleanText).digest('hex');
}
