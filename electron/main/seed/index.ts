import { dirname, join } from 'node:path';

import { app } from 'electron';

import { configPath } from '../config/paths';

import { SEED_MANIFEST_FILE, shippedRoot } from './paths';
import { seedShipped, type SeedReport } from './seed';

/**
 * Seed the shipped skills and agents into `~/.hive` (HIVE-162).
 *
 * The composition: `seed.ts` knows nothing about Electron or where the config
 * lives, and this file knows nothing else. `ipc/index.ts` calls it once, at
 * registration, and hands the promise to the skills runtime so the first
 * plugin regeneration waits for it. The agents registry needs no such hand:
 * it watches its folder, and a definition the seed writes reaches it the way
 * a hand-written one does.
 *
 * `fromDir` is a parameter for the reason `trayIconPath`'s is: under vitest
 * `import.meta.dirname` is this source folder, not `out/main/`, and the test
 * has to name the tree it means.
 *
 * Never fatal. A `~/.hive` the app cannot write is a `~/.hive` the rest of the
 * app is about to complain about in its own words; a seed that failed costs
 * the shipped skills until the next launch, and says so on the console.
 */
export async function seedShippedIntoHive(
  fromDir: string = import.meta.dirname,
): Promise<SeedReport | null> {
  const target = dirname(configPath());
  try {
    const report = await seedShipped({
      source: shippedRoot(app.isPackaged, process.resourcesPath, fromDir),
      target,
      manifestFile: join(target, SEED_MANIFEST_FILE),
    });
    const changed = report.created.length + report.upgraded.length;
    if (changed > 0 || report.skipped.length > 0) {
      console.info(
        `[hive] seeded ${report.created.length} new and ${report.upgraded.length} updated shipped file(s) into ${target}` +
          (report.skipped.length > 0
            ? `; left alone (symlinked): ${report.skipped.join(', ')}`
            : ''),
      );
    }
    return report;
  } catch (cause) {
    console.info(
      `[hive] the shipped skills and agents could not be seeded into ${target} (${String(cause)})`,
    );
    return null;
  }
}
