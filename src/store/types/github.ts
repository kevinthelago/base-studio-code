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
