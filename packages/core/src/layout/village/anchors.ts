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
import { distancePolygonToPolyline, pointAlongPolyline, polygonWithin, polygonsOverlap, polylineLength, projectOnPolyline } from '../geometry.ts';
import { add, between, dot, left, tangentAt, unit } from '../staged/lines.ts';
import type { Coast, River } from '../staged/water.ts';
import type { VillageInput } from './plan.ts';
import { DRY, type Fronted, plotAt, rectAt } from './ground.ts';
import { grown, united } from '../staged/shapes.ts';
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
  /** The lane round the green, the lane to the mill and the lanes to the landing, in that order, to follow the roads in the plan's ways. */
  lanes: Way[];
  /** Where each sea route leaves: the ends of the lanes to the landing. */
  quays: Point[];
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
/** How far inside the green's edge the well may stand, in metres, nearest first: its site must lie wholly on the green. */
const WELL_IN = [0.1, 0.5, 1, 1.5, 2];
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
    dry(probes(outline), margin) && allWays().every((way) => distancePolygonToPolyline(outline, way.points) >= way.width / 2 + 0.01) && occupied.every((other) => !polygonsOverlap(outline, other));

  /** The free plot nearest the centre fronting one of the ways given, its front's middle at least `from` metres out. */
  const nearestPlot = (onto: readonly Way[], width: number, depth: number, from: number, accept: (plot: Fronted) => boolean = () => true) => {
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
      if (plot && free(plot.outline) && accept(plot)) return { ...plot, way };
    }
    return undefined;
  };
  const indexOf = (way: Way) => allWays().indexOf(way);
  /** Whether a lane keeps out of the water and off everything placed but the sites it serves, which it may touch. */
  const laneClear = (lane: Way, serves: readonly Point[][]): boolean => {
    const length = polylineLength(lane.points);
    const samples = Array.from({ length: Math.max(2, Math.ceil(length / 2) + 1) }, (_, k) => pointAlongPolyline(lane.points, (length * k) / Math.max(1, Math.ceil(length / 2))));
    if (!dry(samples, lane.width / 2 + DRY)) return false;
    if (green && distancePolygonToPolyline(green.outline, lane.points) < lane.width / 2 + gap) return false;
    return serves.every((site) => distancePolygonToPolyline(site, lane.points) >= lane.width / 2) && occupied.every((other) => distancePolygonToPolyline(other, lane.points) >= lane.width / 2 + gap);
  };

  // ---- The green, with its pond, the well and a lane round it -------------------------------------------------------
  let greenLane: Way | undefined;
  let wellPlaced = false;
  /** The well the city has, not yet given a site. */
  const wellType = () => rules.well.types.flatMap((type) => input.buildings.filter((building) => building.type === type && !taken.has(building.id)).map((building) => building.id).sort()).at(0);
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
          // The lane runs round the far side, from the road to the road, a lane's half width and the gap off the green;
          // the road is the near side.
          const ring = farSide(grown([outline], off, true).rings, (point) => projectOnPolyline(road.points, point).distance > road.width / 2 + off);
          if (ring.length < 2) continue;
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
          // The well, on the green at its edge where a way comes nearest, so that it is reached from that way.
          const well = wellType();
          if (well !== undefined) {
            const side = rules.well.side;
            const edges = outline.map((corner, k) => {
              const nearest = [road, lane].map((way) => ({ way, distance: projectOnPolyline(way.points, corner).distance })).sort((a, b) => a.distance - b.distance)[0] as { way: Way; distance: number };
              return { k, corner, ...nearest };
            });
            edges.sort((a, b) => a.distance - b.distance || a.k - b.k);
            well: for (const { k, corner, way } of edges) {
              const u = unit(outline[(k + OVAL - 1) % OVAL] as Point, outline[(k + 1) % OVAL] as Point);
              const v = unit(corner, middle);
              for (const inset of WELL_IN) {
                const square = rectAt(add(add(corner, u, -side / 2), v, inset), u, v, side, side);
                if (!polygonWithin(square, outline)) continue;
                taken.add(well);
                wellPlaced = true;
                sites.push({ role: 'well', building: well, outline: square, footprints: [wellIn(square[0] as Point, u, v, side, rules.well.footprint)], drawing: [], way: indexOf(way), front: [square[0] as Point, square[1] as Point] });
                break well;
              }
            }
          }
          break search;
        }
      }
    }
    if (!green) notes.push('there is no room for a green beside a road at the centre');
  }

  // ---- Without a green, or with no room on it, the well by the road at the centre -------------------------------------
  if (!wellPlaced) {
    const well = holder(rules.well.types);
    if (well !== undefined) {
      const found = nearestPlot(ways, rules.well.side, rules.well.side, 0, (plot) => polygonWithin(wellIn(plot.front[0], plot.u, plot.v, rules.well.side, rules.well.footprint), plot.outline));
      if (found) {
        occupied.push(found.outline);
        sites.push({ role: 'well', building: well, outline: found.outline, footprints: [wellIn(found.front[0], found.u, found.v, rules.well.side, rules.well.footprint)], drawing: [], way: indexOf(found.way), front: found.front });
      } else notes.push('there is no room for the well by the road at the centre');
    }
  }

  // ---- The church, by the green or the centre -----------------------------------------------------------------------
  const wantsChurch = brief.flags.temple || input.buildings.some((building) => rules.church.types.includes(building.type));
  if (wantsChurch) {
    const { width, depth } = rules.church;
    // A nave along the front, a tower across it, in the middle of the churchyard, made one outline.
    const churchOn = ({ front, u, v }: Fronted): Point[] => {
      const middle = add(add(front[0], u, width / 2), v, depth / 2);
      const nave = rectAt(add(add(middle, u, -width * 0.38), v, -depth * 0.1), u, v, width * 0.76, depth * 0.2);
      const tower = rectAt(add(add(middle, u, width * 0.09), v, -depth * 0.22), u, v, width * 0.18, depth * 0.44);
      return united([nave, tower]).rings[0] ?? nave;
    };
    const fits = (plot: Fronted) => polygonWithin(churchOn(plot), plot.outline);
    const plot = (greenLane && nearestPlot([greenLane], width, depth, 0, fits)) ?? nearestPlot(ways, width, depth, rules.church.from, fits);
    if (plot) {
      const holds = holder(rules.church.types);
      if (holds === undefined) notes.push(`the brief is flagged temple, but the city has no ${rules.church.types.join(' or ')} to hold the church`);
      occupied.push(plot.outline);
      sites.push({ role: 'church', ...(holds !== undefined && { building: holds }), outline: plot.outline, footprints: [churchOn(plot)], drawing: [], way: indexOf(plot.way), front: plot.front });
    } else notes.push('there is no room for the church');
  }

  // ---- The manor, in its own yard with a barn -----------------------------------------------------------------------
  if (brief.flags.citadel) {
    const { width, depth } = rules.manor;
    const manorOn = ({ front, u, v }: Fronted) => {
      const corner = add(add(front[0], u, width * 0.26), v, depth * 0.3);
      const hall = rectAt(corner, u, v, width * 0.48, depth * 0.16);
      const wing = rectAt(add(corner, v, depth * 0.16), u, v, width * 0.14, depth * 0.19);
      const barn = rectAt(add(add(front[0], u, width * 0.66), v, depth * 0.76), u, v, width * 0.22, depth * 0.11);
      return { house: united([hall, wing]).rings[0] ?? hall, barn };
    };
    const plot = nearestPlot(ways, width, depth, rules.manor.from, (candidate) => {
      const { house, barn } = manorOn(candidate);
      return polygonWithin(house, candidate.outline) && polygonWithin(barn, candidate.outline);
    });
    if (plot) {
      const holds = holder(rules.manor.types);
      if (holds === undefined) notes.push(`the brief is flagged citadel, but the city has no ${rules.manor.types.join(' or ')} to hold the manor`);
      const { house, barn } = manorOn(plot);
      occupied.push(plot.outline);
      sites.push({ role: 'manor', ...(holds !== undefined && { building: holds }), outline: plot.outline, footprints: [house], drawing: [barn], way: indexOf(plot.way), front: plot.front });
    } else notes.push('there is no room for the manor');
  }

  // ---- The mill, beside the stream's crossing, with a lane to it ---------------------------------------------------------
  if (river) {
    // By the crossing nearest the centre; where no road crosses, by the bank nearest the centre.
    const crossing = [...bridges].sort((a, b) => Math.hypot(...a.centre) - Math.hypot(...b.centre))[0];
    const from = river.nearest(crossing ? crossing.centre : CENTRE).along;
    const { length, width, along } = rules.mill;
    const laneWidth = settings.widths.lane;
    let placed: { site: Point[]; lane: Way; front: [Point, Point] } | undefined;
    search: for (const step of [along, -along, 2 * along, -2 * along, 3 * along, -3 * along]) {
      for (const bank of [1, -1] as const) {
        const at = from + step;
        if (at < 0 || at > river.length) continue;
        const { point, direction } = river.at(at);
        const out: Point = [left(direction)[0] * bank, left(direction)[1] * bank];
        const site = rectAt(add(add(point, direction, -length / 2), out, river.width / 2 + DRY), direction, out, length, width);
        if (!free(site, 0)) continue;
        // The lane comes to the middle of its landward side from the nearest way.
        const front: [Point, Point] = [site[3] as Point, site[2] as Point];
        const end = add(between(front[0], front[1], 0.5), out, laneWidth / 2 + gap);
        const start = allWays().map((way) => projectOnPolyline(way.points, end)).sort((a, b) => a.distance - b.distance)[0];
        if (!start) continue;
        const lane: Way = { kind: 'lane', points: start.distance < 0.01 ? [end, add(end, out, 1)] : [start.point, end], width: laneWidth, routes: [] };
        if (!laneClear(lane, [site])) continue;
        placed = { site, lane, front };
        break search;
      }
    }
    if (placed) {
      const holds = holder(rules.mill.types);
      if (holds === undefined) notes.push(`the village has a stream, but the city has no ${rules.mill.types.join(' or ')} to hold the mill`);
      occupied.push(placed.site);
      lanes.push(placed.lane);
      sites.push({ role: 'mill', ...(holds !== undefined && { building: holds }), outline: placed.site, footprints: [placed.site], drawing: [], way: indexOf(placed.lane), front: placed.front });
    } else notes.push('there is no room for the mill beside the stream');
    if (!crossing) notes.push('no road crosses the stream: the mill stands by the bank nearest the centre');
  }

  // ---- The landing: a lane to the shore, the landing's ground at its end, one jetty, and the quay for each sea route ---
  const quays: Point[] = [];
  const seaRoutes = brief.routes.filter((route) => route.kind === 'sea-route').length;
  if (brief.flags.port || seaRoutes > 0) {
    const shore = coast ? coast.shore : river?.line;
    if (!shore) notes.push('the brief is flagged port or has a sea route, but the village has no water for a landing');
    else {
      const shoreLength = polylineLength(shore);
      const nearest = projectOnPolyline(shore, CENTRE).along;
      const { length, width, site: ground } = rules.landing;
      const laneWidth = settings.widths.lane;
      let done = false;
      for (let k = 0; k < LANDING_TRIES && !done; k++) {
        const at = nearest + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 10;
        if (at < 0 || at > shoreLength) continue;
        const onShore = pointAlongPolyline(shore, at);
        const outward = coast ? coast.seaward : unit(CENTRE, onShore);
        const across = left(outward);
        const edge = coast ? onShore : add(onShore, outward, -(river as River).width / 2);
        const reach = coast ? length : Math.min(length, (river as River).width * 0.4);
        // A lane from the nearest road to just short of the water, and the landing's ground beside it at the shore end.
        const end = add(edge, outward, -(laneWidth / 2 + 1));
        const start = ways.map((way) => ({ way, ...projectOnPolyline(way.points, end) })).sort((a, b) => a.distance - b.distance)[0];
        if (!start || start.distance < start.way.width / 2 + gap + ground.width + 1) continue;
        const lane: Way = { kind: 'lane', points: [start.point, end], width: laneWidth, routes: [] };
        const laneLength = polylineLength(lane.points);
        const sited = ([1, -1] as const).map((side) => plotAt(lane, laneLength, laneLength - ground.width, side, ground.width, ground.depth, gap)).find((plot) => plot && free(plot.outline));
        if (!sited || !laneClear(lane, [sited.outline])) continue;
        const site = sited.outline;
        // A second sea route leaves from its own quay, along the shore from the first.
        const stubs: Way[] = [];
        for (let extra = 1; extra < seaRoutes; extra++) {
          const side = extra % 2 === 1 ? 1 : -1;
          const reachOut = ground.width / 2 + laneWidth * (Math.ceil(extra / 2) + 1);
          stubs.push({ kind: 'lane', points: [end, add(end, across, side * reachOut)], width: laneWidth, routes: [] });
        }
        if (!stubs.every((stub) => laneClear(stub, [site]))) continue;
        const holds = holder(rules.landing.types);
        if (holds === undefined && brief.flags.port) notes.push(`the brief is flagged port, but the city has no ${rules.landing.types.join(' or ')} to hold the landing`);
        const jetty = rectAt(add(edge, across, -width / 2), outward, across, reach + 1, width);
        occupied.push(site);
        lanes.push(lane, ...stubs);
        quays.push(end, ...stubs.map((stub) => stub.points[1] as Point));
        sites.push({ role: 'landing', ...(holds !== undefined && { building: holds }), outline: site, footprints: [], drawing: [jetty], way: indexOf(lane), front: sited.front });
        done = true;
      }
      if (!done) notes.push('there is no clear way to the shore for the landing');
    }
  }
  return { ...(green && { green }), sites, lanes, quays, notes };
}

/** A well's footprint, in the middle of its square site. */
export function wellIn(corner: Point, u: Point, v: Point, side: number, footprint: number): Point[] {
  const inset = (side - Math.min(footprint, side)) / 2;
  return rectAt(add(add(corner, u, inset), v, inset), u, v, Math.min(footprint, side), Math.min(footprint, side));
}

/** The longest run of a ring's points that are all far from something, in order from one end to the other. */
function farSide(rings: readonly Point[][], isFar: (point: Point) => boolean): Point[] {
  const ring = rings.reduce<Point[]>((best, one) => (one.length > best.length ? one : best), []);
  const far = ring.map(isFar);
  // Begin just after a near point, so that the far points run on without a break.
  const start = far.findIndex((isFar, k) => isFar && !far[(k + ring.length - 1) % ring.length]);
  if (start < 0) return [];
  const out: Point[] = [];
  for (let k = 0; k < ring.length && far[(start + k) % ring.length]; k++) out.push(ring[(start + k) % ring.length] as Point);
  return out;
}
