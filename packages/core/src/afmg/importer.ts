/**
 * The AFMG importer: parsed export JSON in, a world in our format plus an
 * import report out. This directory is the only place that knows AFMG's
 * structure and field names.
 *
 * Verified against exports from AFMG 1.158.
 */
import { bearing } from '../geometry.ts';
import { makeId } from '../ids.ts';
import { findDanglingReferences } from '../references.ts';
import {
  type Cell,
  type Culture,
  type ImportReport,
  type ImportWarning,
  type NameBase,
  type NeighbourLink,
  type Point,
  type Province,
  type Religion,
  type River,
  type Route,
  type RouteExit,
  type RouteKind,
  type SettlementBrief,
  type SettlementRiver,
  type SizeGroup,
  type State,
  type War,
  type World,
  SizeGroupSchema,
  WorldSchema,
} from '../schema.ts';
import { deriveSeed } from '../seed.ts';
import { AfmgImportError, type Entity, type Rec, rootRecord } from './reader.ts';

export { AfmgImportError } from './reader.ts';

export interface ImportResult {
  world: World;
  report: ImportReport;
}

const SOURCE_TOOL = "Azgaar's Fantasy Map Generator";
const VERIFIED_VERSION = /^1\.158\./;
const WATER_BELOW_HEIGHT = 20;
const COASTAL_LAND = 1;

const TOP_LEVEL_SECTIONS_READ = ['info', 'settings', 'pack', 'grid', 'nameBases'];
const PACK_SECTIONS_READ = [
  'cells',
  'vertices',
  'biomes',
  'cultures',
  'burgs',
  'states',
  'provinces',
  'religions',
  'rivers',
  'goods',
  'routes',
];

const ROUTE_KINDS: Record<string, RouteKind> = {
  roads: 'road',
  trails: 'trail',
  searoutes: 'sea-route',
};

const KNOWN_DIPLOMACY = new Set([
  'ally',
  'friendly',
  'neutral',
  'suspicion',
  'rival',
  'enemy',
  'unknown',
  'vassal',
  'suzerain',
]);

/** What the importer keeps about a cell beyond what the world format stores. */
interface CellSource {
  number: number;
  rec: Rec;
  cell: Cell;
  neighbours: number[];
  river: number;
  settlement: number;
  province: number;
  /** Route number by neighbouring cell number. */
  routes: Array<[number, number]>;
}

export function importAfmg(source: unknown): ImportResult {
  const root = rootRecord(source);
  const info = root.record('info');
  const settings = root.record('settings');
  const pack = root.record('pack');
  const grid = root.record('grid');

  const warnings: ImportWarning[] = [];
  const warn = (code: string, entity: string, message: string) => {
    warnings.push({ code, entity, message });
  };

  const version = info.string('version');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw info.error('version', `must be a version number such as 1.158.0, but is "${version}"`);
  }
  if (!VERIFIED_VERSION.test(version)) {
    warn('unverified-version', 'export', `this importer was verified against AFMG 1.158, the file is from ${version}`);
  }

  const calendar = settings.record('options').record('map').record('lore').record('calendar');
  const worldInfo: World['info'] = {
    name: info.string('mapName'),
    seed: seedText(info),
    currentYear: calendar.integer('year'),
    eraName: calendar.string('era'),
    source: { tool: SOURCE_TOOL, version },
    width: info.number('width'),
    height: info.number('height'),
    distanceScale: {
      unitsPerMapUnit: settings.number('distanceScale'),
      unit: settings.string('distanceUnit'),
    },
  };
  const populationRate = settings.number('populationRate');
  const urbanization = settings.number('urbanization');

  /** Drops entries the map's author deleted in AFMG, which stay in the file flagged as removed. */
  const live = (entities: Entity[]): Entity[] =>
    entities.filter(({ rec }) => {
      if (!rec.has('removed') || !rec.flag('removed', 'required')) return true;
      warn('removed-entity', rec.entity, 'is flagged as removed in the export and was skipped');
      return false;
    });

  // Lookup tables that are not entities of their own in the world format.
  const vertexPositions = new Map<number, Point>();
  for (const { number, rec } of pack.entities('vertices', 'vertex')) {
    vertexPositions.set(number, rec.point('p'));
  }
  const biomeNames = new Map<number, string>();
  for (const { number, rec } of pack.entities('biomes', 'biome')) {
    biomeNames.set(number, rec.string('name'));
  }
  const goodNames = new Map<number, string>();
  for (const { number, rec } of pack.entities('goods', 'good')) {
    goodNames.set(number, rec.string('name'));
  }
  const nameBases = new Map<number, NameBase>();
  for (const { number, rec } of root.entities('nameBases', 'name base')) {
    const doubledLetters = rec.optionalString('d');
    nameBases.set(number, {
      name: rec.string('name'),
      minLength: rec.integer('min'),
      maxLength: rec.integer('max'),
      ...(doubledLetters !== undefined && { doubledLetters }),
      multiWordRate: rec.number('m'),
      sampleNames: rec
        .string('b')
        .split(',')
        .filter((name) => name !== ''),
    });
  }
  const gridCells = grid.entities('cells', 'grid cell');
  const gridCellByNumber = new Map(gridCells.map((entity) => [entity.number, entity.rec]));

  // Entities are read first, then cross-references are resolved against them.
  const cellEntities = pack.entities('cells', 'cell');
  const stateEntities = live(pack.entities('states', 'state'));
  const provinceEntities = live(pack.entities('provinces', 'province', { zeroPlaceholder: true }));
  const cultureEntities = live(pack.entities('cultures', 'culture'));
  const religionEntities = live(pack.entities('religions', 'religion'));
  const riverEntities = pack.entities('rivers', 'river');
  const routeEntities = pack.entities('routes', 'route');
  const burgEntities = live(pack.entities('burgs', 'burg', { zeroPlaceholder: true }));

  const numbers = (entities: Entity[]) => new Set(entities.map((entity) => entity.number));
  const cellNumbers = numbers(cellEntities);
  const stateNumbers = numbers(stateEntities);
  const provinceNumbers = numbers(provinceEntities);
  const cultureNumbers = numbers(cultureEntities);
  const religionNumbers = numbers(religionEntities);
  const riverNumbers = numbers(riverEntities);
  const routeNumbers = numbers(routeEntities);
  const burgNumbers = numbers(burgEntities);

  /** Fails unless `number` is one of the known entities of a kind. */
  const mustExist = (known: Set<number>, number: number, rec: Rec, field: string, what: string) => {
    if (!known.has(number)) throw rec.error(field, `refers to ${what} ${number}, which is not in the export`);
    return number;
  };

  // Cells
  const cellSources = new Map<number, CellSource>();
  for (const { number, rec } of cellEntities) {
    const polygon = rec.integers('v').map((vertex, index) => {
      const position = vertexPositions.get(vertex);
      if (!position) throw rec.error(`v[${index}]`, `refers to vertex ${vertex}, which is not in the export`);
      return position;
    });
    const neighbours = rec.integers('c');
    neighbours.forEach((n, index) => mustExist(cellNumbers, n, rec, `c[${index}]`, 'cell'));
    const height = rec.number('h');
    const biome = rec.integer('biome');
    const biomeName = biomeNames.get(biome);
    if (biomeName === undefined) throw rec.error('biome', `refers to biome ${biome}, which is not in the export`);
    const river = rec.integer('r');
    if (river !== 0) mustExist(riverNumbers, river, rec, 'r', 'river');
    const province = rec.integer('province');
    if (province !== 0) mustExist(provinceNumbers, province, rec, 'province', 'province');
    const settlement = rec.integer('burg');
    if (settlement !== 0) mustExist(burgNumbers, settlement, rec, 'burg', 'burg');

    const routes: Array<[number, number]> = [];
    if (rec.has('routes')) {
      for (const [key, route] of rec.integerEntries('routes')) {
        const neighbour = Number(key);
        if (!/^\d+$/.test(key) || !cellNumbers.has(neighbour)) {
          throw rec.error(`routes.${key}`, 'is keyed by something that is not a cell in the export');
        }
        mustExist(routeNumbers, route, rec, `routes.${key}`, 'route');
        routes.push([neighbour, route]);
      }
      routes.sort((a, b) => a[0] - b[0]);
    }

    const cell: Cell = {
      id: makeId('cell', number),
      center: rec.point('p'),
      polygon,
      neighbourIds: neighbours.map((n) => makeId('cell', n)),
      height,
      isLand: height >= WATER_BELOW_HEIGHT,
      biome: biomeName,
      ...(river !== 0 && { riverId: makeId('river', river) }),
      distanceToCoast: rec.integer('t'),
      ruralPopulation: Math.round(rec.number('pop') * populationRate),
      stateId: makeId('state', mustExist(stateNumbers, rec.integer('state'), rec, 'state', 'state')),
      ...(province !== 0 && { provinceId: makeId('province', province) }),
      cultureId: makeId('culture', mustExist(cultureNumbers, rec.integer('culture'), rec, 'culture', 'culture')),
      religionId: makeId('religion', mustExist(religionNumbers, rec.integer('religion'), rec, 'religion', 'religion')),
    };
    cellSources.set(number, { number, rec, cell, neighbours, river, settlement, province, routes });
  }
  const cellSource = (number: number, rec: Rec, field: string): CellSource => {
    const found = cellSources.get(number);
    if (!found) throw rec.error(field, `refers to cell ${number}, which is not in the export`);
    return found;
  };

  // States. Entry 0 is the placeholder that holds unclaimed land.
  const states: State[] = stateEntities.map(({ number, rec }) => {
    const isPlaceholder = number === 0;
    const diplomacy: Record<string, string> = {};
    const wars: War[] = [];
    if (!isPlaceholder) {
      // The stance list is positional: entry n is the stance toward state n.
      rec.array('diplomacy').forEach((stance, other) => {
        if (other === number || stance === 'x') return;
        if (typeof stance !== 'string' || stance === '') {
          throw rec.error(`diplomacy[${other}]`, 'must be text');
        }
        mustExist(stateNumbers, other, rec, `diplomacy[${other}]`, 'state');
        const value = stance.toLowerCase();
        if (!KNOWN_DIPLOMACY.has(value)) {
          warn('unknown-diplomacy', rec.entity, `has the unrecognised stance "${stance}" toward state ${other}`);
        }
        diplomacy[makeId('state', other)] = value;
      });
      for (const war of rec.records('campaigns')) {
        const endYear = war.optionalInteger('end');
        const attacker = war.integer('attacker');
        const defender = war.integer('defender');
        if (!stateNumbers.has(attacker)) throw war.error('attacker', `refers to state ${attacker}, which is not in the export`);
        if (!stateNumbers.has(defender)) throw war.error('defender', `refers to state ${defender}, which is not in the export`);
        wars.push({
          name: war.string('name'),
          startYear: war.integer('start'),
          ...(endYear !== undefined && { endYear }),
          attackerId: makeId('state', attacker),
          defenderId: makeId('state', defender),
        });
      }
    }
    const fullName = isPlaceholder ? rec.optionalString('fullName') : rec.string('fullName');
    const governmentForm = isPlaceholder ? rec.optionalString('form') : rec.string('form');
    const colour = isPlaceholder ? rec.optionalString('color') : rec.string('color');
    const capital = isPlaceholder ? (rec.optionalInteger('capital') ?? 0) : rec.integer('capital');
    if (capital !== 0) mustExist(burgNumbers, capital, rec, 'capital', 'burg');
    if (capital === 0 && !isPlaceholder) {
      warn('state-without-capital', rec.entity, 'has no capital settlement');
    }
    return {
      id: makeId('state', number),
      name: rec.string('name'),
      ...(fullName !== undefined && { fullName }),
      ...(governmentForm !== undefined && { governmentForm }),
      ...(capital !== 0 && { capitalSettlementId: makeId('settlement', capital) }),
      ...(colour !== undefined && { colour }),
      neighbourIds: rec
        .integers('neighbors')
        .map((n, index) => mustExist(stateNumbers, n, rec, `neighbors[${index}]`, 'state'))
        .sort((a, b) => a - b)
        .map((n) => makeId('state', n)),
      diplomacy,
      wars,
      isPlaceholder,
    };
  });
  const stateById = new Map(states.map((state) => [state.id, state]));

  // Provinces
  const provinceSeats = new Map<number, number>();
  const provinces: Province[] = provinceEntities.map(({ number, rec }) => {
    const seat = rec.integer('burg');
    if (seat === 0) {
      warn('province-without-seat', rec.entity, 'has no seat settlement');
    } else {
      provinceSeats.set(number, mustExist(burgNumbers, seat, rec, 'burg', 'burg'));
    }
    return {
      id: makeId('province', number),
      name: rec.string('name'),
      fullName: rec.string('fullName'),
      stateId: makeId('state', mustExist(stateNumbers, rec.integer('state'), rec, 'state', 'state')),
      ...(seat !== 0 && { seatSettlementId: makeId('settlement', seat) }),
    };
  });
  const provinceById = new Map(provinces.map((province) => [province.id, province]));

  // Cultures. Entry 0 is the placeholder for uninhabited land.
  const cultures: Culture[] = cultureEntities.map(({ number, rec }) => {
    const base = rec.integer('base');
    const nameBase = nameBases.get(base);
    if (!nameBase) throw rec.error('base', `refers to name base ${base}, which is not in the export`);
    return {
      id: makeId('culture', number),
      name: rec.string('name'),
      nameBase,
      originCultureIds: origins(rec, cultureNumbers, 'culture').map((n) => makeId('culture', n)),
      isPlaceholder: number === 0,
    };
  });
  const cultureById = new Map(cultures.map((culture) => [culture.id, culture]));

  // Religions. Entry 0 is the placeholder for "no religion".
  const religions: Religion[] = religionEntities.map(({ number, rec }) => {
    const isPlaceholder = number === 0;
    const type = isPlaceholder ? rec.optionalString('type') : rec.string('type');
    const form = isPlaceholder ? rec.optionalString('form') : rec.string('form');
    const deity = rec.optionalString('deity');
    return {
      id: makeId('religion', number),
      name: rec.string('name'),
      ...(type !== undefined && { type }),
      ...(form !== undefined && { form }),
      ...(deity !== undefined && { deity }),
      originReligionIds: origins(rec, religionNumbers, 'religion').map((n) => makeId('religion', n)),
      isPlaceholder,
    };
  });
  const religionById = new Map(religions.map((religion) => [religion.id, religion]));

  // Rivers. A river with no parent names itself, or 0, as its parent.
  const riverCells = new Map<number, number[]>();
  const rivers: River[] = riverEntities.map(({ number, rec }) => {
    const cells = rec.integers('cells');
    cells.forEach((cell, index) => mustExist(cellNumbers, cell, rec, `cells[${index}]`, 'cell'));
    riverCells.set(number, cells);
    const parent = rec.integer('parent');
    const hasParent = parent !== 0 && parent !== number;
    if (hasParent) mustExist(riverNumbers, parent, rec, 'parent', 'river');
    return {
      id: makeId('river', number),
      name: rec.string('name'),
      type: rec.string('type'),
      cellIds: cells.map((cell) => makeId('cell', cell)),
      ...(hasParent && { parentRiverId: makeId('river', parent) }),
    };
  });
  const riverById = new Map(rivers.map((river) => [river.id, river]));

  // Routes
  const routes: Route[] = routeEntities.map(({ number, rec }) => {
    const group = rec.string('group');
    const kind = ROUTE_KINDS[group];
    if (!kind) throw rec.error('group', `must be roads, trails or searoutes, but is "${group}"`);
    const name = rec.optionalString('name');
    return {
      id: makeId('route', number),
      ...(name !== undefined && { name }),
      kind,
      points: rec.array('points').map((point, index) => {
        const field = `points[${index}]`;
        if (!Array.isArray(point) || point.length < 3 || point.some((part) => typeof part !== 'number')) {
          throw rec.error(field, 'must be a list of x, y and cell');
        }
        const [x, y, cell] = point as [number, number, number];
        return { position: [x, y] as Point, cellId: makeId('cell', mustExist(cellNumbers, cell, rec, field, 'cell')) };
      }),
    };
  });
  const routeById = new Map(routes.map((route) => [route.id, route]));

  // Settlement briefs
  const settlements: SettlementBrief[] = burgEntities.map(({ number, rec }) => {
    const id = makeId('settlement', number);
    const home = cellSource(rec.integer('cell'), rec, 'cell');
    const centre = home.cell.center;
    const linkTo = (neighbour: CellSource): NeighbourLink => ({
      cellId: neighbour.cell.id,
      bearing: bearing(centre, neighbour.cell.center),
    });

    const group = rec.string('group');
    const sizeGroup = SizeGroupSchema.safeParse(group);
    if (!sizeGroup.success) {
      throw rec.error('group', `must be one of ${SizeGroupSchema.options.join(', ')}, but is "${group}"`);
    }

    const state = lookUp(stateById, makeId('state', rec.integer('state')), rec, 'state');
    const culture = lookUp(cultureById, makeId('culture', rec.integer('culture')), rec, 'culture');
    const religion = lookUp(religionById, home.cell.religionId, home.rec, 'religion');
    const province =
      home.cell.provinceId === undefined
        ? undefined
        : lookUp(provinceById, home.cell.provinceId, home.rec, 'province');

    // Goods produced, largest quantity first; equal quantities fall back to the good's number.
    const production = rec.array('production').map((entry, index) => {
      const field = `production[${index}]`;
      if (!Array.isArray(entry) || typeof entry[0] !== 'number' || typeof entry[1] !== 'number') {
        throw rec.error(field, 'must be a pair of good and quantity');
      }
      const [good, quantity] = entry as [number, number];
      const name = goodNames.get(good);
      if (name === undefined) throw rec.error(field, `refers to good ${good}, which is not in the export`);
      return { good, quantity, name };
    });
    production.sort((a, b) => b.quantity - a.quantity || a.good - b.good);

    let river: SettlementRiver | undefined;
    if (home.river !== 0) {
      const riverEntity = lookUp(riverById, makeId('river', home.river), home.rec, 'r');
      const course = riverCells.get(home.river) ?? [];
      const at = course.indexOf(home.number);
      if (at === -1) {
        warn('river-misses-cell', rec.entity, `stands on river ${home.river}, whose course does not list cell ${home.number}`);
      }
      const upstream = at > 0 ? course[at - 1] : undefined;
      const downstream = at !== -1 ? course[at + 1] : undefined;
      river = {
        id: riverEntity.id,
        name: riverEntity.name,
        ...(upstream !== undefined && { arrivesFrom: linkTo(cellSource(upstream, rec, 'cell')) }),
        ...(downstream !== undefined && { leavesToward: linkTo(cellSource(downstream, rec, 'cell')) }),
      };
    }

    const exits: RouteExit[] = home.routes.map(([neighbour, routeNumber]) => {
      const route = lookUp(routeById, makeId('route', routeNumber), home.rec, 'routes');
      const link = linkTo(cellSource(neighbour, home.rec, 'routes'));
      return {
        routeId: route.id,
        ...(route.name !== undefined && { name: route.name }),
        kind: route.kind,
        towardCellId: link.cellId,
        bearing: link.bearing,
      };
    });

    const isCoastal = home.cell.distanceToCoast === COASTAL_LAND;
    const waterBearing = isCoastal
      ? linkTo(cellSource(home.rec.integer('haven'), home.rec, 'haven')).bearing
      : undefined;

    const gridNumber = home.rec.integer('g');
    const gridCell = gridCellByNumber.get(gridNumber);
    if (!gridCell) throw home.rec.error('g', `refers to grid cell ${gridNumber}, which is not in the export`);

    return {
      id,
      name: rec.string('name'),
      position: [rec.number('x'), rec.number('y')],
      cellId: home.cell.id,
      population: Math.round(rec.number('population') * populationRate * urbanization),
      ruralPopulation: home.cell.ruralPopulation,
      sizeGroup: sizeGroup.data as SizeGroup,
      state: {
        id: state.id,
        name: state.name,
        ...(state.fullName !== undefined && { fullName: state.fullName }),
      },
      ...(province && { province: { id: province.id, name: province.name, fullName: province.fullName } }),
      culture: { id: culture.id, name: culture.name, nameBase: culture.nameBase },
      religion: { id: religion.id, name: religion.name },
      flags: {
        capital: rec.flag('capital', 'required'),
        port: rec.flag('port', 'optional'),
        citadel: rec.flag('citadel', 'required'),
        walls: rec.flag('walls', 'required'),
        plaza: rec.flag('plaza', 'optional'),
        temple: rec.flag('temple', 'required'),
        shantyTown: rec.flag('shanty', 'required'),
      },
      isProvinceSeat: provinceSeats.get(home.province) === number,
      specialtyTags: production.map((entry) => entry.name.toLowerCase()),
      ...(river && { river }),
      routes: exits,
      coast: { isCoastal, ...(waterBearing !== undefined && { waterBearing }) },
      climate: {
        biome: home.cell.biome,
        height: home.cell.height,
        temperature: gridCell.number('temp'),
      },
      seed: deriveSeed(worldInfo.seed, 'settlement', id),
    };
  });

  // Where each route leads: follow the route from the settlement's cell, in the direction of the exit, to the
  // first cell that holds another settlement. A sea route is followed the same way, to the next settlement on it.
  const settlementAt = new Map(settlements.map((brief) => [brief.cellId, brief]));
  for (const brief of settlements) {
    for (const exit of brief.routes) {
      const { points } = routeById.get(exit.routeId) as Route;
      const lead = (from: number, step: number): RouteExit['leadsTo'] => {
        let travelled = 0;
        for (let at = from + step; at >= 0 && at < points.length; at += step) {
          const [ax, ay] = (points[at - step] as Route['points'][number]).position;
          const [bx, by] = (points[at] as Route['points'][number]).position;
          travelled += Math.hypot(bx - ax, by - ay);
          const reached = settlementAt.get((points[at] as Route['points'][number]).cellId);
          if (!reached || reached.id === brief.id) continue;
          return {
            settlementId: reached.id,
            name: reached.name,
            sizeGroup: reached.sizeGroup,
            population: reached.population,
            culture: reached.culture.name,
            state: reached.state.name,
            distance: Math.round(travelled * worldInfo.distanceScale.unitsPerMapUnit * 10) / 10,
          };
        }
        return undefined;
      };
      // The exit is the step of the route from this cell to the neighbour it names.
      let found = false;
      for (let at = 0; at < points.length && !found; at++) {
        if ((points[at] as Route['points'][number]).cellId !== brief.cellId) continue;
        for (const step of [1, -1]) {
          if (points[at + step]?.cellId !== exit.towardCellId) continue;
          const leadsTo = lead(at, step);
          if (leadsTo) exit.leadsTo = leadsTo;
          found = true;
          break;
        }
      }
      if (!found) warn('route-misses-exit', brief.id, `has an exit by ${exit.routeId} toward ${exit.towardCellId}, which is not a step of that route, so where it leads is not known`);
    }
  }

  const world: World = {
    info: worldInfo,
    cells: [...cellSources.values()].map((source) => source.cell),
    states,
    provinces,
    cultures,
    religions,
    rivers,
    routes,
    settlements,
  };

  // The importer's own output is held to the world format before it is returned.
  const checked = WorldSchema.safeParse(world);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new AfmgImportError('world', issue ? issue.path.join('.') : '(unknown)', `does not fit the world format: ${issue?.message ?? 'invalid'}`);
  }
  const dangling = findDanglingReferences(world);
  if (dangling.length > 0) {
    throw new AfmgImportError('world', 'references', `are broken: ${dangling.slice(0, 5).join('; ')}`);
  }

  const report: ImportReport = {
    source: worldInfo.source,
    counts: {
      cells: world.cells.length,
      states: states.length,
      provinces: provinces.length,
      cultures: cultures.length,
      religions: religions.length,
      rivers: rivers.length,
      routes: routes.length,
      settlements: settlements.length,
    },
    warnings,
    ignoredSections: [
      ...root.keys().filter((key) => !TOP_LEVEL_SECTIONS_READ.includes(key)),
      ...pack
        .keys()
        .filter((key) => !PACK_SECTIONS_READ.includes(key))
        .map((key) => `pack.${key}`),
    ].sort(),
  };
  return { world, report };
}

/** The world seed as text. AFMG writes it as a string, older files as a number. */
function seedText(info: Rec): string {
  if (!info.has('seed')) throw info.error('seed', 'is missing');
  try {
    return info.string('seed');
  } catch {
    return String(info.integer('seed'));
  }
}

/** Origin numbers of a culture or religion. AFMG writes "none" as null or [null]. */
function origins(rec: Rec, known: Set<number>, what: string): number[] {
  if (!rec.has('origins')) return [];
  const result: number[] = [];
  rec.array('origins').forEach((origin, index) => {
    if (origin === null) return;
    if (typeof origin !== 'number' || !known.has(origin)) {
      throw rec.error(`origins[${index}]`, `must refer to a ${what} in the export`);
    }
    result.push(origin);
  });
  return result;
}

function lookUp<T>(byId: Map<string, T>, id: string, rec: Rec, field: string): T {
  const found = byId.get(id);
  if (!found) throw rec.error(field, `refers to ${id.replace('-', ' ')}, which is not in the export`);
  return found;
}
