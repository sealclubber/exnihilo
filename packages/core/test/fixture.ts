import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOMIA_PATH = fileURLToPath(new URL('../../../fixtures/afmg/lomia.json', import.meta.url));

let text: string | undefined;

/** A fresh, independently mutable parse of the Lomia export. */
export function loadLomia(): any {
  text ??= readFileSync(LOMIA_PATH, 'utf8');
  return JSON.parse(text);
}
