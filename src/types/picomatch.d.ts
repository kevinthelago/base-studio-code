// `picomatch` ships no type declarations, and it arrives as a transitive dependency (vite → chokidar),
// so there is no `@types/*` to add without taking on a direct dependency for one test.
//
// It is used in exactly one place — `devWatchIgnore.test.ts` — to assert the dev server's watch-ignore
// patterns against real glob semantics. Matching them with a hand-rolled regex instead would test the
// regex rather than the globs, which is the one thing that must not happen: the patterns exist to be
// evaluated by chokidar's matcher, and picomatch IS that matcher.
declare module "picomatch" {
  interface PicomatchOptions {
    /** Match `.`-prefixed segments. Default false — deliberately left at the default in the test, since
     *  the stricter model proves the patterns hold either way. */
    dot?: boolean;
  }
  /** Compile one or more globs into a predicate over a path. */
  function picomatch(glob: string | string[], options?: PicomatchOptions): (path: string) => boolean;
  export default picomatch;
}
