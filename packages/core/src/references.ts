import type { World } from './schema.ts';

/**
 * Finds every ID that an entity refers to but that does not exist in the
 * world. Returns one line per problem; an empty list means the world is
 * internally consistent.
 */
export function findDanglingReferences(world: World): string[] {
  const known = new Set<string>();
  for (const list of [
    world.cells,
    world.states,
    world.provinces,
    world.cultures,
    world.religions,
    world.rivers,
    world.routes,
    world.settlements,
  ]) {
    for (const entity of list) known.add(entity.id);
  }

  const problems: string[] = [];
  const check = (owner: string, field: string, id: string | undefined) => {
    if (id !== undefined && !known.has(id)) {
      problems.push(`${owner}: ${field} refers to ${id}, which does not exist`);
    }
  };

  for (const cell of world.cells) {
    for (const id of cell.neighbourIds) check(cell.id, 'neighbourIds', id);
    check(cell.id, 'riverId', cell.riverId);
    check(cell.id, 'stateId', cell.stateId);
    check(cell.id, 'provinceId', cell.provinceId);
    check(cell.id, 'cultureId', cell.cultureId);
    check(cell.id, 'religionId', cell.religionId);
  }
  for (const state of world.states) {
    check(state.id, 'capitalSettlementId', state.capitalSettlementId);
    for (const id of state.neighbourIds) check(state.id, 'neighbourIds', id);
    for (const id of Object.keys(state.diplomacy)) check(state.id, 'diplomacy', id);
    for (const war of state.wars) {
      check(state.id, `wars "${war.name}" attackerId`, war.attackerId);
      check(state.id, `wars "${war.name}" defenderId`, war.defenderId);
    }
  }
  for (const province of world.provinces) {
    check(province.id, 'stateId', province.stateId);
    check(province.id, 'seatSettlementId', province.seatSettlementId);
  }
  for (const culture of world.cultures) {
    for (const id of culture.originCultureIds) check(culture.id, 'originCultureIds', id);
  }
  for (const religion of world.religions) {
    for (const id of religion.originReligionIds) check(religion.id, 'originReligionIds', id);
  }
  for (const river of world.rivers) {
    for (const id of river.cellIds) check(river.id, 'cellIds', id);
    check(river.id, 'parentRiverId', river.parentRiverId);
  }
  for (const route of world.routes) {
    for (const point of route.points) check(route.id, 'points', point.cellId);
  }
  for (const brief of world.settlements) {
    check(brief.id, 'cellId', brief.cellId);
    check(brief.id, 'state', brief.state.id);
    check(brief.id, 'province', brief.province?.id);
    check(brief.id, 'culture', brief.culture.id);
    check(brief.id, 'religion', brief.religion.id);
    check(brief.id, 'river', brief.river?.id);
    check(brief.id, 'river.arrivesFrom', brief.river?.arrivesFrom?.cellId);
    check(brief.id, 'river.leavesToward', brief.river?.leavesToward?.cellId);
    for (const exit of brief.routes) {
      check(brief.id, 'routes', exit.routeId);
      check(brief.id, 'routes', exit.towardCellId);
    }
  }
  return problems;
}
