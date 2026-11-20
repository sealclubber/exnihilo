/**
 * The generate command: makes one settlement's city from the stored world and
 * a setting pack, and writes its records and a readable summary to disk.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type City, describeCity, generateCity } from '@worldsim/core';
import { loadPack } from './pack-loader.ts';
import { WorldStore } from './storage.ts';

export interface GenerateRequest {
  settlementId: string;
  storePath: string;
  packPath: string;
  outFolder: string;
  seed?: number;
}

export interface GenerateResult {
  city: City;
  summaryText: string;
  recordsPath: string;
  summaryPath: string;
}

/** The records as JSON with one record per line, so that two runs can be compared with ordinary tools. */
export function cityToJson(city: City): string {
  const list = (records: unknown[]) => `[\n${records.map((record) => `    ${JSON.stringify(record)}`).join(',\n')}\n  ]`;
  return [
    '{',
    `  "summary": ${JSON.stringify(city.summary)},`,
    `  "districts": ${list(city.districts)},`,
    `  "buildings": ${list(city.buildings)},`,
    `  "households": ${list(city.households)},`,
    `  "people": ${list(city.people)}`,
    '}',
    '',
  ].join('\n');
}

export function generateToDisk(request: GenerateRequest): GenerateResult {
  const pack = loadPack(request.packPath);
  const store = new WorldStore(request.storePath);
  let world;
  try {
    world = store.loadWorld();
  } finally {
    store.close();
  }
  const brief = world.settlements.find((entry) => entry.id === request.settlementId);
  if (!brief) {
    throw new Error(`no settlement has the ID "${request.settlementId}"; IDs look like settlement-641`);
  }

  const city = generateCity(brief, pack, request.seed === undefined ? {} : { seed: request.seed });
  const summaryText = describeCity(city, pack);
  const folder = join(request.outFolder, brief.id);
  mkdirSync(folder, { recursive: true });
  const recordsPath = join(folder, 'city.json');
  const summaryPath = join(folder, 'summary.txt');
  writeFileSync(recordsPath, cityToJson(city));
  writeFileSync(summaryPath, summaryText);
  return { city, summaryText, recordsPath, summaryPath };
}
