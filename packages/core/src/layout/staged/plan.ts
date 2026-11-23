/**
 * The staged generator's plan of a town: what each stage has laid so far.
 *
 * The town is made in a fixed order, and a later stage never moves what an
 * earlier one placed. Each stage is a pure function of the stages before it.
 * So far: water, highways, bridges and the harbour, the wall, the special
 * wards, the ground, the mesh, main streets and wards.
 */
import { stepRng } from '../../city/random.ts';
import type { SettingPack, StagedSettings } from '../../pack/schema.ts';
import type { SettlementBrief } from '../../schema.ts';
import { type Ground, takeGround } from './ground.ts';
import { type RoadPlan, planRoads } from './highways.ts';
import { type Mesh, makeMesh } from './mesh.ts';
import { type MainStreet, layMainStreets } from './streets.ts';
import { type Ward, cutWards } from './wards.ts';
import { type SpecialWard, planSpecialWards, plazaRadius } from './special.ts';
import { type Wall, planWall } from './wall.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

export interface TownPlan extends RoadPlan {
  /** The radius of a circle of the ground the town's buildings need. */
  radius: number;
  /** How far from the centre roads and water are drawn. */
  reach: number;
  buildings: number;
  river?: River;
  coast?: Coast;
  wall?: Wall;
  plaza?: SpecialWard;
  castle?: SpecialWard;
  ground: Ground;
  mesh: Mesh;
  /** Every main street: the far legs of bridge roads, then those that follow the mesh. */
  streets: MainStreet[];
  wards: Ward[];
}

export class StagedLayoutError extends Error {}

export function stagedSettings(pack: SettingPack): StagedSettings {
  const settings = pack.layout.staged;
  if (!settings) throw new StagedLayoutError(`pack ${pack.pack.name}: layout has no \`staged\` block, which the staged generator needs`);
  return settings;
}

/** Stages 1 to 9 for a town of so many buildings. */
export function planTown(brief: SettlementBrief, buildings: number, pack: SettingPack, seed: number = brief.seed): TownPlan {
  const settings = stagedSettings(pack);
  const radius = Math.sqrt((buildings * settings.extent.perBuilding) / Math.PI);
  const reach = Math.max(radius * settings.extent.reach, settings.extent.least);
  // Between the centre and a river's bank there is room for the plaza and a quay road.
  const least = plazaRadius(buildings, settings) + settings.widths.highway;
  const waters = { brief, settings, seed, radius, reach, least };
  const river = makeRiver(waters);
  const coast = makeCoast(waters);
  const rng = (step: string) => stepRng(seed, step);
  const roads = planRoads({ brief, settings, rng, buildings, radius, reach, ...(river && { river }), ...(coast && { coast }) });
  const wall = brief.flags.walls ? planWall({ settings, rng: rng('staged-wall'), buildings, roads, ...(river && { river }), ...(coast && { coast }) }) : undefined;
  const special = planSpecialWards({ settings, rng, buildings, radius, flags: brief.flags, roads, ...(wall && { wall }), ...(river && { river }), ...(coast && { coast }) });
  const water = { ...(river && { river }), ...(coast && { coast }) };
  const wards = { ...(wall && { wall }), ...(special.plaza && { plaza: special.plaza }), ...(special.castle && { castle: special.castle }) };
  const ground = takeGround({ settings, rng: rng('staged-ground'), buildings, radius, roads, ...water });
  const mesh = makeMesh({ settings, rng: rng('staged-mesh'), radius, ground, roads, ...(river && { river }), ...wards });
  // Main streets move the mesh's corners as they are evened; nothing after them does.
  const streets = layMainStreets({ settings, buildings, mesh, ground, roads, ...water, ...wards });
  const cut = cutWards({ settings, mesh, ground, roads, streets, ...water, ...wards });
  return {
    radius,
    reach,
    buildings,
    ...water,
    ...roads,
    ...wards,
    ground,
    mesh,
    streets,
    wards: cut.wards,
    notes: [...roads.notes, ...special.notes, ...(cut.holes > 0 ? [`${cut.holes} ward${cut.holes === 1 ? ' has' : 's have'} a hole`] : [])],
  };
}
