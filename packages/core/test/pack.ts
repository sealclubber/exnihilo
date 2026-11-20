import { fileURLToPath } from 'node:url';
import { type SettingPack, type World, importAfmg } from '../src/index.ts';
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
