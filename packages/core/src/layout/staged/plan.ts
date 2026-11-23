/**
 * The staged generator's plan of a town: what each stage has laid so far.
 *
 * The town is made in a fixed order, and a later stage never moves what an
 * earlier one placed. Each stage is a pure function of the stages before it.
 * So far: water, highways, bridges and the harbour, the wall, the special
 * wards, the ground, the mesh, main streets, wards, blocks and rows of
 * houses. More houses are made than the town has: none are chosen yet.
 */
import { stepRng } from '../../city/random.ts';
import type { SettingPack, StagedSettings } from '../../pack/schema.ts';
import type { SettlementBrief } from '../../schema.ts';
import { type Block, type Lane, cutBlocks } from './blocks.ts';
import { type Ground, takeGround } from './ground.ts';
import { type RoadPlan, planRoads } from './highways.ts';
import { type Mesh, makeMesh } from './mesh.ts';
import { type MainStreet, layMainStreets } from './streets.ts';
import { type Ward, cutWards } from './wards.ts';
import { type LandmarkBuilding, type PlacedLandmark, reserve } from './landmarks.ts';
import { type House, type Passage, layRows } from './rows.ts';
import { type SpecialWard, planSpecialWards, plazaRadius } from './special.ts';
import { type Wall, planWall } from './wall.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

/** Stages 1 to 5: water, roads, the wall and the special wards. */
export interface SitePlan extends RoadPlan {
  /** The seed every stage's streams come from. */
  seed: number;
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
}

/** Stages 1 to 9, as far as wards. */
export interface WardPlan extends SitePlan {
  ground: Ground;
  mesh: Mesh;
  /** Every main street: the far legs of bridge roads, then those that follow the mesh. */
  streets: MainStreet[];
  wards: Ward[];
}

/** Every stage built so far. */
export interface TownPlan extends WardPlan {
  blocks: Block[];
  /** The lanes that part a ward's blocks, each the centre line of a cut. */
  lanes: Lane[];
  /** The landmarks given a ward or a block, and those for which none was found. */
  landmarks: PlacedLandmark[];
  unplaced: LandmarkBuilding[];
  /** Every house made: more than the town has. */
  houses: House[];
  passages: Passage[];
}

export class StagedLayoutError extends Error {}

export function stagedSettings(pack: SettingPack): StagedSettings {
  const settings = pack.layout.staged;
  if (!settings) throw new StagedLayoutError(`pack ${pack.pack.name}: layout has no \`staged\` block, which the staged generator needs`);
  return settings;
}

/** Stages 1 to 5 for a town of so many buildings: the site, before any ground is taken. */
export function planSite(brief: SettlementBrief, buildings: number, pack: SettingPack, seed: number = brief.seed): SitePlan {
  const settings = stagedSettings(pack);
  const radius = Math.sqrt((buildings * settings.extent.perBuilding) / Math.PI);
  const reach = Math.max(radius * settings.extent.reach, settings.extent.least);
  // Between the centre and a river's bank there is room for the plaza and a quay road.
  const least = plazaRadius(buildings, settings) + settings.widths.highway;
  const waters = { brief, settings, seed, radius, reach, least };
  const river = makeRiver(waters);
  const coast = makeCoast(waters);
  const water = { ...(river && { river }), ...(coast && { coast }) };
  const rng = (step: string) => stepRng(seed, step);
  const roads = planRoads({ brief, settings, rng, buildings, radius, reach, ...water });
  const wall = brief.flags.walls ? planWall({ settings, rng: rng('staged-wall'), buildings, roads, ...water }) : undefined;
  const special = planSpecialWards({ settings, rng, buildings, radius, flags: brief.flags, roads, ...(wall && { wall }), ...water });
  return {
    seed,
    radius,
    reach,
    buildings,
    ...water,
    ...roads,
    ...(wall && { wall }),
    ...(special.plaza && { plaza: special.plaza }),
    ...(special.castle && { castle: special.castle }),
    notes: [...roads.notes, ...special.notes],
  };
}

/** Stages 6 to 9 on a site: ground, the mesh, main streets and wards. */
export function planWards(site: SitePlan, pack: SettingPack): WardPlan {
  const settings = stagedSettings(pack);
  const { seed, buildings, radius, river, coast, wall, plaza, castle } = site;
  const water = { ...(river && { river }), ...(coast && { coast }) };
  const special = { ...(wall && { wall }), ...(plaza && { plaza }), ...(castle && { castle }) };
  const ground = takeGround({ settings, rng: stepRng(seed, 'staged-ground'), buildings, radius, roads: site, ...water });
  const mesh = makeMesh({ settings, rng: stepRng(seed, 'staged-mesh'), radius, ground, roads: site, ...(river && { river }), ...special });
  // Main streets move the mesh's corners as they are evened; nothing after them does.
  const streets = layMainStreets({ settings, buildings, mesh, ground, roads: site, ...water, ...special });
  const cut = cutWards({ settings, mesh, ground, roads: site, streets, ...water, ...special });
  return { ...site, ground, mesh, streets, wards: cut.wards, notes: [...site.notes, ...(cut.holes > 0 ? [`${cut.holes} ward${cut.holes === 1 ? ' has' : 's have'} a hole`] : [])] };
}

/** The buildings of a city that the pack marks as landmarks, in the city's order. */
export function landmarksOf(buildings: ReadonlyArray<{ id: string; type: string }>, pack: SettingPack): LandmarkBuilding[] {
  const { types } = stagedSettings(pack).landmarks;
  return buildings.filter((building) => building.type in types).map(({ id, type }) => ({ id, type }));
}

/** Every stage built so far, for a town of so many buildings, of which some are landmarks. */
export function planTown(brief: SettlementBrief, buildings: number, pack: SettingPack, seed: number = brief.seed, landmarks: readonly LandmarkBuilding[] = []): TownPlan {
  const settings = stagedSettings(pack);
  const wards = planWards(planSite(brief, buildings, pack, seed), pack);
  const { blocks, lanes } = cutBlocks(wards.wards, settings, seed);
  // Reservations first: ordinary houses fill only the blocks that are left.
  const roads = [...wards.highways.map((highway) => highway.points), ...wards.streets.map((street) => street.points)];
  const { placed, unplaced } = reserve({ settings, rng: stepRng(seed, 'staged-landmarks'), landmarks, wards: wards.wards, blocks, roads, ...(wards.harbour && { quay: wards.harbour.quay }) });
  const reserved = new Set(placed.flatMap((landmark) => (landmark.block === undefined ? [] : [landmark.block])));
  const { houses, passages } = layRows(blocks, wards.wards, settings, seed, reserved);
  return { ...wards, blocks, lanes, landmarks: placed, unplaced, houses, passages };
}
