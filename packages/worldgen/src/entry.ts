/**
 * AFMG's generator, run headless: its whole generation pipeline as one function.
 *
 * Bundled with AFMG's source (`vendor/afmg/`, untouched) into `dist/afmg.mjs` by `scripts/build.ts`. Ported from
 * `docs/prototypes/afmg-headless-entry.ts`. The generator keeps its state in globals (`grid`, `pack`,
 * `options`) and replaces `Math.random` with a seeded generator, so one world is made at a time and
 * `Math.random` is put back afterwards, whether or not the run succeeds. AFMG's modules are imported only once
 * the browser stubs below are in place, as some of them read `window` or `document` when they load.
 */
// 1. The three things AFMG expects of a browser.
const g = globalThis as Record<string, unknown>;
if (typeof g.window === 'undefined') g.window = globalThis;
if (typeof g.Node === 'undefined')
  g.Node = class {
    addEventListener() {}
    removeEventListener() {}
  };
if (typeof g.document === 'undefined')
  g.document = { readyState: 'complete', addEventListener: () => {}, getElementById: () => null, querySelector: () => null };
Object.assign(globalThis, { grid: undefined, pack: {} });

/** Any part of AFMG's options: objects are merged over the defaults key by key; anything else replaces. */
export type PartialOptions = { [key: string]: unknown };

export interface Generated {
  grid: any;
  pack: any;
  options: any;
  /** The world as AFMG's "Full" JSON export, the text a downloaded `.json` file holds. */
  json: string;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (isPlain(value) && isPlain(target[key])) mergeInto(target[key] as Record<string, unknown>, value);
    else target[key] = structuredClone(value);
  }
}

async function run(given: PartialOptions): Promise<Generated> {
  const original = Math.random;
  try {
    // 2. Nothing of the last world is left.
    Object.assign(globalThis, { grid: undefined, pack: {} });
    const { Options } = await import('@/model/options/options-model');
    const { GenerationPipeline } = await import('@/model/generation-pipeline');
    const { log } = await import('@/utils/logger');
    // AFMG times every step on the console; warnings and errors still show.
    log.enabled.time = false;
    log.enabled.info = false;
    // 3. Fresh defaults for every world, or one world's settings leak into the next.
    g.options = Options.getDefaultOptions();
    // 4. The caller's options.
    mergeInto(g.options as Record<string, unknown>, given);
    // 5. The whole pipeline.
    await GenerationPipeline.run({});
    // 6. What it made, and the same as AFMG's export, built while the generator's globals are still this world's.
    return { grid: g.grid, pack: g.pack, options: g.options, json: await fullDataJson() };
  } finally {
    // 7. The seeded generator must not outlive the call.
    Math.random = original;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Makes one world. A call made while another is running waits for it: the generator's state is global. */
export function generateWorld(options: PartialOptions = {}): Promise<Generated> {
  const result = queue.then(() => run(options));
  queue = result.catch(() => undefined);
  return result;
}

/*
 * AFMG's "Full" JSON export, built in memory. The four builders below are copied word for word from AFMG's
 * `services/io/export-json.ts` (`getFullDataJson`, `getMapInfo`, `getSettings`, `getPackCellsData`,
 * `getGridCellsData`), with types added: that module exports only `exportToJson`, which needs a browser to
 * download a file, and nothing under `vendor/afmg/` may be edited to export the builders themselves.
 */
declare const options: any;
declare const pack: any;
declare const grid: any;
/** AFMG's `VERSION`, from `services/versioning.ts`, put in by the build. */
declare const AFMG_VERSION: string;

async function fullDataJson(): Promise<string> {
  const { mapHistory } = await import('@/model/map-history');
  const { Names } = await import('@/model/society/names-generator');
  // `services/versioning.ts` brings AFMG's whole interface with it; the build reads its `VERSION` instead.
  const VERSION = AFMG_VERSION;

  function getMapInfo() {
    return {
      version: VERSION,
      description: "Azgaar's Fantasy Map Generator output: azgaar.github.io/Fantasy-map-generator",
      exportedAt: new Date().toISOString(),
      mapName: options.map.lore.name,
      width: options.map.graph.width,
      height: options.map.graph.height,
      seed: options.map.seed,
      mapId: mapHistory.at(-1)?.created ?? Date.now(),
    };
  }

  function getSettings() {
    return {
      distanceUnit: options.map.units.distance.unit,
      distanceScale: options.map.units.distance.scale,
      areaUnit: options.map.units.area.unit,
      heightUnit: options.map.units.height.unit,
      heightExponent: options.map.units.height.exponent,
      temperatureScale: options.map.units.temperature.unit,
      moneyUnit: options.map.units.money.unit,
      populationRate: options.map.units.population.scale,
      urbanization: options.map.units.population.urbanization.rate,
      urbanDensity: options.map.units.population.urbanization.density,
      options,
      mapName: options.map.lore.name,
      stylePreset: options.map.style.preset,
    };
  }

  function getPackCellsData() {
    const data = {
      v: pack.cells.v,
      c: pack.cells.c,
      p: pack.cells.p,
      g: Array.from(pack.cells.g),
      h: Array.from(pack.cells.h),
      area: Array.from(pack.cells.area),
      f: Array.from(pack.cells.f),
      t: Array.from(pack.cells.t),
      haven: Array.from(pack.cells.haven),
      harbor: Array.from(pack.cells.harbor),
      fl: Array.from(pack.cells.fl),
      r: Array.from(pack.cells.r),
      conf: Array.from(pack.cells.conf),
      biome: Array.from(pack.cells.biome),
      s: Array.from(pack.cells.s),
      pop: Array.from(pack.cells.pop),
      culture: Array.from(pack.cells.culture),
      burg: Array.from(pack.cells.burg),
      routes: pack.cells.routes,
      state: Array.from(pack.cells.state),
      religion: Array.from(pack.cells.religion),
      province: Array.from(pack.cells.province),
      good: Array.from(pack.cells.good),
      market: Array.from(pack.cells.market),
      development: Array.from(pack.cells.development),
      prosperity: Array.from(pack.cells.prosperity),
    };

    return {
      cells: Array.from(pack.cells.i as ArrayLike<number>).map((cellId) => ({
        i: cellId,
        v: data.v[cellId],
        c: data.c[cellId],
        p: data.p[cellId],
        g: data.g[cellId],
        h: data.h[cellId],
        area: data.area[cellId],
        f: data.f[cellId],
        t: data.t[cellId],
        haven: data.haven[cellId],
        harbor: data.harbor[cellId],
        fl: data.fl[cellId],
        r: data.r[cellId],
        conf: data.conf[cellId],
        biome: data.biome[cellId],
        s: data.s[cellId],
        pop: data.pop[cellId],
        culture: data.culture[cellId],
        burg: data.burg[cellId],
        routes: data.routes[cellId],
        state: data.state[cellId],
        religion: data.religion[cellId],
        province: data.province[cellId],
        good: data.good[cellId],
        market: data.market[cellId],
        development: data.development[cellId],
        prosperity: data.prosperity[cellId],
      })),
      vertices: Array.from(pack.vertices.p as ArrayLike<unknown>).map((_, vertexId) => ({
        i: vertexId,
        p: pack.vertices.p[vertexId],
        v: pack.vertices.v[vertexId],
        c: pack.vertices.c[vertexId],
      })),
      features: pack.features,
      biomes: pack.biomes,
      cultures: pack.cultures,
      burgs: pack.burgs,
      states: pack.states,
      provinces: pack.provinces,
      religions: pack.religions,
      rivers: pack.rivers,
      goods: options.map.goods,
      markers: pack.markers,
      events: pack.events,
      markets: pack.markets,
      deals: pack.deals,
      routes: pack.routes,
      zones: pack.zones,
      measurers: pack.measurers,
      journeys: pack.journeys,
    };
  }

  function getGridCellsData() {
    const dataArrays = {
      v: grid.cells.v,
      c: grid.cells.c,
      b: grid.cells.b,
      f: Array.from(grid.cells.f),
      t: Array.from(grid.cells.t),
      h: Array.from(grid.cells.h),
      temp: Array.from(grid.cells.temp),
      prec: Array.from(grid.cells.prec),
    };

    return {
      cells: (Array.from(grid.cells.i) as number[]).map((cellId: number) => ({
        i: cellId,
        v: dataArrays.v[cellId],
        c: dataArrays.c[cellId],
        b: dataArrays.b[cellId],
        f: dataArrays.f[cellId],
        t: dataArrays.t[cellId],
        h: dataArrays.h[cellId],
        temp: dataArrays.temp[cellId],
        prec: dataArrays.prec[cellId],
      })),
      vertices: Array.from(grid.vertices.p as ArrayLike<unknown>).map((_: unknown, vertexId: number) => ({
        i: vertexId,
        p: grid.vertices.p[vertexId],
        v: grid.vertices.v[vertexId],
        c: grid.vertices.c[vertexId],
      })),
      sampling: grid.sampling,
      spacing: grid.spacing,
      cellsY: grid.cellsY,
      cellsX: grid.cellsX,
      points: grid.points,
      boundary: grid.boundary,
      seed: options.map.seed,
      features: pack.features,
    };
  }

  // getFullDataJson
  return JSON.stringify({
    info: getMapInfo(),
    settings: getSettings(),
    mapCoordinates: options.map.geography.coordinates,
    pack: getPackCellsData(),
    grid: getGridCellsData(),
    nameBases: Names.nameBases,
  });
}
