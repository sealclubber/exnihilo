/**
 * Step 5 of the village generator: plots, outward from the centre.
 *
 * Every way is walked along both sides from its point nearest the centre,
 * and plots are laid side by side, each with its house at the front, set
 * back a little, and garden behind. The next plot always goes to the way
 * whose walk is nearest the centre, so the village grows outward evenly. The
 * buildings are taken largest lot first, so the larger a building's lot the
 * nearer the centre and the wider its plot. From the pack's `row.from`
 * buildings, plots near the centre are narrow and their houses join into a
 * terraced row; they go to the buildings with small lots. Some wider plots
 * are farmsteads with a barn and a shed: drawing only.
 *
 * A road is built no farther than the cap each way. What does not fit is left
 * for step 6, which adds lanes and walks on.
 */
import type { Rng } from '../../city/random.ts';
import { type SettingPack, type VillageSettings, footprintCoverageOf, lotSizeOf, placeFlagsOf } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { pointAlongPolyline, polygonArea, polygonWithin, projectOnPolyline } from '../geometry.ts';
import { add, drawFrom } from '../staged/lines.ts';
import { type Fronted, type Ground, plotAt, rectAt } from './ground.ts';
import type { Way } from './roads.ts';

export interface Plot {
  building: string;
  /** The way it fronts, by its place in the plan, and its front on it. */
  way: number;
  outline: Point[];
  front: [Point, Point];
  /** The outlines of its buildings: the house, or nothing for an open-air place with no building. */
  footprints: Point[][];
  /** Barns and sheds: drawing only. */
  drawing: Point[][];
  /** In the terraced row at the centre. */
  row: boolean;
}

interface Cursor {
  way: number;
  along: number;
  side: 1 | -1;
  direction: 1 | -1;
}

const CENTRE: Point = [0, 0];
/** A plot on a bend is kept only if its area is at least this share of a rectangle's. */
const LEAST_AREA = 0.5;

export interface PlotInput {
  settings: VillageSettings;
  pack: SettingPack;
  rng: Rng;
  ground: Ground;
  cap: number;
  /** How many buildings the village has in all, which decides its rows. */
  buildings: number;
  /** The buildings still to place: those no anchor holds. */
  toPlace: ReadonlyArray<{ id: string; type: string }>;
}

/** Lays plots outward from the centre. `walk` places as many as the ways allow; `addWay` lets it walk a new one. */
export class PlotWalker {
  readonly plots: Plot[] = [];
  /** How much farther than the pack's reach a lane's plots may go, once step 6 has had to reach farther. */
  reachScale = 1;
  private readonly remaining: Array<{ id: string; type: string; area: number; small: boolean }>;
  private readonly widthShare = new Map<string, number>();
  private readonly cursors: Cursor[] = [];
  private readonly types = new Map<string, string>();
  private readonly centreAlong = new Map<number, number>();

  private readonly input: PlotInput;

  constructor(input: PlotInput) {
    this.input = input;
    const { pack, settings, toPlace } = input;
    for (const building of toPlace) this.types.set(building.id, building.type);
    const sized = toPlace.map((building) => {
      const lot = lotSizeOf(building.type, pack);
      return { ...building, area: lot.frontage * lot.depth, small: lot.frontage <= settings.plots.row.most };
    });
    // Largest lot first; the same lot by ID.
    sized.sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1));
    this.remaining = sized;
    // A building's place in that order is how wide its plot is, as a share of the span of widths.
    sized.forEach((building, at) => this.widthShare.set(building.id, sized.length > 1 ? 1 - at / (sized.length - 1) : 0.5));
    input.ground.ways.forEach((_, index) => this.addWay(index));
  }

  /** Takes plots away, their buildings to be placed again. */
  release(outlines: ReadonlySet<Point[]>): void {
    const freed = this.plots.filter((plot) => outlines.has(plot.outline));
    if (freed.length === 0) return;
    const kept = this.plots.filter((plot) => !outlines.has(plot.outline));
    this.plots.length = 0;
    this.plots.push(...kept);
    const { pack, settings } = this.input;
    for (const plot of freed) {
      const type = this.types.get(plot.building) as string;
      const lot = lotSizeOf(type, pack);
      this.remaining.push({ id: plot.building, type, area: lot.frontage * lot.depth, small: lot.frontage <= settings.plots.row.most });
    }
    this.remaining.sort((a, b) => b.area - a.area || (a.id < b.id ? -1 : 1));
  }

  get unplaced(): string[] {
    return this.remaining.map((building) => building.id);
  }

  /** Walks a way along both sides from its point nearest the centre, each way along it. */
  addWay(index: number): void {
    const way = this.input.ground.ways[index] as Way;
    const along = projectOnPolyline(way.points, CENTRE).along;
    this.centreAlong.set(index, along);
    for (const side of [1, -1] as const) for (const direction of [1, -1] as const) this.cursors.push({ way: index, along, side, direction });
  }

  private live(cursor: Cursor): boolean {
    const { ground, cap, settings } = this.input;
    const way = ground.ways[cursor.way] as Way;
    if (cursor.along < 0 || cursor.along > ground.lengthOf(way)) return false;
    if (way.kind === 'road') return Math.abs(cursor.along - (this.centreAlong.get(cursor.way) as number)) <= cap;
    return Math.hypot(...pointAlongPolyline(way.points, cursor.along)) <= settings.plots.laneReach * cap * this.reachScale;
  }

  /** How near the centre a walk is, a road's weighted in a village large enough to fork. */
  private nearness(cursor: Cursor): number {
    const { ground, settings, buildings } = this.input;
    const way = ground.ways[cursor.way] as Way;
    const away = Math.hypot(...pointAlongPolyline(way.points, cursor.along));
    return way.kind === 'road' ? away * (buildings >= settings.forks.from ? settings.plots.roadWeight : 1) : away + settings.plots.lanePenalty;
  }

  /** Places plots until every building has one or no walk can go on. */
  walk(): void {
    const { ground, settings, rng, buildings } = this.input;
    const rules = settings.plots;
    for (;;) {
      if (this.remaining.length === 0) return;
      let best: Cursor | undefined;
      let nearest = Infinity;
      for (const cursor of this.cursors) {
        if (!this.live(cursor)) continue;
        const near = this.nearness(cursor);
        if (near < nearest) {
          nearest = near;
          best = cursor;
        }
      }
      if (!best) return;
      const way = ground.ways[best.way] as Way;
      const length = ground.lengthOf(way);
      const away = Math.hypot(...pointAlongPolyline(way.points, best.along));
      // In the row at the centre, the largest building with a small lot; otherwise the largest.
      const inRow = buildings >= rules.row.from && away < rules.row.within && this.remaining.some((building) => building.small);
      const pick = inRow ? this.remaining.findIndex((building) => building.small) : 0;
      const building = this.remaining[pick] as (typeof this.remaining)[number];
      const share = Math.min(Math.max((this.widthShare.get(building.id) as number) + (rng.next() * 2 - 1) * rules.jitter, 0), 1);
      const width = inRow ? drawFrom(rng, rules.row.width) : rules.width.min + (rules.width.max - rules.width.min) * share;
      const depth = drawFrom(rng, inRow ? rules.row.plot : buildings >= rules.largeFrom ? rules.largeDepth : rules.depth);
      const start = best.direction > 0 ? best.along : best.along - width;
      const plot = plotAt(way, length, start, best.side, width, depth, settings.gap);
      const built = plot && polygonArea(plot.outline) >= LEAST_AREA * width * depth && ground.free(plot.outline) ? this.build(plot, building, width, depth, inRow) : undefined;
      if (!plot || !built) {
        best.along += best.direction * rules.step;
        continue;
      }
      ground.occupy(plot.outline, true);
      this.plots.push({ building: building.id, way: best.way, outline: plot.outline, front: plot.front, ...built, row: inRow });
      this.remaining.splice(pick, 1);
      best.along += best.direction * (width + (inRow ? 0 : drawFrom(rng, rules.spacing)));
    }
  }

  /** The house on a plot, and any barn and shed; nothing if the house will not lie inside the plot. */
  private build(plot: Fronted, building: { type: string }, width: number, depth: number, inRow: boolean): { footprints: Point[][]; drawing: Point[][] } | undefined {
    const { settings, pack, rng } = this.input;
    const { house: rules, farmstead, row } = settings.plots;
    const { front, u, v, outline } = plot;
    const corner = front[0];
    const inside = (shape: Point[]) => polygonWithin(shape, outline);
    // A small thing in the open, as a well: a square at the middle of the front.
    if (settings.anchors.well.types.includes(building.type)) {
      const side = Math.min(settings.anchors.well.footprint, width, depth);
      const square = rectAt(add(add(corner, u, (width - side) / 2), v, rules.margin), u, v, side, side);
      return inside(square) ? { footprints: [square], drawing: [] } : undefined;
    }
    // An open-air place is built over only as far back as the pack's coverage for its type: none by default.
    if (placeFlagsOf(building.type, pack).openAir) {
      const coverage = footprintCoverageOf(building.type, pack);
      if (coverage <= 0) return { footprints: [], drawing: [] };
      const shed = rectAt(add(add(corner, u, rules.margin), v, rules.margin), u, v, width - 2 * rules.margin, Math.min(depth * coverage, depth - 2 * rules.margin));
      return inside(shed) ? { footprints: [shed], drawing: [] } : undefined;
    }
    if (inRow) {
      const house = rectAt(add(corner, v, rules.margin / 2), u, v, width, drawFrom(rng, row.depth));
      // On a bend a row house may not fill its plot to the corners; it is narrowed to fit.
      if (inside(house)) return { footprints: [house], drawing: [] };
      const narrowed = rectAt(add(add(corner, u, rules.margin / 2), v, rules.margin / 2), u, v, width - rules.margin, drawFrom(rng, row.depth));
      return inside(narrowed) ? { footprints: [narrowed], drawing: [] } : undefined;
    }
    let houseWidth = Math.min(width - 2 * rules.margin, drawFrom(rng, rules.width));
    let houseDepth = drawFrom(rng, rules.depth);
    if (rng.next() < rules.turned) [houseWidth, houseDepth] = [Math.min(houseDepth, width - 2 * rules.margin), Math.min(houseWidth, depth / 2)];
    const setBack = drawFrom(rng, rules.setBack);
    const offset = rules.margin + rng.next() * Math.max(width - houseWidth - 2 * rules.margin, 0);
    let house = rectAt(add(add(corner, u, offset), v, setBack), u, v, houseWidth, houseDepth);
    if (!inside(house)) {
      // On a bend: in the middle of the front, as near the front as it may stand.
      house = rectAt(add(add(corner, u, (width - houseWidth) / 2), v, rules.margin), u, v, houseWidth, houseDepth);
      if (!inside(house)) return undefined;
    }
    const drawing: Point[][] = [];
    if (width > farmstead.wider && rng.next() < farmstead.share) {
      const barnWidth = Math.min(drawFrom(rng, farmstead.barn.width), width - 2 * rules.margin);
      const barnDepth = drawFrom(rng, farmstead.barn.depth);
      const barn = rectAt(add(add(corner, u, rules.margin + rng.next() * (width - barnWidth - 2 * rules.margin)), v, setBack + houseDepth + drawFrom(rng, farmstead.barn.behind)), u, v, barnWidth, barnDepth);
      if (inside(barn)) drawing.push(barn);
      if (rng.next() < farmstead.shed.share) {
        const shed = rectAt(add(add(corner, u, rules.margin + rng.next() * (width - farmstead.shed.width - 2 * rules.margin)), v, depth - farmstead.shed.depth - rules.margin), u, v, farmstead.shed.width, farmstead.shed.depth);
        if (inside(shed)) drawing.push(shed);
      }
    }
    return { footprints: [house], drawing };
  }
}
