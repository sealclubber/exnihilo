/**
 * Checks the rules that keep the packages apart: AFMG knowledge stays in the
 * importer, and core stays pure.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../..', import.meta.url));
const IMPORTER = join('core', 'src', 'afmg');

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'dist' ? [] : sourceFiles(path);
    return /\.(ts|html|css)$/.test(entry.name) ? [path] : [];
  });
}

/** Every file of the three packages that ships: sources, not tests. */
const shipped = ['core', 'server', 'client'].flatMap((name) => [
  ...sourceFiles(join(PACKAGES, name, 'src')),
  ...sourceFiles(join(PACKAGES, name)).filter((path) => !path.includes(`${name}/src/`) && !path.includes(`${name}/test/`)),
]);

const offenders = (files: string[], pattern: RegExp): string[] =>
  files.flatMap((path) =>
    readFileSync(path, 'utf8')
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(PACKAGES, path)}:${index + 1}: ${line.trim()}`] : [])),
  );

describe('package boundaries', () => {
  it('finds the source files it is meant to check', () => {
    const names = shipped.map((path) => relative(PACKAGES, path));
    expect(names).toContain(join('core', 'src', 'afmg', 'importer.ts'));
    expect(names).toContain(join('server', 'src', 'storage.ts'));
    expect(names).toContain(join('client', 'src', 'main.ts'));
    expect(names).toContain(join('client', 'index.html'));
  });

  // "pack" alone is not checked: since phase 2 it also means a setting pack.
  it('keeps AFMG structures and field names inside the importer', () => {
    const outside = shipped.filter((path) => !relative(PACKAGES, path).startsWith(IMPORTER));
    const afmgNames =
      /\bpack\.(cells|vertices|features|biomes|burgs|states|provinces|religions|rivers|goods|markers|markets|deals|routes|zones)\b|\b(burgs?|nameBases|populationRate|urbanization|searoutes|formName|campaigns|haven|harbor|mapName|biomesData)\b|\bgrid\.cells\b|\.(burg|pop|feature)\b(?!\()/;
    expect(offenders(outside, afmgNames)).toEqual([]);
  });

  it('keeps core free of disk, network, clock and random-number access', () => {
    const core = shipped.filter((path) => relative(PACKAGES, path).startsWith(join('core', 'src')));
    const impure =
      /from\s+['"]node:|from\s+['"](fs|path|http|https|net|os|crypto|child_process)['"]|\brequire\(|\bDate\b|Math\.random|\bfetch\(|\bprocess\.|performance\.now|\bcrypto\.|XMLHttpRequest|\blocalStorage\b|\bdocument\.|\bwindow\./;
    expect(offenders(core, impure)).toEqual([]);
  });

  it('lets core depend on nothing else in this repository', () => {
    const core = shipped.filter((path) => relative(PACKAGES, path).startsWith(join('core', 'src')));
    expect(offenders(core, /@worldsim\//)).toEqual([]);
  });

  it('lets the client take only types from core', () => {
    const client = shipped.filter((path) => relative(PACKAGES, path).startsWith(join('client', 'src')));
    const statements = client.flatMap((path) =>
      // An import statement may run over several lines.
      [...readFileSync(path, 'utf8').matchAll(/^(?:import|export)\b[^;]*?from\s+['"]@worldsim\/core['"]/gms)].map(
        (match) => `${relative(PACKAGES, path)}: ${match[0].replace(/\s+/g, ' ')}`,
      ),
    );
    expect(statements.length).toBeGreaterThan(5);
    expect(statements.filter((statement) => !/: (import|export) type\b/.test(statement))).toEqual([]);
    expect(offenders(client, /import\(\s*['"]@worldsim\/core/)).toEqual([]);
  });

  it('keeps unseeded randomness out of every package', () => {
    expect(offenders(shipped, /Math\.random|randomUUID|getRandomValues/)).toEqual([]);
  });
});
