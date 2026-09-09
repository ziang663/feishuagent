import { ENGINE_REPOSITORIES, type EngineQuery, type EvidenceDocument, type EvidenceSource } from "./types.js";

interface GitHubClientOptions {
  token?: string;
  maxLinkedPullRequests: number;
  fetchImpl?: typeof fetch;
}

interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function truncate(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}

function uniqueNumbers(text: string): number[] {
  const found = new Set<number>();
  const patterns = [
    /(?:pull|pulls)\/(\d+)/gi,
    /#(\d{2,})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value)) found.add(value);
    }
  }
  return [...found];
}

interface ReleaseReference {
  number: number;
  section: string;
  context: string;
  kindHint: "pull_request" | "issue";
}

interface ReleaseItem {
  section: string;
  context: string;
  numbers: number[];
  order: number;
}

const LOW_PRIORITY_RELEASE_SECTIONS = [
  /model support/i,
  /new model/i,
  /bug fix/i,
  /dependenc/i,
  /documentation/i,
  /new contributor/i,
  /breaking change/i,
  /deprecation/i,
];

function curatedReleaseNotes(body: string): string {
  const cutPatterns = [
    /^#{1,6}\s+What's Changed\s*$/im,
    /^#{1,6}\s+New Contributors[^\n]*$/im,
  ];
  const cutAt = cutPatterns
    .map((pattern) => body.search(pattern))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const curated = cutAt === undefined ? body : body.slice(0, cutAt);
  return truncate(curated || body, 80_000);
}

function releaseItems(body: string): ReleaseItem[] {
  const items: ReleaseItem[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let current: { section: string; lines: string[] } | null = null;
  const flush = () => {
    if (!current) return;
    const context = current.lines.join(" ").replace(/\s+/g, " ").trim();
    const numbers = uniqueNumbers(context);
    if (numbers.length) items.push({ section: current.section, context, numbers, order: items.length });
    current = null;
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (headingStack.length && headingStack.at(-1)!.level >= level) headingStack.pop();
      headingStack.push({ level, title: heading[2]!.trim() });
      continue;
    }
    const section = headingStack.map((item) => item.title).join(" > ") || "Release notes";
    if (/^[-*]\s+/.test(line)) {
      flush();
      current = { section, lines: [line] };
    } else if (current && line) {
      current.lines.push(line);
    }
  }
  flush();
  return items;
}

function releaseReferences(items: ReleaseItem[]): ReleaseReference[] {
  const references = new Map<number, ReleaseReference>();
  for (const item of items) {
    for (const number of item.numbers) {
      if (!references.has(number)) {
        const escaped = String(number);
        const kindHint = new RegExp(`(?:roadmap|issue)\\s*#${escaped}\\b|/issues/${escaped}\\b`, "i").test(item.context)
          ? "issue"
          : "pull_request";
        references.set(number, {
          number,
          section: item.section,
          context: truncate(item.context, 1_500),
          kindHint,
        });
      }
    }
  }
  return [...references.values()];
}

function isDeepDiveCandidate(item: ReleaseItem): boolean {
  const text = `${item.section} ${item.context}`;
  return !LOW_PRIORITY_RELEASE_SECTIONS.some((pattern) => pattern.test(item.section))
    && !/bug\s*fix|critical\s+fix|documentation|\bdocs?\b|dependency|bump\s+\S+\s+version|day\s*0\s+support|new\s+model\s+support/i.test(text);
}

function deepDiveScore(item: ReleaseItem): number {
  const text = `${item.section} ${item.context}`;
  let score = item.section === "Highlights" ? 100
    : /engine core/i.test(item.section) ? 90
      : /performance|kernel|quantization|api|frontend|hardware/i.test(item.section) ? 45
        : 20;
  const signals: Array<[RegExp, number]> = [
    [/async|schedul/i, 30],
    [/model.?runner/i, 28],
    [/streaming input|session/i, 28],
    [/offload/i, 28],
    [/prefix cach|mamba cache/i, 24],
    [/lora/i, 15],
    [/dispatcher|all.?to.?all/i, 20],
    [/attention|kernel|moe/i, 12],
  ];
  for (const [pattern, weight] of signals) if (pattern.test(text)) score += weight;
  return score;
}

function releaseFileSummary(files: Array<Record<string, any>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  let patchBudget = 6_000;
  for (const file of files.slice(0, 30)) {
    const patch = truncate(file.patch, Math.min(1_500, Math.max(0, patchBudget)));
    patchBudget -= patch.length;
    result.push({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      ...(patch ? { patch } : {}),
    });
  }
  return result;
}

function source(id: string, title: string, url: string): EvidenceSource {
  return { id, title, url };
}

interface RelatedPullReference {
  number: number;
  contexts: string[];
  score: number;
}

function featureTerms(text: string): Set<string> {
  const ignored = new Set([
    "with", "from", "that", "this", "support", "supports", "feature", "roadmap",
    "the", "and", "for", "into", "using", "new", "models", "model",
  ]);
  return new Set(
    text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter((term) => !ignored.has(term)) ?? [],
  );
}

function relatedImplementationPulls(issueBody: string, featureContext: string, limit = 4): RelatedPullReference[] {
  const terms = featureTerms(featureContext);
  const found = new Map<number, { contexts: string[]; score: number; order: number }>();
  let order = 0;
  for (const rawLine of issueBody.split("\n")) {
    const line = rawLine.trim();
    if (/\bdocs?|documentation|test case|bug fix|fix potential/i.test(line)) continue;
    const numbers = [...line.matchAll(/github\.com\/[^/\s)]+\/[^/\s)]+\/pull\/(\d+)/gi)]
      .map((match) => Number(match[1]));
    for (const number of numbers) {
      const lineTerms = featureTerms(line);
      let score = 0;
      for (const term of terms) if (lineTerms.has(term)) score += term.length >= 7 ? 4 : 2;
      if (/implement|implementation|introduc|dynamic chunk|event loop|refactor/i.test(line)) score += 5;
      const current = found.get(number);
      if (current) {
        if (!current.contexts.includes(line)) current.contexts.push(line);
        current.score = Math.max(current.score, score);
      } else {
        found.set(number, { contexts: [line], score, order });
        order += 1;
      }
    }
  }
  return [...found.entries()]
    .map(([number, value]) => ({ number, contexts: value.contexts, score: value.score, order: value.order }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ number, contexts, score }) => ({ number, contexts, score }));
}

function releaseLinkedUrls(body: string): string[] {
  const urls = new Set<string>();
  for (const match of body.matchAll(/https:\/\/[^\s)\]>"']+/g)) {
    const url = match[0].replace(/[.,;:]+$/g, "");
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:") urls.add(url);
    } catch {
      // Ignore malformed URLs from release prose.
    }
  }
  return [...urls];
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function releaseBodyHtml(html: string): string | null {
  const opening = html.match(/<div\b[^>]*data-test-selector="body-content"[^>]*>/i);
  if (!opening?.index) return null;
  const start = opening.index;
  const innerStart = start + opening[0].length;
  const tokens = html.slice(start).matchAll(/<\/?div\b[^>]*>/gi);
  let depth = 0;
  let innerEnd = -1;
  for (const token of tokens) {
    const isClosing = token[0].startsWith("</");
    depth += isClosing ? -1 : 1;
    if (depth === 0) {
      innerEnd = start + token.index!;
      break;
    }
  }
  if (innerEnd < innerStart) return null;
  return html.slice(innerStart, innerEnd);
}

function releaseHtmlToMarkdown(html: string): string | null {
  const body = releaseBodyHtml(html);
  if (!body) return null;
  let markdown = body
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const url = href.startsWith("/") ? `https://github.com${href}` : href;
      return `[${stripHtml(label)}](${decodeHtml(url)})`;
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, content: string) =>
      `${"#".repeat(Number(level))} ${stripHtml(content)}\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag: string, content: string) =>
      `**${stripHtml(content)}**`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, content: string) => `\`${stripHtml(content)}\``)
    .replace(/<li\b[^>]*>/gi, "* ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|ul|ol|pre|blockquote)>/gi, "\n")
    .replace(/<(p|ul|ol|pre|blockquote)\b[^>]*>/gi, "")
    .replace(/<[^>]+>/g, "");
  markdown = decodeHtml(markdown)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown || null;
}

async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await task(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async collect(query: EngineQuery): Promise<EvidenceDocument> {
    if (query.kind === "release") return this.collectRelease(query);
    if (query.kind === "pr") return this.collectPullRequest(query.engine, Number(query.value));
    if (query.kind === "issue") return this.collectIssue(query.engine, Number(query.value));
    return this.collectAmbiguousNumber(query.engine, Number(query.value));
  }

  private async request<T>(path: string): Promise<T> {
    const url = `https://api.github.com${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "inference-engine-release-bot/0.1",
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      let body: GitHubErrorBody = {};
      try {
        body = (await response.json()) as GitHubErrorBody;
      } catch {
        // Keep the status-only error when the upstream did not return JSON.
      }
      throw new GitHubApiError(response.status, body.message || response.statusText, url);
    }
    return (await response.json()) as T;
  }

  private async requestOptional<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>(path);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async requestBestEffort<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>(path);
    } catch (error) {
      const detail = error instanceof GitHubApiError
        ? `status=${error.status} message=${error.message}`
        : error instanceof Error ? error.message : String(error);
      console.warn(`[github] optional evidence unavailable path=${path} ${detail}`);
      return null;
    }
  }

  private async requestPublicText(url: string): Promise<string | null> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": "inference-engine-release-bot/0.1" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) return null;
      return await response.text();
    } catch (error) {
      console.warn(`[github] public text evidence unavailable url=${url}`, error);
      return null;
    }
  }

  private async requestPullDiff(repository: string, number: number): Promise<string | null> {
    const diff = await this.requestPublicText(`https://github.com/${repository}/pull/${number}.diff`);
    return diff?.trimStart().startsWith("diff --git ") ? truncate(diff, 8_000) : null;
  }

  private async publicRelease(repository: string, tag: string): Promise<Record<string, any> | null> {
    const url = `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
    const html = await this.requestPublicText(url);
    if (!html) return null;
    const body = releaseHtmlToMarkdown(html);
    if (!body) return null;
    const title = stripHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "")
      .replace(/\s*·\s*GitHub\s*$/, "");
    const publishedAt = html.match(/<relative-time\b[^>]*datetime="([^"]+)"/i)?.[1];
    return {
      tag_name: tag,
      name: title || `Release ${tag}`,
      body,
      html_url: url,
      draft: false,
      prerelease: /(?:rc|alpha|beta|preview)/i.test(tag),
      target_commitish: "unknown",
      published_at: publishedAt,
      author: { login: "unknown" },
      public_page_fallback: true,
    };
  }

  private async collectAmbiguousNumber(engine: EngineQuery["engine"], number: number): Promise<EvidenceDocument> {
    const repository = ENGINE_REPOSITORIES[engine];
    const pull = await this.requestOptional<Record<string, unknown>>(`/repos/${repository}/pulls/${number}`);
    if (pull) return this.collectPullRequest(engine, number, pull);
    return this.collectIssue(engine, number);
  }

  private async collectRelease(query: EngineQuery): Promise<EvidenceDocument> {
    const repository = ENGINE_REPOSITORIES[query.engine];
    const candidates = query.value.startsWith("v")
      ? [query.value, query.value.slice(1)]
      : [query.value, `v${query.value}`];
    let release: Record<string, any> | null = null;
    let apiLimitError: GitHubApiError | null = null;
    for (const tag of candidates) {
      try {
        release = await this.requestOptional<Record<string, any>>(
          `/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        );
      } catch (error) {
        if (error instanceof GitHubApiError && (error.status === 403 || error.status === 429)) {
          apiLimitError = error;
          release = await this.publicRelease(repository, tag);
        } else {
          throw error;
        }
      }
      if (release) break;
    }
    if (!release) {
      if (apiLimitError) throw apiLimitError;
      throw new GitHubApiError(
        404,
        `没有找到 ${repository} 的 release ${query.value}`,
        `https://github.com/${repository}/releases`,
      );
    }

    const fullReleaseBody = truncate(release.body, 200_000);
    const releaseBody = curatedReleaseNotes(fullReleaseBody);
    const items = releaseItems(releaseBody);
    const references = releaseReferences(items);
    const selectedFeatureItems = items
      .filter(isDeepDiveCandidate)
      .sort((a, b) => deepDiveScore(b) - deepDiveScore(a) || a.order - b.order)
      .slice(0, 5)
      .sort((a, b) => a.order - b.order);
    const selectedNumbers = [...new Set(selectedFeatureItems.flatMap((item) => item.numbers))].slice(0, 12);
    // Only fetch PR/roadmap evidence for user-facing features/backends/kernels.
    // Model support, bug fixes, dependency bumps and similar lists keep the
    // release-note text and deterministic PR links without extra API calls.
    const referenceByNumber = new Map(references.map((item) => [item.number, item]));
    const selectedEvidence = (
      await mapWithConcurrency(selectedNumbers, 5, async (number) => {
        const releaseReference = referenceByNumber.get(number)!;
        let pull = releaseReference.kindHint === "pull_request"
          ? await this.requestBestEffort<Record<string, any>>(`/repos/${repository}/pulls/${number}`)
          : null;
        if (pull) {
          const diff = await this.requestPullDiff(repository, number);
          return [{
            object_kind: "pull_request",
            number,
            title: pull.title,
            url: pull.html_url,
            state: pull.state,
            merged: Boolean(pull.merged_at),
            merged_at: pull.merged_at,
            author: pull.user?.login,
            labels: (pull.labels ?? []).map((label: any) => label.name).filter(Boolean),
            additions: pull.additions,
            deletions: pull.deletions,
            changed_files: pull.changed_files,
            author_description: truncate(pull.body, 4_000) || "(empty)",
            release_section: releaseReference.section,
            release_context: releaseReference.context,
            ...(diff ? { selected_code_diff: diff } : {}),
          }];
        }

        const issue = await this.requestBestEffort<Record<string, any>>(`/repos/${repository}/issues/${number}`);
        if (!issue || issue.pull_request) return [];
        const issueBody = truncate(issue.body, 12_000) || "(empty)";
        const implementations = relatedImplementationPulls(issueBody, releaseReference.context, 3);
        const implementationEvidence = (
          await mapWithConcurrency(implementations, 3, async (related) => {
            const relatedPull = await this.requestBestEffort<Record<string, any>>(
              `/repos/${repository}/pulls/${related.number}`,
            );
            const diff = await this.requestPullDiff(repository, related.number);
            if (!relatedPull && !diff) return null;
            return {
              object_kind: "implementation_pull_request",
              number: related.number,
              roadmap_issue_number: number,
              roadmap_context: releaseReference.context,
              issue_reference_contexts: related.contexts,
              title: relatedPull?.title || `PR #${related.number}`,
              url: relatedPull?.html_url || `https://github.com/${repository}/pull/${related.number}`,
              state: relatedPull?.state || "referenced_by_roadmap",
              merged: relatedPull ? Boolean(relatedPull.merged_at) : undefined,
              author_description: relatedPull
                ? truncate(relatedPull.body, 4_000) || "(empty)"
                : "(GitHub API detail unavailable)",
              ...(diff ? { selected_code_diff: diff } : {}),
            };
          })
        ).filter(Boolean);
        return [{
          object_kind: "roadmap_issue",
          number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state,
          author: issue.user?.login,
          release_section: releaseReference.section,
          release_context: releaseReference.context,
          issue_body: issueBody,
          related_implementation_pull_requests: implementations.map((item) => item.number),
        }, ...implementationEvidence];
      })
    ).flat() as Array<Record<string, unknown>>;

    const releaseUrl = String(release.html_url);
    const detailByNumber = new Map(selectedEvidence.map((item) => [Number(item.number), item]));
    const sources: EvidenceSource[] = [source("release", `${repository} ${release.tag_name}`, releaseUrl)];
    for (const reference of references) {
      const detail = detailByNumber.get(reference.number);
      const isIssue = reference.kindHint === "issue" || detail?.object_kind === "roadmap_issue";
      sources.push(source(
        `${isIssue ? "issue" : "pr"}-${reference.number}`,
        detail
          ? `${isIssue ? "Issue" : "PR"} #${reference.number}: ${detail.title}`
          : `${isIssue ? "Issue" : "PR"} #${reference.number}`,
        `https://github.com/${repository}/${isIssue ? "issues" : "pull"}/${reference.number}`,
      ));
    }
    for (const item of selectedEvidence) {
      if (item.object_kind !== "implementation_pull_request") continue;
      const url = String(item.url);
      if (!sources.some((entry) => entry.url === url)) {
        sources.push(source(`implementation-pr-${item.number}`, `实现 PR #${item.number}: ${item.title}`, url));
      }
    }
    for (const [index, url] of releaseLinkedUrls(releaseBody).entries()) {
      if (!sources.some((item) => item.url === url)) {
        sources.push(source(`release-link-${index + 1}`, "Release note 中的相关资料", url));
      }
    }
    return {
      kind: "release",
      engine: query.engine,
      repository,
      title: String(release.name || release.tag_name),
      url: releaseUrl,
      status: release.draft ? "draft" : release.prerelease ? "prerelease" : "published",
      metadata: {
        tag: release.tag_name,
        target: release.target_commitish,
        published_at: release.published_at,
        author: release.author?.login,
        release_source: release.public_page_fallback ? "github_public_page" : "github_api",
        release_note_original_chars: fullReleaseBody.length,
        release_note_curated_chars: releaseBody.length,
        referenced_pull_requests: references.length,
        selected_feature_evidence_objects: selectedEvidence.length,
        selected_feature_reference_limit: selectedNumbers.length,
        skipped_pull_request_detail_categories: [
          "model support",
          "bug fixes",
          "dependencies",
          "documentation",
          "breaking changes and deprecations",
          "new contributors",
        ],
        deep_dive_references: selectedNumbers,
        deep_dive_feature_items: selectedFeatureItems.map((item) => ({
          section: item.section,
          context: item.context,
          pull_requests: item.numbers,
        })),
        linked_pull_request_bodies_truncated_at_chars: 4_000,
      },
      sections: [
        { heading: "Curated release notes", content: releaseBody || "(empty)" },
        {
          heading: "Selected feature evidence: PRs, roadmap issues, implementation PRs and code diffs",
          content: JSON.stringify(selectedEvidence, null, 2),
        },
      ],
      sources,
    };
  }

  private async collectPullRequest(
    engine: EngineQuery["engine"],
    number: number,
    existing?: Record<string, any>,
  ): Promise<EvidenceDocument> {
    const repository = ENGINE_REPOSITORIES[engine];
    const pull = existing ?? await this.request<Record<string, any>>(`/repos/${repository}/pulls/${number}`);
    const [files, comments, reviews] = await Promise.all([
      this.request<Array<Record<string, any>>>(`/repos/${repository}/pulls/${number}/files?per_page=100`),
      this.request<Array<Record<string, any>>>(`/repos/${repository}/issues/${number}/comments?per_page=50`),
      this.request<Array<Record<string, any>>>(`/repos/${repository}/pulls/${number}/reviews?per_page=50`),
    ]);
    const fileSummary = files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      patch: truncate(file.patch, 2_500),
    }));
    const discussion = [
      ...comments.map((comment) => ({
        type: "issue_comment",
        author: comment.user?.login,
        created_at: comment.created_at,
        body: truncate(comment.body, 4_000),
        url: comment.html_url,
      })),
      ...reviews.map((review) => ({
        type: "review",
        author: review.user?.login,
        state: review.state,
        submitted_at: review.submitted_at,
        body: truncate(review.body, 4_000),
        url: review.html_url,
      })),
    ].slice(-50);
    const url = String(pull.html_url);
    return {
      kind: "pull_request",
      engine,
      repository,
      title: `PR #${number}: ${pull.title}`,
      url,
      status: pull.merged_at ? "merged" : pull.state,
      metadata: {
        number,
        author: pull.user?.login,
        created_at: pull.created_at,
        updated_at: pull.updated_at,
        merged_at: pull.merged_at,
        base: pull.base?.ref,
        head: pull.head?.ref,
        additions: pull.additions,
        deletions: pull.deletions,
        changed_files: pull.changed_files,
        commits: pull.commits,
        labels: (pull.labels ?? []).map((label: any) => label.name).filter(Boolean),
      },
      sections: [
        { heading: "Author description", content: truncate(pull.body, 20_000) || "(empty)" },
        { heading: "Changed files and patches", content: JSON.stringify(fileSummary, null, 2) },
        { heading: "Discussion and reviews", content: JSON.stringify(discussion, null, 2) },
      ],
      sources: [source("primary", `PR #${number}: ${pull.title}`, url)],
    };
  }

  private async collectIssue(engine: EngineQuery["engine"], number: number): Promise<EvidenceDocument> {
    const repository = ENGINE_REPOSITORIES[engine];
    const issue = await this.request<Record<string, any>>(`/repos/${repository}/issues/${number}`);
    if (issue.pull_request) return this.collectPullRequest(engine, number);
    const comments = await this.request<Array<Record<string, any>>>(
      `/repos/${repository}/issues/${number}/comments?per_page=100`,
    );
    const discussion = comments.map((comment) => ({
      author: comment.user?.login,
      created_at: comment.created_at,
      body: truncate(comment.body, 5_000),
      url: comment.html_url,
    }));
    const url = String(issue.html_url);
    return {
      kind: "issue",
      engine,
      repository,
      title: `Issue #${number}: ${issue.title}`,
      url,
      status: issue.state_reason || issue.state,
      metadata: {
        number,
        author: issue.user?.login,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        closed_at: issue.closed_at,
        labels: (issue.labels ?? []).map((label: any) => label.name).filter(Boolean),
        assignees: (issue.assignees ?? []).map((assignee: any) => assignee.login).filter(Boolean),
      },
      sections: [
        { heading: "Problem statement", content: truncate(issue.body, 25_000) || "(empty)" },
        { heading: "Discussion", content: JSON.stringify(discussion, null, 2) },
      ],
      sources: [source("primary", `Issue #${number}: ${issue.title}`, url)],
    };
  }
}
