// Performance-monitoring config (#569). Split from the former store/types monolith (#1634).
export interface PerfConfig {
  enabled: boolean;
  /** Sampling cadence in seconds (0 = off). */
  intervalSecs: number;
  /** Retain samples for N hours (0 = unlimited). */
  retentionHours: number;
  /** Max SQLite DB size in MB (0 = no limit). */
  maxDbMb: number;
  trackProcess: boolean;
  trackFrontend: boolean;
}

export const DEFAULT_PERF_CONFIG: PerfConfig = {
  enabled: true,
  intervalSecs: 2,
  retentionHours: 24,
  maxDbMb: 50,
  trackProcess: true,
  trackFrontend: true,
};
