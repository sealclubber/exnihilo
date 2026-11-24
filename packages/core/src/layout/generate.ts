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
import { generateStagedLayout } from './staged/layout.ts';

export function generateLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const generator = options.generator ?? pack.layout.generator ?? 'grid';
  if (generator === 'staged') return generateStagedLayout(city, brief, pack, { ...(options.seed !== undefined && { seed: options.seed }), ...(options.pins && { pins: options.pins }), ...(options.check === false && { check: false }) });
  return generateGridLayout(city, brief, pack, options);
}
