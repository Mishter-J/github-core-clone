// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
// Speaks both eras the suite's client tries: the modern 2026-07-28
// server/discover handshake and the legacy initialize handshake
// (2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05). Every request is
// answered with one JSON body; notifications (no id) get HTTP 202 with an
// empty body. Tools act on the same store as the REST surface.

import {
  VIEWER_LOGIN,
  buildCommit,
  buildTreeFromFlat,
  mergeBase,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  threeWayMerge,
  VIEWER_EMAIL,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_LEGACY_REVISIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------------------
// tool catalogue (a module-level constant, so tools/list is byte-identical)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

export const MCP_TOOLS: readonly ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the viewer.', {
    owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
    name: { type: 'string', description: 'Repository name.' },
    description: { type: 'string', description: 'Repository description.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
  }, ['owner', 'repo']),
  tool('list_repos', 'List repositories owned by a user.', {
    owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
  }, []),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Issue title.' },
    body: { type: 'string', description: 'Issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('get_issue', 'Get one issue by owner, repository and number.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    issue_number: { type: 'integer', description: 'Issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_issues', 'List the issues of a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    state: { type: 'string', description: 'Issue state: open, closed or all.', enum: ['open', 'closed', 'all'] },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    title: { type: 'string', description: 'Pull request title.' },
    body: { type: 'string', description: 'Pull request body.' },
    head: { type: 'string', description: 'Head branch name.' },
    base: { type: 'string', description: 'Base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request into its base branch.', {
    owner: { type: 'string', description: 'Owner login.' },
    repo: { type: 'string', description: 'Repository name.' },
    pull_number: { type: 'integer', description: 'Pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

// ---------------------------------------------------------------------------
// tool implementations (same store, same shapes as REST)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdTs,
    updated_at: repo.updatedTs,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
    created_at: store.clock.iso(issue.createdTs),
    updated_at: store.clock.iso(issue.updatedTs),
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merge_commit_sha: pull.mergeCommitSha,
    created_at: store.clock.iso(pull.createdTs),
    updated_at: store.clock.iso(pull.updatedTs),
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function squashMerge(store: Store, repo: Repo, pull: Pull): { ok: boolean; message: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { ok: false, message: 'Base branch has no commits' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(store, repo, baseTip, headTip);
  if (base === null) return { ok: false, message: 'No merge base between head and base' };
  const merged = threeWayMerge(repo, baseTip, headTip, base);
  if (!merged.ok) return { ok: false, message: `Merge conflict: ${merged.conflicts.join(', ')}` };
  const tree = buildTreeFromFlat(store, repo, merged.tree);
  const ts = store.clock.next();
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit(tree, [baseTip], message, `${VIEWER_NAME} <${VIEWER_EMAIL}>`, ts);
  const commitOid = store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  store.touch(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = commitOid;
  pull.mergedTs = ts;
  pull.updatedTs = ts;
  repo.updatedTs = ts;
  return { ok: true, message: 'Pull request successfully merged' };
}

interface ToolOutcome {
  ok: boolean;
  value: unknown;
  error?: string;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = repoName === '' ? undefined : store.getRepo(owner, repoName);
  const needRepo = (): Repo | null => {
    if (repo === undefined) return null;
    return repo;
  };

  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name : '';
      if (repoNameArg === '') return { ok: false, value: null, error: 'name is required' };
      const ownerArg = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
      if (store.getRepo(ownerArg, repoNameArg) !== undefined) {
        return { ok: false, value: null, error: `Repository ${ownerArg}/${repoNameArg} already exists` };
      }
      const created = store.createRepo(
        ownerArg,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { ok: true, value: repoJson(created) };
    }
    case 'get_repo': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      return { ok: true, value: repoJson(found) };
    }
    case 'list_repos': {
      const list = [...store.repos.values()].filter((r) => r.owner === owner).map(repoJson);
      return { ok: true, value: list };
    }
    case 'create_issue': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, value: null, error: 'title is required' };
      const ts = store.clock.next();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: found.nextIssue,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdTs: ts,
        updatedTs: ts,
      };
      found.nextIssue += 1;
      found.issues.push(issue);
      return { ok: true, value: issueJson(store, found, issue) };
    }
    case 'get_issue': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      const number = typeof args.issue_number === 'number' ? args.issue_number : typeof args.number === 'number' ? args.number : -1;
      const issue = found.issues.find((i) => i.number === number);
      if (issue === undefined) return { ok: false, value: null, error: `Issue #${number} not found` };
      return { ok: true, value: issueJson(store, found, issue) };
    }
    case 'list_issues': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const items = found.issues.filter((i) => state === 'all' || i.state === state);
      return { ok: true, value: items.map((i) => issueJson(store, found, i)) };
    }
    case 'create_pull_request': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const title = typeof args.title === 'string' ? args.title : '';
      if (head === '' || base === '' || title === '') return { ok: false, value: null, error: 'title, head and base are required' };
      const headSha = found.refs.get(`refs/heads/${head}`);
      const baseSha = found.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return { ok: false, value: null, error: `head or base branch does not exist: ${head} -> ${base}` };
      }
      const duplicate = found.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate !== undefined) return { ok: false, value: null, error: 'A pull request already exists for this head and base' };
      const ts = store.clock.next();
      const pull: Pull = {
        id: store.nextIssueId(),
        number: found.nextPull,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      found.nextPull += 1;
      found.pulls.push(pull);
      return { ok: true, value: pullJson(store, found, pull) };
    }
    case 'merge_pull_request': {
      const found = needRepo();
      if (found === null) return { ok: false, value: null, error: `Repository ${owner}/${repoName} not found` };
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : -1;
      const pull = found.pulls.find((p) => p.number === number);
      if (pull === undefined) return { ok: false, value: null, error: `Pull request #${number} not found` };
      if (pull.state !== 'open') return { ok: false, value: null, error: `Pull request #${number} is already ${pull.state}` };
      const merged = squashMerge(store, found, pull);
      if (!merged.ok) return { ok: false, value: null, error: merged.message };
      return { ok: true, value: { ...pullJson(store, found, pull), merged: true, message: merged.message } };
    }
    default:
      return { ok: false, value: null, error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

export interface McpHttpAnswer {
  status: number;
  /** JSON text, or '' for a notification's empty 202. */
  body: string;
}

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): McpHttpAnswer {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: JsonRpcId, code: number, message: string, httpStatus = 200): McpHttpAnswer {
  return { status: httpStatus, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

/** Pull a JSON-RPC id out of raw (possibly truncated) text, for parse errors. */
function extractId(raw: string): JsonRpcId {
  const match = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (match === null) return null;
  const rawId = match[1];
  if (rawId.startsWith('"')) {
    try { return JSON.parse(rawId) as string; } catch { return null; }
  }
  const num = Number(rawId);
  return Number.isFinite(num) ? num : null;
}

function toolResultPayload(outcome: ToolOutcome): Record<string, unknown> {
  if (outcome.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
      structuredContent: outcome.value,
      isError: false,
    };
  }
  return {
    content: [{ type: 'text', text: outcome.error ?? 'Tool call failed' }],
    isError: true,
  };
}

export function handleMcp(store: Store, rawBody: string): McpHttpAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return rpcError(extractId(rawBody), -32700, 'Parse error: the request body is not valid JSON', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id: JsonRpcId = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};

  // A notification (no id) is answered with an empty 202 and no JSON-RPC body.
  if (id === null && request.id === undefined) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = MCP_LEGACY_REVISIONS.includes(offered) ? offered : '2025-06-18';
      return rpcResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: MCP_TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? params.arguments : {};
      const known = MCP_TOOLS.some((t) => t.name === name);
      if (!known) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const def = MCP_TOOLS.find((t) => t.name === name)!;
      const missing = def.inputSchema.required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
      if (missing.length > 0) {
        return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      }
      const outcome = callTool(store, name, args);
      return rpcResult(id, toolResultPayload(outcome));
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      return { status: 202, body: '' };
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
