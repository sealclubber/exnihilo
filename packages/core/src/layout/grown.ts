/**
 * The grown layout generator: roads, then wards, then buildings (phase 6D.3).
 *
 * A finished city, its brief, the pack and a seed in; a layout out, in the
 * same format the grid makes. The city is read and never changed.
 *
 * `town.ts` lays the water, the highways and arterials, the ground the town
 * needs and the wards the roads cut it into. `allot.ts` gives each ward a
 * district and cuts it into exactly the city's buildings. This file makes the
 * street graph of every road, street and lane (`network.ts`), gives each lot
 * its entrance, and writes the records, with every invariant checked.
 */
import type { Building, City, District } from '../city/records.ts';
import { stepRng } from '../city/random.ts';
import { idNumber } from '../ids.ts';
import { type GrownSettings, type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { type Allotment, allot } from './allot.ts';
import { area, inset, inside, interiorPoint, lineThrough, sharedLength, splitAlong, toEdge, toLine, toPiece } from './cutting.ts';
import { boxOf } from './geometry.ts';
import { type LayoutOptions, LayoutGenerationError } from './grid.ts';
import { checkLayout } from './invariants.ts';
import { alongOf } from './lines.ts';
import { ringShare } from './measure.ts';
import { type Line, type Network, buildNetwork, nearestOn } from './network.ts';
import { type Block, type Exit, type Junction, type JunctionKind, type Layout, type Lot, type Place, type Segment, type Wall, type Water, LAYOUT_VERSION } from './records.ts';
import { arrangeTrades } from './shared.ts';
import { type Town, TooSmall, layTown } from './town.ts';
import { VERGE } from './wards.ts';

/** A layout that broke a rule: laid out again with its streams drawn afresh before the fault is reported. */
class Unsound extends Error {}
/** How many attempts a town is given. */
const ATTEMPTS = 8;
/** How far from the wall a street that ends near it may be carried on through it, for a gate. */
const WALL_REACH = 40;
/** How close a lot's edge comes to a roadway's edge to open onto it. */
const BORDER = VERGE + 0.1;

/** The name this generator records in a layout's summary. */
export const GROWN_GENERATOR = 'grown';

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');

export function generateGrownLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  const grown = pack.layout.grown;
  if (!grown) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the pack's layout file has no \`grown\` block, which the grown generator needs`);
  // A town that does not fit is laid out on more ground. One that fit but broke a rule is laid out again with its
  // streams drawn afresh; the last attempt's fault is the one reported. The attempts follow from the seed alone.
  let room = 1;
  let variant = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return attemptLayout(city, brief, pack, grown, seed, room, variant, options.arrange !== false);
    } catch (error) {
      if (error instanceof TooSmall) room *= 1.3;
      else variant++;
      if ((error instanceof TooSmall || error instanceof Unsound) && attempt < ATTEMPTS) continue;
      if (error instanceof Unsound) throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${error.message}`);
      if (error instanceof TooSmall) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the town does not fit even ${room.toFixed(1)} times the usual ground (it stopped at ${error.where})`);
      if (error instanceof LayoutGenerationError) throw error;
      throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${(error as Error).message}`);
    }
  }
}

function attemptLayout(city: City, brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, room: number, variant: number, arrange: boolean): Layout {
  // The streams of a later attempt are drawn from the seed mixed with the attempt's number.
  const streams = variant === 0 ? seed : (seed + Math.imul(variant, 0x9e3779b1)) >>> 0;
  const rngOf = (step: string) => stepRng(streams, step);
  const number = idNumber(brief.id);
  const fail = (message: string): never => {
    throw new Unsound(message);
  };
  const widths = grown.widths;
  const lotArea = (building: Building) => lotSizeOf(building.type, pack).frontage * lotSizeOf(building.type, pack).depth;
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const centralIds = new Set(city.districts.filter((district) => placements.get(district.kind) === 'centre').map((district) => district.id));
  const plazaBuilding = brief.flags.plaza ? city.buildings.find((building) => building.type === grown.plaza.building) : undefined;
  const plazaArea = plazaBuilding ? Math.min(Math.max(brief.population * grown.plaza.perResident, grown.plaza.min), grown.plaza.max) : 0;
  const gatehouses = brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse) : [];

  // ---- The ground plan ----------------------------------------------------------------------------------------
  const town: Town = layTown(brief, pack, grown, streams, {
    lotArea: city.buildings.reduce((sum, building) => sum + (building === plazaBuilding ? 0 : lotArea(building)), 0),
    plazaArea,
    centralLotArea: city.buildings.reduce((sum, building) => sum + (centralIds.has(building.districtId) && building !== plazaBuilding ? lotArea(building) : 0), 0),
    room,
    ...(gatehouses.length > 0 && { wall: { share: brief.population < grown.wall.enclosesAllBelow ? 1 : grown.wall.share, smoothing: grown.wall.smoothing, width: grown.wall.width } }),
  });
  const outlines = town.ground.outlines;
  /** Out of town: not on the ground nor within the trim of it, and not over water. */
  /** The wall's lines as polylines, a closed one returning to its start. */
  const wallLines: Point[][] = town.wall ? (town.wall.closed ? [[...town.wall.loop, town.wall.loop[0] as Point]] : town.wall.lines) : [];
  const nearWall = (point: Point) => Math.min(Infinity, ...wallLines.map((line) => toLine(point, line)));
  const outOfTown = (point: Point) => town.dryBy(point) > 0 && outlines.every((outline) => !inside(point, outline) && toEdge(point, outline) > grown.arterials.trim);

  // ---- Lines of the street graph --------------------------------------------------------------------------------
  const lines: Line[] = [];
  const exitAt = new Map<number, Point>();
  for (const road of town.plan.roads) {
    if (road.kind === 'highway' || road.kind === 'local') {
      // From the centre out past the town to its exit, or for a local road to the town's edge.
      const along = alongOf(road.points);
      let lastIn = 0;
      for (let at = 0; at < road.points.length; at++) if (!outOfTown(road.points[at] as Point)) lastIn = along[at] as number;
      const total = along[along.length - 1] as number;
      const reach = Math.min(total, lastIn + (road.route !== undefined ? grown.highways.beyond : grown.arterials.trim));
      const points = cutAt(road.points, along, reach);
      lines.push({ points, kind: 'arterial', width: road.width, ...(road.route !== undefined && { route: road.route }), bridges: road.bridges.filter(([a, b]) => points.includes(a) && points.includes(b)), bridgeWidth: widths.bridge });
      if (road.route !== undefined) exitAt.set(road.route, points[points.length - 1] as Point);
    } else if (road.kind === 'quay') {
      const along = alongOf(road.points);
      let keep = road.points.length;
      for (let at = 1; at < road.points.length; at++) {
        if (outOfTown(road.points[at] as Point)) {
          keep = at;
          break;
        }
      }
      const points = cutAt(road.points, along, along[keep - 1] as number);
      if (points.length >= 2) lines.push({ points, kind: 'arterial', width: road.width, bridges: [] });
    } else if (road.kind === 'arterial') {
      lines.push({ points: road.points, kind: 'arterial', width: road.width, bridges: road.bridges, bridgeWidth: Math.min(widths.bridge, road.width) });
    } else {
      // A street along a bank: each stretch of it in town.
      let run: Point[] = [];
      const flush = () => {
        if (run.length >= 2 && (alongOf(run)[run.length - 1] as number) > grown.arterials.shortest) lines.push({ points: run, kind: 'street', width: road.width, bridges: [] });
        run = [];
      };
      for (const point of road.points) {
        if (outOfTown(point)) flush();
        else run.push(point);
      }
      flush();
    }
  }
  for (const street of town.wards.streets) lines.push({ points: street, kind: 'street', width: widths.street });
  for (const line of town.wallStreet ?? []) lines.push({ points: line, kind: 'street', width: widths.street });
  // A street that runs up to the wall stops short of it, so that its roadway does not reach past the wall.
  if (town.wall) {
    for (const line of lines) {
      if (line.kind !== 'street' || line.points.length < 2) continue;
      for (const end of [0, 1]) {
        const points = end === 0 ? line.points : [...line.points].reverse();
        if (nearWall(points[0] as Point) > 1e-3) continue;
        const along = alongOf(points);
        const total = along[along.length - 1] as number;
        const back = grown.wall.width / 2 + line.width / 2 + VERGE;
        const kept = total > back + 1 ? sliceLine(points, along, back, total) : [];
        line.points = end === 0 ? kept : kept.reverse();
        if (line.points.length < 2) break;
      }
    }
    for (let at = lines.length - 1; at >= 0; at--) if ((lines[at] as Line).points.length < 2) lines.splice(at, 1);
  }
  if (town.plaza) lines.push({ points: town.plaza.closed ? [...town.plaza.ring, town.plaza.ring[0] as Point] : town.plaza.ring, kind: 'street', width: widths.street });

  // ---- Gates --------------------------------------------------------------------------------------------------
  // Where a highway crosses the wall there is a gate; then where an arterial or a street does, as many more as there
  // are gatehouses, each as far round the wall from the others as can be. Anything else stops short of the wall.
  /** The centre: where the highways meet, or the junction nearest it where they meet a plaza's street instead. */
  const nearestNode = (network: Network) => network.nodes.reduce<number | undefined>((best, node, at) => (best === undefined || Math.hypot(...node.position) < Math.hypot(...(network.nodes[best] as Network['nodes'][number]).position) ? at : best), undefined);
  const gates: Array<{ point: Point; main: boolean; key: string }> = [];
  // Where fewer roads cross the wall than there are gatehouses, a street that ends near the wall is carried on through
  // it, where that passes no ward, so that it can have a gate.
  if (town.wall) {
    const crosses = (line: Line) => line.points.some((point, k) => k > 0 && wallLines.some((loop) => loop.some((corner, m) => m > 0 && crossingOf(line.points[k - 1] as Point, point, loop[m - 1] as Point, corner) !== undefined)));
    let crossing = lines.filter((line) => line.kind !== 'lane' && crosses(line)).length;
    const clearOfWards = (a: Point, b: Point, width: number) => {
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
      for (let step = 1; step <= steps; step++) {
        const point: Point = [a[0] + ((b[0] - a[0]) * step) / steps, a[1] + ((b[1] - a[1]) * step) / steps];
        if (town.dryBy(point) < width) return false;
        for (const ward of town.wards.wards) if (inside(point, ward.polygon) || toEdge(point, ward.polygon) < width / 2 + VERGE) return false;
      }
      return true;
    };
    // Streets within the usual reach first; then, still short, streets and arterials from further.
    for (const [reachOf, kinds] of [[WALL_REACH, ['street']], [3 * WALL_REACH, ['street', 'arterial']]] as const) {
      if (crossing >= gatehouses.length) break;
      const ends = lines
        .flatMap((line) => ((kinds as readonly string[]).includes(line.kind) && line.route === undefined && !crosses(line) ? [0, 1].map((end) => ({ line, end })) : []))
        .map(({ line, end }) => {
          const points = end === 0 ? [...line.points].reverse() : line.points;
          const tip = points[points.length - 1] as Point;
          const before = points[points.length - 2] as Point;
          const run = Math.hypot(tip[0] - before[0], tip[1] - before[1]) || 1;
          const direction: Point = [(tip[0] - before[0]) / run, (tip[1] - before[1]) / run];
          const far: Point = [tip[0] + direction[0] * reachOf, tip[1] + direction[1] * reachOf];
          let hit: number | undefined;
          for (const loop of wallLines) {
            for (let m = 1; m < loop.length; m++) {
              const found = crossingOf(tip, far, loop[m - 1] as Point, loop[m] as Point);
              if (found && (hit === undefined || found.t < hit)) hit = found.t;
            }
          }
          const onOther = lines.some((other) => other !== line && toLine(tip, other.points) < 1e-3);
          if (hit === undefined || onOther) return undefined;
          const beyond = hit * reachOf + grown.wall.width + line.width;
          const out: Point = [tip[0] + direction[0] * beyond, tip[1] + direction[1] * beyond];
          return clearOfWards(tip, out, line.width) ? { line, end, out, reach: hit * reachOf } : undefined;
        })
        .filter((entry): entry is { line: Line; end: number; out: Point; reach: number } => entry !== undefined)
        .sort((a, b) => a.reach - b.reach);
      for (const entry of ends) {
        if (crossing >= gatehouses.length) break;
        if (crosses(entry.line)) continue;
        entry.line.points = entry.end === 0 ? [entry.out, ...entry.line.points] : [...entry.line.points, entry.out];
        crossing++;
      }
    }
  }
  // A gate whose road turns out to reach nowhere is given up, and the gates chosen again without it.
  const snapshot = lines.map((line) => ({ ...line }));
  const refused = new Set<string>();
  let roadNetwork: Network;
  let roadReached: Set<number>;
  let reachedLines: Line[] = [];
  for (let round = 0; ; round++) {
    lines.length = 0;
    lines.push(...snapshot.map((line) => ({ ...line })));
    gates.length = 0;
    if (town.wall) {
      type Crossing = { line: number; at: number; point: Point };
      const crossings: Crossing[] = [];
      lines.forEach((line, id) => {
        const along = alongOf(line.points);
        for (let k = 1; k < line.points.length; k++) {
          for (const loop of wallLines) {
            for (let m = 1; m < loop.length; m++) {
              const found = crossingOf(line.points[k - 1] as Point, line.points[k] as Point, loop[m - 1] as Point, loop[m] as Point);
              if (found) crossings.push({ line: id, at: (along[k - 1] as number) + found.t * ((along[k] as number) - (along[k - 1] as number)), point: found.point });
            }
          }
        }
      });
      const main = crossings.filter((crossing) => (lines[crossing.line] as Line).route !== undefined);
      if (main.length > gatehouses.length) fail(`${gatehouses.length} gatehouses but the highways cross the wall ${main.length} times`);
      const chosen = new Set<Crossing>(main);
      const rest = crossings.filter((crossing) => !chosen.has(crossing) && !refused.has(`${crossing.line}:${crossing.at}`) && town.dryBy(crossing.point) > grown.wall.width);
      // Arterials before streets.
      const order = [...rest].sort((a, b) => Number((lines[b.line] as Line).kind === 'arterial') - Number((lines[a.line] as Line).kind === 'arterial') || a.line - b.line || a.at - b.at);
      const bearing = (point: Point) => Math.atan2(point[0], -point[1]);
      const apart = (a: Point, b: Point) => Math.abs(((((bearing(a) - bearing(b)) * 180) / Math.PI + 540) % 360) - 180);
      while (chosen.size < gatehouses.length && order.length > 0) {
        const arterials = order.filter((crossing) => (lines[crossing.line] as Line).kind === 'arterial');
        const pool = arterials.length > 0 ? arterials : order;
        let best = pool[0] as Crossing;
        let furthest = -1;
        for (const crossing of pool) {
          const away = Math.min(360, ...[...chosen].map((gate) => apart(gate.point, crossing.point)));
          if (away > furthest) {
            furthest = away;
            best = crossing;
          }
        }
        chosen.add(best);
        order.splice(order.indexOf(best), 1);
      }
      if (chosen.size < gatehouses.length) fail(`${gatehouses.length} gatehouses but only ${chosen.size} places where a road crosses the wall`);
      for (const crossing of [...chosen].sort((a, b) => a.line - b.line || a.at - b.at)) {
        const line = lines[crossing.line] as Line;
        line.stops = [...(line.stops ?? []), crossing.point];
        gates.push({ point: crossing.point, main: line.route !== undefined, key: `${crossing.line}:${crossing.at}` });
      }
      // Every other crossing: the line is cut either side of the wall, its roadway a verge clear of it.
      const clear = grown.wall.width / 2 + widths.arterial / 2 + VERGE;
      const cutLines = new Map<number, number[]>();
      for (const crossing of crossings) if (!chosen.has(crossing)) cutLines.set(crossing.line, [...(cutLines.get(crossing.line) ?? []), crossing.at]);
      const replaced: Line[] = [];
      lines.forEach((line, id) => {
        const at = cutLines.get(id);
        if (!at) return replaced.push(line);
        const along = alongOf(line.points);
        const total = along[along.length - 1] as number;
        const stops = [...at].sort((a, b) => a - b);
        let from = 0;
        for (const stop of [...stops, Infinity]) {
          const to = stop === Infinity ? total : stop - clear;
          if (to - from > 5) {
            // A cut end goes back to the last place another line meets it, so that the road ends at a junction and
            // not against the wall; with no such place the piece goes.
            const meets = meetingsAlong(line, lines, along);
            const cutStart = from > 0;
            const cutEnd = stop !== Infinity;
            let start = from;
            let end = to;
            if (cutStart) start = meets.find((at) => at >= from - 1e-6 && at <= to) ?? Infinity;
            if (cutEnd) end = [...meets].reverse().find((at) => at <= to + 1e-6 && at >= start) ?? -Infinity;
            if (!(end - start > 5)) {
              from = stop + clear;
              continue;
            }
            const points = sliceLine(line.points, along, start, end);
            // Past the wall an arterial no longer leaves a highway: what is left of it is a street.
          const kind = from > 0 && line.kind === 'arterial' && line.route === undefined && line.width !== widths.highway ? 'street' : line.kind;
          replaced.push({ ...line, kind, points, bridges: (line.bridges ?? []).filter(([a, b]) => points.includes(a) && points.includes(b)), stops: (line.stops ?? []).filter((point) => points.some((p) => p === point) || isOn(point, points)) });
          }
          from = stop + clear;
        }
        return undefined;
      });
      lines.length = 0;
      lines.push(...replaced);
    }
    // The roads that can be reached from the centre are the ways lots may open onto; the rest are no part of the town.
    roadNetwork = buildNetwork(lines);
    // The centre: where the highways meet, or the junction nearest it where they meet a plaza's street instead.
    const roadCentre = roadNetwork.nodeAt([0, 0]) ?? nearestNode(roadNetwork);
    if (roadCentre === undefined) fail('no road reaches the centre');
    roadReached = new Set<number>([roadCentre as number]);
    {
      const around = new Map<number, number[]>();
      roadNetwork.edges.forEach((edge, id) => {
        for (const node of [edge.from, edge.to]) around.set(node, [...(around.get(node) ?? []), id]);
      });
      const queue = [roadCentre as number];
      for (let at = 0; at < queue.length; at++) {
        for (const id of around.get(queue[at] as number) ?? []) {
          const edge = roadNetwork.edges[id] as Network['edges'][number];
          for (const node of [edge.from, edge.to]) if (!roadReached.has(node)) (roadReached.add(node), queue.push(node));
        }
      }
    }
    reachedLines = lines.filter((_, id) => (roadNetwork.edgesOf[id] ?? []).some((edge) => roadReached.has((roadNetwork.edges[edge] as Network['edges'][number]).from)));
    const lost = gates.filter((gate) => !gate.main && !roadReached.has(roadNetwork.nodeAt(gate.point) ?? -1));
    if (lost.length === 0 || round >= 6) break;
    for (const gate of lost) refused.add(gate.key);
  }
  lines.length = 0;
  lines.push(...reachedLines);
  const kindOfLine = (line: Line): 'highway' | 'quay' | 'arterial' | 'street' => (line.route !== undefined || (line.kind === 'arterial' && line.width === widths.highway) ? 'highway' : line.kind === 'arterial' ? 'arterial' : 'street');
  const ways = lines.map((line) => ({ points: line.points, width: line.width, kind: kindOfLine(line) }));

  // ---- Districts and buildings ----------------------------------------------------------------------------------
  const wardList = town.wards.wards;
  /** The ward nearest a gate, one inside the wall where there is one near. */
  const nearestWard = (point: Point) => {
    let best = 0;
    let gap = Infinity;
    wardList.forEach((ward, at) => {
      const within = town.wall ? inside(interiorPoint(ward.polygon), town.wall.loop) : true;
      const away = (inside(point, ward.polygon) ? 0 : toEdge(point, ward.polygon)) + (within ? 0 : 1000);
      if (away < gap) {
        gap = away;
        best = at;
      }
    });
    return best;
  };
  const plazaFace = town.wards.plazaFace === undefined ? undefined : (town.wards.faces[town.wards.plazaFace] as Point[]);
  const besidePlaza = plazaFace ? wardList.map((ward, at) => (sharedLength(town.wards.faces[ward.face] as Point[], plazaFace, 1e-5) > 1 ? at : -1)).filter((at) => at >= 0) : [];
  let allotment: Allotment;
  try {
    allotment = allot({
      city,
      pack,
      grown,
      town,
      rng: rngOf,
      held: (building) => building === plazaBuilding || gatehouses.includes(building),
      ways,
      ...(town.river && { river: town.river.line }),
      atWater: (polygon) => polygon.some((point) => town.dryBy(point) <= pack.layout.watersideReach),
      dryBy: town.dryBy,
      ...(town.wall && { barrier: wallLines }),
      extra: gates.map((gate, k) => ({ ward: nearestWard(gate.point), building: gatehouses[k] as Building })),
      ...(plazaBuilding && town.wards.plazaFace !== undefined && { besidePlaza: { wards: besidePlaza, district: city.districts.findIndex((district) => district.id === plazaBuilding.districtId) } }),
    });
  } catch (error) {
    if (error instanceof TooSmall || error instanceof LayoutGenerationError) throw error;
    throw new Unsound((error as Error).message);
  }
  const wards = town.wards.wards;

  for (const lane of allotment.lanes) lines.push({ points: lane, kind: 'lane', width: widths.alley });
  const network: Network = buildNetwork(lines);

  // Only what can be reached from the centre is kept.
  const centre = network.nodeAt([0, 0]) ?? nearestNode(network);
  if (centre === undefined) fail('the town has no streets');
  const reached = new Set<number>([centre as number]);
  const around = new Map<number, number[]>();
  network.edges.forEach((edge, id) => {
    for (const node of [edge.from, edge.to]) around.set(node, [...(around.get(node) ?? []), id]);
  });
  const queue = [centre as number];
  for (let at = 0; at < queue.length; at++) {
    for (const id of around.get(queue[at] as number) ?? []) {
      const edge = network.edges[id] as Network['edges'][number];
      for (const node of [edge.from, edge.to]) if (!reached.has(node)) (reached.add(node), queue.push(node));
    }
  }
  const keptEdges = network.edges.map((edge, id) => ({ edge, id })).filter(({ edge }) => reached.has(edge.from));

  // ---- Records: junctions and segments -----------------------------------------------------------------------
  const degree = new Map<number, number>();
  for (const { edge } of keptEdges) for (const node of [edge.from, edge.to]) degree.set(node, (degree.get(node) ?? 0) + 1);
  const exitNodes = new Map<number, number>();
  for (const [route, point] of exitAt) {
    const node = network.nodeAt(point);
    if (node === undefined || !reached.has(node)) fail(`the highway to ${brief.routes[route]?.routeId} does not reach its exit`);
    exitNodes.set(node as number, route);
  }
  const junctionIds = new Map<number, string>();
  const junctions: Junction[] = [];
  const gateNodes = new Set(gates.map((gate) => network.nodeAt(gate.point)).filter((node): node is number => node !== undefined));
  const kindOfNode = (node: number): JunctionKind => (exitNodes.has(node) ? 'exit' : gateNodes.has(node) ? 'gate' : network.nodes[node]?.bridgeEnd ? 'bridge-end' : degree.get(node) === 1 ? 'dead-end' : 'crossing');
  const junctionOf = (node: number): string => {
    let id = junctionIds.get(node);
    if (!id) {
      id = `junction-${number}-${pad(junctions.length + 1, 6)}`;
      junctionIds.set(node, id);
      junctions.push({ id, position: (network.nodes[node] as Network['nodes'][number]).position, kind: kindOfNode(node) });
    }
    return id;
  };
  junctionOf(centre as number);
  const segments: Segment[] = [];
  const segmentOfEdge = new Map<number, Segment>();
  for (const { edge, id } of keptEdges) {
    const route = edge.route === undefined ? undefined : brief.routes[edge.route];
    const segment: Segment = {
      id: `segment-${number}-${pad(segments.length + 1, 6)}`,
      fromJunctionId: junctionOf(edge.from),
      toJunctionId: junctionOf(edge.to),
      points: edge.points,
      kind: edge.kind,
      width: edge.width,
      ...(route?.name !== undefined && edge.kind !== 'bridge' && { name: route.name }),
      ...(route && edge.kind !== 'bridge' && { routeId: route.routeId }),
    };
    segments.push(segment);
    segmentOfEdge.set(id, segment);
  }
  const exits: Exit[] = brief.routes.map((route, position) => {
    const node = [...exitNodes].find(([, at]) => at === position)?.[0];
    if (node === undefined) fail(`the route ${route.routeId} has no exit`);
    return { id: `exit-${number}-${pad(position + 1, 3)}`, junctionId: junctionOf(node as number), routeId: route.routeId, ...(route.name !== undefined && { name: route.name }), kind: route.kind, bearing: route.bearing };
  });

  // ---- Lots ---------------------------------------------------------------------------------------------------
  // Each lot opens onto the way it runs along furthest: at the middle of that stretch, on the segment there.
  const filed = new Map<string, number[]>();
  const SQUARE = 30;
  for (const { id, edge } of keptEdges) {
    const box = boxOf(edge.points, edge.width);
    for (let x = Math.floor(box.minX / SQUARE); x <= Math.floor(box.maxX / SQUARE); x++) {
      for (let y = Math.floor(box.minY / SQUARE); y <= Math.floor(box.maxY / SQUARE); y++) {
        const key = `${x}:${y}`;
        const list = filed.get(key);
        if (list) list.push(id);
        else filed.set(key, [id]);
      }
    }
  }
  const entranceOf = (polygon: Point[]): Lot['entrance'] | undefined => {
    const touching = new Map<number, { length: number; sum: Point; count: number }>();
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i] as Point;
      const b = polygon[(i + 1) % polygon.length] as Point;
      const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(run));
      for (let step = 0; step < steps; step++) {
        const t = (step + 0.5) / steps;
        const point: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const seen = new Set<number>();
        for (const id of filed.get(`${Math.floor(point[0] / SQUARE)}:${Math.floor(point[1] / SQUARE)}`) ?? []) {
          const edge = network.edges[id] as Network['edges'][number];
          if (seen.has(edge.line)) continue;
          let near = Infinity;
          for (let k = 1; k < edge.points.length; k++) near = Math.min(near, toPiece(point, edge.points[k - 1] as Point, edge.points[k] as Point));
          if (near - edge.width / 2 > BORDER) continue;
          seen.add(edge.line);
          const entry = touching.get(edge.line) ?? { length: 0, sum: [0, 0] as Point, count: 0 };
          entry.length += run / steps;
          entry.sum = [entry.sum[0] + point[0], entry.sum[1] + point[1]];
          entry.count++;
          touching.set(edge.line, entry);
        }
      }
    }
    const best = [...touching].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
    if (!best) return undefined;
    const [line, { sum, count }] = best;
    const middle: Point = [sum[0] / count, sum[1] / count];
    let found: { segment: Segment; point: Point; away: number } | undefined;
    for (const id of network.edgesOf[line] ?? []) {
      const segment = segmentOfEdge.get(id);
      if (!segment) continue;
      const near = nearestOn(segment.points, middle);
      if (!found || near.away < found.away) found = { segment, point: near.point, away: near.away };
    }
    return found ? { segmentId: found.segment.id, point: found.point } : undefined;
  };

  // Each gatehouse takes the piece of its ward nearest its gate, the building there taking the gatehouse's.
  const placed = allotment.placed;
  gates.forEach((gate, k) => {
    const gatehouse = gatehouses[k] as Building;
    const own = placed.find((lot) => lot.building === gatehouse);
    if (!own) return;
    const nearest = placed.filter((lot) => lot.ward === own.ward).reduce((best, lot) => (toEdge(gate.point, lot.polygon) < toEdge(gate.point, best.polygon) ? lot : best), own);
    if (nearest !== own && !gatehouses.includes(nearest.building)) [own.building, nearest.building] = [nearest.building, own.building];
  });
  // Buildings change places within a district, between lots alike, so that trades stand together along a street.
  const entrances = new Map(placed.map((lot) => [lot, entranceOf(lot.polygon)]));
  if (arrange) {
    const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
    const key = (lot: (typeof placed)[number]) => {
      const entrance = entrances.get(lot);
      return entrance ? { segment: entrance.segmentId, along: alongTo((segmentById.get(entrance.segmentId) as Segment).points, entrance.point) } : { segment: '', along: 0 };
    };
    const keys = new Map(placed.map((lot) => [lot, key(lot)]));
    const order = new Map(
      [...placed]
        .sort((a, b) => {
          const one = keys.get(a) as { segment: string; along: number };
          const two = keys.get(b) as { segment: string; along: number };
          return one.segment.localeCompare(two.segment) || one.along - two.along;
        })
        .map((lot, at) => [lot, at]),
    );
    const slots = placed.filter((lot) => !gatehouses.includes(lot.building)).map((lot) => ({ lot, building: lot.building }));
    arrangeTrades(
      slots,
      pack,
      (a, b) => (order.get(a.lot) as number) - (order.get(b.lot) as number),
      (a, b) => keys.get(a.lot)?.segment === keys.get(b.lot)?.segment && Math.abs((order.get(a.lot) as number) - (order.get(b.lot) as number)) === 1,
    );
    for (const slot of slots) slot.lot.building = slot.building;
  }
  const buildingOrder = new Map(city.buildings.map((building, index) => [building.id, index]));
  const sortedLots = [...placed].sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
  const footprintRng = rngOf('grown-footprints');
  const { pull } = grown.buildings.loose;
  const places: Place[] = [];
  const plazaLot = plazaBuilding && town.plaza ? { building: plazaBuilding, polygon: town.plaza.polygon, ward: -1, loose: false } : undefined;
  if (plazaBuilding && !plazaLot) fail('the plaza found no place');
  if (plazaLot) {
    sortedLots.push(plazaLot);
    sortedLots.sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
    entrances.set(plazaLot, entranceOf(plazaLot.polygon));
    places.push({ id: `place-${number}-001`, kind: 'plaza', polygon: plazaLot.polygon, buildingId: plazaLot.building.id });
  }
  const lots: Lot[] = sortedLots.map((lot, index) => {
    const entrance = entrances.get(lot) ?? fail(`the lot of ${lot.building.id} borders no street`);
    const coverage = footprintCoverageOf(lot.building.type, pack);
    // In a loose ward the building is drawn in from its lot. It stands across the lot's front, as deep as the pack's
    // share of the lot; the rest is its yard.
    const drawnIn = lot.loose ? inset(lot.polygon, pull.min + (pull.max - pull.min) * footprintRng.next()) : lot.polygon;
    const built = coverage > 0 && drawnIn ? acrossTheFront(drawnIn, entrance.point, coverage) : undefined;
    const footprints = built && area(built) > 1 ? [built] : [];
    return { id: `lot-${number}-${pad(index + 1, 6)}`, buildingId: lot.building.id, polygon: lot.polygon, districtId: lot.building.districtId, entrance, footprints };
  });

  // ---- Districts, blocks, water --------------------------------------------------------------------------------
  const faces = town.wards.faces;
  const districtAreas = city.districts.flatMap((district: District, index) => {
    const own = wards.map((ward, at) => ({ ward, at })).filter(({ at }) => allotment.districtOf[at] === index);
    if (own.length === 0 && !(plazaBuilding?.districtId === district.id && plazaFace)) return [];
    const polygons = own.map(({ ward }) => faces[ward.face] as Point[]);
    if (plazaBuilding?.districtId === district.id && plazaFace) polygons.push(plazaFace);
    const middles = own.length > 0 ? own.map(({ ward }) => interiorPoint(ward.polygon)) : [interiorPoint(plazaFace as Point[])];
    const mean: Point = [middles.reduce((sum, point) => sum + point[0], 0) / middles.length, middles.reduce((sum, point) => sum + point[1], 0) / middles.length];
    const label = middles.reduce((best, point) => (Math.hypot(point[0] - mean[0], point[1] - mean[1]) < Math.hypot(best[0] - mean[0], best[1] - mean[1]) ? point : best));
    return [{ districtId: district.id, polygons, labelPoint: label }];
  });
  const outlineArea = outlines.reduce((sum, outline) => sum + area(outline), 0);
  // Blocks are the wards that hold lots: one that could make no lot that keeps the floor holds none, and is open ground.
  const holding = new Set(placed.map((lot) => lot.ward));
  const byRank = wards.map((_, at) => at).filter((at) => (allotment.districtOf[at] as number) >= 0 && holding.has(at)).sort((a, b) => (allotment.rank[a] as number) - (allotment.rank[b] as number) || a - b);
  const blocks: Block[] = byRank.map((at, index) => {
    const district = allotment.districtOf[at] as number;
    return {
      id: `block-${number}-${pad(index + 1, 6)}`,
      polygon: (wards[at] as Town['wards']['wards'][number]).polygon,
      ...(district >= 0 && { districtId: (city.districts[district] as District).id }),
      growthRank: byRank.length === 1 ? 0 : index / (byRank.length - 1),
    };
  });
  const waters: Water[] = [];
  const waterId = () => `water-${number}-${pad(waters.length + 1, 3)}`;
  if (town.river) waters.push({ id: waterId(), kind: 'river', centreLine: town.river.line, width: town.river.width, widths: town.river.widths });
  if (town.coast) waters.push({ id: waterId(), kind: 'sea', polygon: town.coast.polygon });
  // The wall: one record, its lines, and every gate on them.
  const walls: Wall[] = [];
  if (town.wall) {
    const own = gates.map((gate, k) => ({ gate, k })).filter(({ gate }) => nearWall(gate.point) < 1e-6);
    // Only wall with the town behind it: an open line with no gate on it and few lots inside along it, such as a stretch
    // across the water from the town, is no part of the wall. A closed wall stands whole.
    const loop = town.wall.loop;
    const middles = lots.map((lot) => interiorPoint(lot.polygon)).filter((point) => inside(point, loop));
    const BEHIND = 30;
    const standing = town.wall.closed
      ? [loop]
      : town.wall.lines.filter((line) => {
          if (own.some(({ gate }) => toLine(gate.point, line) < 1e-6)) return true;
          const length = alongOf(line)[line.length - 1] as number;
          const behind = middles.filter((point) => toLine(point, line) < BEHIND).length;
          return behind >= length / BEHIND;
        });
    if (standing.length === 0) fail('no stretch of the wall has the town behind it');
    walls.push({
      id: `wall-${number}-001`,
      lines: standing,
      closed: town.wall.closed,
      width: grown.wall.width,
      gates: own.map(({ gate, k }) => {
        const node = network.nodeAt(gate.point);
        if (node === undefined || !junctionIds.has(node)) fail('a gate is not on the street graph');
        return { junctionId: junctionIds.get(node as number) as string, buildingId: (gatehouses[k] as Building).id, arterial: gate.main };
      }),
    });
    const made = walls.reduce((sum, wall) => sum + wall.gates.length, 0);
    if (made !== gatehouses.length) fail(`${gatehouses.length} gatehouses but ${made} gates in the wall`);
  }

  // ---- The summary ----------------------------------------------------------------------------------------------
  const builtArea = lots.reduce((sum, lot) => sum + area(lot.polygon), 0);
  const roadsOut = town.plan.roads.filter((road) => road.kind === 'highway' || road.kind === 'local').length + town.plan.roads.filter((road) => road.kind === 'arterial' && town.ground.rank(town.ground.cost(road.points[0] as Point)) < 0.25).length;
  const everyPoint = [...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)];
  const layout: Layout = {
    junctions: [...junctions].sort((a, b) => (a.id < b.id ? -1 : 1)),
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    walls,
    places,
    blocks,
    summary: {
      settlementId: brief.id,
      counts: { junctions: junctions.length, segments: segments.length, exits: exits.length, waters: waters.length, lots: lots.length, districtAreas: districtAreas.length, walls: walls.length, gates: walls.reduce((sum, wall) => sum + wall.gates.length, 0), places: places.length },
      outlineArea,
      bounds: boxOf(everyPoint),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
      ringShare: ringShare(segments),
      roadsOut,
      layoutVersion: LAYOUT_VERSION,
      generator: GROWN_GENERATOR,
      pack: { name: pack.pack.name, version: pack.pack.version },
      seed,
    },
  };
  const broken = checkLayout(layout, city, brief, pack);
  if (broken.length > 0) fail(`the layout breaks ${broken.length === 1 ? 'an invariant' : 'invariants'}:\n  ${broken.join('\n  ')}`);
  return layout;
}

/** The front part of a lot: from its edge nearest the entrance back to a share of its depth. */
function acrossTheFront(polygon: Point[], entrance: Point, share: number): Point[] | undefined {
  if (share >= 1) return polygon;
  let front = 0;
  let gap = Infinity;
  polygon.forEach((point, at) => {
    const away = toPiece(entrance, point, polygon[(at + 1) % polygon.length] as Point);
    if (away < gap) {
      gap = away;
      front = at;
    }
  });
  const a = polygon[front] as Point;
  const b = polygon[(front + 1) % polygon.length] as Point;
  const run = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let inward: Point = [-(b[1] - a[1]) / run, (b[0] - a[0]) / run];
  const middle = interiorPoint(polygon);
  if ((middle[0] - a[0]) * inward[0] + (middle[1] - a[1]) * inward[1] < 0) inward = [-inward[0], -inward[1]];
  const depths = polygon.map((point) => (point[0] - a[0]) * inward[0] + (point[1] - a[1]) * inward[1]);
  const reach = Math.min(...depths) + (Math.max(...depths) - Math.min(...depths)) * share;
  const at: Point = [a[0] + inward[0] * reach, a[1] + inward[1] * reach];
  const { pieces } = splitAlong(polygon, lineThrough(at, [b[0] - a[0], b[1] - a[1]], 4 * run + 1000));
  // The piece that holds the middle of the front edge.
  const frontMiddle: Point = [(a[0] + b[0]) / 2 + inward[0] * 1e-3, (a[1] + b[1]) / 2 + inward[1] * 1e-3];
  const piece = pieces.find((one) => inside(frontMiddle, one)) ?? pieces.find((one) => toEdge(frontMiddle, one) < 1e-2);
  // A lot too oddly shaped to be cut at that depth gets no building rather than one over far more of it than asked.
  if (!piece || area(piece) > Math.min(0.9, share + 0.3) * area(polygon)) return undefined;
  return piece;
}

/** Where two pieces cross, strictly inside both: the point and the share along the first. */
function crossingOf(a: Point, b: Point, c: Point, d: Point): { point: Point; t: number } | undefined {
  const ab: Point = [b[0] - a[0], b[1] - a[1]];
  const cd: Point = [d[0] - c[0], d[1] - c[1]];
  const denominator = ab[0] * cd[1] - ab[1] * cd[0];
  if (Math.abs(denominator) < 1e-12) return undefined;
  const t = ((c[0] - a[0]) * cd[1] - (c[1] - a[1]) * cd[0]) / denominator;
  const u = ((c[0] - a[0]) * ab[1] - (c[1] - a[1]) * ab[0]) / denominator;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return undefined;
  return { point: [a[0] + ab[0] * t, a[1] + ab[1] * t], t };
}

/** Whether a point lies on a line, within a hair. */
const isOn = (point: Point, line: readonly Point[]) => toLine(point, line) < 1e-6;

/** The part of a line between two distances along it. */
function sliceLine(points: Point[], along: number[], from: number, to: number): Point[] {
  const at = (distance: number): Point => {
    for (let k = 1; k < points.length; k++) {
      if ((along[k] as number) >= distance || k === points.length - 1) {
        const span = (along[k] as number) - (along[k - 1] as number);
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (distance - (along[k - 1] as number)) / span));
        const a = points[k - 1] as Point;
        const b = points[k] as Point;
        return t <= 0 ? a : t >= 1 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return points[points.length - 1] as Point;
  };
  const out: Point[] = [at(from)];
  for (let k = 0; k < points.length; k++) if ((along[k] as number) > from && (along[k] as number) < to) out.push(points[k] as Point);
  const end = at(to);
  if (out[out.length - 1] !== end) out.push(end);
  return out;
}

/** A line cut short at a distance along it. */
function cutAt(points: Point[], along: number[], at: number): Point[] {
  const out: Point[] = [points[0] as Point];
  for (let k = 1; k < points.length; k++) {
    if ((along[k] as number) < at - 1e-9) {
      out.push(points[k] as Point);
      continue;
    }
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const span = (along[k] as number) - (along[k - 1] as number);
    const t = span === 0 ? 1 : (at - (along[k - 1] as number)) / span;
    out.push(t >= 1 - 1e-9 ? b : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    break;
  }
  return out;
}

/** How far along a line a point on it is. */
function alongTo(points: readonly Point[], point: Point): number {
  let walked = 0;
  let best = { at: 0, away: Infinity };
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const run = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const away = toPiece(point, a, b);
    if (away < best.away) {
      const t = run === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / (run * run)));
      best = { at: walked + t * run, away };
    }
    walked += run;
  }
  return best.at;
}

/** How far along a line each other line meets it: where one ends on it or crosses it, in order. */
function meetingsAlong(line: Line, all: readonly Line[], along: readonly number[]): number[] {
  const found: number[] = [];
  for (const other of all) {
    if (other === line) continue;
    for (const end of [other.points[0] as Point, other.points[other.points.length - 1] as Point]) {
      for (let k = 1; k < line.points.length; k++) {
        const a = line.points[k - 1] as Point;
        const b = line.points[k] as Point;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const span = dx * dx + dy * dy;
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((end[0] - a[0]) * dx + (end[1] - a[1]) * dy) / span));
        if (Math.hypot(a[0] + dx * t - end[0], a[1] + dy * t - end[1]) < 1e-3) found.push((along[k - 1] as number) + t * Math.sqrt(span));
      }
    }
    for (let k = 1; k < line.points.length; k++) {
      for (let m = 1; m < other.points.length; m++) {
        const met = crossingOf(line.points[k - 1] as Point, line.points[k] as Point, other.points[m - 1] as Point, other.points[m] as Point);
        if (met) found.push((along[k - 1] as number) + met.t * ((along[k] as number) - (along[k - 1] as number)));
      }
    }
  }
  return found.sort((a, b) => a - b);
}
