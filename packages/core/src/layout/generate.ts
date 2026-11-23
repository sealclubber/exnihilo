/**
 * Makes a town's layout with the generator the pack names, or the one asked for.
 *
 * A generator takes a finished city, its brief, the pack and a seed, and returns a layout in the one format.
 * Nothing that reads a layout knows which made it, except by the name in its summary.
 */
import type { City } from '../city/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import { type LayoutOptions, generateGridLayout } from './grid.ts';
import type { Layout } from './records.ts';

export function generateLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  // The grid is the only finished generator: the staged one of phase 6E is being built in `staged/`.
  return generateGridLayout(city, brief, pack, options);
}
