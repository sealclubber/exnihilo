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
import { bearingDifference, bearingVector, distance, pointAlongPolyline, polylineLength, projectOnPolyline, slicePolyline } from '../geometry.ts';
import { chaikin, normal } from '../lines.ts';
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
  /** The bearing the exit lies on, which is the brief's unless a river stood in the way. */
  bearing: number;
  point: Point;
}

export interface Harbour {
  on: 'coast' | 'river';
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
  harbour?: Harbour;
  /** Whether the town stands astride its river: only known where a highway crosses it. */
  astride?: boolean;
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

export function planRoads(input: RoadInput): RoadPlan {
  const { brief, settings, buildings, radius, reach, river, coast } = input;
  const { highways: rules, bridges: spans } = settings;
  const highways: Highway[] = [];
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
      if (atEnd) return add(found.point, unit(found.point, point), river.width / 2 + 1.25 * clear);
      return add(found.point, left(river.at(found.along).direction), -side * (river.width / 2 + 1.25 * clear));
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
  let astride: boolean | undefined;
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
    astride = gap <= spans.astrideWithin;
    main = { bridge: index, across, lead, fork: add(b, across, lead) };
    // Further bridges: beside the river the highway splits to them and rejoins; astride it they are side bridges.
    const split = astride ? CENTRE : add(a, across, -(lead - 15));
    const rejoin = add(b, across, lead - 15);
    const wallRadius = Math.sqrt((settings.wall.share * buildings * settings.wall.perBuilding * settings.wall.ratio.several) / Math.PI);
    for (let extra = 0; extra < bridgeCount - 1; extra++) {
      const sign = extra % 2 === 0 ? 1 : -1;
      const apart = astride
        ? Math.min(Math.max(spans.astrideApart.share * wallRadius, spans.astrideApart.min), spans.astrideApart.max) * drawFrom(rng, spans.astrideApart.vary)
        : drawFrom(rng, spans.apart);
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
        points: tidy([...chaikin([split, between(split, near), near, add(ends.a, over, -8)], 4), ends.a, ends.b, ...chaikin([add(ends.b, over, 8), beyond, between(beyond, rejoin), rejoin], 4)]),
        routes: [],
        bridges: [side],
      });
    }
    const before = gap > lead + 20 ? [...first, CENTRE, between(CENTRE, add(a, across, -lead)), add(a, across, -lead), add(a, across, -12)] : [...first, CENTRE, add(a, across, -12)];
    const pre = keptClear(resmooth(before, rules.step), home);
    const post = keptClear(resmooth([add(b, across, 12), add(b, across, lead), between(add(b, across, lead), to), to], rules.step), -home as 1 | -1);
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
    exits.push({ route: index, bearing, point });
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

  // A town on a river has its bridges whether or not a route crosses: the main bridge then carries a road of its
  // own from the centre, which runs on a way into the far bank and ends there.
  if (river && !main) {
    const nearest = river.nearest(CENTRE);
    const over = nearest.distance > 1 ? unit(CENTRE, nearest.point) : left(river.at(nearest.along).direction);
    const end = add(nearest.point, over, river.width / 2 + spans.landing + spans.beyond * radius);
    // A river that only rises at the town's edge, so that the way over it leads round its source, has no bridge.
    if (!river.crossed(CENTRE, end)) notes.push('the river rises at the edge of the town, which has no bridge');
    else if (coastClear(end)) highwayBetween(undefined, end, [], 'bridge-road');
    else notes.push('the far bank of the river is in the sea, so the town has no bridge');
  }

  // A side bridge's road runs on from each end until it joins the nearest highway on that bank.
  for (const { bridge, across } of sideBridges) {
    const { a, b } = bridges[bridge] as Bridge;
    const legs = ([[a, -1], [b, 1]] as Array<[Point, number]>).map(([end, sign]) => {
      const out = add(end, across, sign * spans.run);
      let best: Point | undefined;
      let least = Infinity;
      for (const highway of highways) {
        const length = polylineLength(highway.points);
        for (let along = 0; along < length; along += 15) {
          const point = pointAlongPolyline(highway.points, along);
          if (size(point) > spans.joinWithin * radius || (river as River).crossed(out, point)) continue;
          // Going on ahead is preferred to veering along the bank.
          const away = distance(out, point) + spans.veer * Math.abs(dot([point[0] - out[0], point[1] - out[1]], left(across)));
          if (away < least) {
            least = away;
            best = point;
          }
        }
      }
      const start = add(end, across, sign * 8);
      if (!best) return [start, out];
      return keptClear(chaikin([start, out, add(between(out, best), [normal(rng), normal(rng)], 8), best], 4), (sign < 0 ? home : -home) as 1 | -1);
    });
    branches.push({ kind: 'bridge-road', points: tidy([...(legs[0] as Point[]).reverse(), a, b, ...(legs[1] as Point[])]), routes: [], bridges: [bridge] });
  }
  highways.push(...branches);

  // ---- Harbour ---------------------------------------------------------------------------------------------------
  const harbourRng = input.rng('staged-harbour');
  let harbour: Harbour | undefined;
  const { quay, piers } = settings.harbour;
  const quayLength = Math.min(quay.length, quay.lengthShare * radius);
  const scale = quayLength / quay.length;
  if (brief.flags.port && coast) {
    // Where the first sea route, or failing one the way to open water, meets the shore.
    const bearing = seaRoutes[0]?.route.bearing ?? (brief.coast.waterBearing as number);
    const way = bearingVector(bearing);
    let hit: Point | undefined;
    for (let out = 0; out < reach && !hit; out += 5) if (coast.gap(add(CENTRE, way, out)) <= 0) hit = add(CENTRE, way, out);
    const start = projectOnPolyline(coast.shore, hit ?? CENTRE).along;
    // The quay stands on the town's own side of a river, clear of its mouth.
    const fits = (along: number) => {
      const middle = pointAlongPolyline(coast.shore, along);
      return !river || (!river.crossed(CENTRE, middle) && river.gap(middle) > quayLength / 2 + clear);
    };
    let along = start;
    for (let step = 0; step * 20 < reach && !fits(along); step++) along = start + (step % 2 === 0 ? 1 : -1) * (Math.floor(step / 2) + 1) * 20;
    if (!fits(along)) notes.push('the quay could not be kept clear of the river mouth');
    const strip = slicePolyline(coast.shore, along - quayLength / 2, along + quayLength / 2);
    const total = polylineLength(strip);
    const seawardAt = (at: number): Point => {
      const across = left(tangentAt(strip, at, total));
      return dot(across, coast.seaward) > 0 ? across : [-across[0], -across[1]];
    };
    const line: Point[] = [];
    for (let step = 0; step <= 12; step++) line.push(add(pointAlongPolyline(strip, (total * step) / 12), seawardAt((total * step) / 12), -quay.inset));
    const out = Array.from({ length: piers.count }, (_, at): [Point, Point] => {
      const from = total * (piers.count === 1 ? 0.5 : 0.2 + (0.6 * at) / (piers.count - 1));
      const foot = add(pointAlongPolyline(strip, from), seawardAt(from), -quay.inset);
      return [foot, add(foot, seawardAt(from), piers.length * scale)];
    });
    harbour = { on: 'coast', quay: line, width: quay.width, piers: out, pierWidth: piers.width };
  } else if (brief.flags.port && river) {
    // A wharf along the bank nearest the centre, clear of the bridges.
    let best: number | undefined;
    let least = Infinity;
    for (let along = quayLength / 2; along < river.length - quayLength / 2; along += 10) {
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
      for (let step = 0; step <= 12; step++) line.push(offset(best - quayLength / 2 + (quayLength * step) / 12, edge + quay.inset));
      const reachOut = Math.min(piers.length * scale, settings.harbour.jettyShare * river.width);
      const out = Array.from({ length: piers.count }, (_, at): [Point, Point] => {
        const from = (best as number) - quayLength / 2 + quayLength * (piers.count === 1 ? 0.5 : 0.2 + (0.6 * at) / (piers.count - 1));
        return [offset(from, edge + quay.inset), offset(from, edge - reachOut)];
      });
      harbour = { on: 'river', quay: line, width: quay.width, piers: out, pierWidth: piers.width };
    }
  } else if (brief.flags.port) notes.push('the settlement is flagged a port but has neither coast nor river, so it has no harbour');
  if (harbour) {
    const middle = harbour.quay[Math.floor(harbour.quay.length / 2)] as Point;
    highways.push({ kind: 'quay-road', points: tidy(keptClear(stray(harbourRng, CENTRE, middle, Math.min(settings.harbour.wander, 0.1 * size(middle))), home)), routes: seaRoutes.map(({ index }) => index), bridges: [] });
  } else if (seaRoutes.length > 0) notes.push(`${seaRoutes.length} sea route${seaRoutes.length === 1 ? '' : 's'} with no harbour to end at: the settlement ${brief.flags.port ? 'has no water' : 'is not flagged a port'}`);

  return { highways, bridges, exits, ...(harbour && { harbour }), ...(astride !== undefined && { astride }), notes };
}
