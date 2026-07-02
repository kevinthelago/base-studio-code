// Cross-repo activity feed — recent mapped events across all connected repos (#1644).
// A thin wrapper over the shared <ActivityFeed>; only the hint, filter, and column width differ.

import { ActivityFeed } from "@/shared/ui/data/ActivityFeed";
import { EVENT_TONE, type CrossRepoEvent } from "../lib/githubSummary";

export function CrossRepoActivity({ events, loading }: {
  events: CrossRepoEvent[];
  loading: boolean;
}) {
  return (
    <ActivityFeed
      items={events}
      hint="across all connected repos"
      loading={loading}
      tone={EVENT_TONE}
      actionWidth={70}
      right={
        // eslint-disable-next-line no-restricted-syntax -- uncontrolled decorative filter select (no value/onChange) in a toolbar right slot; SelectField requires value/onChange + would change layout
        <select className="input" style={{ height: 24, width: 100, fontSize: 10.5 }}>
          <option>all events</option><option>PRs only</option><option>commits</option>
        </select>
      }
    />
  );
}
