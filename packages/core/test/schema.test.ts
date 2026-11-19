import { describe, expect, it } from 'vitest';
import {
  type Cell,
  type SettlementBrief,
  type State,
  type World,
  CellSchema,
  CultureSchema,
  ProvinceSchema,
  ReligionSchema,
  RiverSchema,
  RouteSchema,
  SettlementBriefSchema,
  StateSchema,
  WorldInfoSchema,
  WorldSchema,
  findDanglingReferences,
} from '../src/index.ts';

const info: World['info'] = {
  name: 'Testland',
  seed: '42',
  currentYear: 100,
  eraName: 'Test Era',
  source: { tool: 'a tool', version: '1.0.0' },
  width: 100,
  height: 50,
  distanceScale: { unitsPerMapUnit: 2, unit: 'mi' },
};

const cell: Cell = {
  id: 'cell-1',
  center: [10, 10],
  polygon: [
    [0, 0],
    [20, 0],
    [10, 20],
  ],
  neighbourIds: ['cell-2'],
  height: 30,
  isLand: true,
  biome: 'Grassland',
  distanceToCoast: 2,
  ruralPopulation: 120,
  stateId: 'state-1',
  cultureId: 'culture-1',
  religionId: 'religion-1',
};

const state: State = {
  id: 'state-1',
  name: 'Testia',
  fullName: 'Kingdom of Testia',
  governmentForm: 'Monarchy',
  capitalSettlementId: 'settlement-1',
  colour: '#aabbcc',
  neighbourIds: [],
  diplomacy: {},
  wars: [{ name: 'Old War', startYear: 10, endYear: 12, attackerId: 'state-1', defenderId: 'state-1' }],
  isPlaceholder: false,
};

const brief: SettlementBrief = {
  id: 'settlement-1',
  name: 'Testville',
  position: [10, 10],
  cellId: 'cell-1',
  population: 900,
  ruralPopulation: 120,
  sizeGroup: 'town',
  state: { id: 'state-1', name: 'Testia', fullName: 'Kingdom of Testia' },
  province: { id: 'province-1', name: 'Test', fullName: 'Test Shire' },
  culture: { id: 'culture-1', name: 'Testish' },
  religion: { id: 'religion-1', name: 'Testism' },
  flags: { capital: true, port: false, citadel: false, walls: true, plaza: false, temple: false, shantyTown: false },
  isProvinceSeat: true,
  specialtyTags: ['wool'],
  river: {
    id: 'river-1',
    name: 'Test Water',
    arrivesFrom: { cellId: 'cell-2', bearing: 10 },
  },
  routes: [{ routeId: 'route-1', kind: 'road', towardCellId: 'cell-2', bearing: 190 }],
  coast: { isCoastal: false },
  climate: { biome: 'Grassland', height: 30, temperature: 12 },
  seed: 12345,
};

const world: World = {
  info,
  cells: [cell, { ...cell, id: 'cell-2', neighbourIds: ['cell-1'], riverId: 'river-1' }],
  states: [state],
  provinces: [{ id: 'province-1', name: 'Test', fullName: 'Test Shire', stateId: 'state-1', seatSettlementId: 'settlement-1' }],
  cultures: [
    {
      id: 'culture-1',
      name: 'Testish',
      nameBase: { name: 'English', minLength: 4, maxLength: 9, doubledLetters: 'lt', multiWordRate: 0, sampleNames: ['Abing'] },
      originCultureIds: [],
      isPlaceholder: false,
    },
  ],
  religions: [{ id: 'religion-1', name: 'Testism', type: 'Folk', form: 'Animism', originReligionIds: [], isPlaceholder: false }],
  rivers: [{ id: 'river-1', name: 'Test Water', type: 'River', cellIds: ['cell-2', 'cell-1'] }],
  routes: [
    {
      id: 'route-1',
      kind: 'road',
      points: [
        { position: [10, 10], cellId: 'cell-1' },
        { position: [30, 10], cellId: 'cell-2' },
      ],
    },
  ],
  settlements: [brief],
};

describe('world format schemas', () => {
  it('accepts a valid sample of every entity', () => {
    expect(WorldInfoSchema.parse(info)).toEqual(info);
    expect(CellSchema.parse(cell)).toEqual(cell);
    expect(StateSchema.parse(state)).toEqual(state);
    expect(ProvinceSchema.parse(world.provinces[0])).toEqual(world.provinces[0]);
    expect(CultureSchema.parse(world.cultures[0])).toEqual(world.cultures[0]);
    expect(ReligionSchema.parse(world.religions[0])).toEqual(world.religions[0]);
    expect(RiverSchema.parse(world.rivers[0])).toEqual(world.rivers[0]);
    expect(RouteSchema.parse(world.routes[0])).toEqual(world.routes[0]);
    expect(SettlementBriefSchema.parse(brief)).toEqual(brief);
    expect(WorldSchema.parse(world)).toEqual(world);
  });

  it('accepts a placeholder state with only the fields it has', () => {
    const neutrals = { id: 'state-0', name: 'Neutrals', neighbourIds: [], diplomacy: {}, wars: [], isPlaceholder: true };
    expect(StateSchema.safeParse(neutrals).success).toBe(true);
  });

  it('accepts an ongoing war, which has no end year', () => {
    const ongoing = { ...state, wars: [{ name: 'New War', startYear: 99, attackerId: 'state-1', defenderId: 'state-2' }] };
    expect(StateSchema.safeParse(ongoing).success).toBe(true);
  });

  const invalidBriefs: Array<[string, unknown]> = [
    ['an ID of the wrong kind', { ...brief, id: 'burg-1' }],
    ['an ID with a leading zero', { ...brief, id: 'settlement-01' }],
    ['a missing name', { ...brief, name: undefined }],
    ['an empty name', { ...brief, name: '' }],
    ['a fractional population', { ...brief, population: 900.5 }],
    ['a negative population', { ...brief, population: -1 }],
    ['an unknown size group', { ...brief, sizeGroup: 'hamlet' }],
    ['a flag that is not true or false', { ...brief, flags: { ...brief.flags, port: 1 } }],
    ['a missing flag', { ...brief, flags: { ...brief.flags, shantyTown: undefined } }],
    ['a bearing of 360', { ...brief, routes: [{ ...brief.routes[0], bearing: 360 }] }],
    ['a fractional bearing', { ...brief, coast: { isCoastal: true, waterBearing: 12.5 } }],
    ['an unknown route kind', { ...brief, routes: [{ ...brief.routes[0], kind: 'canal' }] }],
    ['an empty specialty tag', { ...brief, specialtyTags: [''] }],
    ['an empty string standing in for an absent route name', { ...brief, routes: [{ ...brief.routes[0], name: '' }] }],
    ['a field the format does not define', { ...brief, treasury: 4.01 }],
    ['a cell reference of the wrong kind', { ...brief, cellId: 'state-1' }],
  ];
  it.each(invalidBriefs)('rejects a settlement brief with %s', (_, sample) => {
    expect(SettlementBriefSchema.safeParse(sample).success).toBe(false);
  });

  const invalidOthers: Array<[string, { safeParse(value: unknown): { success: boolean } }, unknown]> = [
    ['a world without an era name', WorldInfoSchema, { ...info, eraName: undefined }],
    ['a world with a zero width', WorldInfoSchema, { ...info, width: 0 }],
    ['a cell with a two-point polygon', CellSchema, { ...cell, polygon: cell.polygon.slice(0, 2) }],
    ['a cell with a river ID of zero', CellSchema, { ...cell, riverId: 'river-' }],
    ['a cell without a state', CellSchema, { ...cell, stateId: undefined }],
    ['a state without the placeholder flag', StateSchema, { ...state, isPlaceholder: undefined }],
    ['a war without an attacker', StateSchema, { ...state, wars: [{ name: 'W', startYear: 1, defenderId: 'state-1' }] }],
    ['a diplomacy entry keyed by something that is not a state', StateSchema, { ...state, diplomacy: { 'cell-1': 'ally' } }],
    ['a province without a state', ProvinceSchema, { ...world.provinces[0], stateId: undefined }],
    ['a culture without a name base', CultureSchema, { ...world.cultures[0], nameBase: undefined }],
    ['a religion with an empty deity', ReligionSchema, { ...world.religions[0], deity: '' }],
    ['a river with no cells', RiverSchema, { ...world.rivers[0], cellIds: [] }],
    ['a route with one point', RouteSchema, { ...world.routes[0], points: world.routes[0]!.points.slice(0, 1) }],
    ['a world missing its settlements', WorldSchema, { ...world, settlements: undefined }],
  ];
  it.each(invalidOthers)('rejects %s', (_, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(false);
  });
});

describe('findDanglingReferences', () => {
  it('finds nothing in a consistent world', () => {
    expect(findDanglingReferences(world)).toEqual([]);
  });

  it('names the entity and the ID that does not exist', () => {
    const broken: World = {
      ...world,
      settlements: [{ ...brief, religion: { id: 'religion-9', name: 'Gone' } }],
      rivers: [{ ...world.rivers[0]!, cellIds: ['cell-2', 'cell-77'] }],
    };
    const problems = findDanglingReferences(broken);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('settlement-1');
    expect(problems.join('\n')).toContain('religion-9');
    expect(problems.join('\n')).toContain('cell-77');
  });
});
