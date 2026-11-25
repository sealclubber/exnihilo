/**
 * Step 3 of the village generator: the anchors, each on its own plot or site
 * before any house is placed.
 *
 * A village honours every flag of its brief, shrunk: `plaza` gives a green
 * (an oval beside the road at the centre, with a pond, the well and a lane
 * round it), which a share of other villages have too, `temple` or a chapel in the city a church in its churchyard,
 * `citadel` a manor in its own yard with a barn, a stream a mill beside its
 * crossing, `port` a landing with one jetty and a lane to it. Without a green
 * the well stands by the road at the centre. Which building types are which
 * anchor is the pack's.
 */
import type { Rng } from '../../city/random.ts';
import type { VillageSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { distancePolygonToPolyline, pointAlongPolyline, polygonsOverlap, polylineLength, projectOnPolyline } from '../geometry.ts';
import { add, between, dot, left, tangentAt, unit } from '../staged/lines.ts';
import type { Coast, River } from '../staged/water.ts';
import type { VillageInput } from './plan.ts';
import { DRY, plotAt, rectAt } from './ground.ts';
import type { Bridge, Way } from './roads.ts';

export type AnchorRole = 'green' | 'well' | 'church' | 'manor' | 'mill' | 'landing';

export interface Site {
  role: AnchorRole;
  /** The city's building it holds; none where the city has no building of the pack's types for it. */
  building?: string;
  /** Its plot or site. */
  outline: Point[];
  /** The outlines of its buildings. */
  footprints: Point[][];
  /** Barns and sheds: drawing only, no one lives or works in them. */
  drawing: Point[][];
  /** The way it fronts, by its place in the plan, and its front on it. */
  way?: number;
  front?: [Point, Point];
}

export interface Anchors {
  green?: { outline: Point[]; pond: Point[] };
  sites: Site[];
  /** The lane round the green and the lane to the landing, in that order, to follow the roads in the plan's ways. */
  lanes: Way[];
  notes: string[];
}

export interface AnchorInput {
  brief: SettlementBrief;
  settings: VillageSettings;
  input: VillageInput;
  /** Whether the village has a green: where the brief is flagged `plaza`, or by chance. */
  green: boolean;
  rng: Rng;
  /** The roads, which are the plan's first ways. */
  ways: readonly Way[];
  bridges: readonly Bridge[];
  buildings: number;
  river?: River;
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** Ways are searched for a plot in steps of this many metres. */
const STEP = 2;
/** The points an outline is tested at for water: its corners and the points between, this many to a side. */
const PER_SIDE = 4;
/** How many points an oval is drawn with. */
const OVAL = 40;
/** How far a green is moved out from the road at a time when it does not fit, and how many times. */
const GREEN_STEP = 6;
const GREEN_TRIES = 4;
/** Where along a road from the centre a green is tried, in half-lengths of the green. */
const GREEN_SHIFTS = [0, 0.5, -0.5, 1, -1];
/** The landing is looked for along the shore from the point nearest the centre, in steps of ten metres either way, this many times. */
const LANDING_TRIES = 60;

export function placeAnchors({ brief, settings, input, green: wantsGreen, rng, ways, bridges, buildings, river, coast }: AnchorInput): Anchors {
  const notes: string[] = [];
  const { anchors: rules, gap } = settings;
  const sites: Site[] = [];
  const lanes: Way[] = [];
  const occupied: Point[][] = [];
  const allWays = (): Way[] => [...ways, ...lanes];
  const lengths = new Map<Way, number>();
  const lengthOf = (way: Way) => lengths.get(way) ?? (lengths.set(way, polylineLength(way.points)), polylineLength(way.points));

  // Each anchor holds the lowest ID of the first of its types the city has.
  const taken = new Set<string>();
  const holder = (types: readonly string[]): string | undefined => {
    for (const type of types) {
      const found = input.buildings.filter((building) => building.type === type && !taken.has(building.id)).map((building) => building.id).sort()[0];
      if (found !== undefined) {
        taken.add(found);
        return found;
      }
    }
    return undefined;
  };

  /** Points along an outline, for testing against water. */
  const probes = (outline: readonly Point[]): Point[] =>
    outline.flatMap((corner, at) => Array.from({ length: PER_SIDE }, (_, k) => add(corner, unit(corner, outline[(at + 1) % outline.length] as Point), (k / PER_SIDE) * Math.hypot((outline[(at + 1) % outline.length] as Point)[0] - corner[0], (outline[(at + 1) % outline.length] as Point)[1] - corner[1]))));
  const dry = (points: readonly Point[], margin: number) => points.every((point) => (!river || river.gap(point) > margin) && (!coast || coast.gap(point) > margin));
  /** Whether an outline is clear of water, every way's roadway and everything already placed. */
  const free = (outline: readonly Point[], margin = DRY): boolean =>
    dry(probes(outline), margin) && allWays().every((way) => distancePolygonToPolyline(outline, way.points) >= way.width / 2 - 0.05) && occupied.every((other) => !polygonsOverlap(outline, other));

  /** The free plot nearest the centre fronting one of the ways given, its front's middle at least `from` metres out. */
  const nearestPlot = (onto: readonly Way[], width: number, depth: number, from: number) => {
    const candidates: Array<{ way: Way; along: number; side: 1 | -1; away: number }> = [];
    for (const way of onto) {
      const length = lengthOf(way);
      for (let along = 0; along + width <= length; along += STEP) {
        const away = Math.hypot(...pointAlongPolyline(way.points, along + width / 2));
        if (away >= from) for (const side of [1, -1] as const) candidates.push({ way, along, side, away });
      }
    }
    candidates.sort((a, b) => a.away - b.away || onto.indexOf(a.way) - onto.indexOf(b.way) || a.along - b.along || b.side - a.side);
    for (const { way, along, side } of candidates) {
      const plot = plotAt(way, lengthOf(way), along, side, width, depth, gap);
      if (plot && free(plot.outline)) return { ...plot, way };
    }
    return undefined;
  };
  const indexOf = (way: Way) => allWays().indexOf(way);

  // ---- The green, with its pond, the well and a lane round it -------------------------------------------------------
  let greenLane: Way | undefined;
  let green: Anchors['green'];
  if (wantsGreen) {
    const { length, width } = buildings >= rules.green.largeFrom ? rules.green.large : rules.green.small;
    const [half, halfWidth] = [length / 2, width / 2];
    const phase = rng.next() * 2 * Math.PI;
    // Away from the water, where there is water; otherwise either side by chance.
    const first: 1 | -1 = rng.next() < 0.5 ? 1 : -1;
    const off = settings.widths.lane / 2 + gap;
    // Beside a road at the centre, or a little way along it either side where a bend leaves no room.
    const places = ways.flatMap((road) => GREEN_SHIFTS.map((shift) => ({ road, along: projectOnPolyline(road.points, CENTRE).along + shift * half })));
    search: for (const { road, along } of places) {
      const roadLength = lengthOf(road);
      if (along < 0 || along > roadLength) continue;
      const base = pointAlongPolyline(road.points, along);
      const t0 = tangentAt(road.points, along, roadLength);
      const n = left(t0);
      let preferred: 1 | -1 = first;
      if (river) preferred = dot(n, unit(river.nearest(CENTRE).point, CENTRE)) >= 0 ? 1 : -1;
      else if (coast) preferred = dot(n, coast.seaward) <= 0 ? 1 : -1;
      for (let push = 0; push < GREEN_TRIES; push++) {
        for (const side of [preferred, -preferred as 1 | -1]) {
          const across: Point = [n[0] * side, n[1] * side];
          const middle = add(base, across, halfWidth + road.width / 2 + gap + push * GREEN_STEP);
          const at = (x: number, y: number): Point => add(add(middle, t0, x), across, y);
          const outline = Array.from({ length: OVAL }, (_, k) => {
            const angle = (2 * Math.PI * k) / OVAL;
            return at(half * Math.cos(angle) * (1 + rules.green.wobble * Math.sin(3 * angle + phase)), halfWidth * Math.sin(angle));
          });
          // The lane runs round the far side, from the road to the road; the road is the near side.
          const ring = Array.from({ length: OVAL / 2 + 1 }, (_, k) => {
            const angle = (Math.PI * k) / (OVAL / 2);
            return at((half * (1 + rules.green.wobble * Math.sin(3 * angle + phase)) + off) * Math.cos(angle), (halfWidth + off) * Math.sin(angle));
          });
          const lane: Way = { kind: 'lane', points: [projectOnPolyline(road.points, ring[0] as Point).point, ...ring, projectOnPolyline(road.points, ring[ring.length - 1] as Point).point], width: settings.widths.lane, routes: [] };
          if (!free(outline, DRY + off * 2) || !dry(lane.points, lane.width / 2 + DRY)) continue;
          const pondMiddle = at(half * rules.green.pondAlong, 0);
          const radius = Math.min(rules.green.pond, halfWidth / 2);
          const pond = Array.from({ length: OVAL / 2 }, (_, k): Point => add(pondMiddle, [Math.cos((4 * Math.PI * k) / OVAL), Math.sin((4 * Math.PI * k) / OVAL)], radius));
          green = { outline, pond };
          occupied.push(outline);
          lanes.push(lane);
          greenLane = lane;
          const holds = holder(rules.green.types);
          // A green the brief did not ask for is open ground that belongs to no building.
          if (holds === undefined && brief.flags.plaza) notes.push(`the brief is flagged plaza, but the city has no ${rules.green.types.join(' or ')} to hold the green`);
          sites.push({ role: 'green', ...(holds !== undefined && { building: holds }), outline, footprints: [], drawing: [], way: indexOf(lane) });
          // The well, in the green's middle.
          const well = holder(rules.well.types);
          const square = rectAt(add(add(middle, t0, -rules.well.side / 2), across, -rules.well.side / 2), t0, across, rules.well.side, rules.well.side);
          if (well !== undefined) sites.push({ role: 'well', building: well, outline: square, footprints: [square], drawing: [] });
          break search;
        }
      }
    }
    if (!green) notes.push('there is no room for a green beside a road at the centre');
  }

  // ---- Without a green, the well by the road at the centre ----------------------------------------------------------
  if (!green) {
    const well = holder(rules.well.types);
    if (well !== undefined) {
      const found = nearestPlot(ways, rules.well.side, rules.well.side, 0);
      if (found) {
        occupied.push(found.outline);
        sites.push({ role: 'well', building: well, outline: found.outline, footprints: [found.outline], drawing: [], way: indexOf(found.way), front: found.front });
      } else notes.push('there is no room for the well by the road at the centre');
    }
  }

  // ---- The church, by the green or the centre -----------------------------------------------------------------------
  const wantsChurch = brief.flags.temple || input.buildings.some((building) => rules.church.types.includes(building.type));
  if (wantsChurch) {
    const { width, depth } = rules.church;
    const plot = greenLane ? nearestPlot([greenLane], width, depth, 0) ?? nearestPlot(ways, width, depth, rules.church.from) : nearestPlot(ways, width, depth, rules.church.from);
    if (plot) {
      const holds = holder(rules.church.types);
      if (holds === undefined) notes.push(`the brief is flagged temple, but the city has no ${rules.church.types.join(' or ')} to hold the church`);
      // A nave along the front, a tower across it, in the middle of the churchyard.
      const { u, v } = plot;
      const middle = add(add(plot.front[0], u, width / 2), v, depth / 2);
      const nave = rectAt(add(add(middle, u, -width * 0.38), v, -depth * 0.1), u, v, width * 0.76, depth * 0.2);
      const tower = rectAt(add(add(middle, u, width * 0.09), v, -depth * 0.22), u, v, width * 0.18, depth * 0.44);
      occupied.push(plot.outline);
      sites.push({ role: 'church', ...(holds !== undefined && { building: holds }), outline: plot.outline, footprints: [nave, tower], drawing: [], way: indexOf(plot.way), front: plot.front });
    } else notes.push('there is no room for the church');
  }

  // ---- The manor, in its own yard with a barn -----------------------------------------------------------------------
  if (brief.flags.citadel) {
    const { width, depth } = rules.manor;
    const plot = nearestPlot(ways, width, depth, rules.manor.from);
    if (plot) {
      const holds = holder(rules.manor.types);
      if (holds === undefined) notes.push(`the brief is flagged citadel, but the city has no ${rules.manor.types.join(' or ')} to hold the manor`);
      const { u, v } = plot;
      const corner = add(add(plot.front[0], u, width * 0.26), v, depth * 0.3);
      const hall = rectAt(corner, u, v, width * 0.48, depth * 0.16);
      const wing = rectAt(add(corner, v, depth * 0.16), u, v, width * 0.14, depth * 0.19);
      const barn = rectAt(add(add(plot.front[0], u, width * 0.66), v, depth * 0.76), u, v, width * 0.22, depth * 0.11);
      occupied.push(plot.outline);
      sites.push({ role: 'manor', ...(holds !== undefined && { building: holds }), outline: plot.outline, footprints: [hall, wing], drawing: [barn], way: indexOf(plot.way), front: plot.front });
    } else notes.push('there is no room for the manor');
  }

  // ---- The mill, beside the stream's crossing -----------------------------------------------------------------------
  if (river) {
    // By the crossing nearest the centre; where no road crosses, by the bank nearest the centre.
    const crossing = [...bridges].sort((a, b) => Math.hypot(...a.centre) - Math.hypot(...b.centre))[0];
    const from = river.nearest(crossing ? crossing.centre : CENTRE).along;
    const { length, width, along } = rules.mill;
    let placed: Point[] | undefined;
    for (const step of [along, -along, 2 * along, -2 * along]) {
      for (const bank of [1, -1] as const) {
        const at = from + step;
        if (at < 0 || at > river.length) continue;
        const { point, direction } = river.at(at);
        const out: Point = [left(direction)[0] * bank, left(direction)[1] * bank];
        const site = rectAt(add(add(point, direction, -length / 2), out, river.width / 2 + DRY), direction, out, length, width);
        if (free(site, 0)) {
          placed = site;
          break;
        }
      }
      if (placed) break;
    }
    if (placed) {
      const holds = holder(rules.mill.types);
      if (holds === undefined) notes.push(`the village has a stream, but the city has no ${rules.mill.types.join(' or ')} to hold the mill`);
      occupied.push(placed);
      sites.push({ role: 'mill', ...(holds !== undefined && { building: holds }), outline: placed, footprints: [placed], drawing: [] });
    } else notes.push('there is no room for the mill beside the stream');
    if (!crossing) notes.push('no road crosses the stream: the mill stands by the bank nearest the centre');
  }

  // ---- The landing: one jetty, and a lane to it ---------------------------------------------------------------------
  if (brief.flags.port) {
    const shore = coast ? coast.shore : river?.line;
    if (!shore || (!coast && !river)) notes.push('the brief is flagged port, but the village has no water for a landing');
    else {
      const shoreLength = polylineLength(shore);
      const nearest = projectOnPolyline(shore, CENTRE).along;
      const { length, width } = rules.landing;
      let done = false;
      for (let k = 0; k < LANDING_TRIES && !done; k++) {
        const at = nearest + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 10;
        if (at < 0 || at > shoreLength) continue;
        const onShore = pointAlongPolyline(shore, at);
        const outward = coast ? coast.seaward : unit(CENTRE, onShore);
        const edge = coast ? onShore : add(onShore, outward, -(river as River).width / 2);
        const reach = coast ? length : Math.min(length, (river as River).width * 0.4);
        const foot = add(edge, outward, -2);
        const jetty = rectAt(add(foot, left(outward), -width / 2), outward, left(outward), reach + 2, width);
        // The lane comes from the nearest point of a road.
        const start = ways.map((way) => projectOnPolyline(way.points, foot)).sort((a, b) => a.distance - b.distance)[0];
        if (!start) break;
        const lane: Way = { kind: 'lane', points: [start.point, foot], width: settings.widths.lane, routes: [] };
        const clear = occupied.every((other) => distancePolygonToPolyline(other, lane.points) >= lane.width / 2) && dry([between(start.point, foot, 0.5)], lane.width / 2);
        if (!clear) continue;
        const holds = holder(rules.landing.types);
        if (holds === undefined) notes.push(`the brief is flagged port, but the city has no ${rules.landing.types.join(' or ')} to hold the landing`);
        lanes.push(lane);
        sites.push({ role: 'landing', ...(holds !== undefined && { building: holds }), outline: jetty, footprints: [], drawing: [], way: indexOf(lane), front: [jetty[0] as Point, jetty[3] as Point] });
        done = true;
      }
      if (!done) notes.push('there is no clear way to the shore for the landing');
    }
  }
  return { ...(green && { green }), sites, lanes, notes };
}
