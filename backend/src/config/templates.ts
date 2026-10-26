import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * The repo's templates/ directory, or null when the build has none.
 *
 * Found by walking up from this module instead of a fixed number of `..`.
 * tsup bundles the backend into dist/index.js, so in the image the code sits
 * one level shallower than in src/: a fixed `../../../templates` that works in
 * dev resolves to /templates in production, and every template was silently
 * skipped there.
 */
export function findTemplatesDir(start = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, 'templates');
    if (existsSync(join(candidate, 'skills'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
