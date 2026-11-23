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
import { inside, simplify, simplifyRing, toEdge, toLine, untangle } from './cutting.ts';
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
  return simplifyRing([...untangle(left), ...untangle(right).reverse()], 0.1);
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
  for (const one of trunks) {
    const other = one.partner === undefined ? undefined : plan.roads[one.partner];
    if (used.has(one) || !other || used.has(other)) continue;
    used.add(one).add(other);
    throughLines.push([...[...one.points].reverse(), ...other.points.slice(1)]);
  }
  // With none paired, the first two make one line through the centre all the same, for splitting the ground.
  if (throughLines.length === 0 && trunks.length >= 2) {
    const [one, other] = trunks as [Road, Road];
    used.add(one).add(other);
    throughLines.push([...[...one.points].reverse(), ...other.points.slice(1)]);
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
  for (const road of trunks) if (!used.has(road)) cuts.push({ points: toWater(road.points), closed: false, splits: true });
  // Quays and bank streets split the ground next, then arterials, which may end on them, in the order they were laid.
  for (const kinds of [['quay', 'bank'], ['arterial']]) for (const road of plan.roads) if (kinds.includes(road.kind)) cuts.push({ points: toWater(road.points), closed: false, splits: true });
  // Every road's strip at its own width.
  for (const road of plan.roads) cuts.push({ points: road.points, closed: false, strip: roadStrip(road.points, road.width), splits: false });
  const roadLines = plan.roads.map((road) => road.points);
  const wards = layWards({
    settings: grown,
    rng: rngOf('grown-wards'),
    ground: outlines,
    removed,
    cuts,
    streetWidth: widths.street,
    onRoad: (point) => roadLines.some((line) => toLine(point, line) < 1e-4 + VERGE),
  });
  return { ...(river && { river }), ...(coast && { coast }), dryBy, plan, ground, radius, cuts, removed, wards };
}


/** Every road and street of a town's ground plan, with what each is: the ways a lot may open onto. */
export function waysOf(town: Town, grown: GrownSettings): Array<{ points: Point[]; width: number; kind: 'highway' | 'quay' | 'arterial' | 'street' }> {
  return [
    ...town.plan.roads.map((road) => ({ points: road.points, width: road.width, kind: road.kind === 'highway' || road.kind === 'local' ? ('highway' as const) : road.kind === 'quay' ? ('quay' as const) : road.kind === 'arterial' ? ('arterial' as const) : ('street' as const) })),
    ...town.wards.streets.map((points) => ({ points, width: grown.widths.street, kind: 'street' as const })),
  ];
}
