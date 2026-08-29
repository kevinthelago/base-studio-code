// GitHub value types shared across the store (connection STATE lives in the GitHub feature
// slice, @/features/github/store). Split from the former store/types monolith (#1634).
export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface GithubRepo {
  full_name: string;
  private: boolean;
  language: string | null;
  open_issues_count: number;
  default_branch: string;
  description: string | null;
  pushed_at: string;
  stargazers_count: number;
}

/**
 * The fields above, as VALUES — because the interface does nothing at runtime.
 *
 * GitHub's repo response carries 82 fields; this type names 8. Annotating the response as
 * `GithubRepo` narrows what the compiler will let you *read*, and strips exactly nothing from what you
 * *store* — so the whole payload went into the store, and 61% of its bytes are `*_url` templates
 * (`archive_url`, `assignees_url`, `blobs_url`, …) that nothing reads. Measured on a real install: 84
 * repos at ~6 KB each, 493.8 KB, which was 86% of the entire persisted state.
 *
 * That is a CPU cost before it is a memory one. `persist`'s `partialize` result is `JSON.stringify`'d
 * on EVERY store `set()` — the module doc in `store/persist.ts` says so, and says a large one freezes
 * the app, citing #3610 where `components` (592 KB) did exactly that. This list is what keeps the same
 * blob from sitting in the same allowlist.
 */
export const GITHUB_REPO_FIELDS = [
  "full_name",
  "private",
  "language",
  "open_issues_count",
  "default_branch",
  "description",
  "pushed_at",
  "stargazers_count",
] as const;

// The list and the interface must agree in BOTH directions, checked by tsc rather than by a test:
// a field added to one and not the other is either silently dropped at runtime (interface-only) or a
// type error waiting at the first read (list-only). Neither shows up in a test that only feeds a
// fixture through, which is why this is a compile-time check.
type ListedField = (typeof GITHUB_REPO_FIELDS)[number];
type _EveryListedFieldIsDeclared = ListedField extends keyof GithubRepo ? true : never;
type _EveryDeclaredFieldIsListed = keyof GithubRepo extends ListedField ? true : never;
const _fieldsAgree: [_EveryListedFieldIsDeclared, _EveryDeclaredFieldIsListed] = [true, true];
void _fieldsAgree;

/**
 * Keep only the declared fields of a raw GitHub repo response.
 *
 * Takes `unknown`-ish input deliberately: the whole point is that the caller has an API object which
 * is NOT a `GithubRepo` no matter what its annotation claims, and pretending otherwise is how the
 * extra 74 fields got in.
 */
export function leanRepo(raw: Record<string, unknown>): GithubRepo {
  const out = {} as Record<string, unknown>;
  for (const f of GITHUB_REPO_FIELDS) out[f] = raw[f];
  return out as unknown as GithubRepo;
}

/** {@link leanRepo} over a list — what every caller actually has. */
export function leanRepos(raw: readonly Record<string, unknown>[]): GithubRepo[] {
  return raw.map(leanRepo);
}
