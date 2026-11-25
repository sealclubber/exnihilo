/**
 * The village generator (phase 6E, Villages): a settlement under the pack's
 * `village.below` residents has no mesh, wards, districts in the layout,
 * selection or wall ring. The road leads, and buildings are placed one at a
 * time, outward from the centre. It is made in a fixed order, each step a
 * pure function of the ones before, on streams named `village-…`:
 *
 * 1. Environment: a stream with broad bends, or a calm shore.
 * 2. Road: each route of the brief; opposite exits are one through road.
 * 3. Anchors: the green, then church, manor, mill and landing.
 *
 * Later steps (forks, plots, lanes, palisade, fields) are still to come.
 */
import type { City } from '../../city/records.ts';
import { stepRng } from '../../city/random.ts';
import type { SettingPack, VillageSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { type Coast, type River, makeCoast, makeRiver } from '../staged/water.ts';
import { type Anchors, placeAnchors } from './anchors.ts';
import { type Bridge, type Way, layRoads } from './roads.ts';

export class VillageLayoutError extends Error {}

/** The village's shape, from its brief: on a shore, at a crossroads, round a green, or along a street. */
export type VillageShape = 'shore' | 'crossroads' | 'green' | 'street';

/** What the village generator needs of the city: each building's ID and type. */
export interface VillageInput {
  buildings: ReadonlyArray<{ id: string; type: string }>;
}

export interface VillagePlan {
  seed: number;
  buildings: number;
  /** How far the built stretch of the through road may reach each way from the centre, and the village's radius. */
  cap: number;
  shape: VillageShape;
  river?: River;
  coast?: Coast;
  /** Roads first, by the brief's routes; then lanes, in the order they were laid. */
  ways: Way[];
  bridges: Bridge[];
  anchors: Anchors;
  /** What could not be done as the brief asked, for the report. */
  notes: string[];
}

export function villageSettings(pack: SettingPack): VillageSettings {
  const settings = pack.layout.village;
  if (!settings) throw new VillageLayoutError(`pack ${pack.pack.name}: layout has no \`village\` block, which the village generator needs`);
  return settings;
}

/** Whether the pack lays a settlement out as a village. */
export function isVillage(brief: SettlementBrief, pack: SettingPack): boolean {
  return pack.layout.village !== undefined && brief.population < pack.layout.village.below;
}

/** The input of a city: its buildings. */
export function villageInput(city: City): VillageInput {
  return { buildings: city.buildings.map((building) => ({ id: building.id, type: building.type })) };
}

/**
 * The shape, first match wins: a coast gives a shore village; two or more land routes that are not one through
 * road, a crossroads; the `plaza` flag, a green; otherwise a street. The brief carries no settlement type, so a
 * Lake or Naval settlement is a shore village only where it is coastal.
 */
export function shapeOf(brief: SettlementBrief, throughRoads: number, arms: number): VillageShape {
  if (brief.coast.isCoastal) return 'shore';
  if (throughRoads + arms >= 2) return 'crossroads';
  if (brief.flags.plaza) return 'green';
  return 'street';
}

export function planVillage(brief: SettlementBrief, input: VillageInput, pack: SettingPack, seed: number = brief.seed): VillagePlan {
  const settings = villageSettings(pack);
  const buildings = input.buildings.length;
  const cap = settings.cap.base + settings.cap.perBuilding * buildings;
  const notes: string[] = [];

  // 1. Environment.
  const waters = { brief, settings, seed, radius: cap, reach: settings.reach, least: settings.river.least, streams: 'village' };
  const river = makeRiver(waters);
  const coast = makeCoast(waters);

  // 2. Road.
  const roads = layRoads({ brief, settings, rng: stepRng(seed, 'village-roads'), ...(river && { river }), ...(coast && { coast }) });
  notes.push(...roads.notes);
  const shape = shapeOf(brief, roads.through, roads.arms);

  // 3. Anchors.
  const anchors = placeAnchors({ brief, settings, input, shape, rng: stepRng(seed, 'village-anchors'), ways: roads.ways, bridges: roads.bridges, buildings, ...(river && { river }), ...(coast && { coast }) });
  notes.push(...anchors.notes);

  return { seed, buildings, cap, shape, ...(river && { river }), ...(coast && { coast }), ways: [...roads.ways, ...anchors.lanes], bridges: roads.bridges, anchors, notes };
}

/** The centre of every village: where its roads meet. */
export const CENTRE: Point = [0, 0];
