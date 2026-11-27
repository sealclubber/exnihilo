// Headless entry: the whole generation pipeline as one function.
const g = globalThis as Record<string, unknown>;
if (typeof g.window === "undefined") g.window = globalThis;
if (typeof g.Node === "undefined") g.Node = class { addEventListener() {} removeEventListener() {} };
if (typeof g.document === "undefined") g.document = { readyState: "complete", addEventListener: () => {}, getElementById: () => null, querySelector: () => null };
Object.assign(globalThis, { grid: undefined, pack: {} });

export async function generateWorld(apply: (options: any) => void, steps?: string[]) {
  const original = Math.random;
  try {
    Object.assign(globalThis, { grid: undefined, pack: {} });
    const { Options } = await import("./model/options/options-model");
    (globalThis as any).options = Options.getDefaultOptions(); // fresh defaults for every world
    const { GenerationPipeline } = await import("./model/generation-pipeline");
    apply((globalThis as any).options);
    await GenerationPipeline.run({});
    return { grid: (globalThis as any).grid, pack: (globalThis as any).pack, options: (globalThis as any).options };
  } finally {
    Math.random = original;
  }
}
