import type { City } from '../city/records.ts';
import type { SettingPack } from '../pack/schema.ts';
import type { SettlementBrief } from '../schema.ts';
import { type LayoutOptions, LayoutGenerationError } from './grid.ts';
import type { Layout } from './records.ts';

/** The name this generator records in a layout's summary. */
export const GROWN_GENERATOR = 'grown';

export function generateGrownLayout(_city: City, brief: SettlementBrief, _pack: SettingPack, _options: LayoutOptions = {}): Layout {
  throw new LayoutGenerationError(`${brief.id} (${brief.name}): the grown generator is not built yet`);
}
