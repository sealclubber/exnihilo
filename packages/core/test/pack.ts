import { fileURLToPath } from 'node:url';
import { type SettingPack, type World, importAfmg, parsePack } from '../src/index.ts';
import { loadPack, readPackFiles } from '../../server/src/pack-loader.ts';
import { loadLomia } from './fixture.ts';

export const MEDIEVAL_PATH = fileURLToPath(new URL('../../../packs/medieval', import.meta.url));

let pack: SettingPack | undefined;
let world: World | undefined;

/** The medieval pack as the server loads it. Shared between tests, so do not change it; copy it. */
export function medievalPack(): SettingPack {
  return (pack ??= loadPack(MEDIEVAL_PATH));
}

/** A fresh, unchecked copy of the medieval pack's files, for tests that edit a pack. */
export function rawMedievalPack(): any {
  return readPackFiles(MEDIEVAL_PATH);
}

/** The Lomia world, imported once per test file. */
export function lomiaWorld(): World {
  return (world ??= importAfmg(loadLomia()).world);
}

export function settlement(id: string) {
  const brief = lomiaWorld().settlements.find((entry) => entry.id === id);
  if (!brief) throw new Error(`no ${id} in Lomia`);
  return brief;
}

/**
 * Takes out of a raw pack everything phase 6B added, leaving the pack as it
 * was at version 0.7.0 in all that the generators and daily life read. A city
 * made from it is the one generator version 2 made, and its plans are those
 * of life version 3. Tests that hold fingerprints from before use it.
 */
export function stripPhase6B(raw: any): void {
  // Civic buildings, their posts and their lots.
  const civic = raw.landmarks.filter((landmark: any) => landmark.when === undefined);
  const posts = new Set(civic.flatMap((landmark: any) => landmark.posts.map((post: any) => post.occupation)));
  raw.landmarks = raw.landmarks.filter((landmark: any) => landmark.when !== undefined);
  raw.occupations = raw.occupations.filter((occupation: any) => !posts.has(occupation.id));
  for (const landmark of civic) {
    delete raw.layout.lots[landmark.id];
    delete raw.layout.footprints.types[landmark.id];
  }
}

let before6B: SettingPack | undefined;
/** The medieval pack with everything phase 6B added taken out. Shared, so do not change it. */
export function medievalPackBefore6B(): SettingPack {
  if (!before6B) {
    const raw = rawMedievalPack();
    stripPhase6B(raw);
    before6B = parsePack(raw);
  }
  return before6B;
}
