/**
 * What FLUJO does with a file dropped, pasted or picked into a chat (#1224).
 *
 * Classification looks at the file name first: browsers report an empty type
 * for many text files and Windows reports `.ts` code as an MPEG video stream.
 */
export type AttachmentFamily =
  /** Read as UTF-8 text and sent as it is. */
  | 'text'
  /** PNG, JPEG, GIF or WebP: every image-capable model reads these directly. */
  | 'image'
  /** HEIC, AVIF, TIFF, BMP or SVG: turned into PNG before sending. */
  | 'image-convert'
  /** Sent as a PDF to models that read PDFs; the rest get its text, plus page pictures when they see images. */
  | 'pdf'
  /** Word, Excel, PowerPoint and OpenDocument files: text is extracted. */
  | 'document'
  /** ZIP and TAR files: the file list plus the text of readable files inside. */
  | 'archive'
  | 'audio'
  | 'video'
  /** Old Office formats (.doc, .xls, .ppt): text is extracted like from their newer forms. */
  | 'legacy-office'
  /** Anything else: only the name, type and size are sent. */
  | 'binary';

export interface AttachmentClassification {
  family: AttachmentFamily;
  /** A specific MIME type, filled in from the extension when the browser gave none. */
  mimeType: string;
  /** Short format name shown to the user and the model, e.g. "Word document". */
  format: string;
  /** Code fence language for text files, when one is known. */
  language?: string;
}

interface FormatEntry {
  family: AttachmentFamily;
  mimeType: string;
  format: string;
  language?: string;
}

const text = (mimeType: string, format: string, language?: string): FormatEntry =>
  ({ family: 'text', mimeType, format, language });
const code = (language: string, format: string, mimeType = 'text/plain'): FormatEntry =>
  text(mimeType, format, language);

const BY_EXTENSION: Record<string, FormatEntry> = {
  txt: text('text/plain', 'Text'),
  text: text('text/plain', 'Text'),
  log: text('text/plain', 'Log'),
  md: text('text/markdown', 'Markdown', 'markdown'),
  markdown: text('text/markdown', 'Markdown', 'markdown'),
  mdx: text('text/markdown', 'MDX', 'mdx'),
  rst: text('text/x-rst', 'reStructuredText', 'rst'),
  adoc: text('text/plain', 'AsciiDoc', 'asciidoc'),
  tex: code('latex', 'LaTeX'),
  bib: code('bibtex', 'BibTeX'),
  csv: text('text/csv', 'CSV table', 'csv'),
  tsv: text('text/tab-separated-values', 'TSV table', 'tsv'),
  json: text('application/json', 'JSON', 'json'),
  jsonl: text('application/jsonl', 'JSON Lines', 'json'),
  ndjson: text('application/x-ndjson', 'JSON Lines', 'json'),
  geojson: text('application/geo+json', 'GeoJSON', 'json'),
  ipynb: text('application/x-ipynb+json', 'Jupyter notebook', 'json'),
  xml: text('application/xml', 'XML', 'xml'),
  xsd: code('xml', 'XML schema'),
  xsl: code('xml', 'XSL stylesheet'),
  html: text('text/html', 'HTML', 'html'),
  htm: text('text/html', 'HTML', 'html'),
  xhtml: text('application/xhtml+xml', 'XHTML', 'html'),
  css: code('css', 'CSS', 'text/css'),
  scss: code('scss', 'SCSS'),
  sass: code('sass', 'Sass'),
  less: code('less', 'Less'),
  js: code('javascript', 'JavaScript', 'text/javascript'),
  mjs: code('javascript', 'JavaScript', 'text/javascript'),
  cjs: code('javascript', 'JavaScript', 'text/javascript'),
  jsx: code('jsx', 'JavaScript (JSX)'),
  ts: code('typescript', 'TypeScript'),
  mts: code('typescript', 'TypeScript'),
  cts: code('typescript', 'TypeScript'),
  tsx: code('tsx', 'TypeScript (TSX)'),
  vue: code('vue', 'Vue component'),
  svelte: code('svelte', 'Svelte component'),
  astro: code('astro', 'Astro component'),
  py: code('python', 'Python'),
  pyi: code('python', 'Python'),
  rb: code('ruby', 'Ruby'),
  go: code('go', 'Go'),
  rs: code('rust', 'Rust'),
  java: code('java', 'Java'),
  kt: code('kotlin', 'Kotlin'),
  kts: code('kotlin', 'Kotlin'),
  scala: code('scala', 'Scala'),
  swift: code('swift', 'Swift'),
  dart: code('dart', 'Dart'),
  c: code('c', 'C'),
  h: code('c', 'C header'),
  cpp: code('cpp', 'C++'),
  cc: code('cpp', 'C++'),
  cxx: code('cpp', 'C++'),
  hpp: code('cpp', 'C++ header'),
  cs: code('csharp', 'C#'),
  fs: code('fsharp', 'F#'),
  vb: code('vbnet', 'Visual Basic'),
  php: code('php', 'PHP'),
  pl: code('perl', 'Perl'),
  lua: code('lua', 'Lua'),
  r: code('r', 'R'),
  jl: code('julia', 'Julia'),
  m: code('matlab', 'MATLAB'),
  sql: code('sql', 'SQL'),
  sh: code('bash', 'Shell script'),
  bash: code('bash', 'Shell script'),
  zsh: code('bash', 'Shell script'),
  fish: code('fish', 'Shell script'),
  ps1: code('powershell', 'PowerShell'),
  psm1: code('powershell', 'PowerShell'),
  bat: code('bat', 'Batch file'),
  cmd: code('bat', 'Batch file'),
  abap: code('abap', 'ABAP'),
  yaml: code('yaml', 'YAML'),
  yml: code('yaml', 'YAML'),
  toml: code('toml', 'TOML'),
  ini: code('ini', 'INI settings'),
  cfg: code('ini', 'Settings file'),
  conf: code('ini', 'Settings file'),
  properties: code('properties', 'Properties file'),
  env: code('dotenv', 'Environment file'),
  graphql: code('graphql', 'GraphQL'),
  gql: code('graphql', 'GraphQL'),
  proto: code('protobuf', 'Protocol Buffers'),
  gradle: code('groovy', 'Gradle'),
  groovy: code('groovy', 'Groovy'),
  tf: code('hcl', 'Terraform'),
  hcl: code('hcl', 'HCL'),
  diff: code('diff', 'Diff'),
  patch: code('diff', 'Patch'),
  srt: text('application/x-subrip', 'Subtitles'),
  vtt: text('text/vtt', 'Subtitles'),
  ics: text('text/calendar', 'Calendar'),
  vcf: text('text/vcard', 'Contact card'),
  rtf: text('application/rtf', 'Rich text'),
  eml: text('message/rfc822', 'Email'),
  csproj: code('xml', 'Project file'),
  sln: code('text', 'Solution file'),
  lock: code('text', 'Lock file'),
  gitignore: code('gitignore', 'Ignore list'),
  dockerignore: code('gitignore', 'Ignore list'),

  png: { family: 'image', mimeType: 'image/png', format: 'PNG image' },
  jpg: { family: 'image', mimeType: 'image/jpeg', format: 'JPEG image' },
  jpeg: { family: 'image', mimeType: 'image/jpeg', format: 'JPEG image' },
  jfif: { family: 'image', mimeType: 'image/jpeg', format: 'JPEG image' },
  gif: { family: 'image', mimeType: 'image/gif', format: 'GIF image' },
  webp: { family: 'image', mimeType: 'image/webp', format: 'WebP image' },
  heic: { family: 'image-convert', mimeType: 'image/heic', format: 'HEIC photo' },
  heif: { family: 'image-convert', mimeType: 'image/heif', format: 'HEIF photo' },
  avif: { family: 'image-convert', mimeType: 'image/avif', format: 'AVIF image' },
  tif: { family: 'image-convert', mimeType: 'image/tiff', format: 'TIFF image' },
  tiff: { family: 'image-convert', mimeType: 'image/tiff', format: 'TIFF image' },
  bmp: { family: 'image-convert', mimeType: 'image/bmp', format: 'BMP image' },
  svg: { family: 'image-convert', mimeType: 'image/svg+xml', format: 'SVG drawing' },

  pdf: { family: 'pdf', mimeType: 'application/pdf', format: 'PDF' },

  docx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'Word document' },
  docm: { family: 'document', mimeType: 'application/vnd.ms-word.document.macroEnabled.12', format: 'Word document' },
  dotx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template', format: 'Word template' },
  xlsx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', format: 'Excel workbook' },
  xlsm: { family: 'document', mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12', format: 'Excel workbook' },
  xltx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template', format: 'Excel template' },
  pptx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', format: 'PowerPoint presentation' },
  pptm: { family: 'document', mimeType: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12', format: 'PowerPoint presentation' },
  ppsx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', format: 'PowerPoint slide show' },
  potx: { family: 'document', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.template', format: 'PowerPoint template' },
  odt: { family: 'document', mimeType: 'application/vnd.oasis.opendocument.text', format: 'OpenDocument text' },
  ods: { family: 'document', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', format: 'OpenDocument spreadsheet' },
  odp: { family: 'document', mimeType: 'application/vnd.oasis.opendocument.presentation', format: 'OpenDocument presentation' },

  zip: { family: 'archive', mimeType: 'application/zip', format: 'ZIP archive' },
  tar: { family: 'archive', mimeType: 'application/x-tar', format: 'TAR archive' },
  tgz: { family: 'archive', mimeType: 'application/gzip', format: 'TAR archive' },
  gz: { family: 'archive', mimeType: 'application/gzip', format: 'GZIP file' },

  mp3: { family: 'audio', mimeType: 'audio/mpeg', format: 'MP3 audio' },
  wav: { family: 'audio', mimeType: 'audio/wav', format: 'WAV audio' },
  m4a: { family: 'audio', mimeType: 'audio/mp4', format: 'M4A audio' },
  aac: { family: 'audio', mimeType: 'audio/aac', format: 'AAC audio' },
  ogg: { family: 'audio', mimeType: 'audio/ogg', format: 'Ogg audio' },
  oga: { family: 'audio', mimeType: 'audio/ogg', format: 'Ogg audio' },
  opus: { family: 'audio', mimeType: 'audio/opus', format: 'Opus audio' },
  flac: { family: 'audio', mimeType: 'audio/flac', format: 'FLAC audio' },
  weba: { family: 'audio', mimeType: 'audio/webm', format: 'WebM audio' },
  aiff: { family: 'audio', mimeType: 'audio/aiff', format: 'AIFF audio' },

  mp4: { family: 'video', mimeType: 'video/mp4', format: 'MP4 video' },
  m4v: { family: 'video', mimeType: 'video/mp4', format: 'MP4 video' },
  mov: { family: 'video', mimeType: 'video/quicktime', format: 'QuickTime video' },
  webm: { family: 'video', mimeType: 'video/webm', format: 'WebM video' },
  mkv: { family: 'video', mimeType: 'video/x-matroska', format: 'Matroska video' },
  avi: { family: 'video', mimeType: 'video/x-msvideo', format: 'AVI video' },
  mpeg: { family: 'video', mimeType: 'video/mpeg', format: 'MPEG video' },
  mpg: { family: 'video', mimeType: 'video/mpeg', format: 'MPEG video' },
  '3gp': { family: 'video', mimeType: 'video/3gpp', format: '3GP video' },

  doc: { family: 'legacy-office', mimeType: 'application/msword', format: 'Word 97-2003 document' },
  xls: { family: 'legacy-office', mimeType: 'application/vnd.ms-excel', format: 'Excel 97-2003 workbook' },
  ppt: { family: 'legacy-office', mimeType: 'application/vnd.ms-powerpoint', format: 'PowerPoint 97-2003 presentation' },
};

/** Files that are text although they usually have no extension. */
const TEXT_FILE_NAMES: Record<string, FormatEntry> = {
  dockerfile: code('dockerfile', 'Dockerfile'),
  makefile: code('makefile', 'Makefile'),
  readme: text('text/plain', 'Text'),
  license: text('text/plain', 'Text'),
  changelog: text('text/plain', 'Text'),
  procfile: code('text', 'Procfile'),
};

const TEXT_MIME = /^(text\/|application\/(json|ld\+json|xml|javascript|ecmascript|x-sh|x-yaml|yaml|toml|sql|graphql|x-httpd-php|x-python|rtf)\b)|\+(json|xml)$/i;

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.endsWith('.tar.gz')) return 'tgz';
  const dot = base.lastIndexOf('.');
  if (dot === 0) return base.slice(1);
  return dot > 0 ? base.slice(dot + 1) : '';
}

function bareName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(md|txt)$/, '');
}

function fromEntry(entry: FormatEntry, browserMime: string): AttachmentClassification {
  // A WebM file may hold only sound; the browser's type knows which.
  const mimeType = entry.family === 'video' && browserMime.startsWith('audio/') ? browserMime : entry.mimeType;
  const family: AttachmentFamily = entry.family === 'video' && browserMime.startsWith('audio/') ? 'audio' : entry.family;
  return {
    family,
    mimeType,
    format: family === 'audio' && entry.family === 'video' ? 'Audio' : entry.format,
    ...(entry.language ? { language: entry.language } : {}),
  };
}

export function classifyAttachment(name: string, browserMime?: string): AttachmentClassification {
  const mime = (browserMime ?? '').split(';')[0].trim().toLowerCase();
  const entry = BY_EXTENSION[extensionOf(name)] ?? TEXT_FILE_NAMES[bareName(name)];
  if (entry) return fromEntry(entry, mime);
  if (mime === 'application/pdf') return { family: 'pdf', mimeType: mime, format: 'PDF' };
  if (/^image\/(png|jpeg|gif|webp)$/.test(mime)) return { family: 'image', mimeType: mime, format: 'Image' };
  if (mime.startsWith('image/')) return { family: 'image-convert', mimeType: mime, format: 'Image' };
  if (mime.startsWith('audio/')) return { family: 'audio', mimeType: mime, format: 'Audio' };
  if (mime.startsWith('video/')) return { family: 'video', mimeType: mime, format: 'Video' };
  if (TEXT_MIME.test(mime)) return { family: 'text', mimeType: mime, format: 'Text' };
  return { family: 'binary', mimeType: mime || 'application/octet-stream', format: 'File' };
}

/** True when a decoded file looks like text rather than binary bytes. */
export function looksLikeText(sample: Uint8Array): boolean {
  if (sample.length === 0) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.02;
}

/** Image types every image-capable provider reads without conversion. */
export function isProviderImageMime(mimeType: string | undefined): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType ?? '');
}

/** A Markdown code fence that cannot be closed early by the content inside it. */
export function fenceFor(content: string): string {
  let longest = 2;
  for (const match of content.matchAll(/`{3,}/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(longest + 1);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
