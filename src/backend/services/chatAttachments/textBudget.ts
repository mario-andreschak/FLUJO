import { setImmediate as nextTurn } from 'node:timers/promises';

/** Give other requests a turn on the event loop between chunks of parsing. */
export function yieldToEventLoop(): Promise<void> {
  return nextTurn();
}

/** Collects extracted text up to a character limit and remembers whether it stopped early. */
export class TextBudget {
  private readonly parts: string[] = [];
  private length = 0;
  full = false;

  constructor(readonly maxCharacters: number) {}

  /** Returns false once the limit is reached, so callers can stop reading. */
  push(text: string): boolean {
    if (this.full) return false;
    const room = this.maxCharacters - this.length;
    if (text.length > room) {
      this.parts.push(text.slice(0, Math.max(0, room)));
      this.length = this.maxCharacters;
      this.full = true;
      return false;
    }
    this.parts.push(text);
    this.length += text.length;
    return true;
  }

  get used(): number {
    return this.length;
  }

  toString(): string {
    return this.parts.join('').replace(/\n{3,}/g, '\n\n').trim();
  }
}

export type XmlToken =
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; text: string };

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:(lt|gt|amp|quot|apos)|#(\d+)|#x([0-9a-f]+));/gi;
const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(ENTITY, (match, named: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (named) return NAMED[named.toLowerCase()] ?? match;
    const codePoint = decimal ? Number(decimal) : parseInt(hex ?? '', 16);
    return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
  });
}

/** `w:t` and `t` both become `t`: prefixes are conventions, not guarantees. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!source) return attrs;
  for (const match of source.matchAll(ATTRIBUTE)) {
    attrs[localName(match[1])] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attrs;
}

/**
 * Walk the machine-written XML inside Office and OpenDocument files. Element
 * and attribute names arrive without their namespace prefix. The visitor
 * returns `false` to stop early. A cut-off tail (from a size cap) is ignored.
 */
export async function walkXml(
  xml: string,
  visit: (token: XmlToken) => boolean | void,
  tokensPerTurn = 20_000,
): Promise<void> {
  const tokens = new RegExp(TOKEN.source, 'g');
  let count = 0;
  for (let match = tokens.exec(xml); match; match = tokens.exec(xml)) {
    let token: XmlToken | undefined;
    if (match[1] !== undefined) token = { kind: 'text', text: match[1] };
    else if (match[2] !== undefined) token = { kind: 'close', name: localName(match[2]) };
    else if (match[3] !== undefined) {
      token = { kind: 'open', name: localName(match[3]), attrs: parseAttributes(match[4] ?? ''), selfClosing: match[5] === '/' };
    } else if (match[6] !== undefined) token = { kind: 'text', text: decodeXmlEntities(match[6]) };
    if (token) {
      if (visit(token) === false) return;
      if (token.kind === 'open' && token.selfClosing && visit({ kind: 'close', name: token.name }) === false) return;
    }
    if (++count % tokensPerTurn === 0) await yieldToEventLoop();
  }
}
