/** Where the world file lives unless WORLDSIM_DB or a flag says otherwise. */
export const DEFAULT_STORE_PATH = 'data/world.sqlite';

export function storePathFromEnv(): string {
  return process.env.WORLDSIM_DB || DEFAULT_STORE_PATH;
}
