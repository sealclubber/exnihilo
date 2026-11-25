/**
 * The village generator (phase 6E, Villages): a settlement under the pack's
 * `village.below` residents has no mesh, wards, districts in the layout,
 * selection or wall ring. The road leads, and buildings are placed one at a
 * time, outward from the centre. It is made in a fixed order, each step a
 * pure function of the ones before, on streams named `village-…`:
 *
 * 1. Environment: a stream with broad bends, or a calm shore.
 * 2. Road: each route of the brief; opposite exits are one through road.
 * 3. Anchors: the green (where the brief is flagged `plaza`, or by chance), then church, manor, mill and landing.
 * 4. Central forks: lanes off the road near the centre, and links between a
 *    crossroads' arms.
 * 5. Plots, outward from the centre along every way.
 * 6. Thicken, never lengthen: a lane at a time where frontage runs out, until
 *    every building has a plot.
 * 7. Palisade, for a village flagged `walls`, fitted round all the plots.
 * 8. Fields, last, outside the village's envelope: drawing only.
 */
import type { City } from '../../city/records.ts';
import { stepRng } from '../../city/random.ts';
import type { SettingPack, VillageSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { type Coast, type River, makeCoast, makeRiver } from '../staged/water.ts';
import { type Anchors, placeAnchors } from './anchors.ts';
import { type Countryside, layFields } from './fields.ts';
import { layForks } from './forks.ts';
import { Ground } from './ground.ts';
import { thicken } from './lanes.ts';
import { type Palisade, fitPalisade } from './palisade.ts';
import { type Plot, PlotWalker } from './plots.ts';
import { type Bridge, type Way, layRoads } from './roads.ts';

export class VillageLayoutError extends Error {}

/** The village's shape, from its brief: on a shore, at a crossroads, or along a street. A green is an anchor, not a shape. */
export type VillageShape = 'shore' | 'crossroads' | 'street';

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
  /** One for each building no anchor holds, as far as the ways allow so far. */
  plots: Plot[];
  /** The buildings that have no plot yet: none once step 6 is done. */
  unplaced: string[];
  /** How many lanes steps 4 and 6 added, how many plots a lane of step 6 took away to be laid again, and how much farther than the pack's reach the lanes had to go. */
  lanes: { forks: number; thickened: number; displaced: number; reachScale: number };
  /** Round a village flagged `walls`. */
  palisade?: Palisade;
  /** The envelope, and the fields, trees and boats about it: drawing only. */
  countryside: Countryside;
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
 * The shape, first match wins: a coast gives a shore village; three or more land exits, or two through roads that
 * cross, a crossroads; otherwise a street, which bends where its two exits are not opposite. The brief carries no
 * settlement type, so a Lake or Naval settlement is a shore village only where it is coastal.
 */
export function shapeOf(brief: SettlementBrief, landExits: number, throughRoads: number): VillageShape {
  if (brief.coast.isCoastal) return 'shore';
  if (landExits >= 3 || throughRoads >= 2) return 'crossroads';
  return 'street';
}

/** Whether a village has a green: always where the brief is flagged `plaza`, otherwise by a seeded chance that rises with size. */
export function hasGreen(brief: SettlementBrief, buildings: number, settings: VillageSettings, seed: number): boolean {
  if (brief.flags.plaza) return true;
  const { least, most, from, to } = settings.anchors.green.share;
  const share = least + (most - least) * Math.min(Math.max((buildings - from) / Math.max(to - from, 1), 0), 1);
  return stepRng(seed, 'village-green').next() < share;
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
  const shape = shapeOf(brief, roads.landExits, roads.through);

  // 3. Anchors.
  const anchors = placeAnchors({ brief, settings, input, green: hasGreen(brief, buildings, settings, seed), rng: stepRng(seed, 'village-anchors'), ways: roads.ways, bridges: roads.bridges, buildings, ...(river && { river }), ...(coast && { coast }) });
  notes.push(...anchors.notes);
  const ground = new Ground([...roads.ways, ...anchors.lanes], river, coast);
  if (anchors.green) ground.occupy(anchors.green.outline);
  for (const site of anchors.sites) if (site.role !== 'green') ground.occupy(site.outline);

  // 4. Central forks.
  const forks = layForks({ settings, rng: stepRng(seed, 'village-forks'), ground, buildings, crossroads: shape === 'crossroads', ...(anchors.green && { green: anchors.green.outline }), ...(coast && { coast }) });
  notes.push(...forks.notes);

  // 5. Plots, outward from the centre.
  const held = new Set(anchors.sites.flatMap((site) => (site.building === undefined ? [] : [site.building])));
  const walker = new PlotWalker({ settings, pack, rng: stepRng(seed, 'village-plots'), ground, cap, buildings, toPlace: input.buildings.filter((building) => !held.has(building.id)) });
  walker.walk();

  // 6. Thicken, never lengthen.
  const thickening = stepRng(seed, 'village-lanes');
  let scale = 1;
  let failed = 0;
  let added = 0;
  let displaced = 0;
  while (walker.unplaced.length > 0) {
    const before = walker.unplaced.length;
    const found = thicken({ settings, rng: thickening, ground, cap, crossroads: shape === 'crossroads', walled: brief.flags.walls, scale, least: failed > 0 ? 0 : settings.thicken.least, ...(anchors.green && { green: anchors.green.outline }), ...(coast && { coast }) });
    if (found) {
      displaced += found.displaced.size;
      ground.release(found.displaced);
      walker.release(found.displaced);
      walker.addWay(ground.addWay(found.lane));
      walker.walk();
      added++;
    }
    if (walker.unplaced.length < before) {
      failed = 0;
      continue;
    }
    // No lane would do, or none gave a plot: try again with any lane at all, and then reach farther, at most so
    // many times running.
    failed++;
    if (failed % 2 === 1) continue;
    if (failed / 2 > settings.thicken.relax) throw new VillageLayoutError(`${brief.name} (${brief.id}): ${walker.unplaced.length} of ${buildings} buildings found no plot after ${added} lanes were added and the reach grew ${settings.thicken.relax} times`);
    scale *= settings.thicken.grow;
    walker.reachScale = scale;
  }
  if (scale > 1) notes.push(`the lanes had to reach ${scale.toFixed(2)} times as far as the pack says to find room for every building`);

  // 7. Palisade.
  const onLand = [...walker.plots.map((plot) => plot.outline), ...anchors.sites.map((site) => site.outline)];
  let palisade: Palisade | undefined;
  if (brief.flags.walls) {
    const fitted = fitPalisade({ settings, rng: stepRng(seed, 'village-palisade'), outlines: onLand, ways: ground.ways, ...(river && { river }), ...(coast && { coast }) });
    palisade = fitted.palisade;
    notes.push(...fitted.notes);
  }

  // 8. Fields, last.
  const landing = anchors.sites.find((site) => site.role === 'landing');
  const countryside = layFields({
    settings,
    rng: stepRng(seed, 'village-fields'),
    buildings,
    plots: onLand,
    ways: ground.ways,
    ...(palisade && { palisade }),
    ...(anchors.green && { green: anchors.green.outline }),
    ...(landing && landing.drawing[0] && { landing: { outline: landing.drawing[0], out: unitOf(landing.drawing[0][0] as Point, landing.drawing[0][1] as Point) } }),
    ...(river && { river }),
    ...(coast && { coast }),
  });

  return { seed, buildings, cap, shape, ...(river && { river }), ...(coast && { coast }), ways: ground.ways, bridges: roads.bridges, anchors, plots: walker.plots, unplaced: walker.unplaced, lanes: { forks: forks.lanes.length, thickened: added, displaced, reachScale: scale }, ...(palisade && { palisade }), countryside, notes };
}

const unitOf = (from: Point, to: Point): Point => {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
  return [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
};

/** The centre of every village: where its roads meet. */
export const CENTRE: Point = [0, 0];
