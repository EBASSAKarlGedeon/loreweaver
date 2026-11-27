import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Source root of the optional RPG Engine clone. */
export const RPG_ENGINE_SOURCE = path.resolve(here, '../../public/scripts/extensions/rpg-engine/rpg-engine-port/rpg-engine/app/src/scripts');

/** True when the standalone RPG Engine clone is present. */
export const HAS_RPG_ENGINE = fs.existsSync(path.join(RPG_ENGINE_SOURCE, 'lorebook.js'));

/**
 * Import a module from the optional RPG Engine clone.
 * @param {string} relativePath Path under app/src/scripts, e.g. 'lorebook.js'
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadRpgEngine(relativePath) {
    return import(pathToFileURL(path.join(RPG_ENGINE_SOURCE, relativePath)).href);
}
