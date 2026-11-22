/**
 * The grown layout generator: a town that looks as if it grew about its
 * centre. Ring streets run round the centre and cross streets between them,
 * staggered from ring to ring so that most junctions are T-shaped; main roads
 * run out from the centre to the brief's exits, drifting as they go; and the
 * whole is bent out of true by a smooth warp, so that no street is straight
 * and no two blocks match.
 *
 * A finished city, its brief, the pack and a seed in; a layout out, in the
 * same format the grid makes. The city is read and never changed. Every
 * length comes from the pack's layout settings; randomness comes from streams
 * of this generator's own (`grown-…`).
 *
 * The town is first laid out about the centre in distance and bearing, where
 * a block is the ground between two ring streets and two cross streets and a
 * lot is a piece of a block between two distances and two bearings. Lots in
 * one block therefore cannot overlap, and a lot keeps its pack area exactly.
 * Only then is every point moved by the warp, which keeps apart what was
 * apart. Lines are cut into short pieces first, at the same places wherever
 * two shapes share a line, so that they still share it after bending.
 *
 * The steps, in order:
 *   1. Site: the river, bending gently, and the sea with its shore.
 *   2. Main roads: one from the centre, or the plaza's edge, toward each exit.
 *   3. The lattice of ring streets, cross streets and courts, and the wall.
 *   4. Districts, grown block by block from the centre outward along the
 *      main roads and the water, packing each one's lots as it grows.
 *   5. Exits, bridges, and the streets that are kept.
 *   6. The records, with the warp applied, and every layout invariant checked.
 */
import type { Building, City, District } from '../city/records.ts';
import { stepRng } from '../city/random.ts';
import { idNumber } from '../ids.ts';
import { type GrownSettings, type SettingPack, footprintCoverageOf, lotSizeOf } from '../pack/schema.ts';
import type { Point, SettlementBrief } from '../schema.ts';
import { EPSILON, bearingVector, boxOf, crossingsOfPolyline, distance, distanceBetweenPolylines, distanceToPolyline, polygonArea, projectOnPolyline } from './geometry.ts';
import { type LayoutOptions, LayoutGenerationError } from './grid.ts';
import { Heap } from './heap.ts';
import { checkLayout } from './invariants.ts';
import { type Exit, type Junction, type JunctionKind, type Layout, type Lot, type Place, type Segment, type SegmentKind, type Wall, type Water, LAYOUT_VERSION } from './records.ts';
import { arrangeTrades, placementOrder, spreadCivicTypes } from './shared.ts';

/** The name this generator records in a layout's summary. */
export const GROWN_GENERATOR = 'grown';

/** An exit lies within this many degrees of the brief's bearing: it moves aside only to keep out of the river. */
const EXIT_TOLERANCE = 5;
/** The share of the town's ground that lots are expected to cover, for a first guess at how far the town reaches. */
const LOT_SHARE = 0.55;
/** How many blocks a district may grow to find room for a spread civic building far enough from the others of its type. */
const APART_BLOCKS = 3;
/** Every ring has at least this many cross streets, so that no block runs all the way round. */
const LEAST_RADIALS = 3;
const TAU = 2 * Math.PI;

/** Thrown inside an attempt when the lattice proved too small; the attempt is repeated on a larger one. */
class TooSmall extends Error {}

const pad = (value: number, digits: number) => String(value).padStart(digits, '0');
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1];
/** A bearing brought into 0 up to a full turn. */
const turn = (angle: number) => ((angle % TAU) + TAU) % TAU;
/** The bearing equal to `angle` that is the first at or after `from`. */
const after = (angle: number, from: number) => angle + TAU * Math.ceil((from - angle) / TAU - 1e-12);
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function generateGrownLayout(city: City, brief: SettlementBrief, pack: SettingPack, options: LayoutOptions = {}): Layout {
  const seed = options.seed ?? brief.seed;
  if (!pack.layout.grown) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the pack's layout file has no \`grown\` block, which the grown generator needs`);
  // Start with room for the town twice over, and widen the lattice for as long as it proves too small.
  let reach = 1.6;
  for (let attempt = 0; ; attempt++, reach *= 1.5) {
    try {
      return attemptLayout(city, brief, pack, pack.layout.grown, seed, reach);
    } catch (error) {
      if (!(error instanceof TooSmall) || attempt >= 7) {
        if (error instanceof TooSmall) throw new LayoutGenerationError(`${brief.id} (${brief.name}): the town does not fit even a lattice ${reach.toFixed(1)} times its size`);
        throw error;
      }
    }
  }
}

/** A cross street of one ring: a line from the ring's inner street to its outer, at a bearing that may drift on the way. */
interface Radial {
  /** The bearing where it meets the inner ring street, and the outer. */
  inner: number;
  outer: number;
  /** The exit whose main road this is a piece of. */
  arterial?: number;
  /** A court: it stops half way, from the inner street or from the outer. */
  court?: 'inner' | 'outer';
  /** Whether a street runs along it. In the wall's ring only the gates do; the rest are bounds between its cells. */
  street: boolean;
  /** For a gate: the gatehouse that keeps it. */
  gate?: Building;
}
interface Ring {
  index: number;
  /** The ring the wall stands in: it has no blocks and no lots. */
  band: boolean;
  inner: number;
  outer: number;
  radials: Radial[];
  cells: number[];
}
/** A piece of a block's frontage that lots are packed along: bearings for a ring street's, distances for a main road's. */
interface Track {
  from: number;
  to: number;
  cursor: number;
}
/** A block: the ground between two ring streets and two cross streets. */
interface Cell {
  id: number;
  ring: Ring;
  left: Radial;
  right: Radial;
  /** Added to the right cross street's bearings, so that they follow the left's. */
  shift: number;
  neighbours: number[];
  /** The outline along the middles of the streets round it, bent. */
  polygon: Point[];
  centre: Point;
  wet: boolean;
  /** Not to be built on: outside a wall that encloses everything. */
  barred: boolean;
  edges: number[];
  /** Where lots may be: between two distances from the centre, and frontages along each street that has one. */
  near?: number;
  far?: number;
  tracks?: { inner?: Track; outer?: Track; left?: Track; right?: Track };
  /** Distances and bearings at which a lot of this block has a corner: every line in the block is cut there. */
  radii: number[];
  bearings: number[];
}
interface Edge {
  id: number;
  from: number;
  to: number;
  points: Point[];
  length: number;
  kind: SegmentKind;
  /** Wider than its kind: a quay. */
  quay: boolean;
  /** The exit whose main road this is a piece of. */
  arterial?: number;
  /** On a ring street: which, and between which bearings. */
  circle?: number;
  span?: [number, number];
  radial?: Radial;
  wet: boolean;
  cells: number[];
}
/** A lot as it is packed: a piece of a block between two distances and two bearings, or along a main road. */
interface Placed {
  building: Building;
  cell: Cell;
  /** Which frontage it stands on; `through` runs from the inner street to the outer and opens onto the outer. */
  track: 'inner' | 'outer' | 'through' | 'left' | 'right';
  /** A gatehouse, which keeps its place by its gate. */
  gatehouse?: true;
  /** Distances from the centre. */
  near: number;
  far: number;
  /** Bearings; for a lot along a main road, how deep it is back from the road instead. */
  from: number;
  to: number;
  depth: number;
}

function attemptLayout(city: City, brief: SettlementBrief, pack: SettingPack, grown: GrownSettings, seed: number, reachFactor: number): Layout {
  const settings = pack.layout;
  const number = idNumber(brief.id);
  const fail = (message: string): never => {
    throw new LayoutGenerationError(`${brief.id} (${brief.name}): ${message}`);
  };
  const widths = settings.streetWidths;
  const widest = Math.max(widths.arterial, widths.street, widths.lane, widths.bridge);
  const { pieceLength } = grown;
  const halfDepth = grown.ringDepth.min / 2;

  // ---- The warp -------------------------------------------------------------------
  // A few long waves, each pushing along its own direction. Their slopes together stay well below one, so that no
  // two points are ever moved onto each other.
  const waves = (() => {
    const rng = stepRng(seed, 'grown-warp');
    return [1, 0.62, 1.7].map((scale, index) => {
      const along = rng.next() * TAU;
      const push = rng.next() * TAU;
      return { kx: (Math.cos(along) * TAU) / (grown.warp.wavelength * scale), ky: (Math.sin(along) * TAU) / (grown.warp.wavelength * scale), phase: rng.next() * TAU, px: Math.cos(push), py: Math.sin(push), share: [0.5, 0.2, 0.3][index] as number };
    });
  })();
  const warp = ([x, y]: Point): Point => {
    let dx = 0;
    let dy = 0;
    for (const wave of waves) {
      const swing = grown.warp.amplitude * wave.share * Math.sin(wave.kx * x + wave.ky * y + wave.phase);
      dx += wave.px * swing;
      dy += wave.py * swing;
    }
    return [x + dx, y + dy];
  };
  // The warp squeezes in places by as much as its steepest slope, and what is squeezed must still clear a roadway:
  // the clear ground beside a street is laid out wider by that much, and so is a street's own half-width.
  const squeeze = 1 - waves.reduce((sum, wave) => sum + grown.warp.amplitude * wave.share * Math.hypot(wave.kx, wave.ky), 0);
  if (!(squeeze > 0.5)) fail('the warp is too steep: its amplitude must be a small part of its wavelength');
  const roadside = grown.roadside / squeeze;
  /** Half the width of a roadway, as it is allowed for before the warp. */
  const half = (width: number) => width / 2 / squeeze;
  /** A place by its distance and bearing from the centre, as it stands on the map. */
  const at = (radius: number, bearing: number): Point => warp([radius * Math.sin(bearing), -radius * Math.cos(bearing)]);

  // ---- How much ground --------------------------------------------------------------
  const lotArea = (building: Building) => {
    const size = lotSizeOf(building.type, pack);
    return size.frontage * size.depth;
  };
  const plazaBuilding = brief.flags.plaza ? city.buildings.find((building) => building.type === grown.plaza.building) : undefined;
  const plazaArea = plazaBuilding ? Math.min(Math.max(brief.population * grown.plaza.perResident, grown.plaza.min), grown.plaza.max) : 0;
  const plazaRadius = Math.sqrt(plazaArea / Math.PI);
  const totalLotArea = city.buildings.reduce((sum, building) => sum + (building === plazaBuilding ? 0 : lotArea(building)), 0);
  const needed = totalLotArea / LOT_SHARE + plazaArea;
  const townRadius = Math.sqrt(needed / Math.PI);
  const pitch = (grown.ringDepth.min + grown.ringDepth.max) / 2 + widths.street + 2 * roadside;
  const latticeRadius = townRadius * reachFactor + 3 * pitch;

  // ---- Water ------------------------------------------------------------------------
  // The river runs from the brief's arrival bearing to its departure bearing, beside the centre, swinging gently
  // on the way. Its ends lie beyond the lattice, so it always reaches the town's edge.
  const beyond = latticeRadius + 4 * pitch;
  const riverClearance = settings.riverWidth / 2 + widest / 2;
  let riverLine: Point[] | undefined;
  if (brief.river) {
    const arrives = brief.river.arrivesFrom?.bearing;
    const leaves = brief.river.leavesToward?.bearing ?? brief.coast.waterBearing ?? (arrives === undefined ? fail('the brief has a river with no bearing to place it by') : (arrives + 180) % 360);
    const beside = riverClearance + plazaRadius + grown.centreRadius + pitch;
    const end = (bearing: number): Point => {
      const [x, y] = bearingVector(bearing);
      return [x * beyond, y * beyond];
    };
    let through: Point[];
    if (arrives === undefined) {
      const [x, y] = bearingVector(leaves + 90);
      through = [[x * beside, y * beside], end(leaves)];
    } else {
      const bend = ((leaves - arrives + 540) % 360) - 180;
      const [x, y] = bearingVector(arrives + (Math.abs(bend) === 180 ? 90 : bend / 2));
      through = [end(arrives), [x * beside, y * beside], end(leaves)];
    }
    // Each straight stretch swings aside in one slow wave, nothing at its ends.
    const rng = stepRng(seed, 'grown-river');
    riverLine = [];
    for (let stretch = 1; stretch < through.length; stretch++) {
      const a = through[stretch - 1] as Point;
      const b = through[stretch] as Point;
      const length = distance(a, b);
      const swing = (rng.next() < 0.5 ? -1 : 1) * grown.riverBend * Math.min(length, 2 * townRadius) * (0.6 + 0.4 * rng.next());
      const pieces = Math.max(2, Math.ceil(length / (4 * pieceLength)));
      for (let piece = stretch === 1 ? 0 : 1; piece <= pieces; piece++) {
        const share = piece / pieces;
        // The swing is taken out near the centre's end of the stretch too, so that the river keeps clear of it.
        const aside = swing * Math.sin(Math.PI * share) * (stretch === 1 && through.length === 3 ? 1 - share : share < 1 && through.length === 3 ? share : 1);
        riverLine.push([a[0] + (b[0] - a[0]) * share - ((b[1] - a[1]) / length) * aside, a[1] + (b[1] - a[1]) * share + ((b[0] - a[0]) / length) * aside]);
      }
    }
  }
  const nearRiver = (points: readonly Point[], clearance = riverClearance) => riverLine !== undefined && distanceBetweenPolylines(points, riverLine) < clearance - EPSILON;

  // The sea lies beyond a shore on the side of the brief's water bearing. The shore is set before anything is
  // built: far enough out for the centre of the town, near enough for the harbour to stand at the water.
  const placements = new Map(pack.districts.kinds.map((kind) => [kind.id, kind.placement]));
  const placementOf = (district: District) => placements.get(district.kind);
  const seaward = brief.coast.waterBearing === undefined ? undefined : bearingVector(brief.coast.waterBearing);
  let shore: number | undefined;
  if (seaward) {
    const kindOf = new Map(city.districts.map((district) => [district.id, placementOf(district)]));
    const central = city.buildings.reduce((sum, building) => sum + (kindOf.get(building.districtId) === 'centre' && building !== plazaBuilding ? lotArea(building) : 0), 0);
    shore = Math.sqrt((central / LOT_SHARE + plazaArea) / Math.PI) + 1.5 * pitch + grown.centreRadius;
  }
  const inset = widest / 2;
  const inSea = (point: Point) => shore !== undefined && dot(point, seaward as Point) > shore - inset + EPSILON;

  // ---- Main roads ---------------------------------------------------------------------
  // One for each exit, at the brief's bearing, swinging aside in the middle of its way through town and back.
  // The swing is held to a part of the gap to the next main road, so that no two ever cross.
  const exitBearings = brief.routes.map((route) => toRadians(route.bearing));
  const drifts = (() => {
    const rng = stepRng(seed, 'grown-arterials');
    return exitBearings.map((bearing, index) => {
      const gap = Math.min(TAU, ...exitBearings.filter((_, other) => other !== index).map((other) => Math.min(turn(other - bearing), turn(bearing - other))));
      const wanted = toRadians(grown.arterialDrift.min + rng.next() * (grown.arterialDrift.max - grown.arterialDrift.min));
      return (rng.next() < 0.5 ? -1 : 1) * Math.min(wanted, gap * 0.3);
    });
  })();
  const arterialBearing = (index: number, radius: number) => (exitBearings[index] as number) + (drifts[index] as number) * Math.sin(Math.PI * Math.min(1, radius / townRadius));

  // ---- The lattice --------------------------------------------------------------------
  // Ring streets at uneven distances, each ring cut into blocks of uneven length by cross streets that do not line
  // up with those of the ring inside it. The main roads are cross streets that do line up, from ring to ring.
  const rings: Ring[] = [];
  /** The ring streets: circle `n` is the inner street of ring `n`. Circle 0 is the street round the plaza, or the centre itself. */
  const circles: number[] = [];
  const gatehouses = brief.flags.walls ? city.buildings.filter((building) => building.type === grown.wall.gatehouse) : [];
  const walled = gatehouses.length > 0;
  const enclosesAll = walled && brief.population < grown.wall.enclosesAllBelow;
  /** The wall stands just beyond the first ring street at least this far out. */
  const wallFrom = walled ? Math.sqrt(((enclosesAll ? 1.25 * reachFactor : grown.wall.share) * needed) / Math.PI) : Infinity;
  let wallRadius: number | undefined;
  let band: Ring | undefined;
  {
    const rng = stepRng(seed, 'grown-lattice');
    const centre = plazaBuilding ? plazaRadius + half(widths.arterial) + roadside : 0;
    circles.push(centre);
    let inner = centre;
    /** The cross streets that already meet the ring street now being built on, from the ring inside it. */
    let met: Radial[] = [];
    while (inner < latticeRadius || rings.length < 3) {
      const first = rings.length === 0 && !plazaBuilding;
      if (walled && !band && inner >= wallFrom && rings.length >= 2) {
        // The wall's ring: a street inside the wall with a clear strip, the wall, and a street outside it.
        const outer = inner + 2 * half(widths.street) + (grown.wall.clearStrip + grown.wall.width) / squeeze + 2 * roadside;
        wallRadius = inner + half(widths.street) + roadside + (grown.wall.clearStrip + grown.wall.width / 2) / squeeze;
        // Its bounds carry on from the cross streets inside it; which of them are gates is settled once the water is known.
        const through = met.map((radial): Radial => ({ inner: radial.outer, outer: radial.arterial !== undefined ? arterialBearing(radial.arterial, outer) : radial.outer, ...(radial.arterial !== undefined && { arterial: radial.arterial }), street: false }));
        band = { index: rings.length, band: true, inner, outer, radials: through.sort((a, b) => turn(a.inner) - turn(b.inner)), cells: [] };
        rings.push(band);
        circles.push(outer);
        inner = outer;
        met = band.radials;
        continue;
      }
      const depth = first ? grown.centreRadius : grown.ringDepth.min + rng.next() * (grown.ringDepth.max - grown.ringDepth.min) + widths.street + 2 * roadside;
      const outer = inner + depth;
      const middle = (inner + outer) / 2;
      const radials: Radial[] = exitBearings.map((_, index) => ({ inner: arterialBearing(index, inner), outer: arterialBearing(index, outer), arterial: index, street: true }));
      // Cross streets between the main roads: as many as give blocks of about the pack's length, each moved a
      // little by chance, and kept clear of the junctions the ring street already has.
      const gap = grown.junctionGap / Math.max(inner, grown.junctionGap);
      const fixed = radials.map((radial) => turn(radial.inner)).sort((a, b) => a - b);
      const taken = [...met.map((radial) => turn(radial.outer)), ...fixed];
      const clear = (bearing: number, others: number[]) => others.every((other) => Math.min(turn(other - bearing), turn(bearing - other)) >= gap);
      const bounds = fixed.length === 0 ? [0, TAU] : fixed.map((bearing, index) => [bearing, index + 1 < fixed.length ? (fixed[index + 1] as number) : (fixed[0] as number) + TAU]).flat();
      for (let pair = 0; pair + 1 < bounds.length; pair += 2) {
        const from = bounds[pair] as number;
        const to = bounds[pair + 1] as number;
        const arc = (to - from) * middle;
        const length = grown.blockLength.min + rng.next() * (grown.blockLength.max - grown.blockLength.min);
        // The first ring of a town with no plaza has only what cross streets it needs to be more than one block.
        const count = first ? Math.max(0, Math.ceil((LEAST_RADIALS - fixed.length) / Math.max(fixed.length, 1))) : Math.max(0, Math.round(arc / length) - 1);
        for (let piece = 1; piece <= count; piece++) {
          let bearing = from + ((to - from) * (piece + (rng.next() - 0.5) * 0.5)) / (count + 1);
          // Moved aside from a junction it would crowd, if there is room; otherwise left out.
          for (let nudge = 0; nudge < 4 && !clear(bearing, taken); nudge++) bearing += gap * (nudge % 2 === 0 ? 1 : -1) * (nudge + 1);
          if (!clear(bearing, taken)) continue;
          taken.push(turn(bearing));
          radials.push({ inner: bearing, outer: bearing, street: true });
        }
      }
      // A ring needs a few cross streets whatever the main roads give it.
      for (let extra = 0; radials.length < LEAST_RADIALS && extra < 12; extra++) {
        const bearing = rng.next() * TAU;
        if (!clear(bearing, taken)) continue;
        taken.push(turn(bearing));
        radials.push({ inner: bearing, outer: bearing, street: true });
      }
      radials.sort((a, b) => turn(a.inner) - turn(b.inner));
      // Some cross streets stop half way as a court. Never a main road, never beside another court, and never in
      // the first ring, where every one is needed.
      if (rings.length > 0) {
        radials.forEach((radial, index) => {
          const beside = [radials[(index + radials.length - 1) % radials.length] as Radial, radials[(index + 1) % radials.length] as Radial];
          if (radial.arterial === undefined && radials.length > LEAST_RADIALS + 1 && beside.every((other) => !other.court) && rng.next() < grown.courtShare) radial.court = rng.next() < 0.5 ? 'inner' : 'outer';
        });
      }
      rings.push({ index: rings.length, band: false, inner, outer, radials, cells: [] });
      circles.push(outer);
      met = radials.filter((radial) => radial.court !== 'inner');
      inner = outer;
    }
  }

  // ---- Lines, cut the same way everywhere ---------------------------------------------
  /** The bearings at which cross streets meet each ring street. */
  const stops: number[][] = circles.map(() => []);
  for (const ring of rings) {
    for (const radial of ring.radials) {
      if (radial.court !== 'outer') (stops[ring.index] as number[]).push(turn(radial.inner));
      if (radial.court !== 'inner') (stops[ring.index + 1] as number[]).push(turn(radial.outer));
    }
  }
  stops.forEach((list, circle) => {
    list.sort((a, b) => a - b);
    stops[circle] = list.filter((bearing, index) => index === 0 || bearing - (list[index - 1] as number) > 1e-12);
  });
  /** The bearings at which a block has a corner on each ring street, whether or not a street meets it there: every line along the ring street is cut at them. */
  const corners: number[][] = circles.map(() => []);
  for (const ring of rings) {
    for (const radial of ring.radials) {
      (corners[ring.index] as number[]).push(turn(radial.inner));
      (corners[ring.index + 1] as number[]).push(turn(radial.outer));
    }
  }
  /** The bearings at which a line round the centre is cut between two bearings: every so many metres, and wherever a line meets it. */
  const cuts = (radius: number, from: number, to: number, meets: readonly number[] = []): number[] => {
    const found = [from, to];
    if (radius > 0) {
      const step = pieceLength / radius;
      for (let mark = Math.ceil(from / step + 1e-9); mark * step < to - 1e-9; mark++) found.push(mark * step);
    }
    for (const meet of meets) {
      for (let bearing = after(meet, from); bearing < to - 1e-12; bearing += TAU) if (bearing > from + 1e-12) found.push(bearing);
    }
    found.sort((a, b) => a - b);
    return found.filter((bearing, index) => index === 0 || bearing - (found[index - 1] as number) > 1e-12);
  };
  /** The distances at which a line outward from the centre is cut between two distances. */
  const steps = (from: number, to: number, meets: readonly number[] = []): number[] => {
    const found = [from, to];
    for (let mark = Math.ceil(from / pieceLength + 1e-9); mark * pieceLength < to - 1e-9; mark++) found.push(mark * pieceLength);
    for (const meet of meets) if (meet > from + 1e-9 && meet < to - 1e-9) found.push(meet);
    found.sort((a, b) => a - b);
    return found.filter((radius, index) => index === 0 || radius - (found[index - 1] as number) > 1e-9);
  };
  /** The bearing of a cross street at a distance from the centre. */
  const bearingAt = (ring: Ring, radial: Radial, radius: number) => radial.inner + ((radial.outer - radial.inner) * (radius - ring.inner)) / (ring.outer - ring.inner);
  /** A line round the centre, from one bearing to another, as points on the map. */
  const arc = (radius: number, from: number, to: number, meets?: readonly number[]): Point[] => (radius === 0 ? [at(0, 0)] : cuts(radius, from, to, meets).map((bearing) => at(radius, bearing)));
  /** A line along a cross street, shifted round the centre by so many metres at each point, between two distances. */
  const spoke = (ring: Ring, radial: Radial, near: number, far: number, aside = 0, shift = 0, meets?: readonly number[]): Point[] =>
    steps(near, far, meets).map((radius) => at(radius, bearingAt(ring, radial, radius) + shift + (radius > 0 ? aside / radius : 0)));

  // ---- Junctions, edges and blocks ------------------------------------------------------
  const junctions: Array<{ point: Point; kind?: JunctionKind }> = [];
  const junctionKeys = new Map<string, number>();
  const junctionAt = (key: string, point: () => Point): number => {
    let index = junctionKeys.get(key);
    if (index === undefined) {
      index = junctions.length;
      junctions.push({ point: point() });
      junctionKeys.set(key, index);
    }
    return index;
  };
  const onCircle = (circle: number, bearing: number) => ((circles[circle] as number) === 0 ? junctionAt('centre', () => at(0, 0)) : junctionAt(`${circle}:${Math.round(turn(bearing) * 1e9)}`, () => at(circles[circle] as number, bearing)));
  const edges: Edge[] = [];
  const addEdge = (edge: Omit<Edge, 'id' | 'length' | 'wet' | 'cells'>): Edge => {
    const made: Edge = { ...edge, id: edges.length, length: edge.points.reduce((sum, point, index) => (index === 0 ? 0 : sum + distance(edge.points[index - 1] as Point, point)), 0), wet: false, cells: [] };
    edges.push(made);
    return made;
  };
  /** The edges of each ring street, in order round the centre. */
  const ringEdges: Edge[][] = circles.map(() => []);
  circles.forEach((radius, circle) => {
    const list = stops[circle] as number[];
    if (radius === 0 || list.length < 2) return;
    list.forEach((from, index) => {
      const to = index + 1 < list.length ? (list[index + 1] as number) : (list[0] as number) + TAU;
      (ringEdges[circle] as Edge[]).push(addEdge({ from: onCircle(circle, from), to: onCircle(circle, to), points: arc(radius, from, to, corners[circle]), kind: 'street', quay: false, circle, span: [from, to] }));
    });
  });
  const radialEdges = new Map<Radial, Edge[]>();
  const gateJunctions = new Map<Radial, number>();
  for (const ring of rings) {
    for (const radial of ring.radials) {
      if (!radial.street) continue;
      const kind: SegmentKind = radial.arterial !== undefined ? 'arterial' : 'lane';
      const common = { kind, quay: false, radial, ...(radial.arterial !== undefined && { arterial: radial.arterial }) };
      if (ring.band) continue;
      const middle = (ring.inner + ring.outer) / 2;
      const near = radial.court === 'outer' ? middle : ring.inner;
      const far = radial.court === 'inner' ? middle : ring.outer;
      const end = (radius: number, circle: number) => (radius === middle ? junctionAt(`court:${ring.index}:${Math.round(turn(radial.inner) * 1e9)}`, () => at(middle, bearingAt(ring, radial, middle))) : onCircle(circle, bearingAt(ring, radial, radius)));
      radialEdges.set(radial, [addEdge({ ...common, from: end(near, ring.index), to: end(far, ring.index + 1), points: spoke(ring, radial, near, far) })]);
    }
  }
  /** Opens a gate in the wall along one of the bounds of its ring: a street from the street inside to the gate on the wall's line, and on to the street outside. */
  const openGate = (radial: Radial, gatehouse: Building) => {
    const ring = band as Ring;
    radial.street = true;
    radial.gate = gatehouse;
    const kind: SegmentKind = radial.arterial !== undefined ? 'arterial' : 'lane';
    const common = { kind, quay: false, radial, ...(radial.arterial !== undefined && { arterial: radial.arterial }) };
    const gate = junctionAt(`gate:${Math.round(turn(radial.inner) * 1e9)}`, () => at(wallRadius as number, bearingAt(ring, radial, wallRadius as number)));
    (junctions[gate] as { kind?: JunctionKind }).kind = 'gate';
    gateJunctions.set(radial, gate);
    const made = [
      addEdge({ ...common, from: onCircle(ring.index, radial.inner), to: gate, points: spoke(ring, radial, ring.inner, wallRadius as number) }),
      addEdge({ ...common, from: gate, to: onCircle(ring.index + 1, radial.outer), points: spoke(ring, radial, wallRadius as number, ring.outer) }),
    ];
    radialEdges.set(radial, made);
    return made;
  };
  const cells: Cell[] = [];
  for (const ring of rings) {
    ring.radials.forEach((left, index) => {
      const right = ring.radials[(index + 1) % ring.radials.length] as Radial;
      const shift = after(right.inner, left.inner + 1e-9) - right.inner;
      const from = left.inner;
      const to = right.inner + shift;
      const outerFrom = left.outer;
      const outerTo = right.outer + shift;
      const polygon = [
        ...arc(ring.inner, from, to, corners[ring.index]),
        ...spoke(ring, right, ring.inner, ring.outer, 0, shift).slice(1),
        ...arc(ring.outer, outerFrom, outerTo, corners[ring.index + 1])
          .reverse()
          .slice(1),
        ...spoke(ring, left, ring.inner, ring.outer).reverse().slice(1, -1),
      ];
      const middle = (ring.inner + ring.outer) / 2;
      const cell: Cell = { id: cells.length, ring, left, right, shift, neighbours: [], polygon, centre: at(middle, (bearingAt(ring, left, middle) + bearingAt(ring, right, middle) + shift) / 2), wet: false, barred: false, edges: [], radii: [], bearings: [] };
      cells.push(cell);
      ring.cells.push(cell.id);
      for (const radial of [left, right]) for (const edge of radialEdges.get(radial) ?? []) if (!edge.cells.includes(cell.id)) (cell.edges.push(edge.id), edge.cells.push(cell.id));
      // The pieces of the two ring streets that run along the block.
      for (const [circle, a, b] of [[ring.index, from, to], [ring.index + 1, outerFrom, outerTo]] as const) {
        for (const edge of ringEdges[circle] as Edge[]) {
          const [start, finish] = edge.span as [number, number];
          // The first turn of the piece that ends after the block's span begins: it runs along the block if it begins before the span ends.
          const begins = after(start, a - (finish - start) + 1e-9);
          if (begins < b - 1e-9 && !edge.cells.includes(cell.id)) (cell.edges.push(edge.id), edge.cells.push(cell.id));
        }
      }
    });
  }
  // Blocks beside each other in a ring are neighbours, and blocks of two rings whose spans overlap.
  for (const ring of rings) {
    ring.cells.forEach((id, index) => {
      const cell = cells[id] as Cell;
      const next = ring.cells[(index + 1) % ring.cells.length] as number;
      if (next !== id) {
        if (!cell.neighbours.includes(next)) cell.neighbours.push(next);
        if (!(cells[next] as Cell).neighbours.includes(id)) (cells[next] as Cell).neighbours.push(id);
      }
      const above = rings[ring.index + 1];
      if (!above) return;
      const from = cell.left.outer;
      const to = cell.right.outer + cell.shift;
      for (const otherId of above.cells) {
        const other = cells[otherId] as Cell;
        const start = after(other.left.inner, from - TAU + 1e-9);
        const width = other.right.inner + other.shift - other.left.inner;
        // Either turn of the other block's span may be the one that overlaps this block's.
        if ([start, start + TAU].some((begin) => Math.min(begin + width, to) - Math.max(begin, from) > 1e-6)) {
          cell.neighbours.push(otherId);
          other.neighbours.push(id);
        }
      }
    });
  }

  // ---- What is under water ---------------------------------------------------------------
  const wetJunction = new Uint8Array(junctions.length);
  const markWet = () => {
    junctions.forEach((junction, index) => {
      wetJunction[index] = inSea(junction.point) || (riverLine !== undefined && distanceToPolyline(junction.point, riverLine) < riverClearance - EPSILON) ? 1 : 0;
    });
    for (const edge of edges) edge.wet = nearRiver(edge.points) || edge.points.some(inSea) || wetJunction[edge.from] === 1 || wetJunction[edge.to] === 1;
    // A block is under water if any of it is, or any street along it: a lot must be able to open onto every street of its block.
    for (const cell of cells) cell.wet = nearRiver([...cell.polygon, cell.polygon[0] as Point]) || cell.polygon.some(inSea) || cell.edges.some((id) => (edges[id] as Edge).wet);
  };
  markWet();
  if (seaward && shore !== undefined) {
    // The harbour must stand at the water: if no dry block comes near the shore, the shore comes in to the nearest.
    const reachOf = (cell: Cell) => Math.max(...cell.polygon.map((point) => dot(point, seaward)));
    const dry = cells.filter((cell) => !cell.wet && !cell.ring.band);
    if (dry.length === 0) throw new TooSmall();
    const nearest = dry.reduce((best, cell) => (reachOf(cell) > reachOf(best) ? cell : best));
    if (shore - reachOf(nearest) > settings.watersideReach / 2) {
      shore = reachOf(nearest) + inset + 1;
      markWet();
    }
  }
  if (cells.every((cell) => cell.wet)) throw new TooSmall();
  for (const cell of cells) cell.barred = enclosesAll && band !== undefined && cell.ring.index >= band.index;
  // A port's quay: the streets along the sea are as wide as a main road.
  if (brief.flags.port && shore !== undefined) {
    const bySea = (cell: Cell) => cell.wet && cell.polygon.some(inSea);
    for (const edge of edges) edge.quay = !edge.wet && edge.kind === 'street' && edge.cells.some((id) => bySea(cells[id] as Cell)) && edge.cells.some((id) => !(cells[id] as Cell).wet);
  }
  const halfWidth = (edge: Edge) => (edge.quay ? widths.arterial : widths[edge.kind]) / 2;

  // ---- Gates --------------------------------------------------------------------------------
  // One where each main road meets the wall, then the rest where they split the longest stretches without one. A
  // gate needs dry ground through the wall, and a dry block just inside it for its gatehouse.
  /** Where each gatehouse stands: the block, and the side of it that is along the gate's street. */
  const gateLots: Array<{ gate: Radial; cell: Cell; side: 'left' | 'right' }> = [];
  if (band) {
    const inside = (rings[band.index - 1] as Ring).cells.map((id) => cells[id] as Cell);
    const same = (a: number, b: number) => Math.min(turn(a - b), turn(b - a)) < 1e-9;
    /** The block inside the wall that a gatehouse can stand in: clockwise of the gate's street, or failing that the other side. */
    const blockFor = (radial: Radial): { cell: Cell; side: 'left' | 'right' } | undefined => {
      const clockwise = inside.find((cell) => !cell.wet && same(cell.left.outer, radial.inner) && cell.left.court !== 'inner');
      if (clockwise) return { cell: clockwise, side: 'left' };
      const other = inside.find((cell) => !cell.wet && same(cell.right.outer, radial.inner) && cell.right.court !== 'inner');
      return other && { cell: other, side: 'right' };
    };
    const dry = (radial: Radial) => {
      const line = [at(band!.inner, radial.inner), at(wallRadius as number, bearingAt(band as Ring, radial, wallRadius as number)), at(band!.outer, radial.outer)];
      return !nearRiver(line, riverClearance + grown.wall.width) && !line.some(inSea);
    };
    const spare = [...gatehouses];
    const open: Radial[] = [];
    const choose = (radial: Radial) => {
      const block = blockFor(radial);
      if (!block || spare.length === 0 || !dry(radial)) return false;
      openGate(radial, spare.shift() as Building);
      gateLots.push({ gate: radial, ...block });
      open.push(radial);
      return true;
    };
    for (const radial of band.radials) if (radial.arterial !== undefined) choose(radial);
    const lesser = band.radials.filter((radial) => radial.arterial === undefined);
    while (spare.length > 0 && lesser.length > 0) {
      // The bound furthest, round the wall, from every gate there is.
      let furthest = -1;
      let best = 0;
      lesser.forEach((radial, index) => {
        const away = Math.min(TAU, ...open.map((gate) => Math.min(turn(gate.inner - radial.inner), turn(radial.inner - gate.inner))));
        if (away > furthest) {
          furthest = away;
          best = index;
        }
      });
      choose(lesser.splice(best, 1)[0] as Radial);
    }
    if (spare.length > 0) fail(`${spare.length} of its ${gatehouses.length} gatehouses have no dry place in the wall for a gate`);
    // The blocks beside a gate have its street along them.
    for (const cell of cells) for (const radial of [cell.left, cell.right]) if (radial.gate) for (const edge of radialEdges.get(radial) ?? []) if (!edge.cells.includes(cell.id)) (cell.edges.push(edge.id), edge.cells.push(cell.id));
  }

  // ---- Where lots may stand in a block ------------------------------------------------------
  const prepare = (cell: Cell): NonNullable<Cell['tracks']> => {
    if (cell.tracks) return cell.tracks;
    const { ring, left, right, shift } = cell;
    cell.tracks = {};
    if (ring.band) return cell.tracks;
    // A ring street with a quay anywhere along it is allowed for at the quay's width all the way round.
    const sideOf = (circle: number) => half(Math.max(widths.street, ...(ringEdges[circle] as Edge[]).map((edge) => 2 * halfWidth(edge))));
    const widthOf = (radial: Radial) => half(radial.arterial !== undefined ? widths.arterial : widths.lane);
    const first = ring.inner === 0;
    const far = ring.outer - sideOf(ring.index + 1) - roadside;
    const near = first ? Math.max(far - halfDepth, 1) : ring.inner + sideOf(ring.index) + roadside;
    cell.near = near;
    cell.far = far;
    if (far - near < halfDepth - EPSILON) return cell.tracks;
    const leftAt = (radius: number) => bearingAt(ring, left, radius) + (widthOf(left) + roadside) / radius;
    const rightAt = (radius: number) => bearingAt(ring, right, radius) + shift - (widthOf(right) + roadside) / radius;
    let from = Math.max(leftAt(near), leftAt(far));
    let to = Math.min(rightAt(near), rightAt(far));
    // Along a main road, a strip as deep as a lot is kept for lots that front it.
    const room = (to - from) * near;
    const strips = [left, right].filter((radial) => radial.arterial !== undefined).length;
    if (!first && strips > 0 && room > strips * halfDepth + grown.blockLength.min / 3) {
      if (left.arterial !== undefined) {
        cell.tracks.left = { from: near, to: far, cursor: near };
        from = Math.max(leftAt(near) + halfDepth / near, leftAt(far) + halfDepth / far);
      }
      if (right.arterial !== undefined) {
        cell.tracks.right = { from: near, to: far, cursor: near };
        to = Math.min(rightAt(near) - halfDepth / near, rightAt(far) - halfDepth / far);
      }
    }
    if (to - from <= 0) return cell.tracks;
    if (!first) cell.tracks.inner = { from, to, cursor: from };
    cell.tracks.outer = { from, to, cursor: from };
    return cell.tracks;
  };

  // ---- Lots to place ---------------------------------------------------------------------
  const placed: Placed[] = [];
  const districtIndex = new Map(city.districts.map((district, index) => [district.id, index]));
  const buildingsOf: Building[][] = city.districts.map(() => []);
  for (const building of city.buildings) (buildingsOf[districtIndex.get(building.districtId) as number] as Building[]).push(building);
  const held = new Set<string>(plazaBuilding ? [plazaBuilding.id] : []);
  /** Blocks that are used whether or not a district takes them: those with a gatehouse. */
  const reserved = new Set<number>();
  // Each gatehouse stands just inside its gate, at the end of the street its gate is on.
  for (const { gate, cell: block, side } of gateLots) {
    const gatehouse = gate.gate as Building;
    held.add(gatehouse.id);
    const tracks = prepare(block);
    const size = lotSizeOf(gatehouse.type, pack);
    const far = block.far as number;
    const near = far - size.frontage;
    placed.push({ building: gatehouse, cell: block, track: side, near, far, from: 0, to: 0, depth: size.depth, gatehouse: true });
    block.radii.push(near, far);
    reserved.add(block.id);
    // It takes the top of the strip along a main road; on a lesser street, the end of the frontages it stands across.
    const sign = side === 'left' ? 1 : -1;
    const back = [near, far].map((radius) => sideBearing(block, side, radius) + (sign * size.depth) / radius);
    const strip = tracks[side];
    if (strip) strip.to = Math.min(strip.to, near);
    else {
      for (const track of [tracks.outer, near < (block.near as number) + halfDepth ? tracks.inner : undefined]) {
        if (!track) continue;
        if (side === 'left') track.cursor = Math.max(track.cursor, ...back);
        else track.to = Math.min(track.to, ...back);
      }
    }
  }
  const spreadCivic = spreadCivicTypes(pack);
  /** Where the spread civic buildings placed so far stand, by type, for keeping the next apart from them. */
  const civic = new Map<string, Point[]>();

  // ---- Districts ------------------------------------------------------------------------
  const owner = new Int32Array(cells.length).fill(-1);
  const luck = new Float64Array(cells.length);
  {
    const rng = stepRng(seed, 'grown-districts');
    for (let cell = 0; cell < cells.length; cell++) luck[cell] = rng.next();
  }
  // What ground costs: its distance from the centre, counted for less beside a main road and beside the water, and
  // varying a little by chance, which gives the town a ragged edge that reaches out along its roads.
  const mainRoads = exitBearings.map((_, index) => rings.filter((ring) => !ring.band).map((ring) => at((ring.inner + ring.outer) / 2, arterialBearing(index, (ring.inner + ring.outer) / 2))));
  const cost = new Float64Array(cells.length);
  cells.forEach((cell, index) => {
    const fromCentre = distance([0, 0], cell.centre);
    const toRoad = Math.min(Infinity, ...mainRoads.filter((road) => road.length > 1).map((road) => distanceToPolyline(cell.centre, road)));
    const toWater = Math.min(riverLine ? distanceToPolyline(cell.centre, riverLine) : Infinity, shore !== undefined ? Math.max(0, shore - dot(cell.centre, seaward as Point)) : Infinity);
    const pull = Math.max(grown.outline.arterialPull * Math.exp(-toRoad / grown.outline.reach), grown.outline.waterPull * Math.exp(-toWater / grown.outline.reach));
    cost[index] = fromCentre * (1 - pull) + (luck[index] as number) * grown.outline.ragged;
  });
  const isFree = (cell: number) => owner[cell] === -1 && !(cells[cell] as Cell).wet && !(cells[cell] as Cell).barred;
  const border = new Set((rings[rings.length - 1] as Ring).cells);
  /** Free blocks joined to the edge of the lattice: the land a district can still grow into without being boxed in. */
  const openCells = (): Uint8Array => {
    const open = new Uint8Array(cells.length);
    const queue: number[] = [];
    const walledIn = enclosesAll && band ? new Set((rings[band.index - 1] as Ring).cells) : border;
    for (const cell of walledIn) {
      if (isFree(cell)) {
        open[cell] = 1;
        queue.push(cell);
      }
    }
    for (let next = 0; next < queue.length; next++) {
      for (const beside of (cells[queue[next] as number] as Cell).neighbours) {
        if (open[beside] === 0 && isFree(beside)) {
          open[beside] = 1;
          queue.push(beside);
        }
      }
    }
    return open;
  };
  const best = (among: Iterable<number>, score: (cell: number) => number): number | undefined => {
    let found: number | undefined;
    let foundScore = Infinity;
    for (const cell of among) {
      const value = score(cell);
      if (value < foundScore || (value === foundScore && found !== undefined && (luck[cell] as number) < (luck[found] as number))) {
        found = cell;
        foundScore = value;
      }
    }
    return found;
  };
  const allCells = cells.map((cell) => cell.id);
  const lotRng = stepRng(seed, 'grown-lots');
  const cellsOf: number[][] = city.districts.map(() => []);
  const middleOf = (lot: Pick<Placed, 'near' | 'far' | 'from' | 'to' | 'track' | 'cell' | 'depth'>): Point =>
    lot.track === 'left' || lot.track === 'right' ? at((lot.near + lot.far) / 2, sideBearing(lot.cell, lot.track, (lot.near + lot.far) / 2) + ((lot.track === 'left' ? 1 : -1) * lot.depth) / (lot.near + lot.far)) : at((lot.near + lot.far) / 2, (lot.from + lot.to) / 2);
  /** The bearing of the front of a lot that stands along a main road, at a distance from the centre. */
  function sideBearing(cell: Cell, side: 'left' | 'right', radius: number): number {
    const radial = side === 'left' ? cell.left : cell.right;
    const clear = (half(radial.arterial !== undefined ? widths.arterial : widths.lane) + roadside) / radius;
    return side === 'left' ? bearingAt(cell.ring, radial, radius) + clear : bearingAt(cell.ring, radial, radius) + cell.shift - clear;
  }

  /** Grows one district outward from a first block, packing its lots as it goes. */
  const placeDistrict = (district: number, pickFirst: (open: Uint8Array) => number | undefined) => {
    const buildings = (buildingsOf[district] as Building[]).filter((building) => !held.has(building.id));
    if (buildings.length === 0 && !(buildingsOf[district] as Building[]).some((building) => building === plazaBuilding)) return;
    const open = openCells();
    const firstCell = pickFirst(open);
    if (firstCell === undefined) throw new TooSmall();
    const blocks: Cell[] = [];
    const frontier = new Map<number, number>();
    const addBlock = (id: number, depth: number): Cell => {
      owner[id] = district;
      (cellsOf[district] as number[]).push(id);
      frontier.delete(id);
      const cell = cells[id] as Cell;
      for (const next of cell.neighbours) {
        if (isFree(next) && open[next] === 1 && !frontier.has(next)) frontier.set(next, depth + 1);
      }
      blocks.push(cell);
      prepare(cell);
      return cell;
    };
    /** The next block: the cheapest ground, counting how far the district has already spread from where it began. */
    const grow = (): Cell => {
      const cell = best(frontier.keys(), (candidate) => (frontier.get(candidate) as number) * grown.outline.compact + (cost[candidate] as number));
      if (cell === undefined) throw new TooSmall();
      return addBlock(cell, frontier.get(cell) as number);
    };
    /** Where a building would stand in a block, on the frontage with most room left; nothing if it fits on none. */
    const fit = (cell: Cell, building: Building): Placed | undefined => {
      const tracks = cell.tracks ?? {};
      const { frontage, depth } = lotSizeOf(building.type, pack);
      const area = frontage * depth;
      const near = cell.near as number;
      const far = cell.far as number;
      if (depth > (far - near) / 2 + EPSILON) {
        // A lot deeper than half the block runs from street to street and takes both frontages.
        if (!tracks.inner || !tracks.outer) return undefined;
        const from = Math.max(tracks.inner.cursor, tracks.outer.cursor);
        const to = from + area / ((far - near) * ((near + far) / 2));
        return to <= tracks.outer.to + 1e-9 ? { building, cell, track: 'through', near, far, from, to, depth: far - near } : undefined;
      }
      let found: Placed | undefined;
      let fullest = Infinity;
      const offer = (lot: Placed, track: Track) => {
        const used = (track.cursor - track.from) / (track.to - track.from);
        if (used < fullest) {
          fullest = used;
          found = lot;
        }
      };
      for (const side of ['left', 'right'] as const) {
        const track = tracks[side];
        if (!track || depth > halfDepth + EPSILON || track.cursor + frontage > track.to + 1e-9) continue;
        offer({ building, cell, track: side, near: track.cursor, far: track.cursor + frontage, from: 0, to: 0, depth }, track);
      }
      if (tracks.outer) {
        const to = tracks.outer.cursor + area / (depth * (far - depth / 2));
        if (to <= tracks.outer.to + 1e-9) offer({ building, cell, track: 'outer', near: far - depth, far, from: tracks.outer.cursor, to, depth }, tracks.outer);
      }
      if (tracks.inner) {
        const to = tracks.inner.cursor + area / (depth * (near + depth / 2));
        if (to <= tracks.inner.to + 1e-9) offer({ building, cell, track: 'inner', near, far: near + depth, from: tracks.inner.cursor, to, depth }, tracks.inner);
      }
      return found;
    };
    const take = (lot: Placed) => {
      const tracks = lot.cell.tracks as NonNullable<Cell['tracks']>;
      placed.push(lot);
      lot.cell.radii.push(lot.near, lot.far);
      if (lot.track === 'left' || lot.track === 'right') (tracks[lot.track] as Track).cursor = lot.far;
      else {
        lot.cell.bearings.push(lot.from, lot.to);
        if (lot.track !== 'outer') (tracks.inner as Track).cursor = lot.to;
        if (lot.track !== 'inner') (tracks.outer as Track).cursor = lot.to;
      }
    };
    const place = (building: Building) => {
      for (const block of blocks) {
        const lot = fit(block, building);
        if (lot) return take(lot);
      }
      // A new block nearly always has room; a block cut short by the water or a main road may not, so a few are tried.
      for (let tries = 0; tries < 40; tries++) {
        const lot = fit(grow(), building);
        if (lot) return take(lot);
      }
      throw new TooSmall();
    };
    /** A civic building that the pack spreads stands as far as it can from the others of its type, and at least the pack's distance where the district has room. */
    const placeApart = (building: Building) => {
      const others = civic.get(building.type) ?? [];
      const choose = (among: Cell[]): { lot: Placed; away: number } | undefined => {
        let chosen: { lot: Placed; away: number } | undefined;
        for (const block of among) {
          const lot = fit(block, building);
          if (!lot) continue;
          const here = middleOf(lot);
          const away = Math.min(Infinity, ...others.map((other) => distance(other, here)));
          if (!chosen || away > chosen.away) chosen = { lot, away };
        }
        return chosen;
      };
      let chosen = choose(blocks);
      for (let grownBlocks = 0; grownBlocks < APART_BLOCKS && (!chosen || chosen.away < grown.civicSpacing); grownBlocks++) {
        let block: Cell;
        try {
          block = grow();
        } catch (error) {
          if (error instanceof TooSmall && chosen) break;
          throw error;
        }
        const next = choose([block]);
        if (next && (!chosen || next.away > chosen.away)) chosen = next;
      }
      if (!chosen) return place(building);
      take(chosen.lot);
      civic.set(building.type, [...others, middleOf(chosen.lot)]);
    };
    addBlock(firstCell, 0);
    for (const { building, apart } of placementOrder(buildings, pack, lotRng, () => false)) {
      if (apart && spreadCivic.has(building.type)) placeApart(building);
      else place(building);
    }
  };

  const districtsPlaced = (placement: string) => city.districts.map((district, index) => ({ district, index })).filter(({ district }) => placementOf(district) === placement);
  const cheapest = (open: Uint8Array) => best(allCells.filter((cell) => open[cell] === 1), (cell) => cost[cell] as number);
  // The centre: the district with the plaza first, so that its ground lies round it.
  const central = districtsPlaced('centre').sort((a, b) => Number(b.district.id === plazaBuilding?.districtId) - Number(a.district.id === plazaBuilding?.districtId));
  for (const { index } of central) placeDistrict(index, (open) => best(allCells.filter((cell) => open[cell] === 1), (cell) => distance([0, 0], (cells[cell] as Cell).centre)));
  // Waterside districts: at the shore, or else beside the river.
  for (const { index } of districtsPlaced('waterside')) {
    placeDistrict(index, (open) => {
      const candidates = allCells.filter((cell) => open[cell] === 1);
      const gap = (cell: number) => {
        const { polygon } = cells[cell] as Cell;
        if (seaward && shore !== undefined) return shore - Math.max(...polygon.map((point) => dot(point, seaward)));
        return riverLine ? distanceBetweenPolylines([...polygon, polygon[0] as Point], riverLine) - settings.riverWidth / 2 : Infinity;
      };
      if (!seaward && !riverLine) return cheapest(open);
      const within = candidates.filter((cell) => gap(cell) <= settings.watersideReach);
      return within.length > 0 ? best(within, (cell) => cost[cell] as number) : best(candidates, gap);
    });
  }
  for (const { index } of districtsPlaced('middle')) placeDistrict(index, cheapest);
  for (const { index } of districtsPlaced('edge')) placeDistrict(index, cheapest);
  if (placed.length !== city.buildings.length - (plazaBuilding ? 1 : 0)) fail(`${city.buildings.length - (plazaBuilding ? 1 : 0) - placed.length} buildings are in districts whose kind the pack no longer lists`);

  // ---- Streets of one trade ---------------------------------------------------------------
  // Which building holds which lot is settled last, and changes no lot: buildings whose lots are alike change
  // places within a district, as on the grid. A gatehouse keeps its gate.
  {
    const order = (lot: Placed) => (lot.track === 'inner' ? 0 : lot.track === 'outer' || lot.track === 'through' ? 1 : lot.track === 'left' ? 2 : 3);
    const along = (lot: Placed) => (lot.track === 'left' || lot.track === 'right' ? lot.near : lot.from);
    arrangeTrades(
      placed.filter((lot) => !lot.gatehouse && lot.track !== 'through'),
      pack,
      (a, b) => a.cell.ring.index + Number(order(a) === 1) - (b.cell.ring.index + Number(order(b) === 1)) || a.cell.id - b.cell.id || order(a) - order(b) || along(a) - along(b),
      (a, b) => a.cell === b.cell && a.track === b.track && Math.abs((a.track === 'left' || a.track === 'right' ? a.far - b.near : a.to - b.from)) < 1e-9,
    );
  }

  // ---- Bridges, and the ways through the lattice -------------------------------------------
  const used = allCells.filter((cell) => (owner[cell] as number) >= 0 || reserved.has(cell));
  const usedSet = new Set(used);
  const outgoing: Array<Array<{ to: number; edge: number; length: number }>> = junctions.map(() => []);
  const link = (edge: Edge) => {
    (outgoing[edge.from] as Array<{ to: number; edge: number; length: number }>).push({ to: edge.to, edge: edge.id, length: edge.length });
    (outgoing[edge.to] as Array<{ to: number; edge: number; length: number }>).push({ to: edge.from, edge: edge.id, length: edge.length });
  };
  for (const edge of edges) if (!edge.wet) link(edge);
  // A bridge can stand wherever a ring street or a main road meets the river: it spans the run of wet pieces
  // between the last dry junction on one bank and the first on the other.
  const bridgeEdges = new Set<number>();
  if (riverLine) {
    const span = (run: Edge[]) => {
      const from = (run[0] as Edge).from;
      const to = (run[run.length - 1] as Edge).to;
      if (from === to || wetJunction[from] === 1 || wetJunction[to] === 1) return;
      const points = [(junctions[from] as { point: Point }).point, (junctions[to] as { point: Point }).point];
      if (crossingsOfPolyline(points[0] as Point, points[1] as Point, riverLine as Point[]) === 0 || points.some(inSea)) return;
      const bridge = addEdge({ from, to, points, kind: 'bridge', quay: false, ...(run[0]?.arterial !== undefined && { arterial: run[0].arterial }) });
      bridgeEdges.add(bridge.id);
      link(bridge);
    };
    const scan = (chain: Edge[], closed: boolean) => {
      const wet = (edge: Edge) => nearRiver(edge.points);
      const start = closed ? chain.findIndex((edge) => !wet(edge)) : 0;
      if (start === -1) return;
      let run: Edge[] = [];
      for (let step = 0; step < chain.length; step++) {
        const edge = chain[(start + step) % chain.length] as Edge;
        if (wet(edge)) run.push(edge);
        else if (run.length > 0) {
          span(run);
          run = [];
        }
      }
    };
    ringEdges.forEach((chain) => scan(chain, true));
    exitBearings.forEach((_, index) => {
      // A main road's pieces from the centre outward, each running outward.
      const chain = rings.flatMap((ring) => ring.radials.filter((radial) => radial.arterial === index).flatMap((radial) => radialEdges.get(radial) ?? []));
      scan(chain, false);
    });
  }
  /** The cheapest way from any of the start junctions to the first that satisfies `done`, as edges. */
  const route = (starts: Iterable<number>, done: (junction: number) => boolean, weigh: (edge: Edge) => number): number[] | undefined => {
    const reached = new Map<number, number>();
    const cameBy = new Map<number, [number, number]>();
    const heap = new Heap();
    for (const start of starts) {
      reached.set(start, 0);
      heap.push(0, start);
    }
    while (heap.size > 0) {
      const [so, junction] = heap.pop();
      if (so > (reached.get(junction) as number)) continue;
      if (done(junction)) {
        const way: number[] = [];
        for (let back = junction; cameBy.has(back); back = (cameBy.get(back) as [number, number])[0]) way.push((cameBy.get(back) as [number, number])[1]);
        return way.reverse();
      }
      for (const step of outgoing[junction] as Array<{ to: number; edge: number; length: number }>) {
        const next = so + step.length * weigh(edges[step.edge] as Edge);
        if (next < (reached.get(step.to) ?? Infinity)) {
          reached.set(step.to, next);
          cameBy.set(step.to, [junction, step.edge]);
          heap.push(next, step.to);
        }
      }
    }
    return undefined;
  };

  // ---- Exits and the main roads to them ------------------------------------------------------
  const streets = new Set<number>();
  /** The exit each kept edge carries a route for. */
  const carries = new Map<number, number>();
  const exitDrafts: Array<{ point: Point; joins: number }> = [];
  brief.routes.forEach((exit, index) => {
    // The main road is followed out to the last ring that is built on beside it, and one ring more.
    const pieces = rings.map((ring) => ring.radials.find((radial) => radial.arterial === index));
    let last = 0;
    rings.forEach((ring, at) => {
      const radial = pieces[at];
      if (radial && ring.cells.some((id) => usedSet.has(id) && ((cells[id] as Cell).left === radial || (cells[id] as Cell).right === radial))) last = at;
    });
    const candidates: number[] = [];
    for (let at = Math.min(last + 1, rings.length - 1); at >= 0; at--) {
      const radial = pieces[at];
      const edge = radial && (radialEdges.get(radial) ?? []).at(-1);
      if (edge && wetJunction[edge.to] === 0 && (outgoing[edge.to] as unknown[]).length > 0) candidates.push(edge.to);
    }
    const from = plazaBuilding ? [onCircle(0, arterialBearing(index, circles[0] as number))] : [junctionAt('centre', () => at(0, 0))];
    for (const joins of candidates) {
      const way = route(from, (junction) => junction === joins, (edge) => (edge.arterial === index ? 1 : 4));
      if (!way) continue;
      const out = (junctions[joins] as { point: Point }).point;
      // The exit lies beyond the last junction, at the brief's bearing; it moves aside a degree at a time only to keep out of the river.
      for (let step = 0; step <= 2 * EXIT_TOLERANCE; step++) {
        const offset = step % 2 === 1 ? (step + 1) / 2 : -step / 2;
        if (Math.abs(offset) >= EXIT_TOLERANCE) continue;
        const direction = bearingVector(exit.bearing + offset);
        let reach = distance([0, 0], out) + pitch;
        if (shore !== undefined && dot(direction, seaward as Point) > EPSILON) reach = Math.min(reach, (shore - inset) / dot(direction, seaward as Point));
        const point: Point = [direction[0] * reach, direction[1] * reach];
        if (distance(point, out) < widest || nearRiver([out, point]) || exitDrafts.some((other) => distance(other.point, point) < widest)) continue;
        for (const edge of way) {
          streets.add(edge);
          if (!carries.has(edge)) carries.set(edge, index);
        }
        exitDrafts.push({ point, joins });
        return;
      }
    }
    fail(`no road can reach the exit for ${exit.routeId} within ${EXIT_TOLERANCE} degrees of bearing ${exit.bearing} (exit ${index + 1} of ${brief.routes.length})`);
  });

  // ---- The streets that are kept ---------------------------------------------------------------
  // Every used block has its streets round it, the plaza has the street round it, and whatever is left apart is joined.
  for (const cell of used) for (const id of (cells[cell] as Cell).edges) if (!(edges[id] as Edge).wet) streets.add(id);
  if (plazaBuilding) for (const edge of ringEdges[0] as Edge[]) if (!edge.wet) streets.add(edge.id);
  // Every gate is a way through the wall, whether or not a main road uses it.
  if (band) for (const radial of band.radials) if (radial.gate) for (const edge of radialEdges.get(radial) ?? []) streets.add(edge.id);
  for (const { cell } of gateLots) for (const id of cell.edges) if (!(edges[id] as Edge).wet) streets.add(id);
  for (;;) {
    const touched = new Set<number>();
    const linked = new Map<number, number[]>();
    for (const id of streets) {
      const { from, to } = edges[id] as Edge;
      touched.add(from).add(to);
      linked.set(from, [...(linked.get(from) ?? []), to]);
      linked.set(to, [...(linked.get(to) ?? []), from]);
    }
    if (touched.size === 0) break;
    const start = Math.min(...touched);
    const main = new Set([start]);
    const queue = [start];
    for (let next = 0; next < queue.length; next++) {
      for (const beside of linked.get(queue[next] as number) ?? []) {
        if (!main.has(beside)) {
          main.add(beside);
          queue.push(beside);
        }
      }
    }
    if (main.size === touched.size) break;
    const way = route(main, (junction) => touched.has(junction) && !main.has(junction), () => 1);
    if (!way) fail('part of the town cannot be joined to the rest by any street or bridge');
    for (const edge of way as number[]) streets.add(edge);
  }

  // ---- Records ----------------------------------------------------------------------------------
  const kept = [...streets].sort((a, b) => a - b).map((id) => edges[id] as Edge);
  const keptJunctions = [...new Set(kept.flatMap((edge) => [edge.from, edge.to]))].sort((a, b) => a - b);
  const junctionIds = new Map(keptJunctions.map((junction, index) => [junction, `junction-${number}-${pad(index + 1, 6)}`]));
  const degree = new Map<number, number>();
  const atBridge = new Set<number>();
  for (const edge of kept) {
    for (const end of [edge.from, edge.to]) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
      if (edge.kind === 'bridge') atBridge.add(end);
    }
  }
  for (const draft of exitDrafts) degree.set(draft.joins, (degree.get(draft.joins) ?? 0) + 1);
  const layoutJunctions: Junction[] = keptJunctions.map((junction) => ({
    id: junctionIds.get(junction) as string,
    position: (junctions[junction] as { point: Point }).point,
    kind: (junctions[junction] as { kind?: JunctionKind }).kind ?? (atBridge.has(junction) ? 'bridge-end' : degree.get(junction) === 1 ? 'dead-end' : 'crossing'),
  }));
  const segmentIds = new Map<number, string>();
  const segments: Segment[] = kept.map((edge, index) => {
    const id = `segment-${number}-${pad(index + 1, 6)}`;
    segmentIds.set(edge.id, id);
    const exit = carries.has(edge.id) ? (brief.routes[carries.get(edge.id) as number] as SettlementBrief['routes'][number]) : edge.arterial !== undefined ? (brief.routes[edge.arterial] as SettlementBrief['routes'][number]) : undefined;
    const kind: SegmentKind = edge.quay ? 'arterial' : edge.kind;
    return {
      id,
      fromJunctionId: junctionIds.get(edge.from) as string,
      toJunctionId: junctionIds.get(edge.to) as string,
      points: edge.points,
      kind,
      width: edge.quay ? widths.arterial : widths[edge.kind],
      ...(exit?.name !== undefined && { name: exit.name }),
      ...(exit && { routeId: exit.routeId }),
    };
  });
  const exits: Exit[] = exitDrafts.map((draft, position) => {
    const exit = brief.routes[position] as SettlementBrief['routes'][number];
    const junctionId = `junction-${number}-${pad(layoutJunctions.length + 1, 6)}`;
    layoutJunctions.push({ id: junctionId, position: draft.point, kind: 'exit' });
    segments.push({
      id: `segment-${number}-${pad(segments.length + 1, 6)}`,
      fromJunctionId: junctionIds.get(draft.joins) as string,
      toJunctionId: junctionId,
      points: [(junctions[draft.joins] as { point: Point }).point, draft.point],
      kind: 'arterial',
      width: widths.arterial,
      ...(exit.name !== undefined && { name: exit.name }),
      routeId: exit.routeId,
    });
    return { id: `exit-${number}-${pad(position + 1, 3)}`, junctionId, routeId: exit.routeId, ...(exit.name !== undefined && { name: exit.name }), kind: exit.kind, bearing: exit.bearing };
  });

  const waters: Water[] = [];
  const waterId = () => `water-${number}-${pad(waters.length + 1, 3)}`;
  if (riverLine) waters.push({ id: waterId(), kind: 'river', centreLine: riverLine, width: settings.riverWidth });
  if (shore !== undefined && seaward) {
    const along: Point = [-seaward[1], seaward[0]];
    const corner = (out: number, sideways: number): Point => [seaward[0] * out + along[0] * sideways, seaward[1] * out + along[1] * sideways];
    const span = 2 * beyond;
    waters.push({ id: waterId(), kind: 'sea', polygon: [corner(shore, -span), corner(shore, span), corner(shore + span, span), corner(shore + span, -span)] });
  }

  // The wall: its line round the town, broken where it meets water, with the gates that streets were kept through.
  const walls: Wall[] = [];
  if (band && wallRadius !== undefined) {
    const gates = band.radials.filter((radial) => radial.gate && (radialEdges.get(radial) ?? []).every((edge) => streets.has(edge.id)));
    const line = cuts(wallRadius, 0, TAU, band.radials.filter((radial) => radial.gate).map((radial) => turn(bearingAt(band as Ring, radial, wallRadius as number)))).slice(0, -1);
    const points = line.map((bearing) => at(wallRadius as number, bearing));
    const wet = points.map((point) => inSea(point) || (riverLine !== undefined && distanceToPolyline(point, riverLine) < settings.riverWidth / 2 + grown.wall.width / 2 + roadside));
    const gateOf = (point: Point) => gates.find((radial) => distance((junctions[gateJunctions.get(radial) as number] as { point: Point }).point, point) < EPSILON);
    const record = (stretch: Point[], closed: boolean) => {
      if (stretch.length < 2) return;
      walls.push({
        id: `wall-${number}-${pad(walls.length + 1, 3)}`,
        line: stretch,
        closed,
        width: grown.wall.width,
        gates: stretch.flatMap((point) => {
          const radial = gateOf(point);
          return radial ? [{ junctionId: junctionIds.get(gateJunctions.get(radial) as number) as string, buildingId: (radial.gate as Building).id, arterial: radial.arterial !== undefined }] : [];
        }),
      });
    };
    if (!wet.some(Boolean)) record(points, true);
    else {
      // Each dry stretch between two wet ones is a wall of its own.
      const start = wet.findIndex(Boolean);
      let stretch: Point[] = [];
      for (let step = 1; step <= points.length; step++) {
        const index = (start + step) % points.length;
        if (!wet[index]) stretch.push(points[index] as Point);
        else {
          record(stretch, false);
          stretch = [];
        }
      }
    }
    const kept = new Set(walls.flatMap((wall) => wall.gates.map((gate) => gate.buildingId)));
    const lost = gates.filter((radial) => !kept.has((radial.gate as Building).id));
    if (lost.length > 0 || gates.length !== gatehouses.length) fail(`${gatehouses.length} gatehouses but ${kept.size} gates in the wall`);
  }

  // Lots are numbered as their buildings are.
  const buildingOrder = new Map(city.buildings.map((building, index) => [building.id, index]));
  const circleEdge = (circle: number, bearing: number): Edge => {
    const list = ringEdges[circle] as Edge[];
    return list.find((edge) => after(bearing, (edge.span as [number, number])[0] - 1e-12) <= (edge.span as [number, number])[1] + 1e-12) ?? (list[0] as Edge);
  };
  /** A piece of a block between two distances and two bearings, as a polygon on the map, cut wherever the block's lots have corners. */
  const piece = (cell: Cell, near: number, far: number, from: number, to: number): Point[] => [
    ...cuts(near, from, to, cell.bearings).map((bearing) => at(near, bearing)),
    ...steps(near, far, cell.radii).slice(1).map((radius) => at(radius, to)),
    ...cuts(far, from, to, cell.bearings).reverse().slice(1).map((bearing) => at(far, bearing)),
    ...steps(near, far, cell.radii).reverse().slice(1, -1).map((radius) => at(radius, from)),
  ];
  /** A piece of a strip along a main road: its front follows the road, and it is as deep at every point as the lot is. */
  const stripPiece = (lot: Placed, deep: number): Point[] => {
    const side = lot.track as 'left' | 'right';
    const sign = side === 'left' ? 1 : -1;
    const front = (radius: number) => sideBearing(lot.cell, side, radius);
    const back = (radius: number) => front(radius) + (sign * deep) / radius;
    const radii = steps(lot.near, lot.far, lot.cell.radii);
    const end = (radius: number, forward: boolean) => {
      const [a, b] = [Math.min(front(radius), back(radius)), Math.max(front(radius), back(radius))];
      const points = cuts(radius, a, b, lot.cell.bearings).map((bearing) => at(radius, bearing));
      return forward === sign > 0 ? points : points.reverse();
    };
    return [...radii.map((radius) => at(radius, front(radius))), ...end(lot.far, true).slice(1), ...radii.reverse().slice(1).map((radius) => at(radius, back(radius))), ...end(lot.near, false).slice(1, -1)];
  };
  placed.sort((a, b) => (buildingOrder.get(a.building.id) as number) - (buildingOrder.get(b.building.id) as number));
  // The breaks of each block are known only now that every lot is placed.
  // A lot's building stands across its frontage, as deep as the pack's coverage of the lot: its back is a break too.
  for (const lot of placed) {
    const coverage = footprintCoverageOf(lot.building.type, pack);
    if (lot.track !== 'left' && lot.track !== 'right') {
      if (coverage > 0) lot.cell.radii.push(lot.track === 'inner' ? lot.near + lot.depth * coverage : lot.far - lot.depth * coverage);
      continue;
    }
    for (const radius of [lot.near, lot.far]) {
      const front = sideBearing(lot.cell, lot.track, radius);
      const back = ((lot.track === 'left' ? 1 : -1) * lot.depth) / radius;
      lot.cell.bearings.push(front, front + back, front + back * coverage);
    }
  }
  let builtArea = 0;
  const lots: Lot[] = [];
  const entranceOn = (edge: Edge, point: Point) => ({ segmentId: segmentIds.get(edge.id) as string, point: projectOnPolyline(edge.points, point).point });
  const allLots: Array<Placed | 'plaza'> = [...placed];
  if (plazaBuilding) allLots.splice(buildingOrder.get(plazaBuilding.id) as number, 0, 'plaza');
  const places: Place[] = [];
  allLots.forEach((lot, index) => {
    const id = `lot-${number}-${pad(index + 1, 6)}`;
    if (lot === 'plaza') {
      // The plaza is the lot of its building: open ground, with the street all the way round it.
      const building = plazaBuilding as Building;
      const polygon = cuts(plazaRadius, 0, TAU, corners[0]).slice(0, -1).map((bearing) => at(plazaRadius, bearing));
      const toward = exitBearings.length > 0 ? arterialBearing(0, circles[0] as number) + 0.3 : 0;
      builtArea += polygonArea(polygon);
      lots.push({ id, buildingId: building.id, polygon, districtId: building.districtId, entrance: entranceOn(circleEdge(0, toward), at(circles[0] as number, toward)), footprints: [] });
      places.push({ id: `place-${number}-001`, kind: 'plaza', polygon, buildingId: building.id });
      return;
    }
    const { cell, building } = lot;
    const coverage = footprintCoverageOf(building.type, pack);
    let polygon: Point[];
    let footprint: Point[] | undefined;
    let entrance: Lot['entrance'];
    if (lot.track === 'left' || lot.track === 'right') {
      polygon = stripPiece(lot, lot.depth);
      if (coverage > 0) footprint = stripPiece(lot, lot.depth * coverage);
      const radial = lot.track === 'left' ? cell.left : cell.right;
      const middle = (lot.near + lot.far) / 2;
      entrance = entranceOn((radialEdges.get(radial) as Edge[])[0] as Edge, at(middle, bearingAt(cell.ring, radial, middle) + (lot.track === 'right' ? cell.shift : 0)));
    } else {
      polygon = piece(cell, lot.near, lot.far, lot.from, lot.to);
      const inward = lot.track === 'inner';
      if (coverage > 0) footprint = inward ? piece(cell, lot.near, lot.near + lot.depth * coverage, lot.from, lot.to) : piece(cell, lot.far - lot.depth * coverage, lot.far, lot.from, lot.to);
      {
        const circle = inward ? cell.ring.index : cell.ring.index + 1;
        const bearing = (lot.from + lot.to) / 2;
        entrance = entranceOn(circleEdge(circle, bearing), at(circles[circle] as number, bearing));
      }
    }
    builtArea += polygonArea(polygon);
    lots.push({ id, buildingId: building.id, polygon, districtId: building.districtId, entrance, footprints: footprint ? [footprint] : [] });
  });

  // A district's area is its blocks, and for the district of the plaza the ground of the plaza and its street too.
  let outlineArea = 0;
  const districtAreas = city.districts.flatMap((district: District, index) => {
    const own = [...(cellsOf[index] as number[])].sort((a, b) => a - b).map((id) => cells[id] as Cell);
    if (own.length === 0) return [];
    const polygons = own.map((cell) => cell.polygon);
    if (plazaBuilding?.districtId === district.id) polygons.push(cuts(circles[0] as number, 0, TAU, corners[0]).slice(0, -1).map((bearing) => at(circles[0] as number, bearing)));
    for (const polygon of polygons) outlineArea += polygonArea(polygon);
    const middle: Point = [own.reduce((sum, cell) => sum + cell.centre[0], 0) / own.length, own.reduce((sum, cell) => sum + cell.centre[1], 0) / own.length];
    const label = own.reduce((nearest, cell) => (distance(cell.centre, middle) < distance(nearest.centre, middle) ? cell : nearest));
    return [{ districtId: district.id, polygons, labelPoint: label.centre }];
  });

  const everyPoint = [...lots.flatMap((lot) => lot.polygon), ...segments.flatMap((segment) => segment.points)];
  const layout: Layout = {
    junctions: layoutJunctions,
    segments,
    exits,
    waters,
    lots,
    districtAreas,
    walls,
    places,
    summary: {
      settlementId: brief.id,
      counts: { junctions: layoutJunctions.length, segments: segments.length, exits: exits.length, waters: waters.length, lots: lots.length, districtAreas: districtAreas.length, walls: walls.length, gates: walls.reduce((sum, wall) => sum + wall.gates.length, 0), places: places.length },
      outlineArea,
      bounds: boxOf(everyPoint),
      builtArea,
      residentsPerHectare: builtArea === 0 ? 0 : city.people.length / (builtArea / 10_000),
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
