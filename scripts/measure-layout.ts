/**
 * Measures the shape of laid-out towns: the figures of the phase 6D and 6D.1 acceptance tables.
 *
 * Usage: node scripts/measure-layout.ts [--all]
 *
 * Prints one block per town for Badanos, Pombal, Cevilefon, Vereceldo and Flupines on the grown generator, with
 * the grid's figure beside it where the tables compare the two. With --all it also goes through every settlement
 * of Lomia for the rows that are held everywhere.
 */
import { type City, type Layout, type Point, type SettlementBrief, generateCity, distanceToWater, generateLayout, geometry, lotSizeOf, ringShare, riverOutline, riverWidthAt } from '../packages/core/src/index.ts';
import { lomiaWorld, medievalPack } from '../packages/core/test/pack.ts';

const pack = medievalPack();
/** Phase 6D.1's least number of roads out of the centre for a town above 1,000 residents; no longer a pack number. */
const ROADS_OUT = 5;
const world = lomiaWorld();
const { distance, polygonArea, polylineLength, distanceToPolyline, boxOf } = geometry;
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const spread = (values: number[]) => Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2))) / (mean(values) || 1);
const bearingOf = (point: Point) => ((Math.atan2(point[0], -point[1]) * 180) / Math.PI + 360) % 360;
const apart = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** How far the middle stretches of a line bow from the straight line between the ends of each stretch of `span` metres: the least of them. */
function leastBow(line: Point[], span: number, keep: (point: Point) => boolean): number {
  const along = [0];
  for (let at = 1; at < line.length; at++) along.push((along[at - 1] as number) + distance(line[at - 1] as Point, line[at] as Point));
  let least = Infinity;
  let end = 0;
  for (let start = 0; start < line.length; start += 4) {
    while (end < line.length - 1 && (along[end] as number) - (along[start] as number) < span) end++;
    if ((along[end] as number) - (along[start] as number) < span) break;
    if (!keep(line[start] as Point) || !keep(line[end] as Point)) continue;
    let bow = 0;
    for (let at = start + 1; at < end; at++) bow = Math.max(bow, distanceToPolyline(line[at] as Point, [line[start] as Point, line[end] as Point]));
    least = Math.min(least, bow);
  }
  return least;
}

function measure(brief: SettlementBrief, city: City, layout: Layout) {
  const typeOf = new Map(city.buildings.map((building) => [building.id, building.type]));
  const kindOf = new Map(city.districts.map((district) => [district.id, district.kind]));
  const streets = layout.segments.filter((segment) => segment.kind !== 'bridge');
  const degree = new Map<string, number>();
  for (const segment of layout.segments) for (const id of [segment.fromJunctionId, segment.toJunctionId]) degree.set(id, (degree.get(id) ?? 0) + 1);
  // Directions, in bins of 15 degrees.
  const bins = new Array<number>(12).fill(0);
  let streetLength = 0;
  for (const segment of streets) {
    for (let at = 1; at < segment.points.length; at++) {
      const [a, b] = [segment.points[at - 1] as Point, segment.points[at] as Point];
      const angle = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 360) % 180;
      bins[Math.floor(angle / 15) % 12] = (bins[Math.floor(angle / 15) % 12] as number) + distance(a, b);
      streetLength += distance(a, b);
    }
  }
  const meeting = [...degree.values()].filter((count) => count >= 3);
  // Each main road as one line from the centre to its exit, and how far it strays from the straight line between its ends.
  const strays: number[] = [];
  for (const exit of layout.exits) {
    const own = layout.segments.filter((segment) => segment.routeId === exit.routeId);
    const points = own.flatMap((segment) => segment.points);
    const length = own.reduce((sum, segment) => sum + polylineLength(segment.points), 0);
    if (length < 200) continue;
    const end = layout.junctions.find((junction) => junction.id === exit.junctionId)!.position;
    const start = points.reduce((nearest, point) => (Math.hypot(...point) < Math.hypot(...nearest) ? point : nearest));
    strays.push(Math.max(...points.map((point) => distanceToPolyline(point, [start, end]))) / length);
  }
  const deadEnds = layout.junctions.filter((junction) => junction.kind === 'dead-end').length;
  const rectangles = layout.lots.filter((lot) => {
    if (lot.polygon.length !== 4) return false;
    return lot.polygon.every((point, at) => {
      const before = lot.polygon[(at + 3) % 4] as Point;
      const after = lot.polygon[(at + 1) % 4] as Point;
      return Math.abs((before[0] - point[0]) * (after[0] - point[0]) + (before[1] - point[1]) * (after[1] - point[1])) < 1e-6 * distance(before, point) * distance(after, point);
    });
  }).length;
  // Each lot's frontage and depth: its reach along the street it opens onto, and back from it.
  const segmentById = new Map(layout.segments.map((segment) => [segment.id, segment]));
  const shapeOf = (lot: Layout['lots'][number]) => {
    const segment = segmentById.get(lot.entrance.segmentId)!;
    const [a, b] = [segment.points[0] as Point, segment.points.at(-1) as Point];
    const length = distance(a, b) || 1;
    const along: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    const on = lot.polygon.map((point) => (point[0] - a[0]) * along[0] + (point[1] - a[1]) * along[1]);
    const back = lot.polygon.map((point) => Math.abs(-(point[0] - a[0]) * along[1] + (point[1] - a[1]) * along[0]));
    return { frontage: Math.max(...on) - Math.min(...on), depth: Math.max(...back) - Math.min(...back), from: Math.min(...on), side: Math.sign(-(lot.polygon[0]![0] - a[0]) * along[1] + (lot.polygon[0]![1] - a[1]) * along[0]) };
  };
  const shapes = new Map(layout.lots.map((lot) => [lot.id, shapeOf(lot)]));
  const sized = layout.lots.filter((lot) => !layout.places.some((place) => place.kind === 'plaza' && place.buildingId === lot.buildingId));
  const nearSize = sized.filter((lot) => {
    const size = lotSizeOf(typeOf.get(lot.buildingId)!, pack);
    return Math.abs(polygonArea(lot.polygon) / (size.frontage * size.depth) - 1) <= 0.25;
  }).length;
  const wideEnough = sized.filter((lot) => shapes.get(lot.id)!.frontage >= 0.6 * lotSizeOf(typeOf.get(lot.buildingId)!, pack).frontage).length;
  // Three lots in a row on one side of a street with the same frontage and depth.
  const rows = new Map<string, Array<{ from: number; frontage: number; depth: number }>>();
  for (const lot of layout.lots) {
    const shape = shapes.get(lot.id)!;
    const key = `${lot.entrance.segmentId}|${shape.side}`;
    rows.set(key, [...(rows.get(key) ?? []), shape]);
  }
  let threes = 0;
  for (const row of rows.values()) {
    row.sort((a, b) => a.from - b.from);
    const same = (a: (typeof row)[number], b: (typeof row)[number]) => Math.abs(a.frontage - b.frontage) < 0.05 && Math.abs(a.depth - b.depth) < 0.05;
    for (let at = 2; at < row.length; at++) if (same(row[at - 2]!, row[at - 1]!) && same(row[at - 1]!, row[at]!)) threes++;
  }
  const frontageSpread = (type: string) => spread(layout.lots.filter((lot) => typeOf.get(lot.buildingId) === type).map((lot) => shapes.get(lot.id)!.frontage));
  // District lot area against the pack's sizes.
  const districtArea = city.districts.map((district) => {
    const own = sized.filter((lot) => lot.districtId === district.id);
    const wanted = own.reduce((sum, lot) => sum + lotSizeOf(typeOf.get(lot.buildingId)!, pack).frontage * lotSizeOf(typeOf.get(lot.buildingId)!, pack).depth, 0);
    return { name: district.name, kind: district.kind, ratio: own.reduce((sum, lot) => sum + polygonArea(lot.polygon), 0) / (wanted || 1) };
  });
  // Blocks: the polygons of the district areas. How much of each one's street sides is lot frontage, in the centre and craft districts.
  const blocks = layout.districtAreas.flatMap((area) => area.polygons.map((polygon) => ({ polygon, districtId: area.districtId })));
  const segmentKey = (a: Point, b: Point) => [a, b].map((point) => point.map((value) => value.toFixed(3)).join(',')).sort().join('|');
  const bySide = new Map(layout.segments.filter((segment) => segment.points.length === 2).map((segment) => [segmentKey(segment.points[0]!, segment.points[1]!), segment]));
  const filled: number[] = [];
  for (const block of blocks) {
    if (!['centre', 'craft'].includes(kindOf.get(block.districtId)!)) continue;
    const box = boxOf(block.polygon);
    const inside = layout.lots.filter((lot) => lot.districtId === block.districtId && lot.polygon.every((point) => point[0] >= box.minX - 1 && point[0] <= box.maxX + 1 && point[1] >= box.minY - 1 && point[1] <= box.maxY + 1) && geometry.pointInPolygon(geometry.polygonCentroid(lot.polygon), block.polygon));
    let side = 0;
    let lot = 0;
    block.polygon.forEach((point, at) => {
      const segment = bySide.get(segmentKey(point, block.polygon[(at + 1) % block.polygon.length] as Point));
      if (!segment) return;
      // The frontage a side can hold: its length, less the corners cut back for the roadways that meet there.
      side += Math.max(0, polylineLength(segment.points) - 2 * (pack.layout.streetWidths.arterial / 2 + 0));
      lot += inside.filter((entry) => entry.entrance.segmentId === segment.id).reduce((sum, entry) => sum + shapes.get(entry.id)!.frontage, 0);
    });
    if (side > 0 && inside.length > 0) filled.push(Math.min(1, lot / side));
  }
  // Water.
  const river = layout.waters.find((water) => water.kind === 'river');
  const sea = layout.waters.find((water) => water.kind === 'sea');
  const bounds = layout.summary.bounds;
  const inBounds = (point: Point, margin = 0) => point[0] >= bounds.minX - margin && point[0] <= bounds.maxX + margin && point[1] >= bounds.minY - margin && point[1] <= bounds.maxY + margin;
  const lotPoints = layout.lots.map((lot) => geometry.polygonCentroid(lot.polygon));
  let riverFigures: Record<string, unknown> | undefined;
  if (river && river.kind === 'river') {
    const line = river.centreLine;
    let turn = 0;
    for (let at = 2; at < line.length; at++) {
      const one = Math.atan2(line[at - 1]![1] - line[at - 2]![1], line[at - 1]![0] - line[at - 2]![0]);
      const other = Math.atan2(line[at]![1] - line[at - 1]![1], line[at]![0] - line[at - 1]![0]);
      turn = Math.max(turn, Math.abs(((((other - one) * 180) / Math.PI + 540) % 360) - 180));
    }
    const within = line.filter((point) => inBounds(point));
    const widths = line.map((_, at) => riverWidthAt(river, at));
    const outline = riverOutline(river);
    const banks = [outline.slice(0, line.length), outline.slice(line.length).reverse()];
    // The bank beside the town: within a block's depth of some lot.
    const beside = (point: Point) => lotPoints.some((lot) => distance(lot, point) < 80);
    const bankPoints = banks.flat().filter((point, at) => at % 3 === 0 && beside(point));
    const streetNear = bankPoints.filter((point) => streets.some((segment) => distanceToPolyline(point, segment.points) <= 40)).length;
    const bridges = layout.segments.filter((segment) => segment.kind === 'bridge');
    const widthAt = (point: Point) => {
      let best = 0;
      line.forEach((entry, at) => {
        if (distance(entry, point) < distance(line[best] as Point, point)) best = at;
      });
      return widths[best] as number;
    };
    const angleAt = (segment: Layout['segments'][number]) => {
      const middle: Point = [(segment.points[0]![0] + segment.points.at(-1)![0]) / 2, (segment.points[0]![1] + segment.points.at(-1)![1]) / 2];
      let best = 1;
      for (let at = 1; at < line.length; at++) if (distance(line[at] as Point, middle) < distance(line[best] as Point, middle)) best = at;
      const flow = Math.atan2(line[best]![1] - line[best - 1]![1], line[best]![0] - line[best - 1]![0]);
      const across = Math.atan2(segment.points.at(-1)![1] - segment.points[0]![1], segment.points.at(-1)![0] - segment.points[0]![0]);
      return Math.abs(((((across - flow) * 180) / Math.PI + 360) % 180) - 90);
    };
    riverFigures = {
      'sharpest turn between pieces': `${turn.toFixed(1)}°`,
      'length within bounds over straight distance': within.length > 1 ? (polylineLength(within) / distance(within[0] as Point, within.at(-1) as Point)).toFixed(2) : 'n/a',
      'ends off the brief bearings': [brief.river?.arrivesFrom?.bearing === undefined ? 'n/a' : `${apart(bearingOf(line[0] as Point), brief.river.arrivesFrom.bearing).toFixed(1)}°`, brief.river?.leavesToward?.bearing === undefined ? 'n/a' : `${apart(bearingOf(line.at(-1) as Point), brief.river.leavesToward.bearing).toFixed(1)}°`].join(' and '),
      'width: narrowest, widest, mean': `${Math.min(...widths).toFixed(1)}, ${Math.max(...widths).toFixed(1)}, ${river.width.toFixed(1)} (${pct((Math.max(...widths) - Math.min(...widths)) / river.width)} of the mean)`,
      'bank beside the town with a street within 40 m': bankPoints.length === 0 ? 'no bank beside the town' : pct(streetNear / bankPoints.length),
      bridges: bridges.length,
      'bridge widths against the mean': bridges.map((segment) => `${widthAt(segment.points[0] as Point).toFixed(1)}/${river.width.toFixed(1)}`).join(', '),
      'bridges off a right angle': bridges.map((segment) => `${angleAt(segment).toFixed(0)}°`).join(', '),
      'least bow of a 200 m stretch of bank near the town': `${Math.min(...banks.map((bank) => leastBow(bank, 200, (point) => inBounds(point, 200)))).toFixed(1)} m`,
    };
  }
  const docks = layout.lots.filter((lot) => typeOf.get(lot.buildingId) === 'docks');
  const gapToWater = (polygon: Point[]) => Math.min(...layout.waters.map((water) => distanceToWater(polygon, water)));
  const gatehouses = layout.walls.flatMap((wall) => wall.gates.map((gate) => distance(layout.junctions.find((junction) => junction.id === gate.junctionId)!.position, geometry.polygonCentroid(layout.lots.find((lot) => lot.buildingId === gate.buildingId)!.polygon))));
  const outline = layout.districtAreas.flatMap((area) => area.polygons.flat());
  const outlineBox = boxOf(outline);
  return {
    lots: layout.lots.length,
    'ring share about the centre': pct(layout.summary.ringShare),
    'highest ring share about a district label': pct(Math.max(...layout.districtAreas.map((area) => ringShare(layout.segments, area.labelPoint)))),
    'roads out of the centre': layout.summary.roadsOut,
    'busiest 15° bin of street directions': pct(Math.max(...bins) / streetLength),
    'junctions of 3 or more streets with 4 or more': pct(meeting.filter((count) => count >= 4).length / (meeting.length || 1)),
    'main roads over 200 m: least stray from straight': strays.length === 0 ? 'none that long' : pct(Math.min(...strays)),
    'dead ends among junctions': `${deadEnds} of ${layout.junctions.length} (${pct(deadEnds / layout.junctions.length)})`,
    lanes: layout.segments.filter((segment) => segment.kind === 'lane').length,
    'lots that are exact rectangles': pct(rectangles / layout.lots.length),
    'lots within 25% of the pack area': pct(nearSize / sized.length),
    'lots with at least 60% of the pack frontage': pct(wideEnough / sized.length),
    'residents per hectare of lot': layout.summary.residentsPerHectare.toFixed(0),
    'outline area over its bounding box': pct(layout.summary.outlineArea / ((outlineBox.maxX - outlineBox.minX) * (outlineBox.maxY - outlineBox.minY))),
    'block area: spread over mean': `${pct(spread(blocks.map((block) => polygonArea(block.polygon))))} of ${blocks.length} blocks`,
    'frontage spread: cottage, row-house': `${pct(frontageSpread('cottage'))}, ${pct(frontageSpread('row-house'))}`,
    'threes of equal lots in a row': threes,
    'centre and craft blocks: frontage that is lot': filled.length === 0 ? 'n/a' : `mean ${pct(mean(filled))}, ${filled.filter((share) => share >= 0.9).length} of ${filled.length} blocks at 90% or more`,
    'district lot area over the pack total': `${Math.min(...districtArea.map((entry) => entry.ratio)).toFixed(2)} to ${Math.max(...districtArea.map((entry) => entry.ratio)).toFixed(2)}; outside 10%: ${districtArea.filter((entry) => Math.abs(entry.ratio - 1) > 0.1).map((entry) => `${entry.name} (${entry.kind}) ${entry.ratio.toFixed(2)}`).join(', ') || 'none'}`,
    walls: layout.walls.length,
    gates: layout.summary.counts.gates,
    'gatehouse furthest from its gate': gatehouses.length === 0 ? 'n/a' : `${Math.max(...gatehouses).toFixed(0)} m`,
    'lots outside the wall': layout.walls.some((wall) => wall.closed) ? layout.lots.filter((lot) => !layout.walls.some((wall) => wall.closed && geometry.pointInPolygon(geometry.polygonCentroid(lot.polygon), wall.lines[0]!))).length : 'n/a',
    'plaza area': layout.places[0] ? `${polygonArea(layout.places[0].polygon).toFixed(0)} m²` : 'none',
    ...(riverFigures ?? {}),
    ...(sea && sea.kind === 'sea' && { 'least bow of a 200 m stretch of coast near the town': `${leastBow(sea.polygon.slice(0, -2), 200, (point) => inBounds(point, 200)).toFixed(1)} m` }),
    ...(docks.length > 0 && { 'docks: furthest from the water': `${Math.max(...docks.map((lot) => gapToWater(lot.polygon))).toFixed(1)} m of ${docks.length}` }),
  };
}

const townOf = (name: string) => world.settlements.find((entry) => entry.name === name)!;
for (const name of ['Badanos', 'Pombal', 'Cevilefon', 'Vereceldo', 'Flupines']) {
  const brief = townOf(name);
  const city = generateCity(brief, pack);
  const started = performance.now();
  const grown = generateLayout(city, brief, pack, { generator: 'grown' });
  const took = performance.now() - started;
  const gridStarted = performance.now();
  const grid = generateLayout(city, brief, pack, { generator: 'grid' });
  const gridTook = performance.now() - gridStarted;
  const [now, was] = [measure(brief, city, grown), measure(brief, city, grid)] as [Record<string, unknown>, Record<string, unknown>];
  console.log(`\n${name}, ${brief.population.toLocaleString('en')} residents: grown in ${took.toFixed(0)} ms, grid in ${gridTook.toFixed(0)} ms`);
  for (const key of Object.keys(now)) console.log(`  ${key}: ${now[key]}${key in was && !/river|bank|bridge|bow|width|ends off|sharpest|length within/.test(key) ? `   [grid: ${was[key]}]` : ''}`);
}

if (process.argv.includes('--all')) {
  const rings: Array<[number, string, number]> = [];
  const labelRings: Array<[number, string]> = [];
  const fewRoads: string[] = [];
  const noLanes: string[] = [];
  let leastRiverBow = [Infinity, ''] as [number, string];
  let leastCoastBow = [Infinity, ''] as [number, string];
  let narrowSpread = [Infinity, ''] as [number, string];
  let sharpest = [0, ''] as [number, string];
  const wideBridges: string[] = [];
  let seconds = 0;
  for (const brief of world.settlements) {
    const city = generateCity(brief, pack);
    const started = performance.now();
    const layout = generateLayout(city, brief, pack, { generator: 'grown' });
    seconds += (performance.now() - started) / 1000;
    rings.push([layout.summary.ringShare, brief.name, brief.population]);
    if (brief.population > 2000) labelRings.push([Math.max(...layout.districtAreas.map((area) => ringShare(layout.segments, area.labelPoint))), brief.name]);
    if (brief.population > 1000 && layout.summary.roadsOut < ROADS_OUT) fewRoads.push(`${brief.name} ${layout.summary.roadsOut}`);
    if (brief.population > 1000 && !layout.segments.some((segment) => segment.kind === 'lane')) noLanes.push(brief.name);
    const bounds = layout.summary.bounds;
    const near = (point: Point) => point[0] >= bounds.minX - 200 && point[0] <= bounds.maxX + 200 && point[1] >= bounds.minY - 200 && point[1] <= bounds.maxY + 200;
    for (const water of layout.waters) {
      if (water.kind === 'sea') {
        const bow = leastBow(water.polygon.slice(0, -2), 200, near);
        if (bow < leastCoastBow[0]) leastCoastBow = [bow, brief.name];
        continue;
      }
      const outline = riverOutline(water);
      const count = water.centreLine.length;
      for (const bank of [outline.slice(0, count), outline.slice(count).reverse()]) {
        const bow = leastBow(bank, 200, near);
        if (bow < leastRiverBow[0]) leastRiverBow = [bow, brief.name];
      }
      const widths = water.centreLine.map((_, at) => riverWidthAt(water, at));
      const variation = (Math.max(...widths) - Math.min(...widths)) / water.width;
      if (variation < narrowSpread[0]) narrowSpread = [variation, brief.name];
      for (let at = 2; at < count; at++) {
        const one = Math.atan2(water.centreLine[at - 1]![1] - water.centreLine[at - 2]![1], water.centreLine[at - 1]![0] - water.centreLine[at - 2]![0]);
        const other = Math.atan2(water.centreLine[at]![1] - water.centreLine[at - 1]![1], water.centreLine[at]![0] - water.centreLine[at - 1]![0]);
        const turn = Math.abs(((((other - one) * 180) / Math.PI + 540) % 360) - 180);
        if (turn > sharpest[0]) sharpest = [turn, brief.name];
      }
      for (const segment of layout.segments) {
        if (segment.kind !== 'bridge') continue;
        let best = 0;
        water.centreLine.forEach((entry, at) => {
          if (distance(entry, segment.points[0] as Point) < distance(water.centreLine[best] as Point, segment.points[0] as Point)) best = at;
        });
        if ((widths[best] as number) > water.width * 1.02) wideBridges.push(`${brief.name} ${(widths[best] as number).toFixed(1)}/${water.width.toFixed(1)}`);
      }
    }
  }
  rings.sort((a, b) => b[0] - a[0]);
  const large = rings.filter((entry) => entry[2] > 2000);
  console.log(`\nAll ${world.settlements.length} settlements of Lomia, grown, in ${seconds.toFixed(1)} s of layout`);
  console.log(`  ten highest ring shares: ${rings.slice(0, 10).map(([share, name, population]) => `${name} ${pct(share)} (${population.toLocaleString('en')})`).join(', ')}`);
  console.log(`  above 2,000 residents: ${large.length} settlements, highest ${large.slice(0, 5).map(([share, name]) => `${name} ${pct(share)}`).join(', ')}; over 60%: ${large.filter((entry) => entry[0] > 0.6).length}`);
  labelRings.sort((a, b) => b[0] - a[0]);
  console.log(`  about district labels, above 2,000 residents: highest ${labelRings.slice(0, 5).map(([share, name]) => `${name} ${pct(share)}`).join(', ')}; over 65%: ${labelRings.filter((entry) => entry[0] > 0.65).length} of ${labelRings.length}`);
  console.log(`  above 1,000 residents with fewer roads out than the pack's number: ${fewRoads.length} (${fewRoads.slice(0, 8).join(', ')})`);
  console.log(`  above 1,000 residents with no lane: ${noLanes.length} (${noLanes.slice(0, 8).join(', ')})`);
  console.log(`  least bow of a 200 m stretch of river bank: ${leastRiverBow[0].toFixed(1)} m (${leastRiverBow[1]}); of coast: ${leastCoastBow[0].toFixed(1)} m (${leastCoastBow[1]})`);
  console.log(`  least river width variation: ${pct(narrowSpread[0])} of the mean (${narrowSpread[1]}); sharpest turn between two pieces of any river: ${sharpest[0].toFixed(1)}° (${sharpest[1]})`);
  console.log(`  bridges where the river is wider than its mean: ${wideBridges.length} (${wideBridges.slice(0, 8).join(', ')})`);
}
