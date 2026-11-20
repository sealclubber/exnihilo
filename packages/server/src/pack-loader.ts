/**
 * Reads a setting pack from a folder of YAML files, one per part of the pack,
 * and hands the parsed content to core for checking.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type SettingPack, PACK_FILES, PackError, parsePack } from '@worldsim/core';

/** Reads the YAML files of a pack without checking what they hold. */
export function readPackFiles(folder: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const file of PACK_FILES) {
    const path = join(folder, `${file}.yaml`);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new PackError([`${path} cannot be read; a pack needs the files ${PACK_FILES.map((name) => `${name}.yaml`).join(', ')}`]);
    }
    try {
      raw[file] = parse(text);
    } catch (error) {
      throw new PackError([`${path} is not valid YAML: ${(error as Error).message}`]);
    }
  }
  return raw;
}

export function loadPack(folder: string): SettingPack {
  return parsePack(readPackFiles(folder));
}
