# World Sim

A persistent world explored from a world map down to a street. This repository
holds Phase 1: an importer that turns an Azgaar's Fantasy Map Generator (AFMG)
export into our own world format, a server that stores and serves it, and a
browser viewer with a map and a brief for every settlement.

The brief for this work is [worldsim-phase1-gameplan.md](worldsim-phase1-gameplan.md).

## Packages

| Package | Holds |
| --- | --- |
| `packages/core` | The world format (Zod schemas and types), the seed utility, and the AFMG importer. Pure code. |
| `packages/server` | SQLite storage, the import command, and the HTTP API. |
| `packages/client` | The browser viewer. Uses `core` for types only. |

Only `packages/core/src/afmg` knows AFMG's structure. Everything else reads the
world format.

## Install

Needs Node.js 24 or newer (developed on 26 LTS). TypeScript is run directly by
Node, so there is no build step for the server.

```sh
npm install
```

## Import Lomia

```sh
npm run import -- fixtures/afmg/lomia.json
```

This writes the world to `data/world.sqlite` and prints the import report:
what was imported, any warnings, and the parts of the export that were not
read. Importing again replaces the stored world. To store it elsewhere, add
`--db path/to/world.sqlite` or set `WORLDSIM_DB`.

## Start the server

```sh
npm run server
```

The API listens on port 3001 on every network interface. Set `PORT`, `HOST`
or `WORLDSIM_DB` to change that.

| Request | Returns |
| --- | --- |
| `GET /api/world` | The world summary: name, year, era, map size, entity counts |
| `GET /api/map` | The map geometry: cells, states, rivers, routes, settlement markers |
| `GET /api/settlements` | The list of settlements |
| `GET /api/settlements/settlement-641` | One settlement's brief |

## Open the viewer

In a second terminal on the same machine as the server:

```sh
npm run client
```

Then open `http://<that machine>:5173` in a browser, which may be on another
machine. Drag to pan, scroll to zoom, and click a settlement to see its brief.
Badanos is at `http://<that machine>:5173/#settlement-641`.

The viewer looks for the API on port 3001 of the host it was loaded from. If
the server is somewhere else, say where when starting the viewer:

```sh
VITE_API_URL=http://192.168.1.20:3001 npm run client
```

The viewer's development server answers requests made to `localhost` or an IP
address. To reach it by a host name, list that name in `server.allowedHosts`
in `packages/client/vite.config.ts`.

## Tests

```sh
npm test            # every test in every package
npm run typecheck   # strict TypeScript across packages and tests
npm run check       # both
```

The acceptance tests in the gameplan run against the Lomia fixture and live in
`packages/core/test/importer.test.ts`, with the storage, API and viewer tests
beside their packages.
