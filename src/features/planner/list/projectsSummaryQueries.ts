// GraphQL queries backing the Portfolio summary (ProjectsSummary.tsx). Kept as TS
// string constants so the data hook can pass them straight to `githubGraphql`.

/** Viewer's Projects V2 with item counts + linked repos — the portfolio overview. */
export const PROJECTS_SUMMARY_QUERY = `{
  viewer {
    projectsV2(first: 20) {
      nodes {
        id number title shortDescription closed updatedAt
        items { totalCount }
        repositories(first: 5) { nodes { nameWithOwner } }
      }
    }
  }
}`;
