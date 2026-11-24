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
import type { Building } from '../../city/records.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { type Block, type Lane, cutBlocks, wardKey, wardVariation } from './blocks.ts';
import { polygonCentroid } from '../geometry.ts';
import { type Character, type DistrictPlan, type Placement, type TownDistrict, characterOf, growDistricts, roomIn } from './districts.ts';
import { type Fitting, fitBuildings } from './fitting.ts';
import { type Ground, takeGround } from './ground.ts';
import { type RoadPlan, planRoads } from './highways.ts';
import { type Mesh, makeMesh } from './mesh.ts';
import { type MainStreet, layMainStreets } from './streets.ts';
import { type Ward, cutWards } from './wards.ts';
import { type LandmarkBuilding, type PlacedLandmark, reserve } from './landmarks.ts';
import { type House, type Passage, layRows } from './rows.ts';
import { type Selection, chooseHouses } from './selection.ts';
import { gateLanes } from './network.ts';
import { bridgeLinks, tileBlocks } from './tiles.ts';
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
  /** The city's districts as given, which wards each has, and each ward's character. */
  districts: TownDistrict[];
  districtPlan: DistrictPlan;
  characters: Character[];
  /** Which houses the town keeps, and for which district. */
  selection: Selection;
  /** How many times more ground was taken because the town had too few houses. */
  moreGround: number;
  /** The gatehouses that stand at gates, in the order gates are given them, and the ward borders let through the wall for them. */
  gatehouses: string[];
  gateLanes: Array<[number, number]>;
  /** The ground about each block, and after the blocks about the plaza and the castle in the order of the wards. */
  tiles: Point[][][];
  /** For each of those, the others whose ground touches its own. */
  tilesBeside: number[][];
  /** The two tiles each bridge joins, the line between them over the bridge, and which bridge. */
  links: Array<{ a: number; b: number; line: Point[]; bridge: number }>;
  /** Which building stands in which house: only where the plan was made for a city's own buildings. */
  fitting?: Fitting;
}

/** What the staged generator reads of a city: how many buildings, its districts, and which buildings are landmarks. */
export interface TownInput {
  buildings: number;
  districts: TownDistrict[];
  landmarks: LandmarkBuilding[];
  /** The city's buildings, where each is to be given its place. */
  list?: readonly Building[];
  /** Reservations a person made, applied before the rules. An empty list gives the same town as none. */
  pins?: ReadonlyArray<{ reservation: 'ward' | 'block' | 'slot'; at: Point; buildingType?: string }>;
  /** Wards to draw afresh, by their names (`wardKey`), each with a number that says which fresh draw. */
  redraw?: ReadonlyMap<string, number>;
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
export function planWards(site: SitePlan, pack: SettingPack, more = 1): WardPlan {
  const settings = stagedSettings(pack);
  const { seed, buildings, radius, river, coast, wall, plaza, castle } = site;
  const water = { ...(river && { river }), ...(coast && { coast }) };
  const special = { ...(wall && { wall }), ...(plaza && { plaza }), ...(castle && { castle }) };
  const ground = takeGround({ settings, rng: stepRng(seed, 'staged-ground'), buildings, radius, roads: site, more, ...water });
  const mesh = makeMesh({ settings, rng: stepRng(seed, 'staged-mesh'), radius, ground, roads: site, ...(river && { river }), ...special });
  // Main streets move the mesh's corners as they are evened; nothing after them does.
  const streets = layMainStreets({ settings, buildings, mesh, ground, roads: site, ...water, ...special });
  const cut = cutWards({ settings, mesh, ground, roads: site, streets, ...water, ...special });
  return { ...site, ground, mesh, streets, wards: cut.wards, notes: [...site.notes, ...(cut.holes > 0 ? [`${cut.holes} ward${cut.holes === 1 ? ' has' : 's have'} a hole`] : [])] };
}

/** The buildings of a city that the pack marks as landmarks, in the city's order. */
export function landmarksOf(buildings: ReadonlyArray<{ id: string; type: string; districtId?: string }>, pack: SettingPack, districts: ReadonlyArray<{ id: string }> = []): LandmarkBuilding[] {
  const { types } = stagedSettings(pack).landmarks;
  const place = new Map(districts.map((district, index) => [district.id, index]));
  return buildings
    .filter((building) => building.type in types)
    .map(({ id, type, districtId }) => ({ id, type, ...(districtId !== undefined && place.has(districtId) && { district: place.get(districtId) as number }) }));
}

/** What the staged generator reads of a city. */
export function townInput(city: { buildings: readonly Building[]; districts: ReadonlyArray<{ id: string; kind: string; buildingIds: readonly string[] }> }, pack: SettingPack): TownInput {
  return {
    buildings: city.buildings.length,
    districts: city.districts.map((district) => ({ id: district.id, kind: district.kind, buildings: district.buildingIds.length })),
    landmarks: landmarksOf(city.buildings, pack, city.districts),
    list: city.buildings,
  };
}

/**
 * Every stage built so far, for a city, or for a bare number of buildings in one district of the pack's first
 * kind. If the town turns out to have too few houses, more ground is taken and the stages from the ground on are
 * made again: the only loop in the generator.
 */
export function planTown(brief: SettlementBrief, town: number | TownInput, pack: SettingPack, seed: number = brief.seed, landmarks?: readonly LandmarkBuilding[]): TownPlan {
  const settings = stagedSettings(pack);
  const input: TownInput = typeof town === 'number' ? { buildings: town, districts: [{ id: 'district', kind: pack.districts.kinds[0]?.id ?? '', buildings: town }], landmarks: [...(landmarks ?? [])] } : town;
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement as Placement]));
  const site = planSite(brief, input.buildings, pack, seed);
  let more = 1;
  for (let attempt = 0; ; attempt++) {
    const wards = planWards(site, pack, more);
    if (input.redraw) for (const ward of wards.wards) if (input.redraw.has(wardKey(ward))) ward.redraw = input.redraw.get(wardKey(ward)) as number;
    const variation = wards.wards.map((ward) => wardVariation(seed, ward, settings));
    // The plaza is a building of one district: that district starts beside it.
    const square = wards.wards.some((ward) => ward.kind === 'plaza') ? input.landmarks.find((landmark) => settings.landmarks.types[landmark.type]?.reservation === 'ward' && settings.landmarks.types[landmark.type]?.ward === 'plaza')?.district : undefined;
    const districtPlan = growDistricts({ ...(square !== undefined && { plazaDistrict: square }), settings, districts: input.districts, variation, placementOf: (kind) => placements.get(kind) ?? 'middle', buildings: input.buildings, wards: wards.wards, mesh: wards.mesh, roads: site, streets: wards.streets, ...(site.river && { river: site.river }), ...(site.coast && { coast: site.coast }), ...(site.wall && { wall: site.wall }) });
    const characters = wards.wards.map((_, index) => characterOf(settings, districtPlan.of[index] === undefined ? undefined : input.districts[districtPlan.of[index] as number]?.kind));
    const { blocks, lanes } = cutBlocks(wards.wards, settings, seed, (_, index) => characters[index] as Character);
    // Reservations first: ordinary houses fill only the blocks that are left. A landmark stands in its own district.
    const roads = [...wards.highways.map((highway) => highway.points), ...wards.streets.map((street) => street.points)];
    const wardsIn = input.districts.map((_, district) => new Set(districtPlan.of.flatMap((of, ward) => (of === district ? [ward] : []))));
    // A landmark stands where the town will be built up: among the innermost blocks that have room for most of
    // its buildings, never out in the fringe where few houses are kept.
    const inFar = blocks.map(() => false);
    let room = 0;
    for (const { at, block } of blocks.map((block, at) => ({ at, block, rank: wards.ground.rank(polygonCentroid(block.polygon)) })).sort((a, b) => a.rank - b.rank || a.at - b.at)) {
      if (room >= settings.landmarks.block.within * input.buildings) inFar[at] = true;
      room += roomIn(block, settings, block.scale);
    }
    const { placed, unplaced } = reserve({
      settings,
      rng: stepRng(seed, 'staged-landmarks'),
      landmarks: input.landmarks,
      ...(input.pins && input.pins.length > 0 && { pins: input.pins }),
      wards: wards.wards,
      blocks,
      roads,
      ...(wards.harbour && { quay: wards.harbour.quay }),
      wardsOf: (landmark) => (landmark.district === undefined || (wardsIn[landmark.district]?.size ?? 0) === 0 ? undefined : wardsIn[landmark.district]),
      blockOk: (_, block) => !inFar[block],
    });
    const reserved = new Set(placed.flatMap((landmark) => (landmark.block === undefined ? [] : [landmark.block])));
    const { houses, passages } = layRows(blocks, wards.wards, settings, seed, reserved, (_, index) => characters[index] as Character);
    // Gatehouses stand at gates: at the highways' and the bridges' first, then at as many ward borders as are let
    // through the wall for them. Any beyond that are ordinary houses.
    const place = new Map(input.districts.map((district, index) => [district.id, index]));
    const keepers = (input.list ?? []).filter((building) => settings.landmarks.types[building.type]?.reservation === 'gate');
    const atRoads = site.wall ? site.wall.gates.length : 0;
    const gateLanesChosen = site.wall ? gateLanes({ mesh: wards.mesh, streets: wards.streets, wall: site.wall }, keepers.length - atRoads) : [];
    const gatehouses = keepers.slice(0, site.wall ? atRoads + gateLanesChosen.length : 0).map((building) => building.id);
    const atGates = new Set(gatehouses);
    // A landmark with a ward or a block of its own, or a gate, is one of its district's buildings and needs no house.
    const wanted = input.districts.map((district, index) => district.buildings - placed.filter((landmark) => landmark.district === index).length - keepers.filter((building) => atGates.has(building.id) && place.get(building.districtId) === index).length);
    // The ground about every block, and about the plaza and the castle after them: blocks whose ground touches
    // are neighbours, as are the two at the ends of a bridge.
    const corridor = settings.widths.highway + 2 * settings.wards.highwayVerge + settings.widths.wardBorder;
    const specials = wards.wards.map((ward, index) => ({ ward, index })).filter(({ ward }) => ward.kind !== 'ordinary');
    const tiles = tileBlocks([...blocks.map((block) => block.polygon), ...specials.map(({ ward }) => ward.polygon)], [settings.widths.lane / 2 + 0.2, settings.widths.wardBorder / 2 + 0.25, settings.widths.mainStreet / 2 + 1, corridor / 2 + 0.6]);
    // Blocks whose ground touches are beside each other. For whole blocks the two at the ends of a bridge are too:
    // a district whose block stands at each end has its ground joined across the bridge.
    const touching = blocks.map((_, index) => (tiles.beside[index] as number[]).filter((other) => other < blocks.length));
    const beside = touching.map((list) => [...list]);
    const fixed = new Map<number, number>();
    for (const landmark of placed) if (landmark.block !== undefined && landmark.district !== undefined) fixed.set(landmark.block, landmark.district);
    // The same links the districts' ground is joined by: the blocks nearest each end of a bridge. A landmark's
    // block, which never changes district, and the plaza and the castle are passed for the next block along the road.
    const links = bridgeLinks(tiles.rings, site.bridges, (tile) => tile >= blocks.length || fixed.has(tile));
    for (const link of links) {
      if (link.a >= blocks.length || link.b >= blocks.length) continue;
      (beside[link.a] as number[]).push(link.b);
      (beside[link.b] as number[]).push(link.a);
    }
    const selection = chooseHouses({ settings, seed, houses, blocks, wards: wards.wards, plan: districtPlan, wanted, ground: wards.ground, beside, fixed, ...(site.wall && { wall: site.wall }) });
    if (selection.short > 0 && attempt < settings.selection.tries) {
      more *= settings.selection.moreGround;
      continue;
    }
    if (selection.short > 0) {
      throw new StagedLayoutError(`${brief.name} (${brief.id}): ${houses.length} houses were made for ${input.buildings} buildings and the town is ${selection.short} short, after taking ${more.toFixed(2)} times the ground in ${attempt} further tries; raise layout.staged.ground.factor or layout.staged.selection.tries`);
    }
    const fitting = input.list && fitBuildings({ pack, buildings: input.list, districtOf: (building) => place.get(building.districtId) as number, landmarks: placed, elsewhere: atGates, houses, kept: selection.district, roads });
    return { ...wards, blocks, lanes, landmarks: placed, unplaced, houses, passages, districts: input.districts, districtPlan, characters, selection, moreGround: attempt, gatehouses, gateLanes: gateLanesChosen, tiles: tiles.rings, tilesBeside: tiles.beside, links, ...(fitting && { fitting }) };
  }
}
