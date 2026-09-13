import { describe, it, expect } from 'vitest';
// The MERGED store loader — the committed store is a DATABASE, resolved through `graph/store.toml`
// rather than spelled, so this guard cannot quietly read an empty file and report a clean tree.
import { loadStore, resolveStorePath } from './lib/recordStore.mjs';

/**
 * EVERY `bsc` reader of the RUNNING APP's persisted state must resolve it the way tauri-plugin-store
 * writes it — `BaseDirectory::AppData`, the app-DATA dir, on every platform (request 310).
 *
 * The bug this exists to stop happening a fourth time: `bsc ui` resolved `app-state.json` under the
 * CONFIG dir. On Linux — the only platform where config and data differ — that directory did not exist
 * at all, while the live file sat in the data dir at 178 KB. So `bsc ui theme active` reported its
 * `default` FALLBACK, and looked correct only because the live `kitTheme` happened to be `default`.
 *
 * This is a rule over the WHOLE tree rather than one crate's test, because the resolution is COPIED:
 * three crates each compose the path themselves, and a Rust test can only ever see its own. Two halves
 * are asserted — WHO resolves app-state (so a fourth copy has to be looked at, not merely added), and
 * that none of them consults a config dir.
 */
const APP_STATE = 'app-state.json';

/** The records allowed to compose an app-state path, each checked below. A new one is not a failure to
 *  paper over — it is a copy of this rule that a human should see before it lands. */
const KNOWN_RESOLVERS = [
  'bsc-ui--cli.rs', // `bsc ui theme active` / `changes` / `adopt`
  'bsc-session--launch-plan--sources.rs', // the launch's user-settings + credential fallback
  'bsc-publish--token.rs', // a headless publish's last-resort GitHub token
];

/** A config-dir resolution, in every spelling that reaches one. `AppConfig` is Tauri's own. */
const CONFIG_DIR_TOKENS = ['XDG_CONFIG_HOME', 'config_dir', 'AppConfig', 'BaseDirectory::AppConfig', '".config"', "'.config'"];

/**
 * The PRODUCTION half of a record — everything before its `#[cfg(test)]` module.
 *
 * Tests legitimately mention a config dir: `bsc-ui--cli.rs` builds a config-dir DECOY and proves it is
 * never preferred, which is the strongest evidence there is and must not be what trips this guard.
 */
function productionPart(code: string): string {
  const marker = code.search(/#\[cfg\(test\)\]/);
  return marker === -1 ? code : code.slice(0, marker);
}

/** Does this text COMPOSE an app-state path (as opposed to merely naming the file in prose)? */
function composesAppStatePath(text: string): boolean {
  return /join\(\s*"app-state\.json"\s*\)/.test(text) || /join\(\s*APP_STATE_FILE\s*\)/.test(text);
}

describe('app-state resolution (request 310)', () => {
  const records: any[] = loadStore(resolveStorePath()).implementations;

  it('is composed by exactly the records that are supposed to compose it', () => {
    // A floor first: a loader that returned nothing would pass every assertion below by vacuity, and
    // "the guard stopped matching" reads exactly like "the tree is clean".
    expect(records.length).toBeGreaterThan(100);

    const resolvers = records
      .filter((r) => typeof r.code === 'string' && composesAppStatePath(productionPart(r.code)))
      .map((r) => r.id)
      .sort();
    expect(resolvers).toEqual([...KNOWN_RESOLVERS].sort());
  });

  it('never resolves the app-state through a CONFIG dir', () => {
    for (const id of KNOWN_RESOLVERS) {
      const rec = records.find((r) => r.id === id);
      expect(rec, `${id} is missing from the store`).toBeTruthy();
      const code = productionPart(rec.code as string);
      expect(code.includes(APP_STATE), `${id} should still resolve ${APP_STATE}`).toBe(true);
      for (const token of CONFIG_DIR_TOKENS) {
        expect(
          code.includes(token),
          `${id} resolves app-state through ${token} — tauri-plugin-store writes it under BaseDirectory::AppData on every platform, so a config-dir path is either dead or, worse, WINS over the live file`,
        ).toBe(false);
      }
    }
  });
});
