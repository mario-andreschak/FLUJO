// Rebuilds the tiny chat attachment fixtures: `node __tests__/fixtures/chat-attachments/generate.mjs`.
// Every file is made here from invented text, so nothing copyrighted is committed.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = new Date('2026-01-02T03:04:05Z');
const out = (name, bytes) => writeFile(path.join(here, name), bytes);

async function zip(entries, { mimetype } = {}) {
  const archive = new JSZip();
  if (mimetype) archive.file('mimetype', mimetype, { compression: 'STORE', date: FIXED_DATE });
  for (const [name, content] of Object.entries(entries)) {
    archive.file(name, content, { date: FIXED_DATE, createFolders: false });
  }
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function pdf(pages) {
  const objects = [];
  const add = body => { objects.push(body); return objects.length; };
  const catalog = add('');
  const pageTree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = pages.map(lines => {
    const stream = lines.length
      ? `BT /F1 14 Tf 72 720 Td 18 TL ${lines.map(line => `(${line}) Tj T*`).join(' ')} ET`
      : '0.2 0.4 0.8 rg 72 600 200 100 re f';
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${kids.map(id => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>`
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Garden plan</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Plant tomatoes </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>after</w:t></w:r><w:r><w:t xml:space="preserve"> the last frost &amp; water daily.</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Basil</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Chives</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Bed</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Crop</w:t></w:r></w:p></w:tc></w:tr>'
    + '<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Beans</w:t></w:r><w:r><w:tab/><w:t>tall</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br/><w:t>Line two</w:t></w:r></w:p>'
    + '</w:body></w:document>',
});

const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xlsx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook ${S}><sheets><sheet name="Harvest" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst ${S}><si><t>Crop</t></si><si><t>Kilos</t></si><si><t>Picked</t></si><si><r><t>Toma</t></r><r><t>toes</t></r></si><si><t>Beans, green</t></si></sst>`,
  'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${S}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet ${S}><sheetData>`
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>12.5</v></c><c r="C2" s="1"><v>46023</v></c></row>'
    + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3"><f>B2*2</f><v>25</v></c><c r="D3" t="b"><v>1</v></c></row>'
    + '</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Rain expected Friday</t></is></c></row></sheetData></worksheet>`,
});

const P = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = paragraphs => `<?xml version="1.0" encoding="UTF-8"?><p:sld ${P}><p:cSld><p:spTree>`
  + paragraphs.map(text => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')
  + '</p:spTree></p:cSld></p:sld>';
const pptx = () => zip({
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
  'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId7"/><p:sldId id="257" r:id="rId8"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
  'ppt/slides/slide2.xml': slide(['Welcome to the club', 'Meeting every Tuesday']),
  'ppt/slides/slide1.xml': slide(['Budget', 'Seeds: 40 euros']),
  'ppt/slides/_rels/slide1.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
  'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0" encoding="UTF-8"?><p:notes ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Ask about the compost bin</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
});

const ODF_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"';
const odf = (mimetype, body) => zip({
  'META-INF/manifest.xml': `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mimetype}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
  'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODF_NS} office:version="1.3"><office:body>${body}</office:body></office:document-content>`,
}, { mimetype });

const odt = () => odf('application/vnd.oasis.opendocument.text',
  '<office:text><text:h text:outline-level="1">Club rules</text:h><text:p>Bring your own gloves.<text:line-break/>Share the tools.</text:p>'
  + '<text:list><text:list-item><text:p>Close the gate</text:p></text:list-item></text:list></office:text>');
const ods = () => odf('application/vnd.oasis.opendocument.spreadsheet',
  '<office:spreadsheet><table:table table:name="Plots"><table:table-row><table:table-cell office:value-type="string"><text:p>Plot</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Owner</text:p></table:table-cell></table:table-row>'
  + '<table:table-row><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Ana</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16000"/></table:table-row>'
  + '<table:table-row table:number-rows-repeated="1048000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet>');
const odp = () => odf('application/vnd.oasis.opendocument.presentation',
  '<office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Harvest party</text:p></draw:text-box></draw:frame></draw:page>'
  + '<draw:page draw:name="page2"><draw:frame><draw:text-box><text:p>Bring a dish</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Remind people twice</text:p></draw:text-box></draw:frame></presentation:notes></draw:page></office:presentation>');

function tar(entries) {
  const blocks = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(`${Math.floor(FIXED_DATE.getTime() / 1000).toString(8).padStart(11, '0')}\0`, 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function bmp() {
  // 2 x 2, 24-bit, bottom-up rows padded to 4 bytes: red, green / blue, white.
  const rows = [
    [0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0, 0],
    [0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0, 0],
  ];
  const pixels = Buffer.from(rows.flat());
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + pixels.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(2, 18);
  header.writeInt32LE(2, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([header, pixels]);
}

const square = () => sharp({ create: { width: 8, height: 6, channels: 3, background: '#3a7d44' } });
const png = await square().png().toBuffer();

await out('sample.pdf', pdf([['Quarterly garden report', 'Tomatoes did well'], ['Page two total 42']]));
await out('scanned.pdf', pdf([[]]));
await out('sample.docx', await docx());
await out('sample.xlsx', await xlsx());
await out('sample.pptx', await pptx());
await out('sample.odt', await odt());
await out('sample.ods', await ods());
await out('sample.odp', await odp());
await out('sample.zip', await zip({
  'notes.txt': 'Water the seedlings.',
  'data/plots.csv': 'plot,owner\n7,Ana\n',
  'docs/plan.docx': await docx(),
  'photo.png': png,
  'tool.bin': Buffer.from([0, 1, 2, 3, 254, 255]),
}));
await out('sample.tar.gz', gzipSync(tar({ 'readme.md': '# Seeds\nKeep them dry.', 'src/app.ts': 'export const plots = 12;\n' })));
await out('sample.bmp', bmp());
await out('sample.tiff', await square().tiff().toBuffer());
await out('sample.heic', await square().heif({ compression: 'av1', quality: 50 }).toBuffer());
await out('sample.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6" fill="#3a7d44"/></svg>');
await out('sample.bin', Buffer.from([0x00, 0x13, 0x37, 0xff, 0x42, 0x00, 0x99]));
console.log('chat attachment fixtures written');
