/** Deterministic capability vocabulary. No model, installation or network IO. */
const IGNORED = new Set(('i a an to me my we our you your can could would please give get add use using do does make help able ability capable capability connect with from into want need server servers mcp that this the and or for of on in read write access manage useful find looking work working edit editing turn convert summarize daily free paid keyless local remote high trust trusted cheap cheapest best good reliable open create generate list show retrieve execute run install').split(' '));

const CAPABILITIES: ReadonlyArray<{ words: readonly string[]; terms: readonly string[] }> = [
  { words: ['web', 'internet', 'website', 'websites'], terms: ['search', 'web', 'browser', 'brave', 'tavily', 'exa'] },
  { words: ['browse', 'browser', 'browsing', 'automation', 'automate'], terms: ['browser', 'playwright', 'puppeteer'] },
  { words: ['file', 'files', 'folder', 'folders', 'directory', 'directories', 'filesystem'], terms: ['filesystem', 'files', 'file'] },
  { words: ['database', 'databases', 'sql'], terms: ['database', 'sql', 'postgres', 'mysql', 'sqlite'] },
  { words: ['voice', 'speech', 'speak', 'speaking', 'tts'], terms: ['tts', 'speech', 'voice', 'audio'] },
  { words: ['transcribe', 'transcription', 'transcript', 'transcripts'], terms: ['transcription', 'transcribe', 'whisper', 'speech'] },
  { words: ['calendar', 'calendars', 'schedule', 'scheduling', 'appointment', 'appointments'], terms: ['calendar', 'schedule'] },
  { words: ['email', 'emails', 'mail', 'inbox'], terms: ['gmail', 'email', 'mail', 'outlook'] },
  { words: ['image', 'images', 'picture', 'pictures', 'vision', 'recognize', 'recognition'], terms: ['image', 'vision', 'recognition'] },
  { words: ['document', 'documents', 'knowledge', 'notes'], terms: ['notion', 'knowledge', 'document', 'pdf'] },
  { words: ['message', 'messages', 'messaging', 'chat'], terms: ['slack', 'discord', 'telegram', 'chat'] },
  { words: ['payment', 'payments', 'pay', 'billing'], terms: ['paypal', 'stripe', 'payment'] },
  { words: ['crawl', 'crawling', 'scrape', 'scraping', 'scraper'], terms: ['crawl', 'scrape', 'firecrawl'] },
  { words: ['spreadsheet', 'spreadsheets', 'excel', 'xlsx'], terms: ['excel', 'spreadsheet', 'sheets'] },
  { words: ['word', 'docx'], terms: ['office-word', 'word', 'document'] },
  { words: ['presentation', 'presentations', 'slides', 'powerpoint', 'pptx'], terms: ['powerpoint', 'presentation', 'slides'] },
  { words: ['terminal', 'bash', 'shell', 'command', 'commands'], terms: ['bash', 'shell', 'terminal'] },
  { words: ['coding', 'code', 'development', 'developer', 'repository', 'repositories', 'git'], terms: ['github', 'git', 'vscode'] },
];

export function normalizeDiscoveryQuery(query: string): string {
  return query.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Equivalent space/dash queries share acquisition and pagination snapshots. */
export function canonicalDiscoveryQuery(query: string): string {
  const normalized = normalizeDiscoveryQuery(query);
  return normalized.includes('/') ? normalized : normalized.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

/** Whether deterministic vocabulary covers the entire requested capability/brand. */
export function hasKnownDiscoveryIntent(query: string): boolean {
  const normalized = normalizeDiscoveryQuery(query);
  const isKnown = (token: string) => CAPABILITIES.some(group => group.words.includes(token) || group.terms.includes(token));
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(normalized) || isKnown(normalized)) return true;
  // A familiar word in a larger task does not explain the whole request.
  // Use the same meaningful groups as relevance, including text-to-speech,
  // so the assistant can interpret tasks without overriding known identities.
  const groups = intent(normalized);
  return groups.length > 0 && groups.every(group => isKnown(group[0]));
}

function words(value: string): string[] {
  return normalizeDiscoveryQuery(value).match(/[a-z0-9]+/g) ?? [];
}

function intent(query: string): string[][] {
  const tokens = [...new Set(words(query).filter(word => word.length >= 2 && !IGNORED.has(word)))];
  // "text to speech" describes one speech capability; text alone must not
  // become a second requirement that excludes a TTS publisher's short title.
  const speech = tokens.some(token => ['speech', 'tts', 'speak', 'voice'].includes(token));
  return tokens.filter(token => !(speech && token === 'text')).map(token => {
    const capability = CAPABILITIES.find(group => group.words.includes(token));
    // "web" acquisition uses the Registry's broad search token, but metadata
    // must also say web/internet/browser or identify a web-search service.
    const aliases = capability?.terms.filter(term => !(capability.words.includes('web') && term === 'search')) ?? [];
    return [...new Set([token, ...(capability?.words ?? []), ...aliases])];
  });
}

/** At most six name-substring queries; never issue an unfiltered fallback. */
export function discoverySearchTerms(query: string): string[] {
  const normalized = normalizeDiscoveryQuery(query).slice(0, 256);
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/.test(normalized)) return [normalized];
  const groups = intent(normalized);
  if (!groups.length) return [];
  const tokens = words(normalized).filter(token => token.length >= 2 && !IGNORED.has(token));
  const phrase = tokens.filter(token => !(token === 'text' && groups.some(group => group.includes('speech')))).join('-');
  const aliases = tokens.flatMap(token => CAPABILITIES.find(group => group.words.includes(token))?.terms ?? []);
  return [...new Set([...(tokens.length > 1 ? [phrase] : []), ...tokens, ...aliases])]
    .filter(term => term.length >= 2).map(term => term.slice(0, 80)).slice(0, 6);
}

/** All meaningful intent groups must match metadata; substring accidents do not. */
export function discoveryRelevance(query: string, server: { name: string; title?: string; description?: string }): number {
  const normalized = normalizeDiscoveryQuery(query);
  const name = normalizeDiscoveryQuery(server.name);
  if (name === normalized) return 100;
  const groups = intent(normalized);
  if (!groups.length) return 0;
  const nameWords = new Set(words(server.name));
  const titleWords = new Set(words(server.title ?? ''));
  const descriptionWords = new Set(words((server.description ?? '').slice(0, 4096)));
  let score = 0;
  for (const group of groups) {
    const matches = (set: Set<string>) => group.some(alias => words(alias).every(word => set.has(word)));
    if (matches(nameWords)) score += 4;
    else if (matches(titleWords)) score += 3;
    else if (matches(descriptionWords)) score += 1;
    else return 0;
  }
  const compact = words(normalized).filter(word => !IGNORED.has(word)).join('-');
  return score + (name.endsWith('/' + compact) ? 20 : 0);
}
