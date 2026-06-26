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

// Fetches one project's Iteration + Status fields and items (with close times) so
// the burn-down can be computed from real iteration data. See burndown.ts.
export const PROJECT_ITERATION_QUERY = `query ProjectIteration($projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      title
      fields(first: 30) {
        nodes {
          __typename
          ... on ProjectV2IterationField {
            name
            configuration {
              iterations { id title startDate duration }
              completedIterations { id title startDate duration }
            }
          }
          ... on ProjectV2SingleSelectField { name options { id name } }
        }
      }
      items(first: 100) {
        nodes {
          content {
            __typename
            ... on Issue { closed closedAt }
            ... on PullRequest { closed closedAt }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldIterationValue { iterationId field { ... on ProjectV2IterationField { name } } }
              ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
            }
          }
        }
      }
    }
  }
}`;
