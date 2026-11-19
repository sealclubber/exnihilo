/**
 * Derives a seed for one entity from the world seed. The result depends only
 * on the three strings, so it is the same on every machine and every run.
 *
 * The inputs are hashed as UTF-8 with FNV-1a, each field ended by a zero byte
 * so that ("ab", "c") and ("a", "bc") differ, then mixed with the MurmurHash3
 * finaliser. Returns an unsigned 32-bit integer.
 */
export function deriveSeed(worldSeed: string, kind: string, id: string): number {
  let hash = 0x811c9dc5;
  for (const field of [worldSeed, kind, id]) {
    for (const byte of utf8(field)) {
      hash = Math.imul(hash ^ byte, 0x01000193);
    }
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function utf8(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}
