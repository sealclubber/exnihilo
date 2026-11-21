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
  // Rounds, and the watch as it was: a day watch to 18:00 and a night watch, half and half.
  raw.rounds = {};
  for (const occupation of raw.occupations) delete occupation.round;
  raw.occupations.find((occupation: any) => occupation.id === 'watchman').shift = [{ shift: 'watch-day', share: 0.5 }, { shift: 'night', share: 0.5 }];
  raw.shifts.shifts['watch-day'].end = '18:00';
  delete raw.shifts.shifts['watch-evening'];
  // Chains, repeats, strolls and stays on the street.
  raw.visits.visits = raw.visits.visits.filter((visit: any) => visit.stops === undefined && visit.stroll === undefined && visit.timesPerDay === undefined && !['bathhouse', 'hall-business'].includes(visit.id));
  for (const visit of raw.visits.visits) {
    delete visit.where;
    delete visit.nearest;
  }
  delete raw.visits.streetReach;
  stripPhase6B5(raw);
}

/**
 * Takes out of a raw pack what phase 6B.5 added: everyday buildings spread across districts, housing near work,
 * the lists of where each tier lives, and the name for a home that is a workshop. A city made from the result
 * is the one generator version 3 made. To lay it out as layout version 2 did, pass `BEFORE_6B5` to the layout
 * generator as well: which building holds which lot is the one thing the pack does not decide.
 */
export function stripPhase6B5(raw: any): void {
  for (const type of raw.workplaces) delete type.spread;
  delete raw.districts.tierDistricts;
  delete raw.districts.housingNearWork;
  delete raw.pack.homeAndWorkLabel;
}

/** Layout options that leave every building on the lot it was first given, as layout version 2 did. */
export const BEFORE_6B5 = { arrange: false } as const;

let before6B5: SettingPack | undefined;
/** The medieval pack with what phase 6B.5 added taken out. Shared, so do not change it. */
export function medievalPackBefore6B5(): SettingPack {
  if (!before6B5) {
    const raw = rawMedievalPack();
    stripPhase6B5(raw);
    before6B5 = parsePack(raw);
  }
  return before6B5;
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
