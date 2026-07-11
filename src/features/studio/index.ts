// Public API of the studio feature (#2889) — a Studio is the top-level shareable bundle: a
// self-contained snapshot of the app's library state (teams · personas · components · variants ·
// themes · blueprints). Slice #2891 adds gist export/import over the shared extension-manifest
// envelope, mirroring blueprints + component-kits. Cross-feature, import ONLY through this barrel.
export {
  STUDIO_KIND,
  studioToManifest,
  manifestToStudio,
  exportStudioToGist,
  importStudioFromGist,
  type Studio,
} from "./lib/studioGist";
