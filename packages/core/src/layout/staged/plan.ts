/**
 * The staged generator's plan of a town: what each stage has laid so far.
 *
 * The town is made in a fixed order, and a later stage never moves what an
 * earlier one placed. Each stage is a pure function of the stages before it.
 * So far: water, then highways, bridges and the harbour.
 */
import { stepRng } from '../../city/random.ts';
import type { SettingPack, StagedSettings } from '../../pack/schema.ts';
import type { SettlementBrief } from '../../schema.ts';
import { type RoadPlan, planRoads } from './highways.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

export interface TownPlan extends RoadPlan {
  /** The radius of a circle of the ground the town's buildings need. */
  radius: number;
  /** How far from the centre roads and water are drawn. */
  reach: number;
  buildings: number;
  river?: River;
  coast?: Coast;
}

export class StagedLayoutError extends Error {}

export function stagedSettings(pack: SettingPack): StagedSettings {
  const settings = pack.layout.staged;
  if (!settings) throw new StagedLayoutError(`pack ${pack.pack.name}: layout has no \`staged\` block, which the staged generator needs`);
  return settings;
}

/** How far a plaza reaches from the centre: half the diagonal of a square of its area. */
export function plazaRadius(buildings: number, settings: StagedSettings): number {
  const { plaza } = settings;
  return Math.sqrt(Math.min(Math.max(buildings * plaza.perBuilding, plaza.min), plaza.max) / 2);
}

/** Stages 1 to 3 for a town of so many buildings. */
export function planTown(brief: SettlementBrief, buildings: number, pack: SettingPack, seed: number = brief.seed): TownPlan {
  const settings = stagedSettings(pack);
  const radius = Math.sqrt((buildings * settings.extent.perBuilding) / Math.PI);
  const reach = Math.max(radius * settings.extent.reach, settings.extent.least);
  // Between the centre and a river's bank there is room for the plaza and a quay road.
  const least = plazaRadius(buildings, settings) + settings.widths.highway;
  const water = { brief, settings, seed, radius, reach, least };
  const river = makeRiver(water);
  const coast = makeCoast(water);
  const roads = planRoads({ brief, settings, rng: (step) => stepRng(seed, step), buildings, radius, reach, ...(river && { river }), ...(coast && { coast }) });
  return { radius, reach, buildings, ...(river && { river }), ...(coast && { coast }), ...roads };
}
