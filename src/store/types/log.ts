// Text-log retention config (#1060). Split from the former store/types monolith (#1634).
/** Retention for the text log streams (#1060). 0 disables a cap. */
export interface LogConfig {
  /** Trim a text log to its newest N lines on enforcement. 0 = no line cap. */
  maxLines: number;
  /** Trim a text log to its newest bytes if it exceeds this many MB. 0 = no size cap. */
  maxSizeMb: number;
}

export const DEFAULT_LOG_CONFIG: LogConfig = {
  maxLines: 10_000,
  maxSizeMb: 20,
};
