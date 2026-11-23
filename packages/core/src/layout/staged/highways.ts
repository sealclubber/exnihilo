/**
 * Stages 2 and 3 of the staged generator: highways with their bridges, and
 * the harbour.
 *
 * Every land route of the brief is a highway. Two exits nearly opposite are
 * one road through the centre. Where a highway must cross the river the
 * bridge is chosen first, square to the bank, and the road is laid onto its
 * axis. A town beside its river splits the highway to further bridges and
 * rejoins it; a town astride its river has side bridges whose roads curve
 * into the nearest highway on each bank. A sea route is a highway from the
 * centre that ends at the quay. Nothing later moves any of it.
 */
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point, SettlementBrief } from '../../schema.ts';
import { bearingDifference, bearingVector, distance, exactBearing, pointAlongPolyline, polylineLength, projectOnPolyline, slicePolyline } from '../geometry.ts';
import { chaikin, firstCrossing, normal } from '../lines.ts';
import { add, between, dot, drawFrom, left, resmooth, size, stray, tangentAt, tidy, unit } from './lines.ts';
import type { Coast, River } from './water.ts';

/** `route`: a highway to one exit, or through the centre to two. `branch`: a split to a further bridge. `bridge-road`: a side bridge's road. `quay-road`: the road to the harbour. `local`: the one road of a town with no routes. */
export type HighwayKind = 'route' | 'branch' | 'bridge-road' | 'quay-road' | 'local';

export interface Highway {
  kind: HighwayKind;
  points: Point[];
  /** The brief's routes it carries, by their place in the brief. */
  routes: number[];
  /** The bridges it crosses, by their place in the plan. */
  bridges: number[];
}

export interface Bridge {
  /** Its two ends, the first on the centre's bank. */
  a: Point;
  b: Point;
  /** The point of the river's centre line it crosses at, and how far along the river that is. */
  centre: Point;
  along: number;
  main: boolean;
}

export interface PlanExit {
  /** The route's place in the brief. */
  route: number;
  /** The bearing the exit lies on from the centre: the brief's unless water stood in the way, or the quay's for a sea route. */
  bearing: number;
  point: Point;
  /** A sea route's exit is at the end of the quay: ships leave by water. */
  atQuay: boolean;
}

export interface Harbour {
  on: 'coast' | 'river';
  /** A port has a quay with piers; a settlement with a sea route but no port has a landing with a single jetty. */
  kind: 'quay' | 'jetty';
  /** The quay's centre line and width. */
  quay: Point[];
  width: number;
  /** Each pier or jetty, from the quay out over the water, and their width. */
  piers: Array<[Point, Point]>;
  pierWidth: number;
}

export interface RoadPlan {
  highways: Highway[];
  bridges: Bridge[];
  exits: PlanExit[];
  /** The roads that run on from a bridge into the far bank of a town astride a river no route crosses. */
  mainStreets: Point[][];
  harbour?: Harbour;
  /** Whether the town stands astride its river, which passes near its centre, or beside it. */
  astride?: boolean;
  /** Whether the town takes ground across its river: only where it has a bridge. */
  farBank: boolean;
  /** What could not be done as the brief asked, for the report. */
  notes: string[];
}

export interface RoadInput {
  brief: SettlementBrief;
  settings: StagedSettings;
  /** The streams this stage draws on, by name. */
  rng: (step: string) => Rng;
  buildings: number;
  radius: number;
  reach: number;
  river?: River;
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** How finely a road is walked when the nearest point of it is looked for, in metres. */
const JOIN_STEP = 15;
/** How finely a ray or a bank is walked when a place on the shore is looked for, in metres. */
const SHORE_STEP = 5;
/** How many pieces a quay's line is drawn in. */
const QUAY_PIECES = 12;

export function planRoads(input: RoadInput): RoadPlan {
  const { brief, settings, buildings, radius, reach, river, coast } = input;
  const { highways: rules, bridges: spans } = settings;
  const highways: Highway[] = [];
  const mainStreets: Point[][] = [];
  const bridges: Bridge[] = [];
  const exits: PlanExit[] = [];
  const notes: string[] = [];
  const rng = input.rng('staged-highways');
  const amplitude = rules.wander * reach;
  const clear = settings.widths.highway / 2 + rules.waterClear;
  const home = river ? river.side(CENTRE) : 1;
  const bridgeCount = (spans.counts.find((entry) => entry.below === undefined || buildings < entry.below) ?? (spans.counts[spans.counts.length - 1] as { bridges: number })).bridges;

  /** A stretch of road kept to its own bank: wherever it comes too near the river or strays over it, it is moved out beside the bank. */
  const keptClear = (points: Point[], side: 1 | -1): Point[] => {
    if (!river) return points;
    const length = polylineLength(points);
    const fine: Point[] = [];
    for (let along = 0; along < length; along += 8) fine.push(pointAlongPolyline(points, along));
    fine.push(points[points.length - 1] as Point);
    let moved = false;
    const out = fine.map((point, at): Point => {
      if (at === 0 || at === fine.length - 1) return point;
      const found = river.nearest(point);
      const atEnd = found.along <= 0 || found.along >= river.length;
      const wrong = !atEnd && river.side(point) !== side;
      if (!wrong && found.distance - river.width / 2 >= clear) return point;
      moved = true;
      // A little further than it need be, since rounding the line afterwards draws it back in.
      if (atEnd) return add(found.point, unit(found.point, point), river.width / 2 + rules.waterPush * clear);
      return add(found.point, left(river.at(found.along).direction), -side * (river.width / 2 + rules.waterPush * clear));
    });
    return moved ? chaikin(out, 2) : points;
  };
  const coastClear = (point: Point) => !coast || coast.gap(point) > 0;

  /** Where to cross: the point of the river, not far from the centre, where it runs most nearly square to the way we are going. */
  const bridgeSite = (toward: Point): { centre: Point; along: number; across: Point } | undefined => {
    if (!river) return undefined;
    let best: { centre: Point; along: number; across: Point } | undefined;
    let most = -Infinity;
    for (let along = 0; along < river.length; along += spans.step) {
      const { point, direction } = river.at(along);
      if (size(point) > spans.search * radius || !coastClear(point)) continue;
      const across = left(direction);
      const going = unit(point, toward);
      const score = Math.abs(dot(across, going)) * spans.square - spans.near * size(point);
      if (score > most) {
        most = score;
        best = { centre: point, along, across: dot(across, going) > 0 ? across : [-across[0], -across[1]] };
      }
    }
    return best;
  };
  const makeBridge = (centre: Point, along: number, across: Point, main: boolean): number => {
    const half = (river as River).width / 2 + spans.landing;
    bridges.push({ a: add(centre, across, -half), b: add(centre, across, half), centre, along, main });
    return bridges.length - 1;
  };

  // The main crossing, once made, is used by every highway that crosses.
  let main: { bridge: number; across: Point; lead: number; fork: Point } | undefined;
  // A town is astride its river where the river passes near its centre, and beside it otherwise.
  const astride = river ? river.nearest(CENTRE).distance <= spans.astrideWithin * radius : undefined;
  /** Whether a route crosses the river. Where none does, an astride town's bridge roads end at their bridges and run on as main streets. */
  let routeCrosses = false;
  const sideBridges: Array<{ bridge: number; across: Point }> = [];
  const branches: Highway[] = [];

  /** Exit a, the centre, exit b; or the centre and exit b alone. If b lies across the river, the crossing is planned here. */
  const highwayBetween = (from: Point | undefined, to: Point, routes: number[], kind: HighwayKind = 'route') => {
    const first = from ? stray(rng, from, CENTRE, amplitude).slice(0, -1) : [];
    if (!river || !river.crossed(CENTRE, to)) {
      highways.push({ kind: 'route', points: tidy(keptClear(resmooth([...first, ...stray(rng, CENTRE, to, amplitude)], rules.step), home)), routes, bridges: [] });
      return;
    }
    if (main) {
      // A further highway over the river uses the main bridge, and leaves the first where its straight lead ends.
      highways.push({ kind: 'route', points: tidy(keptClear(resmooth(stray(rng, main.fork, to, amplitude), rules.step), -home as 1 | -1)), routes: routes.slice(-1), bridges: [main.bridge] });
      if (first.length > 0) highways.push({ kind: 'route', points: tidy(keptClear(resmooth([...first, CENTRE], rules.step), home)).reverse(), routes: routes.slice(0, 1), bridges: [] });
      return;
    }
    const site = bridgeSite(to);
    if (!site) {
      notes.push(`route ${routes.join(' and ')} must cross the river, but no crossing was found within ${spans.search} radii of the centre`);
      highways.push({ kind: 'route', points: tidy(resmooth([...first, ...stray(rng, CENTRE, to, amplitude)], rules.step)), routes, bridges: [] });
      return;
    }
    const across = site.across;
    const index = makeBridge(site.centre, site.along, across, true);
    const { a, b } = bridges[index] as Bridge;
    const gap = size(a);
    const lead = bridgeCount === 1 ? spans.lead.single : Math.min(Math.max(spans.lead.share * gap, spans.lead.min), spans.lead.max);
    main = { bridge: index, across, lead, fork: add(b, across, lead) };
    // Further bridges: beside the river the highway splits to them and rejoins; astride it they are side bridges.
    const split = astride ? CENTRE : add(a, across, -(lead - spans.splitBefore));
    const rejoin = add(b, across, lead - spans.splitBefore);
    for (let extra = 0; extra < bridgeCount - 1; extra++) {
      const sign = extra % 2 === 0 ? 1 : -1;
      const apart = Math.max(drawFrom(rng, spans.apart) * radius, spans.apartLeast);
      const along = site.along + sign * (Math.floor(extra / 2) + 1) * apart;
      if (along <= 0 || along >= river.length || !coastClear(river.at(along).point)) {
        notes.push(`bridge ${extra + 2} of ${bridgeCount} would stand beyond the river's end or in the sea, and was left out`);
        continue;
      }
      const { point, direction } = river.at(along);
      let over = left(direction);
      if (dot(over, across) < 0) over = [-over[0], -over[1]];
      const side = makeBridge(point, along, over, false);
      const ends = bridges[side] as Bridge;
      if (astride) {
        sideBridges.push({ bridge: side, across: over });
        continue;
      }
      const near = add(ends.a, over, -spans.approach);
      const beyond = add(ends.b, over, spans.approach);
      branches.push({
        kind: 'branch',
        points: tidy([...chaikin([split, between(split, near), near, add(ends.a, over, -spans.straight.side)], 4), ends.a, ends.b, ...chaikin([add(ends.b, over, spans.straight.side), beyond, between(beyond, rejoin), rejoin], 4)]),
        routes: [],
        bridges: [side],
      });
    }
    const before = gap > lead + spans.leadSlack ? [...first, CENTRE, between(CENTRE, add(a, across, -lead)), add(a, across, -lead), add(a, across, -spans.straight.main)] : [...first, CENTRE, add(a, across, -spans.straight.main)];
    const pre = keptClear(resmooth(before, rules.step), home);
    const post = keptClear(resmooth([add(b, across, spans.straight.main), add(b, across, lead), between(add(b, across, lead), to), to], rules.step), -home as 1 | -1);
    if (kind === 'bridge-road') {
      // No route crosses: the road ends at the bridge, and runs on into the far bank as a main street.
      highways.push({ kind, points: tidy([...pre, a, b]), routes, bridges: [index] });
      mainStreets.push(tidy([b, ...post]));
      return;
    }
    highways.push({ kind, points: tidy([...pre, a, b, ...post]), routes, bridges: [index] });
    // A further highway over the river leaves this one where its straight lead ends, on the road as laid.
    main.fork = projectOnPolyline(post, main.fork).point;
  };
  // ---- Exits ---------------------------------------------------------------------------------------------------
  const land = brief.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.kind !== 'sea-route');
  const seaRoutes = brief.routes.map((route, index) => ({ route, index })).filter(({ route }) => route.kind === 'sea-route');
  const exitOf = new Map<number, Point>();
  for (const { route, index } of land) {
    let bearing = route.bearing;
    let point = add(CENTRE, bearingVector(bearing), reach);
    // An exit that would fall in the water, or on a river's bank, is turned away from it: toward the town's own side of a river.
    const dry = (at: Point) => (!river || river.gap(at) >= 2 * clear) && (!coast || coast.gap(at) >= 2 * clear);
    if (!dry(point)) {
      let found = false;
      for (let turn = 1; turn <= rules.exitShift && !found; turn++) {
        for (const sign of [1, -1]) {
          const tried = add(CENTRE, bearingVector(route.bearing + sign * turn), reach);
          if (dry(tried) && !(river && river.gap(point) < 2 * clear && river.crossed(CENTRE, tried))) {
            bearing = (route.bearing + sign * turn + 360) % 360;
            point = tried;
            found = true;
            break;
          }
        }
      }
      if (!found) notes.push(`route ${index} leaves at ${route.bearing}°, into the water, and no bearing within ${rules.exitShift}° is clear of it`);
    }
    exitOf.set(index, point);
    exits.push({ route: index, bearing, point, atQuay: false });
  }

  // ---- Highways ------------------------------------------------------------------------------------------------
  const crosses = (index: number) => river !== undefined && river.crossed(CENTRE, exitOf.get(index) as Point);
  // Opposite exits make one through road, the pair nearest to opposite first. Two exits both over the river are
  // not paired: each must come back to the main bridge.
  const pairs: Array<{ a: number; b: number; off: number }> = [];
  land.forEach((one, i) => land.forEach((other, j) => {
    const apart = bearingDifference(one.route.bearing, other.route.bearing);
    if (j > i && apart > rules.through && !(crosses(one.index) && crosses(other.index))) pairs.push({ a: one.index, b: other.index, off: 180 - apart });
  }));
  pairs.sort((x, y) => x.off - y.off || x.a - y.a || x.b - y.b);
  const partner = new Map<number, number>();
  for (const { a, b } of pairs) {
    if (partner.has(a) || partner.has(b)) continue;
    partner.set(a, b).set(b, a);
  }
  const laid = new Set<number>();
  for (const { index } of land) {
    if (laid.has(index)) continue;
    laid.add(index);
    const other = partner.get(index);
    if (other === undefined) {
      highwayBetween(undefined, exitOf.get(index) as Point, [index]);
      continue;
    }
    laid.add(other);
    // The end that lies over the river is the far one.
    const [from, to] = crosses(index) ? [other, index] : [index, other];
    highwayBetween(exitOf.get(from) as Point, exitOf.get(to) as Point, [from, to]);
  }
  // A town with no land route has one local road through its centre, so that there is something to build along.
  if (land.length === 0 && seaRoutes.length === 0) {
    const bearing = rng.next() * 360;
    highways.push({ kind: 'local', points: tidy(resmooth([...stray(rng, add(CENTRE, bearingVector(bearing), 2 * radius), CENTRE, amplitude / 2).slice(0, -1), ...stray(rng, CENTRE, add(CENTRE, bearingVector(bearing + 180), 2 * radius), amplitude / 2)], rules.step)), routes: [], bridges: [] });
  }

  routeCrosses = main !== undefined;
  // Bridges stand only where a route crosses the river or the town is astride it. Astride with no route across,
  // the main bridge carries a road of its own from the centre.
  if (river && !main && astride) {
    const nearest = river.nearest(CENTRE);
    const over = nearest.distance > 1 ? unit(CENTRE, nearest.point) : left(river.at(nearest.along).direction);
    const end = add(nearest.point, over, river.width / 2 + spans.landing + spans.beyond * radius);
    // A river that only rises at the town's edge, so that the way over it leads round its source, has no bridge.
    if (!river.crossed(CENTRE, end)) notes.push('the river rises at the edge of the town, which has no bridge');
    else if (coastClear(end)) highwayBetween(undefined, end, [], 'bridge-road');
    else notes.push('the far bank of the river is in the sea, so the town has no bridge');
  }

  // A side bridge's road runs on from each end until it joins the nearest road on that bank: a highway, or on a far
  // bank no route reaches, a main street.
  for (const { bridge, across } of sideBridges) {
    const { a, b } = bridges[bridge] as Bridge;
    const legs = ([[a, -1], [b, 1]] as Array<[Point, number]>).map(([end, sign]) => {
      const out = add(end, across, sign * spans.run);
      const roads = [...highways.map((highway) => highway.points), ...mainStreets];
      // Where a road already passes in front of the bridge, the bridge's road runs straight to it and stops.
      const meets = Math.min(...roads.map((road) => firstCrossing([end, out], road) ?? Infinity));
      if (meets < Infinity) return [end, add(end, across, sign * meets)];
      let best: Point | undefined;
      let least = Infinity;
      for (const road of roads) {
        const length = polylineLength(road);
        for (let along = 0; along < length; along += JOIN_STEP) {
          const point = pointAlongPolyline(road, along);
          if (size(point) > spans.joinWithin * radius || (river as River).crossed(out, point)) continue;
          // Going on ahead is preferred to veering along the bank.
          const away = distance(out, point) + spans.veer * Math.abs(dot([point[0] - out[0], point[1] - out[1]], left(across)));
          if (away < least) {
            least = away;
            best = point;
          }
        }
      }
      const start = add(end, across, sign * spans.straight.side);
      if (!best) return [start, out];
      return keptClear(chaikin([start, out, add(between(out, best), [normal(rng), normal(rng)], spans.straight.side), best], 4), (sign < 0 ? home : -home) as 1 | -1);
    });
    if (routeCrosses) branches.push({ kind: 'bridge-road', points: tidy([...(legs[0] as Point[]).reverse(), a, b, ...(legs[1] as Point[])]), routes: [], bridges: [bridge] });
    else {
      branches.push({ kind: 'bridge-road', points: tidy([...(legs[0] as Point[]).reverse(), a, b]), routes: [], bridges: [bridge] });
      mainStreets.push(tidy([b, ...(legs[1] as Point[])]));
    }
  }
  highways.push(...branches);

  // ---- Harbour ---------------------------------------------------------------------------------------------------
  // A port has a quay with piers. A settlement with a sea route but no port flag has a landing with one jetty.
  const harbourRng = input.rng('staged-harbour');
  let harbour: Harbour | undefined;
  const { quay, piers, jetty } = settings.harbour;
  const kind: Harbour['kind'] | undefined = brief.flags.port ? 'quay' : seaRoutes.length > 0 ? 'jetty' : undefined;
  const quayLength = kind === 'jetty' ? jetty.landing : Math.min(quay.length, quay.lengthShare * radius);
  const pierCount = kind === 'jetty' ? 1 : piers.count;
  const pierLength = kind === 'jetty' ? jetty.length : (piers.length * quayLength) / quay.length;
  const pierAt = (at: number) => (pierCount === 1 ? 0.5 : piers.first + ((1 - 2 * piers.first) * at) / (pierCount - 1));
  if (kind && coast) {
    // Where the first sea route, or failing one the way to open water, meets the shore.
    const bearing = seaRoutes[0]?.route.bearing ?? (brief.coast.waterBearing as number);
    const way = bearingVector(bearing);
    let hit: Point | undefined;
    for (let out = 0; out < reach && !hit; out += SHORE_STEP) if (coast.gap(add(CENTRE, way, out)) <= 0) hit = add(CENTRE, way, out);
    const start = projectOnPolyline(coast.shore, hit ?? CENTRE).along;
    // The quay stands on the town's own side of a river, clear of its mouth.
    const fits = (along: number) => {
      const middle = pointAlongPolyline(coast.shore, along);
      return !river || (!river.crossed(CENTRE, middle) && river.gap(middle) > quayLength / 2 + clear);
    };
    let along = start;
    for (let step = 0; step * spans.step < reach && !fits(along); step++) along = start + (step % 2 === 0 ? 1 : -1) * (Math.floor(step / 2) + 1) * spans.step;
    if (!fits(along)) notes.push('the quay could not be kept clear of the river mouth');
    const strip = slicePolyline(coast.shore, along - quayLength / 2, along + quayLength / 2);
    const total = polylineLength(strip);
    const seawardAt = (at: number): Point => {
      const across = left(tangentAt(strip, at, total));
      return dot(across, coast.seaward) > 0 ? across : [-across[0], -across[1]];
    };
    const line: Point[] = [];
    for (let step = 0; step <= QUAY_PIECES; step++) line.push(add(pointAlongPolyline(strip, (total * step) / QUAY_PIECES), seawardAt((total * step) / QUAY_PIECES), -quay.inset));
    const out = Array.from({ length: pierCount }, (_, at): [Point, Point] => {
      const from = total * pierAt(at);
      const foot = add(pointAlongPolyline(strip, from), seawardAt(from), -quay.inset);
      return [foot, add(foot, seawardAt(from), quay.inset + pierLength)];
    });
    harbour = { on: 'coast', kind, quay: line, width: quay.width, piers: out, pierWidth: piers.width };
  } else if (kind && river) {
    // A wharf along the bank nearest the centre, clear of the bridges.
    let best: number | undefined;
    let least = Infinity;
    for (let along = quayLength / 2; along < river.length - quayLength / 2; along += SHORE_STEP) {
      if (bridges.some((bridge) => Math.abs(bridge.along - along) < quayLength / 2 + settings.harbour.clearOfBridge)) continue;
      const away = size(river.at(along).point);
      if (away < least) {
        least = away;
        best = along;
      }
    }
    if (best === undefined) notes.push('no stretch of the bank is clear of the bridges for a wharf');
    else {
      const offset = (at: number, by: number) => {
        const { point, direction } = river.at(at);
        return add(point, left(direction), -home * by);
      };
      const edge = river.width / 2;
      const line: Point[] = [];
      for (let step = 0; step <= QUAY_PIECES; step++) line.push(offset(best - quayLength / 2 + (quayLength * step) / QUAY_PIECES, edge + quay.inset));
      // Jetties are short, so that the channel stays open.
      const reachOut = Math.min(pierLength, settings.harbour.jettyShare * river.width);
      const out = Array.from({ length: pierCount }, (_, at): [Point, Point] => {
        const from = (best as number) - quayLength / 2 + quayLength * pierAt(at);
        return [offset(from, edge + quay.inset), offset(from, edge - reachOut)];
      });
      harbour = { on: 'river', kind, quay: line, width: quay.width, piers: out, pierWidth: piers.width };
    }
  } else if (kind === 'quay') notes.push('the settlement is flagged a port but has neither coast nor river, so it has no harbour');
  else if (kind === 'jetty') notes.push(`${seaRoutes.length} sea route${seaRoutes.length === 1 ? '' : 's'}, but neither coast nor river to land at`);
  if (harbour) {
    const middle = harbour.quay[Math.floor(harbour.quay.length / 2)] as Point;
    highways.push({ kind: 'quay-road', points: tidy(keptClear(stray(harbourRng, CENTRE, middle, Math.min(settings.harbour.wander, settings.harbour.wanderShare * size(middle))), home)), routes: seaRoutes.map(({ index }) => index), bridges: [] });
    // A sea route has its exit at the end of the quay that lies more its way: ships leave by water.
    const ends = [harbour.quay[0] as Point, harbour.quay[harbour.quay.length - 1] as Point];
    for (const { route, index } of seaRoutes) {
      const way = bearingVector(route.bearing);
      const point = dot([ends[0]![0] - middle[0], ends[0]![1] - middle[1]], way) >= dot([ends[1]![0] - middle[0], ends[1]![1] - middle[1]], way) ? (ends[0] as Point) : (ends[1] as Point);
      exits.push({ route: index, bearing: exactBearing(CENTRE, point), point, atQuay: true });
    }
    exits.sort((x, y) => x.route - y.route);
  }

  return { highways, bridges, exits, mainStreets, ...(harbour && { harbour }), ...(astride !== undefined && { astride }), farBank: bridges.length > 0, notes };
}
