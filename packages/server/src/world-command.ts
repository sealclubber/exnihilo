/**
 * The world command: makes a new world with AFMG's generator from a seed, a heightmap template and a number of
 * points (`@worldsim/worldgen`), runs the pure importer from core on it, and stores the result, as the import
 * command does for a file.
 */
import { type ImportReport, importAfmg } from '@worldsim/core';
import { type NewWorld, generateExport, newWorldOptions } from '@worldsim/worldgen';
import { WorldStore } from './storage.ts';

export async function createWorldFile(choice: NewWorld, storePath: string): Promise<ImportReport> {
  const { world, report } = importAfmg(await generateExport(...newWorldOptions(choice)));
  const store = new WorldStore(storePath);
  try {
    store.save(world, report);
  } finally {
    store.close();
  }
  return report;
}
