import { imageSize } from 'image-size';
import type { FileVersion } from '@openkraken/ipc-contract';
/** Only byte-identified, bounded static raster formats enter an image element. */
export function rasterPreview(bytes: Buffer): FileVersion['image'] {
  let mime: NonNullable<FileVersion['image']>['mime'];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mime = 'image/png';
    // Animated PNG can allocate many full frames. Keep the initial preview static.
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) return;
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') return;
      offset += length + 12;
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp';
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && (bytes[20] ?? 0) & 2) return;
  } else return;
  try {
    const { width, height } = imageSize(bytes);
    if (!width || !height || width > 16384 || height > 16384 || width * height > 40000000) return;
    return { mime, width, height, base64: bytes.toString('base64') };
  } catch {
    return;
  }
}
