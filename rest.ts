// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all over the shared in-memory store.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commitFileChange,
  diffTrees,
  fileAtCommit,
  flattenTree,
  isOid,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  resolveRef,
  threeWayMerge,
  buildTreeFromFlat,
  buildCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface RestCtx {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  origin: string;
  path: string;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strField(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function boolField(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`forge:v1:User:${VIEWER_ID}`, 'utf8').toString('base64url'),
    avatar_url: `https://example.invalid/avatar/${VIEWER_LOGIN}`,
    gravatar_id: '',
    url: `/users/${VIEWER_LOGIN}`,
    html_url: `https://example.invalid/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const clock = store.clock;
  const openIssues = repo.issues.filter((i) => i.state === 'open').length
    + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: Buffer.from(`forge:v1:Repository:${repo.dbId}`, 'utf8').toString('base64url'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/repos/${repo.owner}/${repo.name}`,
    created_at: clock.iso(repo.createdTs),
    updated_at: clock.iso(repo.updatedTs),
    pushed_at: clock.iso(repo.updatedTs),
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const clock = store.clock;
  return {
    id: issue.id,
    node_id: Buffer.from(`forge:v1:Issue:${repo.dbId}:${issue.number}`, 'utf8').toString('base64url'),
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/repos/${repo.owner}/${repo.name}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? '', url: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: clock.iso(issue.createdTs),
    updated_at: clock.iso(issue.updatedTs),
    closed_at: issue.state === 'closed' ? clock.iso(issue.updatedTs) : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(store: Store, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  const clock = store.clock;
  return {
    id: comment.id,
    node_id: Buffer.from(`forge:v1:IssueComment:${repo.dbId}:${issue.number}:${comment.id}`, 'utf8').toString('base64url'),
    url: `/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: clock.iso(comment.createdTs),
    updated_at: clock.iso(comment.createdTs),
    issue_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const clock = store.clock;
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(store, repo),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`forge:v1:PullRequest:${repo.dbId}:${pull.number}`, 'utf8').toString('base64url'),
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: clock.iso(pull.createdTs),
    updated_at: clock.iso(pull.updatedTs),
    closed_at: pull.state === 'closed' ? clock.iso(pull.updatedTs) : null,
    merged_at: pull.mergedTs === null ? null : clock.iso(pull.mergedTs),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: pull.merged ? 'clean' : 'clean',
    merged_by: pull.merged ? userJson() : null,
    head: refJson(pull.headRef, pull.headSha),
    base: refJson(pull.baseRef, pull.baseSha),
    draft: false,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Math.min(100, Math.max(1, Number.isFinite(rawPerPage) ? rawPerPage : 30));
  return { page, perPage };
}

function paginate<T>(items: T[], ctx: RestCtx): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const next = new URL(ctx.path, ctx.origin);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(ctx.path, ctx.origin);
    last.searchParams.set('page', String(totalPages));
    last.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, headers };
}

// ---------------------------------------------------------------------------
// repo lookup
// ---------------------------------------------------------------------------

function lookupRepo(ctx: RestCtx, owner: string, name: string): Repo | RestResult {
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) return err(404, 'Not Found');
  return repo;
}

function isRepo(value: Repo | RestResult): value is Repo {
  return (value as Repo).dbId !== undefined;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function base64Of(data: Buffer): string {
  return data.toString('base64');
}

function putContents(ctx: RestCtx, repo: Repo, path: string): RestResult {
  const body = ctx.body;
  const message = strField(body, 'message') || `Update ${path}`;
  const contentB64 = strField(body, 'content');
  if (contentB64 === '') return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64, 'base64');
    if (contentB64.replace(/\s/g, '') !== '' && content.length === 0 && contentB64.trim() !== '') {
      // Empty decode of a non-empty string: fall through to the re-encode check.
    }
    if (content.toString('base64') !== contentB64.replace(/\s/g, '')) return err(422, 'content is not valid base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  const branch = strField(body, 'branch') || repo.defaultBranch;
  const sha = strField(body, 'sha');
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A contents write on a branch that does not exist yet creates it from the
    // default branch tip (or starts an unborn branch).
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) repo.refs.set(ref, defaultTip);
    tip = repo.refs.get(ref);
  }
  const existing = tip === undefined ? null : fileAtCommit(ctx.store, repo, tip, path);
  if (sha !== '') {
    if (existing === null) return err(422, 'sha was provided but the file does not exist');
    if (existing.oid.toLowerCase() !== sha.toLowerCase()) return err(409, 'sha does not match the current file');
  }
  const isUpdate = existing !== null;
  const changes = new Map<string, Buffer | null>();
  changes.set(path, content);
  const commitOid = commitFileChange(ctx.store, repo, branch, message, changes);
  repo.updatedTs = ctx.store.clock.next();
  const blobOid = ctx.store.putObject(repo, 'blob', content);
  const name = path.split('/').pop() ?? path;
  const status = isUpdate ? 200 : 201;
  return ok(status, {
    content: {
      name,
      path,
      sha: blobOid,
      size: content.length,
      url: `/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
      git_url: `/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      download_url: null,
      type: 'file',
      encoding: 'base64',
      content: base64Of(content),
    },
    commit: {
      sha: commitOid,
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
    },
  });
}

function getContents(ctx: RestCtx, repo: Repo, path: string): RestResult {
  const ref = ctx.query.get('ref') ?? undefined;
  const tip = resolveRef(repo, ref);
  if (tip === null) return err(404, 'Not Found');
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
  const treeOid = parseCommit(commit.data).tree;
  const flat = flattenTree(repo, treeOid);
  if (path === '') {
    const entries = dirEntries(ctx.store, repo, treeOid, '');
    return ok(200, entries);
  }
  const file = flat.get(path);
  if (file !== undefined) {
    const blob = repo.objects.get(file.oid);
    const data = blob === undefined ? Buffer.alloc(0) : blob.data;
    const name = path.split('/').pop() ?? path;
    return ok(200, {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name,
      path,
      content: base64Of(data),
      sha: file.oid,
      url: `/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      git_url: `/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
      download_url: null,
    });
  }
  // A directory: any path that is a prefix of a file path.
  const prefix = `${path}/`;
  const isDir = [...flat.keys()].some((p) => p.startsWith(prefix));
  if (!isDir) return err(404, 'Not Found');
  const entries = dirEntries(ctx.store, repo, treeOid, path);
  return ok(200, entries);
}

function dirEntries(store: Store, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const flat = flattenTree(repo, treeOid);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [path, entry] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const blob = repo.objects.get(entry.oid);
      seen.set(rest, { type: 'file', oid: entry.oid, size: blob === undefined ? 0 : blob.data.length });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seen.has(dirName)) {
        // Find the subtree oid for the directory.
        const dirOid = findDirOid(repo, treeOid, dirPath === '' ? dirName : `${dirPath}/${dirName}`);
        seen.set(dirName, { type: 'dir', oid: dirOid ?? '', size: 0 });
      }
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const [name, info] of [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const fullPath = dirPath === '' ? name : `${dirPath}/${name}`;
    out.push({
      type: info.type,
      size: info.size,
      name,
      path: fullPath,
      sha: info.oid,
      url: `/repos/${repo.owner}/${repo.name}/contents/${fullPath}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${fullPath}`,
      git_url: `/repos/${repo.owner}/${repo.name}/git/trees/${info.oid}`,
      download_url: info.type === 'file' ? null : null,
    });
  }
  return out;
}

function findDirOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const segments = dirPath.split('/');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    let found: string | null = null;
    for (const entry of parseTree(object.data)) {
      if (entry.name === segment && entry.mode === '40000') { found = entry.oid; break; }
    }
    if (found === null) return null;
    current = found;
  }
  return current;
}

function deleteContents(ctx: RestCtx, repo: Repo, path: string): RestResult {
  const body = ctx.body;
  const message = strField(body, 'message') || `Delete ${path}`;
  const sha = strField(body, 'sha');
  const branch = strField(body, 'branch') || repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return err(404, 'Not Found');
  const existing = fileAtCommit(ctx.store, repo, tip, path);
  if (existing === null) return err(404, 'Not Found');
  if (sha !== '' && existing.oid.toLowerCase() !== sha.toLowerCase()) return err(409, 'sha does not match the current file');
  const changes = new Map<string, Buffer | null>();
  changes.set(path, null);
  const commitOid = commitFileChange(ctx.store, repo, branch, message, changes);
  repo.updatedTs = ctx.store.clock.next();
  return ok(200, {
    commit: {
      sha: commitOid,
      message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
    },
    content: null,
  });
}

// ---------------------------------------------------------------------------
// issues and pulls
// ---------------------------------------------------------------------------

function createIssue(ctx: RestCtx, repo: Repo): RestResult {
  const body = ctx.body;
  const title = strField(body, 'title');
  if (title === '') return err(422, 'title is required');
  const labels = isRecord(body) && Array.isArray(body.labels) ? body.labels : [];
  for (const label of labels) {
    if (typeof label !== 'string' || !repo.labels.has(label)) {
      return err(422, `Validation Failed: label "${String(label)}" does not exist`);
    }
  }
  const ts = ctx.store.clock.next();
  const issue: Issue = {
    id: ctx.store.nextIssueId(),
    number: repo.nextIssue,
    title,
    body: strField(body, 'body'),
    state: 'open',
    labels: labels as string[],
    comments: [],
    createdTs: ts,
    updatedTs: ts,
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return ok(201, issueJson(ctx.store, repo, issue));
}

function listIssues(ctx: RestCtx, repo: Repo): RestResult {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  if (sort === 'created') {
    items = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { page, headers } = paginate(items, ctx);
  return ok(200, page.map((issue) => issueJson(ctx.store, repo, issue)), headers);
}

function createPull(ctx: RestCtx, repo: Repo): RestResult {
  const body = ctx.body;
  const head = strField(body, 'head');
  const base = strField(body, 'base');
  const title = strField(body, 'title');
  if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return err(422, `head branch "${head}" does not exist`);
  if (baseSha === undefined) return err(422, `base branch "${base}" does not exist`);
  const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
  if (duplicate !== undefined) return err(422, 'A pull request already exists for this head and base');
  const ts = ctx.store.clock.next();
  const pull: Pull = {
    id: ctx.store.nextIssueId(),
    number: repo.nextPull,
    title,
    body: strField(body, 'body'),
    state: 'open',
    merged: false,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    mergeCommitSha: null,
    mergedTs: null,
    createdTs: ts,
    updatedTs: ts,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return ok(201, pullJson(ctx.store, repo, pull));
}

function mergePull(ctx: RestCtx, repo: Repo, number: number): RestResult {
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) return err(404, 'Not Found');
  if (pull.state !== 'open') return err(405, 'Pull request is already closed');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return err(405, 'Base branch has no commits');
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(ctx.store, repo, baseTip, headTip);
  if (base === null) return err(405, 'No merge base: unrelated histories');
  const merged = threeWayMerge(repo, baseTip, headTip, base);
  if (!merged.ok) return err(405, `Merge conflict: ${merged.conflicts.join(', ')}`);
  const tree = buildTreeFromFlat(ctx.store, repo, merged.tree);
  const ts = ctx.store.clock.next();
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit(tree, [baseTip], message, `${VIEWER_NAME} <${VIEWER_EMAIL}>`, ts);
  const commitOid = ctx.store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  ctx.store.touch(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedTs = ts;
  pull.updatedTs = ts;
  repo.updatedTs = ts;
  return ok(200, { sha: commitOid, merged: true, message: 'Pull request successfully merged' });
}

function pullFiles(ctx: RestCtx, repo: Repo, number: number): RestResult {
  const pull = repo.pulls.find((p) => p.number === number);
  if (pull === undefined) return err(404, 'Not Found');
  const baseCommit = repo.objects.get(pull.baseSha);
  const headCommit = repo.objects.get(pull.headSha);
  if (baseCommit === undefined || headCommit === undefined) return err(404, 'Not Found');
  const baseTree = parseCommit(baseCommit.data).tree;
  const headTree = parseCommit(headCommit.data).tree;
  const files = diffTrees(repo, baseTree, headTree);
  return ok(200, files.map((f) => ({
    sha: '',
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    blob_url: '',
    raw_url: '',
    contents_url: '',
  })));
}

// ---------------------------------------------------------------------------
// main router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestCtx): RestResult {
  const { store, method, segments } = ctx;
  const seg = (i: number): string => segments[i] ?? '';

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, {
      current_user_url: '/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/authorizations',
      code_search_url: '/search/code?q={query}',
      commit_search_url: '/search/commits?q={query}',
      emails_url: '/user/emails',
      emojis_url: '/emojis',
      events_url: '/events',
      feeds_url: '/feeds',
      followers_url: '/user/followers',
      following_url: '/user/following',
      gists_url: '/gists/{gist_id}',
      issue_search_url: '/search/issues?q={query}',
      issues_url: '/issues',
      keys_url: '/user/keys',
      labels_url: '/labels/{label_id}',
      notifications_url: '/notifications',
      organization_repositories_url: '/orgs/{org}/repos',
      organization_url: '/orgs/{org}',
      public_gists_url: '/gists/public',
      rate_limit_url: '/rate_limit',
      repository_url: '/repos/{owner}/{repo}',
      repository_search_url: '/search/repositories?q={query}',
      current_user_repositories_url: '/user/repos',
      user_url: '/users/{user}',
      user_organizations_url: '/user/orgs',
      user_repositories_url: '/users/{user}/repos',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (seg(0) === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_services_sha: '0000000000000000000000000000000000000000' });
  }

  if (seg(0) === 'user' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, userJson());
  }

  if (seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const { page, headers } = paginate(store.listRepos(VIEWER_LOGIN), ctx);
      return ok(200, page.map((repo) => repoJson(store, repo)), headers);
    }
    if (method === 'POST') {
      const name = strField(ctx.body, 'name');
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return err(422, `Repository "${name}" already exists on this account`);
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        strField(ctx.body, 'description'),
        boolField(ctx.body, 'private', false),
      );
      return ok(201, repoJson(store, repo));
    }
    return err(404, 'Not Found');
  }

  if (seg(0) === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(seg(1));
    const name = decodeURIComponent(seg(2));
    const found = lookupRepo(ctx, owner, name);
    if (!isRepo(found)) return found;
    const repo = found;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (isRecord(ctx.body) && typeof ctx.body.description === 'string') {
          repo.description = ctx.body.description;
        }
        if (isRecord(ctx.body) && typeof ctx.body.private === 'boolean') {
          repo.private = ctx.body.private;
        }
        repo.updatedTs = store.clock.next();
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort();
        return ok(200, branches.map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? '', url: '' },
          protected: false,
        })));
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { name: branch, commit: { sha, url: '' }, protected: false });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = strField(ctx.body, 'ref');
        const sha = strField(ctx.body, 'sha');
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'ref must start with refs/heads/ or refs/tags/');
        if (!isOid(sha)) return err(422, 'sha is not a valid object id');
        const object = repo.objects.get(sha);
        if (object === undefined || (ref.startsWith('refs/heads/') && object.type !== 'commit')) {
          return err(422, 'sha does not name an existing commit');
        }
        if (repo.refs.has(ref)) return err(422, 'ref already exists');
        repo.refs.set(ref, sha);
        store.touch(repo);
        return ok(201, { ref, object: { sha, type: object.type }, url: '' });
      }
      if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
        const branch = decodeURIComponent(rest[3]);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' }, url: '' });
      }
      if (method === 'GET' && rest.length === 2) {
        const refs = [...repo.refs.keys()].sort().map((ref) => ({
          ref,
          object: { sha: repo.refs.get(ref) ?? '', type: 'commit' },
          url: '',
        }));
        return ok(200, refs);
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const tip = resolveRef(repo, ctx.query.get('sha') ?? undefined);
        if (tip === null) return ok(200, []);
        const commits = listCommits(repo, tip);
        const { page, headers } = paginate(commits, ctx);
        return ok(200, page.map((sha) => {
          const object = repo.objects.get(sha)!;
          const view = parseCommit(object.data);
          const date = store.clock.iso(extractTs(view.author));
          return {
            sha,
            commit: {
              // GitHub's API presents the message without the trailing
              // newline the commit object itself carries.
              message: view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message,
              author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
              committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
              tree: { sha: view.tree },
            },
            author: { login: VIEWER_LOGIN },
            committer: { login: VIEWER_LOGIN },
            parents: view.parents.map((p) => ({ sha: p })),
            url: '',
            html_url: '',
          };
        }), headers);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = decodeURIComponent(rest[1]);
        const object = repo.objects.get(sha);
        if (object === undefined || object.type !== 'commit') return err(404, 'Not Found');
        const view = parseCommit(object.data);
        const date = store.clock.iso(extractTs(view.author));
        return ok(200, {
          sha,
          commit: {
            message: view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message,
            author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
            committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
            tree: { sha: view.tree },
          },
          author: { login: VIEWER_LOGIN },
          committer: { login: VIEWER_LOGIN },
          parents: view.parents.map((p) => ({ sha: p })),
          url: '',
          html_url: '',
        });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      if (method === 'GET') return getContents(ctx, repo, path);
      if (method === 'PUT') return putContents(ctx, repo, path);
      if (method === 'DELETE') return deleteContents(ctx, repo, path);
      return err(404, 'Not Found');
    }

    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description, url: '' })));
      }
      if (method === 'POST' && rest.length === 1) {
        const labelName = strField(ctx.body, 'name');
        if (labelName === '') return err(422, 'name is required');
        if (repo.labels.has(labelName)) return err(422, `label "${labelName}" already exists`);
        const label = {
          name: labelName,
          color: strField(ctx.body, 'color') || 'ededed',
          description: strField(ctx.body, 'description'),
        };
        repo.labels.set(labelName, label);
        return ok(201, { name: label.name, color: label.color, description: label.description, url: '' });
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') return listIssues(ctx, repo);
        if (method === 'POST') return createIssue(ctx, repo);
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === number);
      if (rest.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (isRecord(ctx.body) && typeof ctx.body.state === 'string' && (ctx.body.state === 'open' || ctx.body.state === 'closed')) {
            issue.state = ctx.body.state;
          }
          if (isRecord(ctx.body) && typeof ctx.body.title === 'string') issue.title = ctx.body.title;
          if (isRecord(ctx.body) && typeof ctx.body.body === 'string') issue.body = ctx.body.body;
          issue.updatedTs = store.clock.next();
          return ok(200, issueJson(store, repo, issue));
        }
        return err(404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return ok(200, issue.comments.map((comment) => commentJson(store, repo, issue, comment)));
        }
        if (method === 'POST') {
          const text = strField(ctx.body, 'body');
          if (text === '') return err(422, 'body is required');
          const comment = { id: store.nextCommentIdValue(), body: text, createdTs: store.clock.next() };
          issue.comments.push(comment);
          issue.updatedTs = store.clock.next();
          return ok(201, commentJson(store, repo, issue, comment));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const items = repo.pulls.filter((p) => state === 'all' || p.state === state);
          const { page, headers } = paginate(items, ctx);
          return ok(200, page.map((pull) => pullJson(store, repo, pull)), headers);
        }
        if (method === 'POST') return createPull(ctx, repo);
        return err(404, 'Not Found');
      }
      const number = Number.parseInt(rest[1], 10);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      if (rest.length === 2 && method === 'GET') {
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return err(404, 'Not Found');
        return ok(200, pullJson(store, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        return pullFiles(ctx, repo, number);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        return mergePull(ctx, repo, number);
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function extractTs(identity: string): number {
  const match = identity.match(/ (\d+) \+0000$/);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}
