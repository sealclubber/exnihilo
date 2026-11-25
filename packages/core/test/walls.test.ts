/**
 * Phase 6D: walls, gates and places in the layout format, and a gatehouse for every way out of a walled town.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type City, type Layout, type SettlementBrief, GENERATOR_VERSION, LAYOUT_VERSION, LayoutSchema, checkCity, checkLayout, generateCity, generateGridLayout, geometry } from '../src/index.ts';
import { lomiaWorld, medievalPack, medievalPackBefore6D, settlement } from './pack.ts';

const pack = medievalPack();

/** A walled hamlet built by hand: a street from west to east through a gate in a wall that runs north to south, with a gatehouse inside it and a cottage outside. */
function fixture(): { layout: Layout; city: City; brief: SettlementBrief } {
  const brief: SettlementBrief = {
    ...structuredClone(settlement('settlement-641')),
    id: 'settlement-1',
    population: 10,
    flags: { ...settlement('settlement-641').flags, walls: true, plaza: true },
    routes: [{ routeId: 'route-1', name: 'East road', kind: 'road', towardCellId: 'cell-1', bearing: 90 }],
    coast: { isCoastal: false },
  };
  delete brief.river;
  const building = (number: number, type: string) => ({ id: `building-1-00000${number}`, type, kind: type === 'cottage' ? 'dwelling' : 'landmark', districtId: 'district-1-001', householdIds: [], workerIds: [] });
  const city = {
    people: Array.from({ length: 10 }, () => ({})),
    households: [],
    buildings: [building(1, 'gatehouse'), building(2, 'cottage'), building(3, 'market-square')],
    districts: [{ id: 'district-1-001', name: 'Old Town', kind: 'centre', buildingIds: ['building-1-000001', 'building-1-000002', 'building-1-000003'] }],
  } as unknown as City;
  const layout: Layout = {
    junctions: [
      { id: 'junction-1-000001', position: [-60, 0], kind: 'dead-end' },
      { id: 'junction-1-000002', position: [0, 0], kind: 'gate' },
      { id: 'junction-1-000003', position: [70, 0], kind: 'exit' },
    ],
    segments: [
      { id: 'segment-1-000001', fromJunctionId: 'junction-1-000001', toJunctionId: 'junction-1-000002', points: [[-60, 0], [-30, 0.5], [0, 0]], kind: 'arterial', width: 10, routeId: 'route-1' },
      { id: 'segment-1-000002', fromJunctionId: 'junction-1-000002', toJunctionId: 'junction-1-000003', points: [[0, 0], [35, -0.5], [70, 0]], kind: 'arterial', width: 10, name: 'East road', routeId: 'route-1' },
    ],
    exits: [{ id: 'exit-1-001', junctionId: 'junction-1-000003', routeId: 'route-1', name: 'East road', kind: 'road', bearing: 90 }],
    waters: [],
    lots: [
      { id: 'lot-1-000001', buildingId: 'building-1-000001', polygon: [[-20, 5.6], [-8, 5.6], [-8, 20], [-20, 20]], districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000001', point: [-14, 0] }, footprints: [] },
      { id: 'lot-1-000002', buildingId: 'building-1-000002', polygon: [[20, 5.6], [30, 5.6], [30, 24], [20, 24]], districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000002', point: [25, 0] }, footprints: [] },
      { id: 'lot-1-000003', buildingId: 'building-1-000003', polygon: [[-58, 5.6], [-30, 5.6], [-30, 30], [-58, 30]], districtId: 'district-1-001', entrance: { segmentId: 'segment-1-000001', point: [-44, 0] }, footprints: [] },
    ],
    districtAreas: [{ districtId: 'district-1-001', polygons: [[[-60, 0], [70, 0], [70, 40], [-60, 40]]], labelPoint: [0, 20] }],
    walls: [{ id: 'wall-1-001', lines: [[[0, -80], [0, 80]]], closed: false, width: 3, gates: [{ junctionId: 'junction-1-000002', buildingId: 'building-1-000001', arterial: true }] }],
    places: [{ id: 'place-1-001', kind: 'plaza', polygon: [[-58, 5.6], [-30, 5.6], [-30, 30], [-58, 30]], buildingId: 'building-1-000003' }],
    summary: {
      settlementId: 'settlement-1',
      counts: { junctions: 3, segments: 2, exits: 1, waters: 0, lots: 3, districtAreas: 1, walls: 1, gates: 1, places: 1 },
      outlineArea: 5200,
      bounds: { minX: -60, minY: -2, maxX: 70, maxY: 30 },
      builtArea: 0,
      residentsPerHectare: 0,
      ringShare: 0,
      roadsOut: 1,
      layoutVersion: LAYOUT_VERSION,
      generator: 'by-hand',
      pack: { name: 'medieval', version: pack.pack.version },
      seed: 1,
    },
  };
  // Entrances are put on their segments' lines, and the summary's figures worked out.
  for (const lot of layout.lots) lot.entrance.point = geometry.projectOnPolyline(layout.segments.find((segment) => segment.id === lot.entrance.segmentId)!.points, lot.entrance.point).point;
  layout.summary.builtArea = layout.lots.reduce((sum, lot) => sum + geometry.polygonArea(lot.polygon), 0);
  layout.summary.residentsPerHectare = 10 / (layout.summary.builtArea / 10_000);
  return { layout, city, brief };
}

describe('walls, gates and places in the format', () => {
  it('fit the schema and break no rule in a walled hamlet built by hand', () => {
    const { layout, city, brief } = fixture();
    expect(LayoutSchema.safeParse(layout).success).toBe(true);
    expect(checkLayout(layout, city, brief, pack)).toEqual([]);
    expect(LAYOUT_VERSION).toBe(12);
  });

  type Parts = ReturnType<typeof fixture>;
  const broken: Array<[string, (parts: Parts) => void, RegExp]> = [
    ['a street that crosses the wall where there is no gate', ({ layout }) => (layout.walls[0]!.gates = []), /segment-1-00000\d crosses wall-1-001 where there is no gate|is marked as a gate but no wall has it/],
    ['a gate that is not on the wall\'s line', ({ layout }) => (layout.walls[0]!.lines = [[[5, -80], [5, 80]]]), /has a gate at junction-1-000002, which is not on the wall's line/],
    ['a gate at a junction not marked as one', ({ layout }) => (layout.junctions[1]!.kind = 'crossing'), /which is not marked as a gate/],
    ['a gate kept by a building that does not exist', ({ layout }) => (layout.walls[0]!.gates[0]!.buildingId = 'building-1-000009'), /kept by building-1-000009, which does not exist/],
    ['a lot that overlaps the wall', ({ layout }) => (layout.lots[1]!.polygon = [[-1, 5.6], [30, 5.6], [30, 24], [-1, 24]]), /lot-1-000002 overlaps wall-1-001/],
    ['a lot that overlaps the plaza', ({ layout }) => (layout.lots[0]!.polygon = [[-35, 5.6], [-8, 5.6], [-8, 20], [-35, 20]]), /lot-1-000001 overlaps place-1-001/],
    ['a plaza that a roadway runs over', ({ layout }) => (layout.places[0]!.polygon = [[-58, 2], [-30, 2], [-30, 30], [-58, 30]]), /place-1-001 overlaps the roadway of segment-1-000001/],
    ['a wall in a town not flagged for one', ({ brief }) => (brief.flags.walls = false), /has a wall but the brief is not flagged for walls/],
    ['a plaza in a town not flagged for one', ({ brief }) => (brief.flags.plaza = false), /has a plaza but the brief is not flagged for one/],
    ['a summary that miscounts the gates', ({ layout }) => (layout.summary.counts.gates = 2), /the summary counts 2 gates but there are 1/],
  ];
  it.each(broken)('report %s', (_, mutate, message) => {
    const parts = fixture();
    mutate(parts);
    expect(checkLayout(parts.layout, parts.city, parts.brief, pack).join('\n')).toMatch(message);
  });

  it('are empty lists in every layout the grid makes, which knows nothing of them', () => {
    const brief = settlement('settlement-5');
    const layout = generateGridLayout(generateCity(brief, pack), brief, pack);
    expect(layout.walls).toEqual([]);
    expect(layout.places).toEqual([]);
    expect(layout.summary.counts).toMatchObject({ walls: 0, gates: 0, places: 0 });
    expect(layout.summary.generator).toBe('grid');
    expect(layout.summary.outlineArea).toBeGreaterThan(layout.summary.builtArea);
  });
});

describe('a gatehouse for every way out', () => {
  it('gives every walled settlement at least as many gatehouses as it has route exits, and changes nothing else', () => {
    const before = medievalPackBefore6D();
    const versionFive = createHash('sha256');
    const failures: string[] = [];
    let walled = 0;
    let more = 0;
    for (const brief of lomiaWorld().settlements) {
      const was = generateCity(brief, before);
      const { generatorVersion: _version, pack: _pack, ...summary } = was.summary;
      versionFive.update(JSON.stringify({ ...was, summary }));
      const city = generateCity(brief, pack);
      const count = (town: City) => town.buildings.filter((building) => building.type === 'gatehouse').length;
      if (!brief.flags.walls) {
        // A town with no walls has no gatehouses, and is the town it was.
        if (count(city) !== 0 || JSON.stringify(city.people) !== JSON.stringify(was.people) || city.buildings.length !== was.buildings.length) failures.push(`${brief.id}: an unwalled town changed`);
        continue;
      }
      walled++;
      if (count(city) < brief.routes.length) failures.push(`${brief.id}: ${count(city)} gatehouses for ${brief.routes.length} exits`);
      if (count(city) !== Math.max(count(was), brief.routes.length)) failures.push(`${brief.id}: ${count(city)} gatehouses, not the greater of ${count(was)} and its ${brief.routes.length} exits`);
      if (count(city) > count(was)) more++;
      // Nobody was added or removed, and no count moved: the new gatehouses share the gate guards there were.
      if (JSON.stringify(city.summary.occupations) !== JSON.stringify(was.summary.occupations) || city.people.length !== was.people.length) failures.push(`${brief.id}: people or occupations moved`);
      failures.push(...checkCity(city, brief, pack).map((problem) => `${brief.id}: ${problem}`));
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(walled).toBe(107);
    expect(more).toBe(50);
    // Without the rule, every city is the one generator version 5 made.
    expect(versionFive.digest('hex')).toBe(JSON.parse(readFileSync(new URL('./baselines/city-v5.json', import.meta.url), 'utf8')).all);
    expect(GENERATOR_VERSION).toBe(6);
  });
});
