import type {
  ChangedFile,
  GitHubGateway,
  InstallationInfo,
  NewReview,
  PullRequestInfo,
  RepoRef,
  RepositoryInfo,
  ReviewCommentRef,
  ReviewRef,
} from "../server/github.ts";

type StoredReview = NewReview & { id: number; number: number };

/** An in-memory GitHub that records what would have been published. */
export class FakeGitHub implements GitHubGateway {
  installations: InstallationInfo[] = [
    { id: 7, accountId: 1, accountLogin: "Acme", repositorySelection: "all" },
  ];
  repositories = new Map<number, RepositoryInfo[]>([
    [7, [{ id: 10, fullName: "acme/app", private: true, archived: false }]],
  ]);
  pullRequests: PullRequestInfo[] = [];
  files = new Map<number, ChangedFile[]>();
  sources = new Map<string, string>();
  reviews: StoredReview[] = [];
  /** Accepts the next review, then throws as if the response was lost. */
  loseNextResponse = false;
  /** Runs just before a review is stored. */
  beforeCreateReview?: () => void | Promise<void>;
  private nextId = 1000;

  addPullRequest(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
    const pr: PullRequestInfo = {
      number: 1,
      title: "Add feature",
      author: "dev",
      url: "https://github.com/acme/app/pull/1",
      state: "open",
      draft: false,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      openedAt: "2026-11-01T00:00:00.000Z",
      ...overrides,
    };
    this.pullRequests.push(pr);
    return pr;
  }

  async listInstallations() {
    return this.installations;
  }

  async listRepositories(installationId: number) {
    return this.repositories.get(installationId) ?? [];
  }

  async listOpenPullRequests(_ref: RepoRef) {
    return this.pullRequests.filter((pr) => pr.state === "open");
  }

  async getPullRequest(_ref: RepoRef, number: number) {
    return this.pullRequests.find((pr) => pr.number === number) ?? null;
  }

  async listChangedFiles(_ref: RepoRef, number: number, limit: number) {
    const files = this.files.get(number) ?? [];
    return { files: files.slice(0, limit), truncated: files.length > limit };
  }

  async getFileContent(_ref: RepoRef, path: string, sha: string) {
    return this.sources.get(`${sha}:${path}`) ?? this.sources.get(path) ?? null;
  }

  async listReviews(_ref: RepoRef, number: number): Promise<ReviewRef[]> {
    return this.reviews
      .filter((review) => review.number === number)
      .map((review) => ({ id: review.id, body: review.body }));
  }

  async listReviewComments(_ref: RepoRef, _number: number, reviewId: number): Promise<ReviewCommentRef[]> {
    const review = this.reviews.find((item) => item.id === reviewId);
    return (review?.comments ?? []).map((comment, index) => ({
      id: reviewId * 10 + index,
      url: `https://github.com/acme/app/pull/1#discussion_r${reviewId * 10 + index}`,
      body: comment.body,
    }));
  }

  async createReview(_ref: RepoRef, number: number, review: NewReview) {
    await this.beforeCreateReview?.();
    const id = this.nextId++;
    this.reviews.push({ ...review, id, number });
    if (this.loseNextResponse) {
      this.loseNextResponse = false;
      throw new Error("connection reset after GitHub accepted the review");
    }
    return { id };
  }
}
