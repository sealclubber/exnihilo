import { readFileSync, writeFileSync } from "node:fs";
import { test } from "vitest";

test("reproduce Lomia", async () => {
  const lomia = JSON.parse(readFileSync("/home/claude/sealclubber/exnihilo/fixtures/afmg/lomia.json", "utf8"));
  const saved = lomia.settings.options;
  Object.assign(globalThis, { grid: undefined, pack: {} });
  const { GenerationPipeline } = await import("./model/generation-pipeline");
  const o: any = (globalThis as any).options;
  o.map.seed = saved.map.seed;
  o.generation.template = saved.generation.template;
  o.map.graph = { ...o.map.graph, ...saved.map.graph };
  o.generation.graph = { ...o.generation.graph, ...saved.generation.graph };
  o.generation.geography = { mapSize: saved.map.geography.mapSize, latitude: saved.map.geography.latitude, longitude: saved.map.geography.longitude };
  o.map.climate = JSON.parse(JSON.stringify(saved.map.climate));
  o.generation.resolveDepressionsSteps = saved.generation.resolveDepressionsSteps;
  o.generation.lakeElevationLimit = saved.generation.lakeElevationLimit;
  if (saved.map.coastline) o.map.coastline = JSON.parse(JSON.stringify(saved.map.coastline));
  o.generation.cultures = saved.generation.cultures; o.generation.states = saved.generation.states;
  let err = "";
  try { await GenerationPipeline.run({}); } catch (e: any) { err = String(e?.message ?? e).slice(0, 300); }
  const g: any = (globalThis as any).grid; const p: any = (globalThis as any).pack;
  const out: any = { err, gridCells: g?.cells?.h?.length, savedGrid: lomia.grid.cells.length, spacing: g?.spacing, cellsX: g?.cellsX, cellsY: g?.cellsY };
  if (g?.cells?.h) {
    const n = Math.min(g.cells.h.length, lomia.grid.cells.length);
    const cmp = (name: string, mine: any) => { if (!mine) return "missing"; let same = 0, maxd = 0; for (let i = 0; i < n; i++) { const d = Math.abs(mine[i] - lomia.grid.cells[i][name]); if (d === 0) same++; if (d > maxd) maxd = d; } return `${same} of ${n} equal, largest difference ${maxd}`; };
    out.gridH = cmp("h", g.cells.h); out.gridTemp = cmp("temp", g.cells.temp); out.gridPrec = cmp("prec", g.cells.prec); out.gridF = cmp("f", g.cells.f);
    out.coordinates = o.map.geography.coordinates; out.savedCoordinates = saved.map.geography.coordinates;
  }
  if (p?.cells?.h) {
    const n = Math.min(p.cells.h.length, lomia.pack.cells.length); out.packCells = p.cells.h.length; out.savedPack = lomia.pack.cells.length;
    const cmp = (name: string, mine: any) => { if (!mine) return "missing"; let same = 0; for (let i = 0; i < n; i++) if (mine[i] === lomia.pack.cells[i][name]) same++; return `${same} of ${n} equal`; };
    out.packH = cmp("h", p.cells.h); out.packBiome = cmp("biome", p.cells.biome); out.packRiver = cmp("r", p.cells.r); out.packFlux = cmp("fl", p.cells.fl);
    out.rivers = p.rivers?.length; out.savedRivers = lomia.pack.rivers.length; out.features = p.features?.length; out.savedFeatures = lomia.pack.features.length;
    out.burgs = p.burgs?.length; out.savedBurgs = lomia.pack.burgs.length; out.states = p.states?.length; out.savedStates = lomia.pack.states.length;
  }
  writeFileSync("/tmp/lomia-repro.json", JSON.stringify(out, null, 1));
}, 600000);
