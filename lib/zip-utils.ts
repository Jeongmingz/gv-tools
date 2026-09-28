/**
 * Pure TypeScript ZIP builder (STORE method, no external dependencies).
 * Fully compatible with standard ZIP extractors, Windows Explorer, macOS Archive Utility.
 */

// Precomputed CRC32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c >>> 0;
}

function calculateCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = {
  name: string;
  data: Uint8Array | string;
};

/**
 * Creates a ZIP file Blob from an array of files.
 */
export function createZipBlob(files: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const fileHeaders: Uint8Array[] = [];
  const parts: Uint8Array[] = [];
  let offset = 0;

  // Format current DOS date/time
  const now = new Date();
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2) & 0x1f));
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes =
      typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const crc = calculateCrc32(dataBytes);
    const size = dataBytes.length;

    // Local file header (30 bytes + filename)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true); // Version needed to extract (2.0)
    lv.setUint16(6, 0x0800, true); // Flags: UTF-8 filename encoding (bit 11)
    lv.setUint16(8, 0, true); // Compression: 0 = Store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // Compressed size
    lv.setUint32(22, size, true); // Uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // Extra field length
    localHeader.set(nameBytes, 30);

    parts.push(localHeader, dataBytes);

    // Central directory header (46 bytes + filename)
    const cdHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true); // Version made by
    cv.setUint16(6, 20, true); // Version needed to extract
    cv.setUint16(8, 0x0800, true); // Flags: UTF-8
    cv.setUint16(10, 0, true); // Compression: Store
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // Extra field length
    cv.setUint16(32, 0, true); // File comment length
    cv.setUint16(34, 0, true); // Disk number start
    cv.setUint16(36, 0, true); // Internal attributes
    cv.setUint32(38, 0, true); // External attributes
    cv.setUint32(42, offset, true); // Local header offset
    cdHeader.set(nameBytes, 46);

    fileHeaders.push(cdHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const h of fileHeaders) {
    parts.push(h);
    cdSize += h.length;
  }

  // End of central directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(4, 0, true); // Disk number
  ev.setUint16(6, 0, true); // Disk with start of CD
  ev.setUint16(8, files.length, true); // Num entries this disk
  ev.setUint16(10, files.length, true); // Total entries
  ev.setUint32(12, cdSize, true); // CD size
  ev.setUint32(16, cdOffset, true); // CD offset
  ev.setUint16(20, 0, true); // Comment length
  parts.push(eocd);

  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const combined = new Uint8Array(totalLength);
  let cur = 0;
  for (const part of parts) {
    combined.set(part, cur);
    cur += part.length;
  }

  return new Blob([combined], { type: "application/zip" });
}
