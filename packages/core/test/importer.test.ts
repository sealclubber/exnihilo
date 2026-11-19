/**
 * Acceptance tests for the importer, run against the Lomia export.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ImportReport,
  type SettlementBrief,
  type World,
  AfmgImportError,
  ImportReportSchema,
  SettlementBriefSchema,
  WorldSchema,
  byIdNumber,
  deriveSeed,
  findDanglingReferences,
  importAfmg,
} from '../src/index.ts';
import { loadLomia } from './fixture.ts';

let world: World;
let report: ImportReport;

beforeAll(() => {
  ({ world, report } = importAfmg(loadLomia()));
});

describe('world totals', () => {
  it('has the expected number of each entity', () => {
    expect(world.settlements).toHaveLength(682);
    expect(world.cells).toHaveLength(4605);
    expect(world.states.filter((state) => !state.isPlaceholder)).toHaveLength(23);
    expect(world.provinces).toHaveLength(168);
    expect(world.cultures).toHaveLength(13);
    expect(world.religions).toHaveLength(18);
    expect(world.rivers).toHaveLength(156);
    expect(world.routes).toHaveLength(606);
  });

  it('describes the world itself', () => {
    expect(world.info).toEqual({
      name: 'Lomia',
      seed: '154035788',
      currentYear: 848,
      eraName: 'Thatcking Era',
      source: { tool: "Azgaar's Fantasy Map Generator", version: '1.158.0' },
      width: 1920,
      height: 1002,
      distanceScale: { unitsPerMapUnit: 2, unit: 'mi' },
    });
  });

  it('keeps the placeholder entries as flagged entities', () => {
    const flagged = (list: Array<{ name: string; isPlaceholder: boolean }>) =>
      list.filter((entity) => entity.isPlaceholder).map((entity) => entity.name);
    expect(flagged(world.states)).toEqual(['Neutrals']);
    expect(flagged(world.cultures)).toEqual(['Wildlands']);
    expect(flagged(world.religions)).toEqual(['No religion']);
  });
});

describe('the Badanos brief', () => {
  let badanos: SettlementBrief;
  beforeAll(() => {
    badanos = world.settlements.find((brief) => brief.id === 'settlement-641')!;
  });

  it('has the expected identity and place', () => {
    expect(badanos.name).toBe('Badanos');
    expect(badanos.cellId).toBe('cell-2134');
    expect(badanos.position).toEqual([931.35, 422.9]);
  });

  it('has the expected populations and size group', () => {
    expect(badanos.population).toBe(9607);
    expect(badanos.ruralPopulation).toBe(4495);
    expect(badanos.sizeGroup).toBe('city');
  });

  it('belongs to the expected state, province, culture and religion', () => {
    expect(badanos.state).toEqual({ id: 'state-4', name: 'Monzia', fullName: 'Monzian Empire' });
    expect(badanos.province).toEqual({ id: 'province-24', name: 'Badanos', fullName: 'Badanos County' });
    expect(badanos.isProvinceSeat).toBe(true);
    expect(badanos.culture).toEqual({ id: 'culture-8', name: 'Vengrian' });
    expect(badanos.religion).toEqual({ id: 'religion-14', name: 'Klakkrova Pantheon' });
  });

  it('has all seven flags false', () => {
    expect(badanos.flags).toEqual({
      capital: false,
      port: false,
      citadel: false,
      walls: false,
      plaza: false,
      temple: false,
      shantyTown: false,
    });
  });

  it('lists its specialty tags, largest quantity first', () => {
    expect(badanos.specialtyTags).toEqual(['leather', 'arms']);
  });

  it('describes the river crossing it', () => {
    expect(badanos.river).toEqual({
      id: 'river-85',
      name: 'Hegyes',
      arrivesFrom: { cellId: 'cell-2237', bearing: 152 },
      leavesToward: { cellId: 'cell-2029', bearing: 61 },
    });
  });

  it('has two exits on the Pusztaszian trail', () => {
    expect(badanos.routes).toHaveLength(2);
    expect(badanos.routes).toContainEqual({
      routeId: 'route-34',
      name: 'Pusztaszian trail',
      kind: 'trail',
      towardCellId: 'cell-2236',
      bearing: 227,
    });
    expect(badanos.routes).toContainEqual({
      routeId: 'route-34',
      name: 'Pusztaszian trail',
      kind: 'trail',
      towardCellId: 'cell-2029',
      bearing: 61,
    });
  });

  it('is not coastal', () => {
    expect(badanos.coast).toEqual({ isCoastal: false });
  });

  it('has the expected climate', () => {
    expect(badanos.climate).toEqual({ biome: 'Tropical seasonal forest', height: 25, temperature: 33 });
  });

  it('has a seed derived from the world seed and its ID', () => {
    expect(badanos.seed).toBe(deriveSeed('154035788', 'settlement', 'settlement-641'));
  });
});

describe('whole-world checks', () => {
  it('produces 682 briefs that all pass schema validation', () => {
    expect(world.settlements).toHaveLength(682);
    for (const brief of world.settlements) {
      const result = SettlementBriefSchema.safeParse(brief);
      expect(result.success, `${brief.id}: ${result.error?.message}`).toBe(true);
    }
    expect(WorldSchema.safeParse(world).success).toBe(true);
    expect(ImportReportSchema.safeParse(report).success).toBe(true);
  });

  it('refers only to IDs that exist in the world', () => {
    expect(findDanglingReferences(world)).toEqual([]);
  });

  it('has 178 ports and 210 settlements with a river', () => {
    expect(world.settlements.filter((brief) => brief.flags.port)).toHaveLength(178);
    expect(world.settlements.filter((brief) => brief.river)).toHaveLength(210);
  });

  it('gives every settlement at least one route exit', () => {
    expect(world.settlements.filter((brief) => brief.routes.length === 0)).toEqual([]);
  });

  it('gives a water bearing to exactly the coastal settlements', () => {
    for (const brief of world.settlements) {
      expect(brief.coast.waterBearing !== undefined, brief.id).toBe(brief.coast.isCoastal);
    }
  });

  it('marks exactly one province seat per province that has one', () => {
    const seats = world.settlements.filter((brief) => brief.isProvinceSeat);
    const provincesWithSeat = world.provinces.filter((province) => province.seatSettlementId !== undefined);
    expect(seats.map((brief) => brief.id).sort()).toEqual(provincesWithSeat.map((p) => p.seatSettlementId!).sort());
  });

  it('never records an absent value as an empty string, null or undefined key', () => {
    const problems: string[] = [];
    const visit = (value: unknown, path: string) => {
      if (value === '' || value === null || value === undefined) problems.push(path);
      else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`));
      else if (typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
      }
    };
    visit(world, 'world');
    expect(problems).toEqual([]);
  });

  it('outputs every list of entities in ID order', () => {
    for (const list of [
      world.cells,
      world.states,
      world.provinces,
      world.cultures,
      world.religions,
      world.rivers,
      world.routes,
      world.settlements,
    ]) {
      const ids = list.map((entity) => entity.id);
      expect(ids).toEqual([...list].sort(byIdNumber).map((entity) => entity.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('produces byte-identical output when the fixture is imported twice', () => {
    const first = JSON.stringify(importAfmg(loadLomia()));
    const second = JSON.stringify(importAfmg(loadLomia()));
    expect(second).toBe(first);
    expect(first).toBe(JSON.stringify({ world, report }));
  });

  it('does not change the parsed export it is given', () => {
    const source = loadLomia();
    const before = JSON.stringify(source);
    importAfmg(source);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('the world beyond the briefs', () => {
  it('imports states with capital, diplomacy and wars', () => {
    const monzia = world.states.find((state) => state.id === 'state-4')!;
    expect(monzia.name).toBe('Monzia');
    expect(monzia.fullName).toBe('Monzian Empire');
    expect(monzia.governmentForm).toBe('Monarchy');
    expect(monzia.capitalSettlementId).toBe('settlement-4');
    expect(monzia.colour).toBe('#e78ac3');
    expect(monzia.neighbourIds).toEqual(['state-2', 'state-6', 'state-11', 'state-13', 'state-20', 'state-22', 'state-23']);
    expect(Object.keys(monzia.diplomacy)).toHaveLength(22);
    expect(monzia.diplomacy['state-1']).toBe('ally');
    expect(monzia.diplomacy['state-11']).toBe('suzerain');
    expect(monzia.diplomacy['state-4']).toBeUndefined();
    expect(monzia.diplomacy['state-0']).toBeUndefined();
    expect(monzia.wars[0]).toEqual({
      name: 'Cuercian Rebellion',
      startYear: 508,
      endYear: 517,
      attackerId: 'state-4',
      defenderId: 'state-23',
    });
  });

  it('leaves the end year off a war that is still being fought', () => {
    const oyavik = world.states.find((state) => state.id === 'state-2')!;
    const war = oyavik.wars.find((entry) => entry.name === 'Oyavik-Kunsilian War')!;
    expect(war).toEqual({ name: 'Oyavik-Kunsilian War', startYear: 846, attackerId: 'state-2', defenderId: 'state-18' });
    expect('endYear' in war).toBe(false);
  });

  it('imports the placeholder state with nothing invented', () => {
    expect(world.states[0]).toEqual({
      id: 'state-0',
      name: 'Neutrals',
      neighbourIds: [],
      diplomacy: {},
      wars: [],
      isPlaceholder: true,
    });
  });

  it('imports cells with geometry and ownership', () => {
    const cell = world.cells.find((entry) => entry.id === 'cell-2134')!;
    expect(cell.center).toEqual([931.71, 423.13]);
    expect(cell.polygon).toHaveLength(6);
    expect(cell.neighbourIds).toEqual(['cell-2237', 'cell-2236', 'cell-2133', 'cell-2028', 'cell-2029', 'cell-2135']);
    expect(cell).toMatchObject({
      height: 25,
      isLand: true,
      biome: 'Tropical seasonal forest',
      riverId: 'river-85',
      distanceToCoast: 8,
      ruralPopulation: 4495,
      stateId: 'state-4',
      provinceId: 'province-24',
      cultureId: 'culture-8',
      religionId: 'religion-14',
    });
    const water = world.cells.find((entry) => entry.id === 'cell-0')!;
    expect(water.isLand).toBe(false);
    expect('riverId' in water).toBe(false);
    expect('provinceId' in water).toBe(false);
    expect(world.cells.filter((entry) => !entry.isLand)).toHaveLength(1329);
  });

  it('imports provinces, cultures, religions, rivers and routes', () => {
    expect(world.provinces.find((entry) => entry.id === 'province-24')).toEqual({
      id: 'province-24',
      name: 'Badanos',
      fullName: 'Badanos County',
      stateId: 'state-4',
      seatSettlementId: 'settlement-641',
    });

    const vengrian = world.cultures.find((entry) => entry.id === 'culture-8')!;
    expect(vengrian.name).toBe('Vengrian');
    expect(vengrian.nameBase.name).toBe('Hungarian');
    expect(vengrian.nameBase.sampleNames.length).toBeGreaterThan(10);
    expect(vengrian.originCultureIds).toEqual(['culture-0']);
    expect(world.cultures[0]!.originCultureIds).toEqual([]);

    expect(world.religions.find((entry) => entry.id === 'religion-14')).toEqual({
      id: 'religion-14',
      name: 'Klakkrova Pantheon',
      type: 'Organized',
      form: 'Polytheism',
      deity: 'Straugar, The Major Boar',
      originReligionIds: ['religion-1'],
      isPlaceholder: false,
    });
    expect(world.religions[0]).toEqual({ id: 'religion-0', name: 'No religion', originReligionIds: [], isPlaceholder: true });
    expect('deity' in world.religions.find((entry) => entry.id === 'religion-2')!).toBe(false);

    expect(world.rivers.find((entry) => entry.id === 'river-85')).toEqual({
      id: 'river-85',
      name: 'Hegyes',
      type: 'River',
      cellIds: ['cell-2238', 'cell-2237', 'cell-2134', 'cell-2029', 'cell-2030', 'cell-2031', 'cell-1847'],
      parentRiverId: 'river-25',
    });
    expect('parentRiverId' in world.rivers.find((entry) => entry.id === 'river-3')!).toBe(false);

    const trail = world.routes.find((entry) => entry.id === 'route-34')!;
    expect(trail.name).toBe('Pusztaszian trail');
    expect(trail.kind).toBe('trail');
    expect(trail.points[0]).toEqual({ position: [921.02, 433.03], cellId: 'cell-2236' });
    expect(trail.points).toHaveLength(7);
    const kinds = (kind: string) => world.routes.filter((entry) => entry.kind === kind).length;
    expect([kinds('road'), kinds('trail'), kinds('sea-route')]).toEqual([28, 432, 146]);
    expect(world.routes.filter((entry) => entry.name === undefined)).toHaveLength(338);
  });
});

describe('the import report', () => {
  it('counts what was imported', () => {
    expect(report.counts).toEqual({
      cells: 4605,
      states: 24,
      provinces: 168,
      cultures: 13,
      religions: 18,
      rivers: 156,
      routes: 606,
      settlements: 682,
    });
    expect(report.source.version).toBe('1.158.0');
  });

  it('reports the provinces that have no seat, and nothing else', () => {
    expect(report.warnings.map((warning) => warning.code)).toEqual(Array(5).fill('province-without-seat'));
  });

  it('lists the sections it did not read, including the economy', () => {
    expect(report.ignoredSections).toContain('pack.markets');
    expect(report.ignoredSections).toContain('pack.deals');
    expect(report.ignoredSections).not.toContain('pack.cells');
  });

  it('warns about an export from a version it was not verified against', () => {
    const source = loadLomia();
    source.info.version = '1.200.3';
    const result = importAfmg(source);
    expect(result.report.warnings.some((warning) => warning.code === 'unverified-version')).toBe(true);
  });
});

describe('an export the importer cannot rely on', () => {
  const failure = (mutate: (source: any) => void): AfmgImportError => {
    const source = loadLomia();
    mutate(source);
    try {
      importAfmg(source);
    } catch (error) {
      expect(error).toBeInstanceOf(AfmgImportError);
      return error as AfmgImportError;
    }
    throw new Error('the import did not fail');
  };

  it('fails with a message naming a removed required field and its entity', () => {
    const error = failure((source) => delete source.pack.burgs[641].population);
    expect(error.message).toContain('population');
    expect(error.message).toContain('burg 641');
    expect(error.field).toBe('population');
    expect(error.entity).toBe('burg 641');
  });

  const removals: Array<[string, (source: any) => void, string, string]> = [
    ['the version', (s) => delete s.info.version, 'version', 'export'],
    ['the calendar year', (s) => delete s.settings.options.map.lore.calendar.year, 'options.map.lore.calendar.year', 'export'],
    ['the population rate', (s) => delete s.settings.populationRate, 'populationRate', 'export'],
    ['a cell height', (s) => delete s.pack.cells[2134].h, 'h', 'cell 2134'],
    ['a cell centre', (s) => delete s.pack.cells[10].p, 'p', 'cell 10'],
    ['a settlement name', (s) => delete s.pack.burgs[1].name, 'name', 'burg 1'],
    ['a settlement flag', (s) => delete s.pack.burgs[1].walls, 'walls', 'burg 1'],
    ['a state name', (s) => delete s.pack.states[4].fullName, 'fullName', 'state 4'],
    ['a war attacker', (s) => delete s.pack.states[4].campaigns[0].attacker, 'campaigns[0].attacker', 'state 4'],
    ['a province state', (s) => delete s.pack.provinces[24].state, 'state', 'province 24'],
    ['a culture name base', (s) => delete s.pack.cultures[8].base, 'base', 'culture 8'],
    ['a river course', (s) => delete s.pack.rivers[0].cells, 'cells', 'river 1'],
    ['a route group', (s) => delete s.pack.routes[34].group, 'group', 'route 34'],
    ['a grid temperature', (s) => delete s.grid.cells[4207].temp, 'temp', 'grid cell 4207'],
    ['the whole settlement list', (s) => delete s.pack.burgs, 'burgs', 'export'],
  ];
  it.each(removals)('fails when %s is removed', (_, mutate, field, entity) => {
    const error = failure(mutate);
    expect(error.field).toContain(field);
    expect(error.entity).toBe(entity);
    expect(error.message).toContain(field);
  });

  const mistyped: Array<[string, (source: any) => void, string]> = [
    ['a population given as text', (s) => (s.pack.burgs[641].population = '9.607'), 'population'],
    ['a name given as a number', (s) => (s.pack.burgs[641].name = 7), 'name'],
    ['a size group the format does not know', (s) => (s.pack.burgs[641].group = 'hamlet'), 'group'],
    ['a route group the format does not know', (s) => (s.pack.routes[0].group = 'canals'), 'group'],
    ['a settlement on a cell that does not exist', (s) => (s.pack.burgs[641].cell = 99999), 'cell'],
    ['a cell in a state that does not exist', (s) => (s.pack.cells[2134].state = 77), 'state'],
    ['a version that is not a version', (s) => (s.info.version = 'latest'), 'info.version'],
  ];
  it.each(mistyped)('fails on %s', (_, mutate, field) => {
    expect(failure(mutate).field).toBe(field);
  });

  it('fails on something that is not an export at all', () => {
    expect(() => importAfmg(null)).toThrow(AfmgImportError);
    expect(() => importAfmg([])).toThrow(AfmgImportError);
    expect(() => importAfmg({})).toThrow(/info/);
  });
});
