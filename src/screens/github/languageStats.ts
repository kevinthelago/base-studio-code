// Language-mix aggregation for the GitHub summary's Languages card.
//
// The summary samples only the N most-recently-updated repos (see SUMMARY_REPO_SAMPLE
// in GitHubSummary.tsx) and sums their `/languages` byte counts. This pure helper does
// the aggregation and — unlike the old inline code, which mislabeled the language count
// as a repo count — reports how many sampled repos actually contributed language data.

/** Just the language-byte slice of a repo's fetched data. */
export interface RepoLangData {
  langBytes: Record<string, number>;
}

export interface LanguageStats {
  /** Total bytes per language, summed across the contributing repos. */
  totals: Record<string, number>;
  /** How many of the sampled repos actually contributed language data. */
  repoCount: number;
}

/**
 * Aggregate per-repo language byte counts into a single mix. Repos with no detected
 * language (an empty `langBytes`) are skipped and not counted toward `repoCount`.
 */
export function languageStats(repoData: Record<string, RepoLangData>): LanguageStats {
  const totals: Record<string, number> = {};
  let repoCount = 0;
  for (const rd of Object.values(repoData)) {
    const langs = Object.entries(rd?.langBytes ?? {});
    if (langs.length === 0) continue;
    repoCount += 1;
    for (const [lang, bytes] of langs) {
      totals[lang] = (totals[lang] ?? 0) + bytes;
    }
  }
  return { totals, repoCount };
}
