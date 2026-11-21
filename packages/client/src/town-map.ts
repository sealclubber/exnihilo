/**
 * The town map: a layout drawn on a canvas, with pan and zoom, a scale bar,
 * lots that can be clicked, a tool that shows the walking path between two
 * lots, and the residents who can be seen: those walking as moving dots, and
 * those out of doors at a place as smaller dots that stay where they are.
 *
 * It draws what the layout format holds and nothing more: water, segments as
 * polylines of their own width, and lots as polygons. The dots are moved
 * along the trips the server sends, by the clock; nothing here plans or
 * decides where anyone goes.
 */
import type { District, Layout, LayoutPath, Lot, OutsideStay, Point, Region, Trip } from '@worldsim/core';
import { tripPosition, tripWindow } from './clock.ts';
import { describeSeen } from './town-format.ts';
import { h } from './dom.ts';
import { describePath, districtColours, fitBox, formatMetres, lotAt, scaleBar } from './town-format.ts';
import { type View, panBy, toMap, toScreen, zoomAt } from './view.ts';

const LAND = '#f4f1e8';
const WATER = '#9cc3e6';
const INK = '#23272e';
const NIGHT = 'rgba(18, 28, 60, 0.38)';
const SEGMENT_COLOURS: Record<Layout['segments'][number]['kind'], string> = {
  arterial: '#8a5a2b',
  street: '#b9b4a8',
  lane: '#d2cec3',
  bridge: '#c0392b',
};
const CLICK_SLOP = 4;
const DOT_RADIUS = 2.6;
/** People out of doors at a place are drawn smaller than walkers, in another colour. */
const OUTSIDE_RADIUS = 1.9;
/** Someone standing on a lot is picked only by a click close to them, so that the lot itself can still be clicked. */
const OUTSIDE_REACH = 4;
const OUTSIDE_INK = '#b4530a';
const OUTSIDE_INK_NIGHT = '#ffb86b';
const DOT_REACH = 8;
/** After a failed request for trips, how long to wait before asking again, in real milliseconds. */
const RETRY_AFTER = 3000;

export interface TownMap {
  /** Shows a layout, fitted to the canvas. */
  show(layout: Layout, districts: District[]): void;
  /** Shows a message in place of a map, while loading or on failure. */
  message(text: string): void;
  /** Outlines the lot of a building, or clears the outline. */
  highlight(buildingId: string | undefined): void;
  /** Keeps the map centred on a person: on their dot while they walk, otherwise on the building given. */
  follow(person: { personId: string; buildingId?: string } | undefined): void;
  /** Call when the clock has been set or its rate changed, so the trips on hand are checked afresh. */
  clockChanged(): void;
}

export interface TownMapHandlers {
  onLotClick(lot: Lot): void;
  /** Asked for the walking path between two lots. */
  findPath(fromLotId: string, toLotId: string): Promise<LayoutPath>;
  /** The game time now, if the clock is known, and its rate. */
  now(): number | undefined;
  rate(): number;
  /** Whether the sun is up at a game time. */
  isLight(time: number): boolean;
  /** Asked for the trips under way in a window of game time that pass through a region, and the stays out of doors in it. */
  loadTrips(from: number, to: number, region: Region): Promise<{ trips: Trip[]; outside: OutsideStay[] }>;
  onPersonClick(personId: string): void;
}

export function createTownMap(root: HTMLElement, handlers: TownMapHandlers): TownMap {
  const canvas = h('canvas', { attrs: { 'aria-label': 'Town map' } });
  const note = h('p', { class: 'map-note' });
  const pathButton = h('button', { attrs: { type: 'button' }, title: 'Show the shortest walking path between two lots' }, 'Path');
  const fitButton = h('button', { attrs: { type: 'button' }, title: 'Show the whole town' }, '⌂');
  const pathStatus = h('span', { class: 'path-status' });
  const streetCount = h('span', { class: 'street-count', title: 'Residents who can be seen at this moment: walking somewhere, or out of doors at a place' });
  root.replaceChildren(canvas, note, h('div', { class: 'map-tools' }, fitButton, pathButton, pathStatus), streetCount);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  /** Everything that does not move is drawn here once per change of view, then copied each frame under the dots. */
  const base = document.createElement('canvas');
  const baseCtx = base.getContext('2d') as CanvasRenderingContext2D;

  let layout: Layout | undefined;
  let districtNames = new Map<string, string>();
  /** Paths are built once per layout, in map coordinates, and redrawn under the view's transform. */
  let lotPaths: Array<{ colour: string; path: Path2D }> = [];
  let segmentPaths: Array<{ colour: string; width: number; path: Path2D }> = [];
  let lotCentres = new Map<string, Point>();
  let view: View = { scale: 1, x: 0, y: 0 };
  let fitScale = 1;
  let size = { width: 0, height: 0 };
  let highlighted: Lot | undefined;
  let path: LayoutPath | undefined;
  /** The path tool: off, or waiting for its first or second lot. */
  let picking: { from?: Lot; to?: Lot } | undefined;
  let baseStale = true;
  let looping = false;

  // The trips on hand: those of a window of game time, through a region of the map.
  let trips: { from: number; to: number; region: Region; list: Trip[]; outside: OutsideStay[] } | undefined;
  let asking = false;
  let asked = 0;
  let notBefore = 0;
  /** The dots drawn in the last frame, for finding the one under a click. */
  let dots: Array<{ personId: string; x: number; y: number; reach: number }> = [];
  let followed: { personId: string; buildingId?: string } | undefined;
  let lastTime: number | undefined;
  let lastLight: boolean | undefined;

  const trace = (target: Path2D | CanvasRenderingContext2D, points: readonly Point[], close: boolean) => {
    points.forEach(([x, y], index) => (index === 0 ? target.moveTo(x, y) : target.lineTo(x, y)));
    if (close) target.closePath();
  };

  /** Draws the town itself: everything that stays put until the view or the selection changes. */
  function drawBase(): void {
    baseStale = false;
    const ratio = window.devicePixelRatio || 1;
    const target = baseCtx;
    target.setTransform(ratio, 0, 0, ratio, 0, 0);
    target.fillStyle = LAND;
    target.fillRect(0, 0, size.width, size.height);
    if (!layout) return;

    target.setTransform(ratio * view.scale, 0, 0, ratio * view.scale, ratio * view.x, ratio * view.y);
    const px = 1 / view.scale;
    target.lineJoin = 'round';
    target.lineCap = 'butt';
    for (const water of layout.waters) {
      target.beginPath();
      if (water.kind === 'sea') {
        trace(target, water.polygon, true);
        target.fillStyle = WATER;
        target.fill();
      } else {
        trace(target, water.centreLine, false);
        target.strokeStyle = WATER;
        target.lineWidth = water.width;
        target.stroke();
      }
    }
    for (const { colour, width, path: line } of segmentPaths) {
      target.strokeStyle = colour;
      target.lineWidth = Math.max(width, px);
      target.stroke(line);
    }
    for (const { colour, path: shape } of lotPaths) {
      target.fillStyle = colour;
      target.fill(shape);
      target.strokeStyle = 'rgba(35, 39, 46, 0.45)';
      target.lineWidth = Math.min(0.5, 1.5 * px);
      target.stroke(shape);
    }

    const outline = (lot: Lot, colour: string) => {
      target.beginPath();
      trace(target, lot.polygon, true);
      target.strokeStyle = colour;
      target.lineWidth = 3 * px;
      target.stroke();
    };
    if (path) {
      target.beginPath();
      trace(target, path.points, false);
      target.strokeStyle = '#1d4ed8';
      target.lineWidth = 4 * px;
      target.lineCap = 'round';
      target.stroke();
    }
    if (highlighted) outline(highlighted, '#d92d20');
    if (picking?.from) outline(picking.from, '#1d4ed8');
    if (picking?.to) outline(picking.to, '#1d4ed8');

    // Labels and the scale bar keep their size on screen.
    target.setTransform(ratio, 0, 0, ratio, 0, 0);
    target.textBaseline = 'middle';
    target.lineJoin = 'round';
    const label = (text: string, [x, y]: Point, font: string, align: CanvasTextAlign = 'left') => {
      target.font = font;
      target.textAlign = align;
      target.lineWidth = 3;
      target.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      target.strokeText(text, x, y);
      target.fillStyle = INK;
      target.fillText(text, x, y);
    };
    if (view.scale / fitScale < 6) {
      for (const area of layout.districtAreas) {
        label(districtNames.get(area.districtId) ?? area.districtId, toScreen(view, area.labelPoint), '600 12px system-ui, sans-serif', 'center');
      }
    }
    const junctions = new Map(layout.junctions.map((junction) => [junction.id, junction]));
    for (const exit of layout.exits) {
      const junction = junctions.get(exit.junctionId);
      if (!junction) continue;
      const [x, y] = toScreen(view, junction.position);
      target.beginPath();
      target.arc(x, y, 5, 0, Math.PI * 2);
      target.fillStyle = INK;
      target.fill();
      label(`${exit.name ?? `Unnamed ${exit.kind.replace('-', ' ')}`} →`, [x + 9, y], '12px system-ui, sans-serif');
    }
    const bar = scaleBar(view.scale);
    const left = 14;
    const bottom = size.height - 16;
    target.strokeStyle = INK;
    target.lineWidth = 2;
    target.beginPath();
    target.moveTo(left, bottom - 5);
    target.lineTo(left, bottom);
    target.lineTo(left + bar.pixels, bottom);
    target.lineTo(left + bar.pixels, bottom - 5);
    target.stroke();
    label(formatMetres(bar.metres), [left + bar.pixels + 8, bottom - 2], '12px system-ui, sans-serif');
  }

  /** The part of the map in view, widened so that a little panning needs no new request. */
  const viewRegion = (widen: number): Region => {
    const [minX, minY] = toMap(view, 0, 0);
    const [maxX, maxY] = toMap(view, size.width, size.height);
    const padX = (maxX - minX) * widen;
    const padY = (maxY - minY) * widen;
    return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
  };
  const contains = (outer: Region, inner: Region) => outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;

  /** Makes sure the trips on hand cover the present moment and the part of the map in view. */
  function ensureTrips(time: number): void {
    const ahead = tripWindow(handlers.rate());
    const stale = !trips || time < trips.from || time > trips.to - ahead / 4 || !contains(trips.region, viewRegion(0));
    if (!stale || asking || performance.now() < notBefore) return;
    asking = true;
    const request = ++asked;
    const region = viewRegion(0.5);
    const from = time - 1;
    const to = time + ahead;
    handlers
      .loadTrips(from, to, region)
      .then((loaded) => {
        if (request !== asked) return;
        trips = { from, to, region, list: loaded.trips, outside: loaded.outside };
        // Draw again even if the clock is standing still.
        lastTime = undefined;
      })
      .catch(() => (notBefore = performance.now() + RETRY_AFTER))
      .finally(() => (asking = false));
  }

  function frame(): void {
    if (!layout || !root.isConnected) {
      looping = false;
      return;
    }
    requestAnimationFrame(frame);
    // Nothing to do while the map is out of sight.
    if (root.offsetParent === null || size.width === 0) return;
    const time = handlers.now();
    const light = time === undefined ? true : handlers.isLight(time);
    if (time !== undefined) ensureTrips(time);

    // Following someone: on their dot while they walk or stand outside, otherwise on the building they are in.
    let position: Point | undefined;
    if (followed && time !== undefined) {
      const walking = trips?.list.find((trip) => trip.personId === followed!.personId && time >= trip.departAt && time <= trip.arriveAt);
      const standing = walking ? undefined : trips?.outside.find((stay) => stay.personId === followed!.personId && time >= stay.from && time < stay.to);
      if (walking) {
        position = tripPosition(walking, time);
        followed.buildingId = walking.toBuildingId;
      } else if (standing) {
        position = standing.point;
        followed.buildingId = standing.buildingId;
      } else if (followed.buildingId !== undefined) {
        position = lotCentres.get(followed.buildingId);
      }
      if (position) {
        const x = size.width / 2 - position[0] * view.scale;
        const y = size.height / 2 - position[1] * view.scale;
        if (Math.abs(x - view.x) > 0.01 || Math.abs(y - view.y) > 0.01) {
          view = { scale: view.scale, x, y };
          baseStale = true;
        }
      }
    }

    if (!baseStale && time === lastTime && light === lastLight) return;
    lastTime = time;
    lastLight = light;
    if (baseStale) drawBase();
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!light) {
      ctx.fillStyle = NIGHT;
      ctx.fillRect(0, 0, size.width, size.height);
    }

    dots = [];
    if (time !== undefined && trips) {
      // Those out of doors at a place first, so that walkers pass over them.
      let standing = 0;
      ctx.fillStyle = light ? OUTSIDE_INK : OUTSIDE_INK_NIGHT;
      ctx.beginPath();
      for (const stay of trips.outside) {
        if (time < stay.from || time >= stay.to) continue;
        standing++;
        const [x, y] = toScreen(view, stay.point);
        dots.push({ personId: stay.personId, x, y, reach: OUTSIDE_REACH });
        if (x < -5 || y < -5 || x > size.width + 5 || y > size.height + 5) continue;
        ctx.moveTo(x + OUTSIDE_RADIUS, y);
        ctx.arc(x, y, OUTSIDE_RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.fillStyle = light ? INK : '#ffe9a8';
      ctx.beginPath();
      for (const trip of trips.list) {
        const at = tripPosition(trip, time);
        if (!at) continue;
        const [x, y] = toScreen(view, at);
        dots.push({ personId: trip.personId, x, y, reach: DOT_REACH });
        if (x < -5 || y < -5 || x > size.width + 5 || y > size.height + 5) continue;
        ctx.moveTo(x + DOT_RADIUS, y);
        ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();
      const whole = contains(trips.region, layout.summary.bounds);
      streetCount.textContent = describeSeen(dots.length - standing, standing, whole);
    } else {
      streetCount.textContent = '';
    }
    if (followed && position) {
      const [x, y] = toScreen(view, position);
      ctx.beginPath();
      ctx.arc(x, y, DOT_RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#d92d20';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  const redraw = () => {
    baseStale = true;
    if (!looping && layout) {
      looping = true;
      requestAnimationFrame(frame);
    }
  };

  function fit(): void {
    if (!layout) return;
    view = fitBox(layout.summary.bounds, size.width, size.height);
    fitScale = view.scale;
    redraw();
  }

  function resize(): void {
    const ratio = window.devicePixelRatio || 1;
    const wasFitted = size.width === 0 || view.scale === fitScale;
    size = { width: root.clientWidth, height: root.clientHeight };
    for (const surface of [canvas, base]) {
      surface.width = Math.round(size.width * ratio);
      surface.height = Math.round(size.height * ratio);
    }
    if (layout && wasFitted) fit();
    else redraw();
  }

  function showPathStatus(text: string): void {
    pathStatus.textContent = text;
    pathButton.classList.toggle('active', picking !== undefined);
    pathButton.textContent = picking ? 'Done' : 'Path';
  }

  async function pick(lot: Lot): Promise<void> {
    if (!picking) return;
    if (!picking.from || picking.to) {
      picking = { from: lot };
      path = undefined;
      showPathStatus('Now pick the lot to walk to.');
      redraw();
      return;
    }
    picking.to = lot;
    redraw();
    const chosen = picking;
    try {
      const found = await handlers.findPath(chosen.from!.id, lot.id);
      if (picking !== chosen) return;
      path = found;
      showPathStatus(`${describePath(found)}. Pick another lot to start again.`);
    } catch (error) {
      if (picking === chosen) showPathStatus((error as Error).message);
    }
    redraw();
  }

  pathButton.addEventListener('click', () => {
    picking = picking ? undefined : {};
    path = undefined;
    showPathStatus(picking ? 'Pick the lot to walk from.' : '');
    redraw();
  });
  fitButton.addEventListener('click', () => {
    followed = undefined;
    fit();
  });

  let drag: { pointerId: number; lastX: number; lastY: number; travelled: number } | undefined;
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { pointerId: event.pointerId, lastX: event.offsetX, lastY: event.offsetY, travelled: 0 };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.offsetX - drag.lastX;
    const dy = event.offsetY - drag.lastY;
    drag.travelled += Math.abs(dx) + Math.abs(dy);
    drag.lastX = event.offsetX;
    drag.lastY = event.offsetY;
    if (drag.travelled > CLICK_SLOP) {
      view = panBy(view, dx, dy);
      redraw();
    }
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const wasClick = drag.travelled <= CLICK_SLOP;
    drag = undefined;
    if (!wasClick || !layout) return;
    // A person on the street is picked before the lot behind them.
    if (!picking) {
      let nearest: { personId: string; away: number } | undefined;
      for (const dot of dots) {
        const away = Math.hypot(dot.x - event.offsetX, dot.y - event.offsetY);
        if (away <= dot.reach && (!nearest || away < nearest.away)) nearest = { personId: dot.personId, away };
      }
      if (nearest) return handlers.onPersonClick(nearest.personId);
    }
    const lot = lotAt(layout.lots, toMap(view, event.offsetX, event.offsetY));
    if (!lot) return;
    if (picking) void pick(lot);
    else handlers.onLotClick(lot);
  });
  canvas.addEventListener('pointercancel', () => (drag = undefined));
  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015));
      view = zoomAt(view, event.offsetX, event.offsetY, factor, { min: fitScale * 0.5, max: fitScale * 80 });
      redraw();
    },
    { passive: false },
  );
  new ResizeObserver(resize).observe(root);

  return {
    show(next, districts) {
      layout = next;
      note.hidden = true;
      highlighted = undefined;
      path = undefined;
      picking = undefined;
      followed = undefined;
      trips = undefined;
      asked++;
      dots = [];
      showPathStatus('');
      districtNames = new Map(districts.map((district) => [district.id, district.name]));
      const colours = districtColours(districts.map((district) => district.id));
      const byColour = new Map<string, Path2D>();
      lotCentres = new Map();
      for (const lot of next.lots) {
        const colour = colours.get(lot.districtId) ?? '#dddddd';
        let shape = byColour.get(colour);
        if (!shape) byColour.set(colour, (shape = new Path2D()));
        trace(shape, lot.polygon, true);
        const sum = lot.polygon.reduce((total, point) => [total[0] + point[0], total[1] + point[1]] as Point, [0, 0] as Point);
        lotCentres.set(lot.buildingId, [sum[0] / lot.polygon.length, sum[1] / lot.polygon.length]);
      }
      lotPaths = [...byColour].map(([colour, shape]) => ({ colour, path: shape }));
      // Segments are grouped by colour and width, the widest kinds drawn last so they lie on top.
      const byStyle = new Map<string, { colour: string; width: number; path: Path2D }>();
      for (const segment of next.segments) {
        const key = `${segment.kind}:${segment.width}`;
        let style = byStyle.get(key);
        if (!style) byStyle.set(key, (style = { colour: SEGMENT_COLOURS[segment.kind], width: segment.width, path: new Path2D() }));
        trace(style.path, segment.points, false);
      }
      segmentPaths = [...byStyle.values()].sort((a, b) => a.width - b.width);
      size = { width: 0, height: 0 };
      resize();
    },
    message(text) {
      layout = undefined;
      trips = undefined;
      asked++;
      dots = [];
      streetCount.textContent = '';
      note.hidden = false;
      note.textContent = text;
      baseStale = true;
      // Clear what was drawn, unless the map is out of sight and has no size to draw at.
      if (base.width > 0 && base.height > 0) {
        drawBase();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(base, 0, 0);
      }
    },
    highlight(buildingId) {
      highlighted = buildingId === undefined ? undefined : layout?.lots.find((lot) => lot.buildingId === buildingId);
      redraw();
    },
    follow(person) {
      followed = person ? { ...person } : undefined;
      redraw();
    },
    clockChanged() {
      // A jump in time or a new rate may leave the trips on hand covering the wrong window.
      const time = handlers.now();
      if (trips && time !== undefined && (time < trips.from || time > trips.to)) trips = undefined;
      lastTime = undefined;
    },
  };
}
