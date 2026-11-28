import { CompoundFile, LegacyOfficeError } from './compoundFile';
import { legacyExcelText } from './legacyExcel';
import { legacyPowerPointText } from './legacyPowerPoint';
import { legacyWordText } from './legacyWord';
import type { ExtractedText, ExtractLimits } from './officeText';

/**
 * Text of an old Office file (.doc, .xls, .ppt), recognised by the streams
 * inside it rather than by its name, so a workbook saved as ".doc" still
 * reads as a workbook (#1224). A password-protected .docx, .xlsx or .pptx is
 * also a compound file; it is reported as protected.
 */
export type LegacyOfficeFormat = 'Word 97-2003 document' | 'Excel 97-2003 workbook' | 'PowerPoint 97-2003 presentation';

export async function extractLegacyOfficeText(
  bytes: Uint8Array,
  limits: ExtractLimits,
): Promise<ExtractedText & { format: LegacyOfficeFormat }> {
  const file = new CompoundFile(bytes);
  if (file.has('EncryptedPackage') || file.has('EncryptionInfo')) {
    throw new LegacyOfficeError('password', 'The document is protected with a password');
  }
  // Streams are stored uncompressed, so none can be larger than the file that was already accepted.
  const whole = { ...limits, maxPartBytes: Math.max(limits.maxPartBytes, bytes.length) };
  if (file.has('WordDocument')) return { ...await legacyWordText(file, whole), format: 'Word 97-2003 document' };
  if (file.has('Workbook') || file.has('Book')) return { ...await legacyExcelText(file, whole), format: 'Excel 97-2003 workbook' };
  if (file.has('PowerPoint Document')) return { ...await legacyPowerPointText(file, whole), format: 'PowerPoint 97-2003 presentation' };
  throw new LegacyOfficeError('unsupported', 'This compound file is not a Word, Excel or PowerPoint document');
}
