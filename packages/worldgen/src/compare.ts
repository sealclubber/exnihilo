/**
 * Compares two JSON values field by field: each path that differs, with list positions folded to `[]`, how many
 * values differ there, and the first example.
 */
export interface Difference {
  count: number;
  example: string;
}

export function differences(mine: unknown, theirs: unknown): Map<string, Difference> {
  const found = new Map<string, Difference>();
  const show = (value: unknown) => JSON.stringify(value)?.slice(0, 90);
  const note = (path: string, a: unknown, b: unknown) => {
    const key = path.replace(/\[\d+\]/g, '[]');
    const entry = found.get(key) ?? { count: 0, example: `${path}: ${show(a)}, against ${show(b)}` };
    entry.count++;
    found.set(key, entry);
  };
  const walk = (a: any, b: any, path: string): void => {
    if (a === b) return;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return note(path, a, b);
    if (Array.isArray(a)) {
      if (a.length !== b.length) note(`${path}.length`, a.length, b.length);
      for (let index = 0; index < Math.min(a.length, b.length); index++) walk(a[index], b[index], `${path}[${index}]`);
      return;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in a)) note(`${path}.${key} (only in the second)`, undefined, b[key]);
      else if (!(key in b)) note(`${path}.${key} (only in the first)`, a[key], undefined);
      else walk(a[key], b[key], `${path}.${key}`);
    }
  };
  walk(mine, theirs, '');
  return found;
}
