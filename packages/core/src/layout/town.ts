/**
 * The ground plan of a grown town, before any building: steps 1 to 8 of the
 * method of phase 6D.3.
 *
 * 1. Water, as phase 6D.1 made it.
 * 2. Highways, each crossing a river on a bridge square to the bank, and
 * 3. arterials branching off them (`roads.ts`);
 * 4. a second bridge in a large town, and 5. a street along each bank.
 * 6. Ground, as much as the buildings need, cheapest first (`ground.ts`).
 * 7. Arterials cut back to the town's edge.
 * 8. Wards: what the roads cut the ground into (`wards.ts`).
 *
 * Every number comes from the pack's `grown` block; randomness from streams
 * named `grown-…`.
 */
import { type Rng, stepRng } from '../city/random.ts';
import type { GrownSettings, SettingPack } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { inside, offsetLine, simplify, simplifyRing, toEdge, toLine, untangle } from './cutting.ts';
import { type Ground, TooSmall, layGround } from './ground.ts';
import { alongOf } from './lines.ts';
import { type Road, type RoadPlan, planRoads } from './roads.ts';
import { type Cut, type Wards, VERGE, layWards, roadStrip } from './wards.ts';
import { type Coast, type River, makeCoast, makeRiver } from './water.ts';

export { TooSmall };

/** What the town's size and flags ask of its ground plan. */
export interface TownNeeds {
  /** The pack lot area of every building but the plaza's, in square metres. */
  lotArea: number;
  /** The plaza's area, or 0 for none. */
  plazaArea: number;
  /** The lot area of the central districts, for how far out a coast stands. */
  centralLotArea: number;
  /** How many times the usual ground to lay out: more each time a layout proves too small. */
  room: number;
  /** A wall round the oldest share of the ground, smoothed over so many metres; a share of 1 encloses it all. */
  wall?: { share: number; smoothing: number; width: number };
}

/** The plaza: open ground at the centre, with a street round it, or round three sides where it stands beside a road. */
export interface Plaza {
  polygon: Point[];
  /** The street round it: a loop, or for a plaza beside a road a line from the road round it and back. */
  ring: Point[];
  closed: boolean;
}

export interface Town {
  river?: River;
  coast?: Coast;
  dryBy: (point: Point) => number;
  plan: RoadPlan;
  ground: Ground;
  /** The town's radius: that of a circle of the ground it needs. */
  radius: number;
  /** Every line that cut the ground, and the strips taken out round them. */
  cuts: Cut[];
  /** The outlines taken out of the ground before it was cut: the sea's. */
  removed: Point[][];
  wards: Wards;
  plaza?: Plaza;
  /** The wall's line, a loop. */
  wall?: Point[];
  /** The street along the outside of the wall, in stretches where the town and dry ground are. */
  wallStreet?: Point[][];
}

/** The river's water and a clear strip either side of it, as a closed outline. */
function riverStrip(river: River, clear: number): Point[] {
  const left: Point[] = [];
  const right: Point[] = [];
  river.line.forEach((point, index) => {
    const next = river.line[Math.min(index + 1, river.line.length - 1)] as Point;
    const before = river.line[Math.max(index - 1, 0)] as Point;
    const run = Math.hypot(next[0] - before[0], next[1] - before[1]) || 1;
    const across: Point = [-(next[1] - before[1]) / run, (next[0] - before[0]) / run];
    const half = (river.widths[index] as number) / 2 + clear;
    left.push([point[0] + across[0] * half, point[1] + across[1] * half]);
    right.push([point[0] - across[0] * half, point[1] - across[1] * half]);
  });
  // Round at each end, as the water's own reach is where a river rises or ends in town.
  const cap = (end: Point, toward: Point, half: number): Point[] => {
    const run = Math.hypot(end[0] - toward[0], end[1] - toward[1]) || 1;
    const out: Point = [(end[0] - toward[0]) / run, (end[1] - toward[1]) / run];
    const side: Point = [-out[1], out[0]];
    const reach = half / Math.cos(Math.PI / 32);
    return Array.from({ length: 15 }, (_, k) => {
      const angle = (Math.PI * (k + 1)) / 16;
      return [end[0] + (out[0] * Math.sin(angle) + side[0] * Math.cos(angle)) * reach, end[1] + (out[1] * Math.sin(angle) + side[1] * Math.cos(angle)) * reach] as Point;
    });
  };
  const line = river.line;
  const last = line.length - 1;
  const halfAt = (index: number) => (river.widths[index] as number) / 2 + clear;
  return simplifyRing([...untangle(left), ...cap(line[last] as Point, line[last - 1] as Point, halfAt(last)), ...untangle(right).reverse(), ...cap(line[0] as Point, line[1] as Point, halfAt(0))], 0.1);
}

export function layTown(brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, needs: TownNeeds): Town {
  const rngOf = (step: string): Rng => stepRng(seed, step);
  const widths = grown.widths;
  const needed = needs.lotArea / grown.ground.fill + needs.plazaArea;
  const radius = Math.sqrt(needed / Math.PI);
  const plazaRadius = Math.sqrt(needs.plazaArea / Math.PI);
  const extent = 2.4 * radius * needs.room;
  // Highways run out past anything the town could reach, to where their exits will be.
  const far = extent + grown.highways.beyond + 100;

  // ---- 1. Water -------------------------------------------------------------------------------------------------
  const river = makeRiver(brief, pack.layout.riverWidth, grown.river, seed, plazaRadius + grown.river.beside + pack.layout.riverWidth, far * 1.6);
  if (brief.river && !river) throw new Error(`${brief.id} (${brief.name}): the brief has a river with no bearing to place it by`);
  let coast: Coast | undefined;
  if (brief.coast.waterBearing !== undefined) coast = makeCoast(brief, grown.coast, seed, Math.sqrt((needs.centralLotArea / grown.ground.fill + needs.plazaArea) / Math.PI) + grown.river.beside, far * 1.3);
  const dryBy = (point: Point) => Math.min(river ? river.gap(point) : Infinity, coast ? coast.gap(point) : Infinity);
  if (dryBy([0, 0]) < widths.highway) throw new Error(`${brief.id} (${brief.name}): the town centre is under water`);

  // ---- 2 to 5. Roads -------------------------------------------------------------------------------------------
  const plan = planRoads({ brief, settings: grown, rng: rngOf, far, radius, dryBy, ...(river && { river }), ...(coast && { coast }) });
  const isTrunk = (road: Road) => road.kind === 'highway' || road.kind === 'quay' || road.kind === 'local';

  // ---- 6. Ground ---------------------------------------------------------------------------------------------------
  const ground = layGround({
    settings: grown,
    rng: rngOf('grown-ground'),
    trunks: plan.roads.filter(isTrunk).map((road) => road.points),
    arterials: plan.roads.filter((road) => road.kind === 'arterial').map((road) => road.points),
    beyondBridges: plan.roads.flatMap((road) => road.bridges.map(([, b]) => road.points.slice(road.points.indexOf(b)))).filter((line) => line.length >= 2),
    dryBy,
    needed,
    extent,
  });
  const outlines = ground.outlines;

  // ---- 7. Arterials cut back to the town's edge ------------------------------------------------------------------
  // Each runs from where it leaves its road to where it first stands more than `trim` metres out of town; on a
  // bridge it is over water, which does not count. One that starts out of town, or is left too short, is dropped.
  const out = (point: Point) => dryBy(point) > 0 && outlines.every((outline) => !inside(point, outline) && toEdge(point, outline) > grown.arterials.trim);
  plan.roads = plan.roads.flatMap((road) => {
    if (road.kind !== 'arterial' && road.kind !== 'bank') return [road];
    let points = road.points;
    if (road.kind === 'arterial' && out(points[0] as Point)) return [];
    // One that ends in town, short of the water and of any other road, runs on straight until it is out of it.
    const end = points[points.length - 1] as Point;
    const onOther = plan.roads.some((other) => other !== road && toLine(end, other.points) < 1e-3);
    if (road.kind === 'arterial' && !out(end) && !onOther && dryBy(end) > grown.arterials.bank + 2) {
      const before = points[points.length - 2] as Point;
      const run = Math.hypot(end[0] - before[0], end[1] - before[1]) || 1;
      const step: Point = [((end[0] - before[0]) / run) * 5, ((end[1] - before[1]) / run) * 5];
      let reach = end;
      for (let guard = 0; guard < 400 && !out(reach) && dryBy(reach) > grown.arterials.bank; guard++) reach = [reach[0] + step[0], reach[1] + step[1]];
      points = [...points, reach];
    }
    let kept = points;
    for (let at = 1; at < points.length; at++) {
      if (!out(points[at] as Point)) continue;
      // Where between the last corner in town and this one it leaves.
      const [from, to] = [points[at - 1] as Point, points[at] as Point];
      let [low, high] = [0, 1];
      for (let step = 0; step < 30; step++) {
        const middle = (low + high) / 2;
        if (out([from[0] + (to[0] - from[0]) * middle, from[1] + (to[1] - from[1]) * middle])) high = middle;
        else low = middle;
      }
      kept = [...points.slice(0, at), [from[0] + (to[0] - from[0]) * high, from[1] + (to[1] - from[1]) * high]];
      break;
    }
    if (road.kind === 'bank') return [road];
    // A bridge whose far end was cut off goes, with the stretch over the water before it.
    const bridges = road.bridges.filter(([a, b]) => kept.includes(a) && kept.includes(b));
    const lost = road.bridges.find(([a, b]) => kept.includes(a) && !kept.includes(b));
    if (lost) kept = kept.slice(0, kept.indexOf(lost[0]));
    if (kept.length < 2 || (alongOf(kept)[kept.length - 1] as number) < grown.arterials.shortest) return [];
    return [{ ...road, points: kept, bridges }];
  });
  // Roads now in other places: indices into `roads` change once arterials are dropped.
  plan.trunks = plan.roads.map((road, index) => (isTrunk(road) ? index : -1)).filter((index) => index >= 0);

  // ---- The plaza -------------------------------------------------------------------------------------------------
  // Where the highways meet, a square with a street all round it, the highways ending on that street; where one
  // road runs through the centre, a square beside it with a street round its other three sides.
  let plaza: Plaza | undefined;
  /** The highways as they ran before a plaza's street cut them short: they still part the ground through the centre. */
  const before = new Map<Road, Point[]>(plan.roads.map((road) => [road, road.points]));
  if (needs.plazaArea > 0) {
    const arms = plan.roads.filter((road) => road.kind === 'highway' || road.kind === 'local');
    const first = arms[0];
    const ahead = first ? pointAt(first.points, 20) : ([0, -1] as Point);
    const run = Math.hypot(ahead[0], ahead[1]) || 1;
    const along: Point = [ahead[0] / run, ahead[1] / run];
    const aside: Point = [-along[1], along[0]];
    const long = Math.sqrt(needs.plazaArea * PLAZA_ASPECT);
    const short = needs.plazaArea / long;
    const gap = widths.street / 2 + VERGE;
    const frame = (u: number, v: number, side = 1): Point => [along[0] * u + aside[0] * v * side, along[1] * u + aside[1] * v * side];
    if (arms.length === 2) {
      // Beside the road, on the side further from water, clear of the road's own roadway all along.
      const road = arms[0] as Road;
      const other = arms[1] as Road;
      const line = [...[...road.points].reverse(), ...other.points.slice(1)];
      const side = dryBy(frame(0, widths.highway + short, 1)) >= dryBy(frame(0, widths.highway + short, -1)) ? 1 : -1;
      let near = widths.highway / 2 + VERGE;
      for (let guard = 0; guard < 20; guard++) {
        const edge = [-long / 2, -long / 4, 0, long / 4, long / 2].map((u) => frame(u, near, side));
        const least = Math.min(...edge.map((point) => toLine(point, line)));
        if (least >= widths.highway / 2 + VERGE + 0.05) break;
        near += widths.highway / 2 + VERGE + 0.1 - least;
      }
      const far = near + short;
      const polygon = [frame(-long / 2, near, side), frame(long / 2, near, side), frame(long / 2, far, side), frame(-long / 2, far, side)];
      const endOf = (u: number) => {
        const corner = frame(u, near, side);
        return projectOnLine(line, corner);
      };
      const ring = [endOf(-long / 2 - gap), frame(-long / 2 - gap, far + gap, side), frame(long / 2 + gap, far + gap, side), endOf(long / 2 + gap)];
      plaza = { polygon: side > 0 ? polygon : [...polygon].reverse(), ring, closed: false };
      // No arterial leaves the road where the plaza stands.
      plan.roads = plan.roads.filter((road) => road.kind !== 'arterial' || !nearPlaza(road.points[0] as Point, ring, gap + widths.arterial));
    } else {
      const polygon = [frame(-long / 2, -short / 2), frame(long / 2, -short / 2), frame(long / 2, short / 2), frame(-long / 2, short / 2)];
      // Far enough out that the roadway of a highway ending on it does not reach the square.
      const gap = widths.highway / 2 + VERGE;
      const ring = [frame(-long / 2 - gap, -short / 2 - gap), frame(long / 2 + gap, -short / 2 - gap), frame(long / 2 + gap, short / 2 + gap), frame(-long / 2 - gap, short / 2 + gap)];
      plaza = { polygon, ring, closed: true };
      // The highways and any arterial that starts inside it begin at the street round it.
      for (const road of plan.roads) {
        if ((road.kind !== 'highway' && road.kind !== 'local' && road.kind !== 'arterial') || !inside(road.points[0] as Point, ring)) continue;
        road.points = fromLoop(road.points, ring);
      }
      plan.roads = plan.roads.filter((road) => road.points.length >= 2);
    }
  }

  // ---- The wall ------------------------------------------------------------------------------------------------
  let wall: Point[] | undefined;
  if (needs.wall) {
    wall = ground.oldest(needs.wall.share, needs.wall.smoothing);
    if (!wall || !inside([0, 0], wall)) throw new TooSmall('the wall');
    if (plaza && plaza.ring.some((point) => !inside(point, wall as Point[]) || toEdge(point, wall as Point[]) < needs.wall!.width)) throw new TooSmall('the wall');
  }
  // A street along the outside of the wall, linking the roads outside it to the gates.
  let wallStreet: Point[][] | undefined;
  if (wall && needs.wall && needs.wall.share < 1) {
    const loop = wall;
    const reach = needs.wall.width / 2 + widths.street / 2 + 2 * VERGE;
    let outer = offsetLine([...loop, loop[0] as Point, loop[1] as Point], reach).slice(1, -1);
    if (inside(outer[0] as Point, loop)) outer = offsetLine([...loop, loop[0] as Point, loop[1] as Point], -reach).slice(1, -1);
    // Up to the street along a bank, and a little way past the town's edge, to meet the roads that end there.
    const farOut = (point: Point) => outlines.every((outline) => !inside(point, outline) && toEdge(point, outline) > 5 * grown.arterials.trim);
    const keep = (point: Point) => !farOut(point) && dryBy(point) > grown.ground.waterClear && !inside(point, loop);
    const runs: Point[][] = [];
    let run: Point[] = [];
    const start = outer.findIndex((point) => !keep(point));
    if (start < 0) runs.push([...outer, outer[0] as Point]);
    else {
      for (let k = 1; k <= outer.length; k++) {
        const point = outer[(start + k) % outer.length] as Point;
        const last = run[run.length - 1];
        // A stretch whose straight line from the last corner touches water starts afresh.
        const wetBetween = last !== undefined && [0.25, 0.5, 0.75].some((t) => dryBy([last[0] + (point[0] - last[0]) * t, last[1] + (point[1] - last[1]) * t]) <= grown.ground.waterClear);
        if (wetBetween) {
          if (run.length >= 2) runs.push(run);
          run = [];
        }
        if (keep(point)) run.push(point);
        else {
          if (run.length >= 2) runs.push(run);
          run = [];
        }
      }
      if (run.length >= 2) runs.push(run);
    }
    wallStreet = runs.filter((line) => (alongOf(line)[line.length - 1] as number) > grown.arterials.shortest);
  }

  // ---- 8. Wards ------------------------------------------------------------------------------------------------
  const cuts: Cut[] = [];
  const removed: Point[][] = [];
  if (coast) {
    // The sea and a clear strip along the shore.
    const clear = grown.ground.waterClear;
    const shore = coast.shore.map((point): Point => [point[0] - coast.seaward[0] * clear, point[1] - coast.seaward[1] * clear]);
    const last = coast.polygon.slice(coast.shore.length);
    removed.push(simplifyRing([...shore, ...last], 0.1));
  }
  if (river) {
    cuts.push({ points: simplify(river.line, 0.2), closed: false, splits: true });
    cuts.push({ points: [], closed: true, strip: riverStrip(river, grown.ground.waterClear), splits: false });
  }
  // Highways split the ground as lines through the centre: those paired through it, then the rest from it.
  const trunks = plan.roads.filter((road) => road.kind === 'highway' || road.kind === 'local');
  const throughLines: Point[][] = [];
  const used = new Set<Road>();
  const full = (road: Road) => before.get(road) ?? road.points;
  for (const one of trunks) {
    const other = one.partner === undefined ? undefined : plan.roads[one.partner];
    if (used.has(one) || !other || used.has(other)) continue;
    used.add(one).add(other);
    throughLines.push([...[...full(one)].reverse(), ...full(other).slice(1)]);
  }
  // With none paired, the first two make one line through the centre all the same, for splitting the ground.
  if (throughLines.length === 0 && trunks.length >= 2) {
    const [one, other] = trunks as [Road, Road];
    used.add(one).add(other);
    throughLines.push([...[...full(one)].reverse(), ...full(other).slice(1)]);
  }
  // A single highway, ending at the centre, parts the ground as a line running on straight beyond it.
  if (throughLines.length === 0 && trunks.length === 1) {
    const [one] = trunks as [Road];
    const points = full(one);
    const start = points[0] as Point;
    const next = points[1] as Point;
    const run = Math.hypot(next[0] - start[0], next[1] - start[1]) || 1;
    used.add(one);
    const beyond: Point = [start[0] - ((next[0] - start[0]) / run) * far, start[1] - ((next[1] - start[1]) / run) * far];
    throughLines.push([beyond, ...points]);
    // The highway's line runs on beyond the centre as a street, as far as the town goes.
    let street = stopShort([start, beyond], out, dryBy, widths.street / 2 + grown.ground.waterClear);
    // Beyond a plaza's street, where there is one.
    if (plaza?.closed && street.length >= 2) street = fromLoop(street, plaza.ring);
    if (street.length >= 2) plan.roads.push({ kind: 'street', points: street, width: widths.street, bridges: [] });
  }
  // A line that stops short of the water runs on into it, so that it parts the ground right up to the shore.
  const toWater = (line: Point[]) => {
    const out = [...line];
    const reach = 3 * widths.highway + grown.ground.waterClear;
    for (const [end, next] of [
      [0, 1],
      [out.length - 1, out.length - 2],
    ] as const) {
      const point = out[end] as Point;
      const gap = dryBy(point);
      if (gap > reach) continue;
      const before = out[next] as Point;
      const run = Math.hypot(point[0] - before[0], point[1] - before[1]) || 1;
      out[end] = [point[0] + ((point[0] - before[0]) / run) * (gap + 2), point[1] + ((point[1] - before[1]) / run) * (gap + 2)];
    }
    return out;
  };
  for (const line of throughLines) cuts.push({ points: toWater(line), closed: false, splits: true });
  for (const road of trunks) if (!used.has(road)) cuts.push({ points: toWater(full(road)), closed: false, splits: true });
  // The street round a plaza at the centre, across the highways; what it encloses is one face again.
  if (plaza?.closed) cuts.push({ points: plaza.ring, closed: true, splits: true });
  // Quays and bank streets split the ground next, then arterials, which may end on them, in the order they were laid.
  for (const kinds of [['quay', 'bank'], ['arterial']]) for (const road of plan.roads) if (kinds.includes(road.kind)) cuts.push({ points: toWater(road.points), closed: false, splits: true });
  // A plaza beside the road: the street round it splits the ground after the road it leaves.
  if (plaza && !plaza.closed) cuts.push({ points: plaza.ring, closed: false, splits: true });
  // The wall, last: a loop; and the street outside it.
  if (wall) cuts.push({ points: wall, closed: true, splits: true });
  for (const line of wallStreet ?? []) {
    const loop = line.length > 3 && line[0] === line[line.length - 1];
    cuts.push({ points: loop ? line.slice(0, -1) : toWater(line), closed: loop, splits: true });
    for (const piece of inPieces(line, loop)) cuts.push({ points: piece, closed: false, strip: roadStrip(piece, widths.street), splits: false });
  }
  // Every road's strip at its own width, the street round the plaza's, and the wall's in pieces.
  for (const road of plan.roads) cuts.push({ points: road.points, closed: false, strip: roadStrip(road.points, road.width), splits: false });
  if (plaza) {
    const ring = plaza.closed ? [...plaza.ring, plaza.ring[0] as Point] : plaza.ring;
    for (const piece of inPieces(ring, plaza.closed)) cuts.push({ points: piece, closed: false, strip: roadStrip(piece, widths.street), splits: false });
  }
  if (wall && needs.wall) for (const piece of inPieces([...wall, wall[0] as Point], true)) cuts.push({ points: piece, closed: false, strip: roadStrip(piece, needs.wall.width), splits: false });
  const roadLines = [...plan.roads.map((road) => road.points), ...(plaza ? [plaza.closed ? [...plaza.ring, plaza.ring[0] as Point] : plaza.ring] : []), ...(wallStreet ?? [])];
  const wards = layWards({
    settings: grown,
    rng: rngOf('grown-wards'),
    ground: outlines,
    removed,
    cuts,
    ...(plaza && { reserved: plaza.polygon, ...(plaza.closed && { reservedRing: plaza.ring }) }),
    streetWidth: widths.street,
    dryBy,
    onRoad: (point) => roadLines.some((line) => toLine(point, line) < 1e-4 + VERGE),
  });
  return { ...(river && { river }), ...(coast && { coast }), dryBy, plan, ground, radius, cuts, removed, wards, ...(plaza && { plaza }), ...(wall && { wall }), ...(wallStreet && { wallStreet }) };
}

/** How long a plaza is for its width. */
const PLAZA_ASPECT = 1.4;
/** How long the pieces are that a loop's strip is taken out in, so that each piece's strip is a plain outline. */
const STRIP_PIECE = 80;

/** A line in overlapping pieces of about `STRIP_PIECE` metres. */
function inPieces(line: Point[], closed: boolean): Point[][] {
  const pieces: Point[][] = [];
  let piece: Point[] = [line[0] as Point];
  let run = 0;
  for (let k = 1; k < line.length; k++) {
    const point = line[k] as Point;
    run += Math.hypot(point[0] - (piece[piece.length - 1] as Point)[0], point[1] - (piece[piece.length - 1] as Point)[1]);
    piece.push(point);
    if (run >= STRIP_PIECE && k < line.length - 1) {
      pieces.push(piece);
      piece = [point];
      run = 0;
    }
  }
  if (piece.length >= 2) pieces.push(piece);
  void closed;
  return pieces;
}

/** The point a distance along a line from its start. */
function pointAt(points: readonly Point[], distance: number): Point {
  let left = distance;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (left <= run && run > 0) return [a[0] + ((b[0] - a[0]) * left) / run, a[1] + ((b[1] - a[1]) * left) / run];
    left -= run;
  }
  return points[points.length - 1] as Point;
}

/** The nearest point of a line to a point. */
function projectOnLine(line: readonly Point[], point: Point): Point {
  let best: Point = line[0] as Point;
  let gap = Infinity;
  for (let k = 1; k < line.length; k++) {
    const a = line[k - 1] as Point;
    const b = line[k] as Point;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span));
    const near: Point = [a[0] + dx * t, a[1] + dy * t];
    const away = Math.hypot(near[0] - point[0], near[1] - point[1]);
    if (away < gap) {
      gap = away;
      best = near;
    }
  }
  return best;
}

/** Whether a point is within some distance of a set of points' hull, roughly: of any of the points or inside them. */
function nearPlaza(point: Point, around: readonly Point[], reach: number): boolean {
  if (inside(point, around)) return true;
  return around.some((corner, k) => {
    const next = around[(k + 1) % around.length] as Point;
    const dx = next[0] - corner[0];
    const dy = next[1] - corner[1];
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - corner[0]) * dx + (point[1] - corner[1]) * dy) / span));
    return Math.hypot(corner[0] + dx * t - point[0], corner[1] + dy * t - point[1]) < reach;
  });
}

/** A line that starts inside a loop, begun instead where it first leaves it. */
function fromLoop(points: Point[], loop: readonly Point[]): Point[] {
  const closed = [...loop, loop[0] as Point];
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    for (let m = 1; m < closed.length; m++) {
      const c = closed[m - 1] as Point;
      const d = closed[m] as Point;
      const denominator = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
      if (denominator === 0) continue;
      const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denominator;
      const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denominator;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return [[a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ...points.slice(k)];
    }
  }
  return [];
}


/** Every road and street of a town's ground plan, with what each is: the ways a lot may open onto. */
export function waysOf(town: Town, grown: GrownSettings): Array<{ points: Point[]; width: number; kind: 'highway' | 'quay' | 'arterial' | 'street' }> {
  return [
    ...town.plan.roads.map((road) => ({ points: road.points, width: road.width, kind: road.kind === 'highway' || road.kind === 'local' ? ('highway' as const) : road.kind === 'quay' ? ('quay' as const) : road.kind === 'arterial' ? ('arterial' as const) : ('street' as const) })),
    ...town.wards.streets.map((points) => ({ points, width: grown.widths.street, kind: 'street' as const })),
  ];
}

/** A line from its start up to where it first leaves town or comes within `wet` of water. */
function stopShort(line: Point[], out: (point: Point) => boolean, dryBy: (point: Point) => number, wet: number): Point[] {
  const [from, to] = line as [Point, Point];
  const run = Math.hypot(to[0] - from[0], to[1] - from[1]);
  let reach = 0;
  for (let along = 2; along <= run; along += 2) {
    const point: Point = [from[0] + ((to[0] - from[0]) * along) / run, from[1] + ((to[1] - from[1]) * along) / run];
    if (out(point) || dryBy(point) < wet) break;
    reach = along;
  }
  return reach < 10 ? [] : [from, [from[0] + ((to[0] - from[0]) * reach) / run, from[1] + ((to[1] - from[1]) * reach) / run]];
}
