/**
 * Stage 4 of the staged generator: the wall, designed before the mesh so
 * that the mesh can follow it.
 *
 * One rounded ring about the centre, enclosing ground for a share of the
 * town's buildings: an oval along the road where one road runs through, and
 * nearly round where several meet. Towers stand along it and the wall runs
 * straight between them. At water it ends at the bank, and at a quay at its
 * edge. Where only a little
 * of the ring lies across a river, or the town has no bridge, the far part
 * is left out and the river closes that side. A gate stands wherever a road
 * crosses the wall, and at each bridge into a bank the river closes.
 */
import type { Rng } from '../../city/random.ts';
import type { StagedSettings } from '../../pack/schema.ts';
import type { Point } from '../../schema.ts';
import { area, interiorPoint, splitAlong } from '../cutting.ts';
import { crossingsOfPolyline, distance, distanceToPiece, distanceToPolyline, pointAlongPolyline, pointInPolygon, polylineLength } from '../geometry.ts';
import type { RoadPlan } from './highways.ts';
import { add, armsAt, between, crossingsAlong, left, tangentAt } from './lines.ts';
import type { Coast, River } from './water.ts';

export interface WallPart {
  /** From tower to tower; its ends are towers too, at a bank or shore unless the part is closed. */
  points: Point[];
  /** Whether it is the whole ring, its last point joined to its first. */
  closed: boolean;
}

export interface Gate {
  point: Point;
  /** What passes through it: a highway or a main street, by its place in the plan; and the bridge it stands at, if it stands at one. */
  highway?: number;
  mainStreet?: number;
  bridge?: number;
}

export interface Wall {
  /** The ring as designed, tower to tower, before water parted it. */
  ring: Point[];
  /** The direction of its long axis, and its half-length and half-width. */
  axis: Point;
  long: number;
  short: number;
  /** The lengths of wall that stand. */
  parts: WallPart[];
  towers: Point[];
  gates: Gate[];
  /** The share of the ring's area that lies across the river, and whether that part was left out. */
  farShare: number;
  farDropped: boolean;
  /** Whether a point of dry ground is within the walls. */
  inside(point: Point): boolean;
}

export interface WallInput {
  settings: StagedSettings;
  rng: Rng;
  buildings: number;
  roads: RoadPlan;
  river?: River;
  coast?: Coast;
}

const CENTRE: Point = [0, 0];
/** How many points the ring is drawn with before its towers are set. */
const RING_POINTS = 240;
/** How finely the wall is walked when its ends at the water are looked for, and how nearly they are found, in metres. */
const BANK_STEP = 2;
const BANK_FOUND = 0.05;

export function planWall({ settings, rng, buildings, roads, river, coast }: WallInput): Wall {
  const { wall: rules } = settings;
  // Along the first road through the centre.
  // A bridge's own road is not one of the roads the ring is shaped to.
  const through = roads.highways.filter((highway) => highway.kind !== 'bridge-road' && highway.kind !== 'branch').map((highway) => highway.points);
  const arms = armsAt(through, settings.widths.highway, settings.highways.armProbe);
  const first = arms[0] ?? ([1, 0] as Point);
  const centred = through.find((road) => armsAt([road], settings.widths.highway, settings.highways.armProbe).length > 0);
  let axis = first;
  if (centred) {
    const length = polylineLength(centred);
    let along = 0;
    let least = Infinity;
    for (let at = 0; at <= length; at += BANK_STEP) {
      const point = pointAlongPolyline(centred, at);
      if (Math.hypot(point[0], point[1]) < least) {
        least = Math.hypot(point[0], point[1]);
        along = at;
      }
    }
    axis = tangentAt(centred, along, length);
  }
  const ratio = arms.length <= 2 ? rules.long : rules.round;
  const long = Math.sqrt(((rules.share * buildings * rules.perBuilding) / Math.PI) * ratio);
  const short = long / ratio;
  const phases = rules.wobble.map(() => rng.next() * 2 * Math.PI);
  const across = left(axis);
  const curve = Array.from({ length: RING_POINTS + 1 }, (_, at): Point => {
    const angle = (2 * Math.PI * (at % RING_POINTS)) / RING_POINTS;
    const swell = 1 + rules.wobble.reduce((sum, wave, index) => sum + wave.size * Math.sin(wave.waves * angle + (phases[index] as number)), 0);
    return add(add(CENTRE, axis, long * swell * Math.cos(angle)), across, short * swell * Math.sin(angle));
  });
  const round = polylineLength(curve);
  const count = Math.max(rules.towers.least, Math.round(round / rules.towers.spacing));
  const ring = Array.from({ length: count }, (_, at) => (((at + (2 * rng.next() - 1) * rules.towers.jitter) / count) % 1 + 1) % 1)
    .sort((a, b) => a - b)
    .map((share) => pointAlongPolyline(curve, share * round));

  // ---- Water parts it ------------------------------------------------------------------------------------------
  // A quay is open to the water: the wall ends at its edge as it does at a bank.
  const quay = roads.harbour;
  const dry = (point: Point) => (!river || river.gap(point) > 0) && (!coast || coast.gap(point) > 0) && (!quay || distanceToPolyline(point, quay.quay) > quay.width / 2);
  const overRiver = (point: Point) => river !== undefined && crossingsOfPolyline(CENTRE, point, river.line) % 2 === 1;
  // The ring's corners and the points where it meets a bank, in order, and whether each stretch after one is dry.
  const nodes: Point[] = [];
  const dryAfter: boolean[] = [];
  ring.forEach((from, at) => {
    const to = ring[(at + 1) % ring.length] as Point;
    const steps = Math.max(1, Math.ceil(distance(from, to) / BANK_STEP));
    nodes.push(from);
    let last = from;
    let state = dry(from);
    for (let step = 1; step <= steps; step++) {
      const point = between(from, to, step / steps);
      if (dry(point) !== state) {
        let [low, high] = [last, point];
        while (distance(low, high) > BANK_FOUND) {
          const middle = between(low, high);
          if (dry(middle) === state) low = middle;
          else high = middle;
        }
        dryAfter.push(state);
        // The end of a wall stands on the dry side.
        nodes.push(state ? low : high);
        state = !state;
      }
      last = point;
    }
    dryAfter.push(state);
  });
  let parts: WallPart[] = [];
  if (dryAfter.every(Boolean)) parts.push({ points: ring, closed: true });
  else {
    const start = dryAfter.findIndex((state, at) => state && !dryAfter[(at + dryAfter.length - 1) % dryAfter.length]);
    for (let walked = 0; start >= 0 && walked < nodes.length; ) {
      const at = (start + walked) % nodes.length;
      if (!dryAfter[at]) {
        walked++;
        continue;
      }
      const points = [nodes[at] as Point];
      while (walked < nodes.length && dryAfter[(start + walked) % nodes.length]) {
        walked++;
        points.push(nodes[(start + walked) % nodes.length] as Point);
      }
      parts.push({ points, closed: false });
    }
  }
  parts = parts.filter((part) => part.closed || polylineLength(part.points) >= rules.shortest);

  // ---- The far bank ----------------------------------------------------------------------------------------------
  let farShare = 0;
  if (river) {
    const { pieces } = splitAlong(ring, river.line);
    const far = pieces.filter((piece) => overRiver(interiorPoint(piece)));
    farShare = far.reduce((sum, piece) => sum + area(piece), 0) / area(ring);
  }
  const farDropped = farShare > 0 && (farShare < rules.dropFarBelow || !roads.farBank);
  if (farDropped) parts = parts.filter((part) => !overRiver(pointAlongPolyline(part.points, polylineLength(part.points) / 2)));
  const inside = (point: Point) => pointInPolygon(point, ring) && dry(point) && !(farDropped && overRiver(point));

  // ---- Gates -----------------------------------------------------------------------------------------------------
  const gates: Gate[] = [];
  const lines = parts.map((part) => (part.closed ? [...part.points, part.points[0] as Point] : part.points));
  // A wall that ends at the bank on a bridge's landing has its gate at the bridge's end.
  const atBridge = (point: Point): { bridge: number; end: Point } | undefined => {
    for (const [index, bridge] of roads.bridges.entries()) {
      if (distanceToPiece(point, bridge.a, bridge.b) > settings.widths.highway) continue;
      return { bridge: index, end: distance(point, bridge.a) <= distance(point, bridge.b) ? bridge.a : bridge.b };
    }
    return undefined;
  };
  const gateAt = (gate: Gate) => {
    if (!gates.some((other) => other.bridge !== undefined && other.bridge === gate.bridge && distance(other.point, gate.point) < 1e-6)) gates.push(gate);
  };
  const passes = (road: readonly Point[], what: Pick<Gate, 'highway' | 'mainStreet'>) => {
    for (const line of lines) {
      for (const along of crossingsAlong(road, line)) {
        const point = pointAlongPolyline(road, along);
        const found = atBridge(point);
        gateAt(found ? { point: found.end, bridge: found.bridge, ...what } : { point, ...what });
      }
    }
  };
  roads.highways.forEach((highway, index) => passes(highway.points, { highway: index }));
  roads.mainStreets.forEach((street, index) => passes(street, { mainStreet: index }));
  // Where the river closes a side, every bridge into the walled bank has a gate at its end.
  if (farDropped) {
    roads.bridges.forEach((bridge, index) => {
      if (!pointInPolygon(bridge.a, ring)) return;
      const highway = roads.highways.findIndex((road) => road.bridges.includes(index));
      gateAt({ point: bridge.a, bridge: index, ...(highway >= 0 && { highway }) });
    });
  }
  const towers: Point[] = [];
  for (const part of parts) towers.push(...part.points);
  return { ring, axis, long, short, parts, towers, gates, farShare, farDropped, inside };
}
