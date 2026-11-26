/**
 * Stage 10 of the staged generator, first half: reservations.
 *
 * Anything special claims its ground first. A landmark the pack gives a
 * ward stands in the castle or on the plaza; one it gives a block takes a
 * whole block, chosen by its rule, and its footprint is a template scaled
 * down until it fits whole inside. It is never clipped. Ordinary houses fill
 * only the blocks that are left. Slots and gates are reserved by later
 * stages.
 *
 * A block is reserved by the kind of site it is, not for a district: its
 * footprint's template and the place it looks for (the plaza, the harbour or
 * a road). Which landmark stands on which site of its kind is settled after
 * the districts are drawn (phase 6G).
 */
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { smallestRectangle } from '../cutting.ts';
import { distance, distanceBetweenPolygons, distanceToPolyline, pointInPolygon, polygonArea, polygonCentroid } from '../geometry.ts';
import { LineIndex } from '../lines.ts';
import type { Block } from './blocks.ts';
import { type Rect, outlineOf, rectInside, widenedRect } from './rects.ts';
import { united } from './shapes.ts';
import type { Ward } from './wards.ts';

/** A building the city made whose type the pack marks as a landmark. */
export interface LandmarkBuilding {
  id: string;
  type: string;
  /** Its district in the city, by the district's place in the city's list. */
  district?: number;
}

/** The kind of site a block landmark stands on: any landmark of the same kind may stand on it instead. */
export interface SiteKind {
  template: string;
  place: 'plaza' | 'harbour' | 'road';
}

export interface PlacedLandmark {
  building: string;
  type: string;
  reservation: 'ward' | 'block';
  /** For a block, the kind of site it is. */
  site?: SiteKind;
  /** Its district in the city, if it was given one. */
  district?: number;
  /** The ward it stands in, and for a block landmark its block, by their places in the plan. */
  ward: number;
  block?: number;
  /** The rectangles its footprint is made of, and the footprint's outline. Empty for open ground, as a market square is. */
  parts: Rect[];
  outline: Point[];
  area: number;
}

export interface LandmarkInput {
  settings: StagedSettings;
  rng: Rng;
  landmarks: readonly LandmarkBuilding[];
  wards: readonly Ward[];
  blocks: readonly Block[];
  /** The lines a `road` landmark looks for: highways and main streets. */
  roads: ReadonlyArray<readonly Point[]>;
  /** Where a `harbour` landmark looks: the quay, if there is one. */
  quay?: readonly Point[];
  /** Reservations a person made: a block pin gives the block at its place to a landmark of its type, before any rule chooses. */
  pins?: ReadonlyArray<{ reservation: 'ward' | 'block' | 'slot'; at: Point; buildingType?: string }>;
  /** Whether a block is far enough in for a landmark: left out, any block of the town's inner wards. */
  blockOk?: (block: number) => boolean;
}

type Template = StagedSettings['landmarks']['templates'][string];

interface Fitted {
  parts: Rect[];
  outline: Point[];
}

/**
 * A template about a middle, along a direction, at a scale: its rectangles and its outline, or nothing if any
 * rectangle would not lie inside the outline of its ground.
 */
function fitted(template: Template, middle: Point, along: Point, long: number, narrow: number, scale: number, margin: number, ground: ReturnType<typeof outlineOf>): Fitted | undefined {
  const length = Math.min(template.lengthShare * long, template.length) * scale;
  const width = Math.min(template.widthShare * narrow, template.width) * scale;
  const across: Point = [-along[1], along[0]];
  const set = (x: number, y: number): Point => [middle[0] + along[0] * x + across[0] * y, middle[1] + along[1] * x + across[1] * y];
  const parts = template.parts.map(([x0, y0, x1, y1]): Rect => ({ corner: set(x0 * length, y0 * width), along, inward: across, width: (x1 - x0) * length, depth: (y1 - y0) * width }));
  if (!parts.every((part) => rectInside(widenedRect(part, margin), ground))) return undefined;
  // The outline is worked out in the template's own frame, where its rectangles meet exactly, and then set down.
  const flat = united(template.parts.map(([x0, y0, x1, y1]): Point[] => [[x0 * length, y0 * width], [x1 * length, y0 * width], [x1 * length, y1 * width], [x0 * length, y1 * width]])).rings[0] ?? [];
  const corners = flat.filter((corner, at) => {
    const before = flat[(at + flat.length - 1) % flat.length] as Point;
    const after = flat[(at + 1) % flat.length] as Point;
    return Math.abs((corner[0] - before[0]) * (after[1] - corner[1]) - (corner[1] - before[1]) * (after[0] - corner[0])) > 1e-6;
  });
  return { parts, outline: corners.map(([x, y]) => set(x, y)) };
}

export function reserve({ settings, rng, landmarks, wards, blocks, roads, quay, pins = [], blockOk }: LandmarkInput): { placed: PlacedLandmark[]; unplaced: LandmarkBuilding[] } {
  const { types, templates, block: rules } = settings.landmarks;
  const placed: PlacedLandmark[] = [];
  const unplaced: LandmarkBuilding[] = [];

  // ---- Wards ---------------------------------------------------------------------------------------------------
  for (const landmark of landmarks) {
    const mark = types[landmark.type];
    if (mark?.reservation !== 'ward') continue;
    const index = wards.findIndex((ward) => ward.kind === mark.ward);
    const ward = wards[index];
    if (!ward || placed.some((other) => other.ward === index)) {
      unplaced.push(landmark);
      continue;
    }
    const template = mark.template === undefined ? undefined : templates[mark.template];
    let found: Fitted | undefined;
    if (template) {
      const outline = outlineOf(ward.polygon);
      const box = smallestRectangle(ward.polygon);
      const [long, narrow] = [Math.hypot(box.long[0], box.long[1]), Math.hypot(box.short[0], box.short[1])];
      const middle = polygonCentroid(ward.polygon);
      const along: Point = [box.long[0] / (long || 1), box.long[1] / (long || 1)];
      for (const scale of rules.scales) {
        // A keep is as wide as it is long: both its shares are of the ward's narrow side.
        found = fitted(template, middle, along, narrow, narrow, scale, rules.margin, outline);
        if (found) break;
      }
    }
    placed.push({ building: landmark.id, type: landmark.type, ...(landmark.district !== undefined && { district: landmark.district }), reservation: 'ward', ward: index, parts: found?.parts ?? [], outline: found?.outline ?? [], area: found ? polygonArea(found.outline) : 0 });
  }

  // ---- Blocks --------------------------------------------------------------------------------------------------
  const plaza = wards.find((ward) => ward.kind === 'plaza');
  const ranks = wards.filter((ward) => ward.kind === 'ordinary').map((ward) => ward.growthRank).sort((a, b) => a - b);
  const innermost = ranks[Math.min(ranks.length - 1, Math.floor(rules.inner * ranks.length))] ?? Infinity;
  const shapes = blocks.map((block) => {
    const box = smallestRectangle(block.polygon);
    const [long, narrow] = [Math.hypot(box.long[0], box.long[1]), Math.hypot(box.short[0], box.short[1])];
    return { long, narrow, along: [box.long[0] / (long || 1), box.long[1] / (long || 1)] as Point, middle: [box.corner[0] + (box.long[0] + box.short[0]) / 2, box.corner[1] + (box.long[1] + box.short[1]) / 2] as Point };
  });
  const roomy = blocks.map((block, index) => block.area > rules.area.min && block.area < rules.area.max && (shapes[index] as { long: number }).long >= rules.long && (shapes[index] as { narrow: number }).narrow >= rules.short);
  const reserved = new Set<number>();
  const siteOf = (landmark: LandmarkBuilding): SiteKind => ({ template: types[landmark.type]?.template as string, place: types[landmark.type]?.place ?? 'road' });
  const lines = new LineIndex();
  for (const road of roads) lines.add(road);
  // Those that want the plaza choose first, then the harbour, then the rest; within each, in the city's order.
  const order = { plaza: 0, harbour: 1, road: 2 } as const;
  // Pins first: the rules fill in around them.
  const pinned = new Set<string>();
  for (const pin of pins) {
    if (pin.reservation !== 'block' || pin.buildingType === undefined) continue;
    const index = blocks.findIndex((block, at) => !reserved.has(at) && pointInPolygon(pin.at, block.polygon));
    const landmark = landmarks.find((entry) => entry.type === pin.buildingType && !pinned.has(entry.id) && types[entry.type]?.reservation === 'block');
    const template = landmark && templates[types[landmark.type]?.template as string];
    if (index < 0 || !landmark || !template) continue;
    const shape = shapes[index] as { long: number; narrow: number; along: Point; middle: Point };
    const outline = outlineOf((blocks[index] as Block).polygon);
    let found: Fitted | undefined;
    for (const scale of rules.scales) if ((found = fitted(template, shape.middle, shape.along, shape.long, shape.narrow, scale, rules.margin, outline) ?? fitted(template, polygonCentroid((blocks[index] as Block).polygon), shape.along, shape.long, shape.narrow, scale, rules.margin, outline))) break;
    if (!found) continue;
    reserved.add(index);
    pinned.add(landmark.id);
    placed.push({ building: landmark.id, type: landmark.type, ...(landmark.district !== undefined && { district: landmark.district }), reservation: 'block', site: siteOf(landmark), ward: (blocks[index] as Block).ward, block: index, parts: found.parts, outline: found.outline, area: polygonArea(found.outline) });
  }
  const wanting = landmarks
    .filter((landmark) => !pinned.has(landmark.id))
    .filter((landmark) => types[landmark.type]?.reservation === 'block')
    .map((landmark, at) => ({ landmark, at, place: types[landmark.type]?.place ?? 'road' }))
    .sort((a, b) => order[a.place] - order[b.place] || a.at - b.at);
  for (const { landmark, place } of wanting) {
    const template = templates[types[landmark.type]?.template as string] as Template;
    const away = (index: number): number => {
      const shape = shapes[index] as { middle: Point; narrow: number };
      if (place === 'plaza') return plaza ? distance(shape.middle, plaza.seed) : Math.hypot(...shape.middle);
      if (place === 'harbour' && quay) return distanceToPolyline(shape.middle, quay);
      // To the nearest highway or main street, from the block's edge as nearly as its middle and width tell.
      return Math.max((lines.nearest(shape.middle)?.distance ?? Infinity) - shape.narrow / 2, 0);
    };
    const candidates: Array<{ index: number; away: number }> = [];
    blocks.forEach((block, index) => {
      if (!roomy[index] || reserved.has(index)) return;
      if (blockOk ? !blockOk(index) : (wards[block.ward] as Ward).growthRank > innermost) return;
      candidates.push({ index, away: away(index) + rng.next() * rules.jitter });
    });
    candidates.sort((a, b) => a.away - b.away || a.index - b.index);
    let done = false;
    // First a block that holds the footprint at one of its larger sizes; failing that, at any size.
    const larger = rules.scales.slice(0, Math.ceil(rules.scales.length / 2));
    search: for (const scales of [larger, rules.scales]) {
      for (const { index } of candidates) {
        const block = blocks[index] as Block;
        // Landmarks stand apart from each other.
        if ([...reserved].some((other) => distance((shapes[other] as { middle: Point }).middle, (shapes[index] as { middle: Point }).middle) < 4 * rules.apart && distanceBetweenPolygons((blocks[other] as Block).polygon, block.polygon) < rules.apart)) continue;
        const shape = shapes[index] as { long: number; narrow: number; along: Point; middle: Point };
        const outline = outlineOf(block.polygon);
        let found: Fitted | undefined;
        fit: for (const scale of scales) {
          // About the middle of the block's box, or failing that the middle of its ground.
          for (const middle of [shape.middle, polygonCentroid(block.polygon)]) {
            found = fitted(template, middle, shape.along, shape.long, shape.narrow, scale, rules.margin, outline);
            if (found) break fit;
          }
        }
        // Where a template's rectangles overlap, as a nave and a transept do, the outline's area is the footprint's.
        if (!found || polygonArea(found.outline) < rules.leastArea) continue;
        reserved.add(index);
        placed.push({ building: landmark.id, type: landmark.type, ...(landmark.district !== undefined && { district: landmark.district }), reservation: 'block', site: siteOf(landmark), ward: block.ward, block: index, parts: found.parts, outline: found.outline, area: polygonArea(found.outline) });
        done = true;
        break search;
      }
    }
    if (!done) unplaced.push(landmark);
  }
  return { placed, unplaced };
}
