// The console PROVIDER surface — public API only. The built-in set is seeded by `./registry`, the
// module that owns the map, so this barrel has NO import-time side effect and can be a record
// (providers-register-in-the-registry-that-owns-them).
export type { ConsoleProvider, ProviderLaunchConfig } from "@/app/console/lib/providers/types";
export { registerProvider, getProvider, listProviders } from "./registry";
