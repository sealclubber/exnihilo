/**
 * Builds the API's response bodies from a world. Pure: no storage, no HTTP.
 */
import type { ImportReport, MapGeometry, Point, SettlementListItem, World, WorldSummary } from '@worldsim/core';

export function worldSummary(world: World, report: ImportReport): WorldSummary {
  return { info: world.info, counts: report.counts };
}

export function settlementList(world: World): SettlementListItem[] {
  return world.settlements.map((brief) => ({
    id: brief.id,
    name: brief.name,
    position: brief.position,
    sizeGroup: brief.sizeGroup,
    isCapital: brief.flags.capital,
    population: brief.population,
    stateId: brief.state.id,
  }));
}

export function mapGeometry(world: World): MapGeometry {
  const centres = new Map<string, Point>(world.cells.map((cell) => [cell.id, cell.center]));
  return {
    width: world.info.width,
    height: world.info.height,
    cells: world.cells.map((cell) => ({
      id: cell.id,
      polygon: cell.polygon,
      isLand: cell.isLand,
      stateId: cell.stateId,
    })),
    states: world.states.map((state) => ({
      id: state.id,
      name: state.name,
      ...(state.colour !== undefined && { colour: state.colour }),
      isPlaceholder: state.isPlaceholder,
    })),
    rivers: world.rivers.map((river) => ({
      id: river.id,
      name: river.name,
      points: river.cellIds.map((id) => centres.get(id) as Point),
    })),
    routes: world.routes.map((route) => ({
      id: route.id,
      kind: route.kind,
      points: route.points.map((point) => point.position),
    })),
    settlements: settlementList(world),
  };
}
