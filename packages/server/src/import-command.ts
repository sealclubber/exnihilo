/**
 * The import command: reads a map-generator export from disk, runs the pure
 * importer from core, and stores the result.
 */
import { readFileSync } from 'node:fs';
import { type ImportReport, importAfmg } from '@worldsim/core';
import { WorldStore } from './storage.ts';

export function importFile(exportPath: string, storePath: string): ImportReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(exportPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${exportPath}: ${(error as Error).message}`);
  }
  const { world, report } = importAfmg(parsed);
  const store = new WorldStore(storePath);
  try {
    store.save(world, report);
  } finally {
    store.close();
  }
  return report;
}

export function formatReport(report: ImportReport): string {
  const lines = [`Imported from ${report.source.tool} ${report.source.version}`, ''];
  for (const [kind, count] of Object.entries(report.counts)) {
    lines.push(`  ${kind.padEnd(12)}${String(count).padStart(6)}`);
  }
  lines.push('', report.warnings.length === 0 ? 'No warnings.' : `Warnings (${report.warnings.length}):`);
  for (const warning of report.warnings) {
    lines.push(`  [${warning.code}] ${warning.entity} ${warning.message}`);
  }
  if (report.ignoredSections.length > 0) {
    lines.push('', `Not read: ${report.ignoredSections.join(', ')}`);
  }
  return lines.join('\n');
}
