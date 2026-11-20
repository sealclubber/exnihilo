/** Where the world file lives unless WORLDSIM_DB or a flag says otherwise. */
export const DEFAULT_STORE_PATH = 'data/world.sqlite';

/** The setting pack used unless WORLDSIM_PACK or a flag says otherwise. */
export const DEFAULT_PACK_PATH = 'packs/medieval';

/** Where the generate command writes unless told otherwise. */
export const DEFAULT_CITIES_FOLDER = 'data/cities';

export function storePathFromEnv(): string {
  return process.env.WORLDSIM_DB || DEFAULT_STORE_PATH;
}

export function packPathFromEnv(): string {
  return process.env.WORLDSIM_PACK || DEFAULT_PACK_PATH;
}
