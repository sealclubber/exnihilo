/**
 * Makes a town's layout with the generator the pack names, or the one asked for.
 *
 * Both generators take a finished city, its brief, the pack and a seed, and return a layout in the one format.
 * Nothing that reads a layout knows which made it, except by the name in its summary.
 */
import type { City } from '../city/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import { type LayoutOptions, generateGridLayout } from './grid.ts';
import { generateGrownLayout } from './grown.ts';
import type { Layout } from './records.ts';

export function generateLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const generator = options.generator ?? pack.layout.generator ?? 'grid';
  return generator === 'grown' ? generateGrownLayout(city, brief, pack, options) : generateGridLayout(city, brief, pack, options);
}
