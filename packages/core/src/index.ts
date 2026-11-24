export * from './schema.ts';
export * from './api.ts';
export { makeId, idNumber, byIdNumber } from './ids.ts';
export { bearing } from './geometry.ts';
export { deriveSeed } from './seed.ts';
export { findDanglingReferences } from './references.ts';
export { importAfmg, AfmgImportError, type ImportResult } from './afmg/importer.ts';
export * from './pack/schema.ts';
export * from './city/records.ts';
export {
  generateCity,
  conditionsOf,
  speciesOf,
  resolveCount,
  CityGenerationError,
  GENERATOR_VERSION,
  type GenerateOptions,
} from './city/generate.ts';
export { checkCity, WORKFORCE_SHARE_LIMITS } from './city/invariants.ts';
export { nameBaseNames, type NameGenerator, type NameGeneratorFactory } from './city/names.ts';
export { createRng, stepRng, apportion, shuffle, weightedPicker, type Rng } from './city/random.ts';
export { describeCity, packLabels } from './city/report.ts';
export * from './layout/records.ts';
export * as geometry from './layout/geometry.ts';
export { checkLayout, distanceToWater, gapToRiver, BEARING_TOLERANCE } from './layout/invariants.ts';
export { ringShare, riverOutline, riverWidthAt } from './layout/measure.ts';
export { generateGridLayout, LayoutGenerationError, GRID_GENERATOR, type LayoutOptions } from './layout/grid.ts';
export { generateStagedLayout, STAGED_GENERATOR, type Pin, type StagedOptions } from './layout/staged/layout.ts';
export { generateLayout } from './layout/generate.ts';
export { renderLayoutSvg, type RenderOptions } from './layout/render.ts';
export { createPathFinder, shortestPath, LayoutPathError, type PathFinder } from './layout/path.ts';
export * from './life/records.ts';
export * from './life/calendar.ts';
export { createLife, walkingSpeed, tripDuration, dutyCount, restDaysUpTo, LifeError, type LifeInputs, type SettlementLife } from './life/life.ts';
export { createWorkingHours, type WorkingHours } from './life/hours.ts';
export { positionOnWander, clipWander, groundOf, makeWander, type Ground, type WanderHabit } from './life/wander.ts';
export { createPlanChecker, type PlanChecker } from './life/invariants.ts';
export { describeDay } from './life/report.ts';
export { drawOf, arrivalRate, expectedTravellers, type Draw, type DrawTerm } from './outsiders/draw.ts';
export * from './outsiders/records.ts';
export { createOutsiders, sleepingPlacesAt, OutsidersError, type Outsiders, type OutsidersInputs } from './outsiders/outsiders.ts';
export { createOutsiderChecker, type OutsiderChecker } from './outsiders/invariants.ts';
export * from './avatar/records.ts';
export {
  AvatarError,
  arrivalTime,
  avatarPosition,
  avatarTown,
  leave as leaveBuilding,
  perceive,
  settle as settleAvatar,
  spawn as spawnAvatar,
  stop as stopAvatar,
  walkToBuilding,
  walkToPoint,
  type AvatarTown,
  type Perception,
} from './avatar/avatar.ts';
