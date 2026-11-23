/**
 * The street graph of a grown town, from its lines: highways, arterials,
 * quays, streets and lanes, each a polyline. Wherever one line ends on
 * another, or two cross, there is a junction; each line is cut at its
 * junctions into segments. A stretch of a line carried on a bridge is a
 * segment of its own.
 */
import type { Point } from '../schema.ts';
import { toPiece } from './cutting.ts';
import type { SegmentKind } from './records.ts';

export interface Line {
  points: Point[];
  kind: SegmentKind;
  width: number;
  /** The brief's route it carries, as an index into the brief's routes. */
  route?: number;
  /** Stretches on bridges: pairs of consecutive corners of the line. */
  bridges?: Array<[Point, Point]>;
  /** The width of a bridge on it. */
  bridgeWidth?: number;
  /** Points on the line where it must have a junction, such as a gate. */
  stops?: Point[];
}

export interface Node {
  position: Point;
  /** Where a bridge begins or ends. */
  bridgeEnd: boolean;
}

export interface Edge {
  line: number;
  from: number;
  to: number;
  points: Point[];
  kind: SegmentKind;
  width: number;
  route?: number;
  /** How far along its line it begins and ends. */
  start: number;
  end: number;
}

export interface Network {
  nodes: Node[];
  edges: Edge[];
  /** For each line, its edges in order along it. */
  edgesOf: number[][];
  /** The node at a point, if there is one within a hair. */
  nodeAt: (point: Point) => number | undefined;
}

/** Points nearer than this, in metres, are one junction. */
const SAME = 0.01;
/** A line's end this near another line ends on it. */
const MEETS = 1e-3;

const along = (points: readonly Point[]): number[] => {
  const out = [0];
  for (let k = 1; k < points.length; k++) out.push((out[k - 1] as number) + Math.hypot((points[k] as Point)[0] - (points[k - 1] as Point)[0], (points[k] as Point)[1] - (points[k - 1] as Point)[1]));
  return out;
};

/** The nearest point of a line to a point: how far along, the point, and how far away. */
function project(points: readonly Point[], alongs: readonly number[], point: Point): { at: number; point: Point; away: number } {
  let best = { at: 0, point: points[0] as Point, away: Infinity };
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const span = dx * dx + dy * dy;
    const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span));
    const near: Point = [a[0] + dx * t, a[1] + dy * t];
    const away = Math.hypot(near[0] - point[0], near[1] - point[1]);
    if (away < best.away) best = { at: (alongs[k - 1] as number) + t * Math.sqrt(span), point: near, away };
  }
  return best;
}

/** The part of a line between two distances along it. */
function slice(points: readonly Point[], alongs: readonly number[], from: number, to: number): Point[] {
  const at = (distance: number): Point => {
    for (let k = 1; k < points.length; k++) {
      if ((alongs[k] as number) >= distance - 1e-12 || k === points.length - 1) {
        const span = (alongs[k] as number) - (alongs[k - 1] as number);
        const t = span === 0 ? 0 : Math.max(0, Math.min(1, (distance - (alongs[k - 1] as number)) / span));
        const a = points[k - 1] as Point;
        const b = points[k] as Point;
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
    }
    return points[points.length - 1] as Point;
  };
  const out: Point[] = [at(from)];
  for (let k = 0; k < points.length; k++) if ((alongs[k] as number) > from + 1e-9 && (alongs[k] as number) < to - 1e-9) out.push(points[k] as Point);
  out.push(at(to));
  return out;
}

export function buildNetwork(lines: readonly Line[]): Network {
  const alongs = lines.map((line) => along(line.points));
  // Pieces of every line filed by square.
  const SQUARE = 30;
  const filed = new Map<string, Array<[number, number]>>();
  lines.forEach((line, id) => {
    for (let k = 1; k < line.points.length; k++) {
      const a = line.points[k - 1] as Point;
      const b = line.points[k] as Point;
      for (let x = Math.floor((Math.min(a[0], b[0]) - 1) / SQUARE); x <= Math.floor((Math.max(a[0], b[0]) + 1) / SQUARE); x++) {
        for (let y = Math.floor((Math.min(a[1], b[1]) - 1) / SQUARE); y <= Math.floor((Math.max(a[1], b[1]) + 1) / SQUARE); y++) {
          const key = `${x}:${y}`;
          const list = filed.get(key);
          if (list) list.push([id, k]);
          else filed.set(key, [[id, k]]);
        }
      }
    }
  });
  const near = (point: Point) => {
    const seen = new Set<number>();
    const x = Math.floor(point[0] / SQUARE);
    const y = Math.floor(point[1] / SQUARE);
    for (const [id] of filed.get(`${x}:${y}`) ?? []) seen.add(id);
    return [...seen].sort((a, b) => a - b);
  };
  // Where each line is to be cut: distances along it.
  const cuts: number[][] = lines.map((line, id) => [0, alongs[id]?.[line.points.length - 1] as number]);
  // A line's end on another line.
  lines.forEach((line, id) => {
    for (const end of [0, line.points.length - 1]) {
      const point = line.points[end] as Point;
      for (const other of near(point)) {
        if (other === id) continue;
        const found = project(lines[other]?.points as Point[], alongs[other] as number[], point);
        if (found.away < MEETS) (cuts[other] as number[]).push(found.at);
      }
    }
  });
  // Two lines crossing.
  const crossings = new Set<string>();
  for (const list of filed.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [one, k] = list[i] as [number, number];
        const [two, m] = list[j] as [number, number];
        if (one === two) continue;
        const key = one < two ? `${one}:${k}:${two}:${m}` : `${two}:${m}:${one}:${k}`;
        if (crossings.has(key)) continue;
        crossings.add(key);
        const a = (lines[one] as Line).points[k - 1] as Point;
        const b = (lines[one] as Line).points[k] as Point;
        const c = (lines[two] as Line).points[m - 1] as Point;
        const d = (lines[two] as Line).points[m] as Point;
        const ab: Point = [b[0] - a[0], b[1] - a[1]];
        const cd: Point = [d[0] - c[0], d[1] - c[1]];
        const denominator = ab[0] * cd[1] - ab[1] * cd[0];
        if (Math.abs(denominator) < 1e-12) continue;
        const t = ((c[0] - a[0]) * cd[1] - (c[1] - a[1]) * cd[0]) / denominator;
        const u = ((c[0] - a[0]) * ab[1] - (c[1] - a[1]) * ab[0]) / denominator;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        (cuts[one] as number[]).push((alongs[one]?.[k - 1] as number) + t * Math.hypot(ab[0], ab[1]));
        (cuts[two] as number[]).push((alongs[two]?.[m - 1] as number) + u * Math.hypot(cd[0], cd[1]));
      }
    }
  }
  // Points that must be junctions.
  lines.forEach((line, id) => {
    for (const point of line.stops ?? []) (cuts[id] as number[]).push(project(line.points, alongs[id] as number[], point).at);
  });
  // Bridge ends.
  const bridgeEnds = new Set<string>();
  lines.forEach((line, id) => {
    for (const [a, b] of line.bridges ?? []) {
      for (const end of [a, b]) {
        const found = project(line.points, alongs[id] as number[], end);
        (cuts[id] as number[]).push(found.at);
        bridgeEnds.add(`${id}:${found.at}`);
      }
    }
  });

  // Junctions: one for every place a line is cut, those within a hair of each other one.
  const nodes: Node[] = [];
  const nodeFiled = new Map<string, number[]>();
  const nodeAt = (point: Point): number | undefined => {
    const x = Math.floor(point[0] / 1);
    const y = Math.floor(point[1] / 1);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const id of nodeFiled.get(`${x + dx}:${y + dy}`) ?? []) if (Math.hypot((nodes[id] as Node).position[0] - point[0], (nodes[id] as Node).position[1] - point[1]) < SAME) return id;
    return undefined;
  };
  const nodeFor = (point: Point, bridgeEnd: boolean): number => {
    const found = nodeAt(point);
    if (found !== undefined) {
      if (bridgeEnd) (nodes[found] as Node).bridgeEnd = true;
      return found;
    }
    nodes.push({ position: point, bridgeEnd });
    const key = `${Math.floor(point[0])}:${Math.floor(point[1])}`;
    const list = nodeFiled.get(key);
    if (list) list.push(nodes.length - 1);
    else nodeFiled.set(key, [nodes.length - 1]);
    return nodes.length - 1;
  };
  const edges: Edge[] = [];
  const edgesOf: number[][] = lines.map(() => []);
  lines.forEach((line, id) => {
    const lineAlong = alongs[id] as number[];
    const total = lineAlong[lineAlong.length - 1] as number;
    const places = [...new Set(cuts[id] as number[])].map((at) => Math.max(0, Math.min(total, at))).sort((a, b) => a - b);
    const kept: number[] = [];
    for (const at of places) if (kept.length === 0 || at - (kept[kept.length - 1] as number) > SAME) kept.push(at);
    if (kept.length > 0 && total - (kept[kept.length - 1] as number) <= SAME) kept[kept.length - 1] = total;
    const isBridgeEnd = (at: number) => [...bridgeEnds].some((key) => key.startsWith(`${id}:`) && Math.abs(Number(key.slice(key.indexOf(':') + 1)) - at) <= SAME);
    const ids = kept.map((at) => {
      const point = slice(line.points, lineAlong, at, at)[0] as Point;
      return nodeFor(point, isBridgeEnd(at));
    });
    for (let k = 1; k < kept.length; k++) {
      const from = ids[k - 1] as number;
      const to = ids[k] as number;
      if (from === to) continue;
      const start = kept[k - 1] as number;
      const end = kept[k] as number;
      const points = slice(line.points, lineAlong, start, end);
      points[0] = (nodes[from] as Node).position;
      points[points.length - 1] = (nodes[to] as Node).position;
      // On a bridge: the stretch between two ends of one bridge.
      const middle = (start + end) / 2;
      const onBridge = (line.bridges ?? []).some(([a, b]) => {
        const one = project(line.points, lineAlong, a).at;
        const two = project(line.points, lineAlong, b).at;
        return middle > Math.min(one, two) && middle < Math.max(one, two);
      });
      edges.push({
        line: id,
        from,
        to,
        points,
        kind: onBridge ? 'bridge' : line.kind,
        width: onBridge ? (line.bridgeWidth ?? line.width) : line.width,
        ...(line.route !== undefined && { route: line.route }),
        start,
        end,
      });
      (edgesOf[id] as number[]).push(edges.length - 1);
    }
  });
  return { nodes, edges, edgesOf, nodeAt };
}

/** The nearest point of an edge's line to a point, and how far. */
export function nearestOn(points: readonly Point[], point: Point): { point: Point; away: number } {
  let best = { point: points[0] as Point, away: Infinity };
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1] as Point;
    const b = points[k] as Point;
    const away = toPiece(point, a, b);
    if (away < best.away) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const span = dx * dx + dy * dy;
      const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / span));
      best = { point: [a[0] + dx * t, a[1] + dy * t], away };
    }
  }
  return best;
}
