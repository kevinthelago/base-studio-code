// ── GraphQL query ─────────────────────────────────────────────────────────────

export const BOARD_QUERY = `
query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2 {
      id title
      fields(first: 20) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id name
            options { id name color }
          }
        }
      }
      items(first: 100) {
        nodes {
          id
          fieldValues(first: 10) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name optionId
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number title body state
              repository            { nameWithOwner }
              labels(first: 5)      { nodes { name color } }
              assignees(first: 3)   { nodes { login } }
              comments              { totalCount }
              milestone             { title }
            }
          }
        }
      }
    }
  }
}`;
