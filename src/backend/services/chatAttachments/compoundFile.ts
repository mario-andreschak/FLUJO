/**
 * Reads the streams of a Compound File (MS-CFB), the container of old Office
 * files: .doc, .xls and .ppt (#1224). Every chain is checked against the file
 * size and walked at most once, so a damaged or hostile file cannot loop or
 * make FLUJO read past its end.
 */
/** Why an old Office file could not be read: it is locked, broken or a version older than Office 97. */
export class LegacyOfficeError extends Error {
  constructor(readonly reason: 'password' | 'damaged' | 'unsupported', message: string) {
    super(message);
  }
}

export class CompoundFileError extends LegacyOfficeError {
  constructor(message: string) {
    super('damaged', message);
  }
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const MAX_REGULAR_SECTOR = 0xfffffffa;
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const HEADER_DIFAT_ENTRIES = 109;

interface DirectoryEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export class CompoundFile {
  private readonly view: DataView;
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly miniCutoff: number;
  private readonly fat: Uint32Array;
  private readonly entries: DirectoryEntry[];
  private miniFat?: Uint32Array;
  private miniStream?: Uint8Array;

  constructor(private readonly bytes: Uint8Array) {
    if (!isCompoundFile(bytes)) throw new CompoundFileError('Not a compound file');
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = this.view.getUint16(0x1e, true);
    const miniShift = this.view.getUint16(0x20, true);
    if (sectorShift !== 9 && sectorShift !== 12) throw new CompoundFileError('Unsupported sector size');
    if (miniShift !== 6) throw new CompoundFileError('Unsupported mini sector size');
    this.sectorSize = 1 << sectorShift;
    this.miniSectorSize = 1 << miniShift;
    this.miniCutoff = this.view.getUint32(0x38, true) || 4096;
    this.fat = this.readFat();
    this.entries = this.readDirectory();
  }

  private get sectorCount(): number {
    return Math.max(0, Math.floor((this.bytes.length - this.sectorSize) / this.sectorSize) + 1);
  }

  private sector(index: number): Uint8Array {
    const start = (index + 1) * this.sectorSize;
    if (index > MAX_REGULAR_SECTOR || start >= this.bytes.length) throw new CompoundFileError('Sector outside the file');
    return this.bytes.subarray(start, Math.min(start + this.sectorSize, this.bytes.length));
  }

  private readFat(): Uint32Array {
    const fatSectors: number[] = [];
    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index++) {
      const sector = this.view.getUint32(0x4c + index * 4, true);
      if (sector <= MAX_REGULAR_SECTOR) fatSectors.push(sector);
    }
    let difat = this.view.getUint32(0x44, true);
    const seen = new Set<number>();
    const perSector = this.sectorSize / 4 - 1;
    while (difat <= MAX_REGULAR_SECTOR) {
      if (seen.has(difat)) throw new CompoundFileError('The file allocation list loops');
      seen.add(difat);
      const data = this.sector(difat);
      const sectorView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let index = 0; index < perSector && (index + 1) * 4 <= data.length; index++) {
        const sector = sectorView.getUint32(index * 4, true);
        if (sector <= MAX_REGULAR_SECTOR) fatSectors.push(sector);
      }
      difat = data.length >= this.sectorSize ? sectorView.getUint32(perSector * 4, true) : END_OF_CHAIN;
    }
    if (fatSectors.length === 0) throw new CompoundFileError('The file has no allocation table');
    const fat = new Uint32Array(fatSectors.length * (this.sectorSize / 4));
    fatSectors.forEach((sector, position) => {
      const data = this.sector(sector);
      const sectorView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let index = 0; index * 4 + 4 <= data.length; index++) {
        fat[position * (this.sectorSize / 4) + index] = sectorView.getUint32(index * 4, true);
      }
    });
    return fat;
  }

  /** Sector numbers of a chain, refusing loops and chains longer than the file. */
  private chain(start: number, table: Uint32Array, limit: number): number[] {
    const sectors: number[] = [];
    const seen = new Set<number>();
    for (let sector = start; sector !== END_OF_CHAIN && sector !== NO_STREAM;) {
      if (sector > MAX_REGULAR_SECTOR || sector >= table.length || seen.has(sector) || sectors.length >= limit) {
        throw new CompoundFileError('Broken sector chain');
      }
      seen.add(sector);
      sectors.push(sector);
      sector = table[sector];
    }
    return sectors;
  }

  private readChain(start: number, size?: number): Uint8Array {
    const sectors = this.chain(start, this.fat, this.sectorCount);
    const length = size ?? sectors.length * this.sectorSize;
    if (length > sectors.length * this.sectorSize) throw new CompoundFileError('Stream longer than its sectors');
    const out = new Uint8Array(length);
    let offset = 0;
    for (const sector of sectors) {
      if (offset >= length) break;
      const data = this.sector(sector).subarray(0, length - offset);
      out.set(data, offset);
      offset += data.length;
    }
    if (offset < length) throw new CompoundFileError('Stream cut short');
    return out;
  }

  private readDirectory(): DirectoryEntry[] {
    const data = this.readChain(this.view.getUint32(0x30, true));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const entries: DirectoryEntry[] = [];
    for (let offset = 0; offset + 128 <= data.length; offset += 128) {
      const nameBytes = Math.min(64, view.getUint16(offset + 0x40, true));
      let name = '';
      for (let index = 0; index + 2 <= nameBytes - 2; index += 2) name += String.fromCharCode(view.getUint16(offset + index, true));
      const sizeLow = view.getUint32(offset + 0x78, true);
      const sizeHigh = this.sectorSize === 512 ? 0 : view.getUint32(offset + 0x7c, true);
      entries.push({
        name,
        type: view.getUint8(offset + 0x42),
        left: view.getUint32(offset + 0x44, true),
        right: view.getUint32(offset + 0x48, true),
        child: view.getUint32(offset + 0x4c, true),
        start: view.getUint32(offset + 0x74, true),
        size: sizeHigh ? Number.MAX_SAFE_INTEGER : sizeLow,
      });
    }
    if (entries[0]?.type !== 5) throw new CompoundFileError('The file has no root entry');
    return entries;
  }

  /** Names of the streams directly inside the root storage. */
  topLevelStreams(): Map<string, DirectoryEntry> {
    const streams = new Map<string, DirectoryEntry>();
    const pending = [this.entries[0].child];
    const seen = new Set<number>();
    while (pending.length > 0) {
      const index = pending.pop()!;
      if (index === NO_STREAM || index >= this.entries.length || seen.has(index)) continue;
      seen.add(index);
      const entry = this.entries[index];
      if (entry.type === 2) streams.set(entry.name.toLowerCase(), entry);
      pending.push(entry.left, entry.right);
    }
    return streams;
  }

  has(name: string): boolean {
    return this.topLevelStreams().has(name.toLowerCase());
  }

  /** A top-level stream's bytes, or undefined when there is none. */
  stream(name: string, maxBytes: number): Uint8Array | undefined {
    const entry = this.topLevelStreams().get(name.toLowerCase());
    if (!entry) return undefined;
    if (entry.size > maxBytes) throw new CompoundFileError(`The ${entry.name} stream is larger than FLUJO reads`);
    if (entry.size < this.miniCutoff) return this.readMini(entry);
    return this.readChain(entry.start, entry.size);
  }

  private readMini(entry: DirectoryEntry): Uint8Array {
    if (entry.size === 0) return new Uint8Array();
    if (!this.miniStream || !this.miniFat) {
      const root = this.entries[0];
      this.miniStream = this.readChain(root.start, root.size);
      const miniFatBytes = this.readChain(this.view.getUint32(0x3c, true));
      const view = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
      this.miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
      for (let index = 0; index < this.miniFat.length; index++) this.miniFat[index] = view.getUint32(index * 4, true);
    }
    const sectors = this.chain(entry.start, this.miniFat, Math.ceil(this.miniStream.length / this.miniSectorSize));
    const out = new Uint8Array(entry.size);
    let offset = 0;
    for (const sector of sectors) {
      if (offset >= entry.size) break;
      const start = sector * this.miniSectorSize;
      const data = this.miniStream.subarray(start, Math.min(start + this.miniSectorSize, start + entry.size - offset));
      if (data.length === 0) throw new CompoundFileError('Mini stream sector outside the file');
      out.set(data, offset);
      offset += data.length;
    }
    if (offset < entry.size) throw new CompoundFileError('Stream cut short');
    return out;
  }
}
