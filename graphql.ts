// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server
// send: a small parser for the query subset in use, plus an executor over the
// shared store. Unknown fields answer HTTP 200 with an errors array naming
// them; an unknown repository answers data.repository = null with no errors.

import {
  VIEWER_LOGIN,
  buildTreeFromFlat,
  buildCommit,
  decodeGlobalId,
  diffTrees,
  issueGlobalId,
  mergeBase,
  parseCommit,
  pullGlobalId,
  repoGlobalId,
  commentGlobalId,
  threeWayMerge,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// parser (the subset the suite's documents use)
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'object'; fields: Record<string, Value> }
  | { kind: 'list'; items: Value[] };

interface Field {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selections: Field[];
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selections: Field[];
}

class ParseError extends Error {}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}():!=$[]@'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(ch) || ch === '-') {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_\-.]/.test(input[j])) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private readonly tokens: string[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = tokenize(input);
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const head = this.peek();
    if (head === 'query' || head === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next();
    }
    const variables: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        // Type: a name, possibly wrapped in [] and suffixed with !.
        while (this.peek() !== undefined && this.peek() !== '=' && this.peek() !== ')' && this.peek() !== ',') {
          this.next();
        }
        if (this.peek() === '=') {
          this.next();
          variables[varName] = this.parseValue();
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelections();
    return { kind, name, variables, selections };
  }

  parseSelections(): Field[] {
    this.expect('{');
    const fields: Field[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  parseField(): Field {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      } else {
        // A named fragment spread: not used by the suite's documents.
        this.next();
        return { alias: null, name: '', args: {}, selections: [], fragmentType: '__spread__' };
      }
      const selections = this.parseSelections();
      return { alias: null, name: '', args: {}, selections, fragmentType };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, Value> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let selections: Field[] = [];
    if (this.peek() === '{') selections = this.parseSelections();
    return { alias, name, args, selections, fragmentType: null };
  }

  parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token === '{') {
      const fields: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var': return variables[value.name] ?? null;
    case 'string': case 'int': case 'float': case 'boolean': case 'enum': return value.value;
    case 'null': return null;
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value.fields)) out[key] = resolveValue(child, variables);
      return out;
    }
    case 'list': return value.items.map((item) => resolveValue(item, variables));
  }
}

// ---------------------------------------------------------------------------
// schema description (for introspection and field validation)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'private', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'author', 'createdAt', 'updatedAt', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  Actor: ['login'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestFile: ['path'],
  AddIssueCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};

interface Ctx {
  store: Store;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function fieldError(ctx: Ctx, typeName: string, fieldName: string, path: Array<string | number>): void {
  ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${typeName}".`, path });
}

function isKnownField(typeName: string, fieldName: string): boolean {
  if (fieldName === '__typename') return true;
  return (TYPE_FIELDS[typeName] ?? []).includes(fieldName);
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function repoById(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const dbId = Number.parseInt(decoded.parts[0], 10);
  for (const repo of store.repos.values()) if (repo.dbId === dbId) return repo;
  return null;
}

function issueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const dbId = Number.parseInt(decoded.parts[0], 10);
  const number = Number.parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function pullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const dbId = Number.parseInt(decoded.parts[0], 10);
  const number = Number.parseInt(decoded.parts[1], 10);
  for (const repo of store.repos.values()) {
    if (repo.dbId !== dbId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(store, repo, baseTip, headTip);
  if (base === null) return 'CONFLICTING';
  return threeWayMerge(repo, baseTip, headTip, base).ok ? 'MERGEABLE' : 'CONFLICTING';
}

function doSquashMerge(store: Store, repo: Repo, pull: Pull): { ok: boolean; message: string } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (baseTip === undefined) return { ok: false, message: 'Base branch has no commits' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(store, repo, baseTip, headTip);
  if (base === null) return { ok: false, message: 'No merge base' };
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

function issueObj(ctx: Ctx, repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: { __typename: 'User', login: VIEWER_LOGIN },
    createdAt: ctx.store.clock.iso(issue.createdTs),
    updatedAt: ctx.store.clock.iso(issue.updatedTs),
    labels: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' })),
    comments: issue.comments.map((c) => ({ __typename: 'IssueComment', id: commentGlobalId(repo, issue, c), body: c.body })),
  };
}

function pullObj(ctx: Ctx, repo: Repo, pull: Pull): AnyObj {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: mergeableOf(ctx.store, repo, pull),
    merged: pull.merged,
    mergedAt: pull.mergedTs === null ? null : ctx.store.clock.iso(pull.mergedTs),
    mergeCommit: pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha },
    author: { __typename: 'User', login: VIEWER_LOGIN },
    createdAt: ctx.store.clock.iso(pull.createdTs),
    updatedAt: ctx.store.clock.iso(pull.updatedTs),
    __repo: repo,
    __pull: pull,
  };
}

function repoObj(ctx: Ctx, repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    id: repoGlobalId(repo),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL },
    defaultBranchRef: repo.refs.get(`refs/heads/${repo.defaultBranch}`) === undefined
      ? null
      : { __typename: 'Ref', name: repo.defaultBranch, target: { oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.private,
    private: repo.private,
    createdAt: ctx.store.clock.iso(repo.createdTs),
    updatedAt: ctx.store.clock.iso(repo.updatedTs),
    url: `/repos/${repo.owner}/${repo.name}`,
    __repo: repo,
  };
}

function executeSelections(
  ctx: Ctx,
  typeName: string,
  source: AnyObj | null,
  selections: Field[],
  variables: Record<string, unknown>,
  path: Array<string | number>,
): AnyObj | null {
  if (source === null) return null;
  const out: AnyObj = {};
  for (const field of selections) {
    if (field.fragmentType === '__spread__') continue;
    if (field.fragmentType !== null) {
      if (field.fragmentType !== typeName && field.fragmentType !== source.__typename) continue;
      const nested = executeSelections(ctx, typeName, source, field.selections, variables, path);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const responseKey = field.alias ?? field.name;
    const fieldPath = [...path, responseKey];
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (!isKnownField(typeName, field.name)) {
      fieldError(ctx, typeName, field.name, fieldPath);
      out[responseKey] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(field.args)) args[key] = resolveValue(value, variables);
    out[responseKey] = resolveField(ctx, typeName, source, field, args, field.selections, variables, fieldPath);
  }
  return out;
}

function resolveField(
  ctx: Ctx,
  typeName: string,
  source: AnyObj,
  field: Field,
  args: Record<string, unknown>,
  selections: Field[],
  variables: Record<string, unknown>,
  path: Array<string | number>,
): unknown {
  const store = ctx.store;
  // Root fields.
  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      const user: AnyObj = { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
      return executeSelections(ctx, 'User', user, selections, variables, path);
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      return executeSelections(ctx, 'Repository', repoObj(ctx, repo), selections, variables, path);
    }
    if (field.name === 'node') {
      const id = String(args.id ?? '');
      const repo = repoById(store, id);
      if (repo !== null) {
        return executeSelections(ctx, 'Repository', repoObj(ctx, repo), selections, variables, path);
      }
      const issue = issueById(store, id);
      if (issue !== null) {
        return executeSelections(ctx, 'Issue', issueObj(ctx, issue.repo, issue.issue), selections, variables, path);
      }
      const pull = pullById(store, id);
      if (pull !== null) {
        return executeSelections(ctx, 'PullRequest', pullObj(ctx, pull.repo, pull.pull), selections, variables, path);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = TYPE_FIELDS[name];
      const enums = TYPE_ENUM_VALUES[name];
      if (fields === undefined && enums === undefined) return null;
      const typeObj: AnyObj = { __typename: '__Type', name, kind: enums !== undefined ? 'ENUM' : 'OBJECT' };
      return executeSelections(ctx, '__Type', typeObj, selections, variables, path);
    }
    if (field.name === '__schema') return { __typename: '__Schema', queryType: { name: 'Query' } };
    return null;
  }

  // __Type pseudo-object.
  if (typeName === '__Type') {
    if (field.name === 'fields') {
      const name = String(source.name ?? '');
      return (TYPE_FIELDS[name] ?? []).map((n) => ({ __typename: '__Field', name: n }));
    }
    if (field.name === 'enumValues') {
      const name = String(source.name ?? '');
      return (TYPE_ENUM_VALUES[name] ?? []).map((n) => ({ __typename: '__EnumValue', name: n }));
    }
    if (field.name === 'name') return source.name ?? null;
    if (field.name === 'kind') return source.kind ?? null;
    return null;
  }

  // Repository fields.
  if (typeName === 'Repository') {
    const repo = source.__repo as Repo;
    if (field.name === 'issue') {
      const number = Number(args.number);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return null;
      return executeSelections(ctx, 'Issue', issueObj(ctx, repo, issue), selections, variables, path);
    }
    if (field.name === 'issues') {
      let items = [...repo.issues];
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        items = items.filter((i) => wanted.has(i.state));
      }
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      if (orderBy !== undefined && String(orderBy.field ?? '') === 'CREATED_AT') {
        const dir = String(orderBy.direction ?? 'DESC');
        items.sort((a, b) => (dir === 'DESC' ? b.number - a.number : a.number - b.number));
      } else {
        items.sort((a, b) => a.number - b.number);
      }
      const after = numberFromCursor(args.after);
      if (after !== null) items = items.filter((i) => i.number > after);
      const first = typeof args.first === 'number' ? args.first : items.length;
      const page = items.slice(0, first);
      const hasNext = items.length > first;
      const connection: AnyObj = {
        __typename: 'IssueConnection',
        __items: page.map((i) => issueObj(ctx, repo, i)),
        __itemType: 'Issue',
        pageInfo: {
          __typename: 'PageInfo',
          hasNextPage: hasNext,
          hasPreviousPage: false,
          endCursor: page.length === 0 ? null : cursorFor(page[page.length - 1].number),
          startCursor: page.length === 0 ? null : cursorFor(page[0].number),
        },
        totalCount: items.length,
      };
      // `selections` here are the connection's own sub-selections (nodes /
      // pageInfo); the node fields live inside the `nodes` selection and are
      // executed by executeConnectionSelections.
      return executeConnectionSelections(ctx, connection, selections, variables, path);
    }
    if (field.name === 'pullRequests') {
      let items = repo.pulls.filter((p) => p.state === 'open');
      const states = args.states;
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s)));
        items = items.filter((p) => wanted.has(p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED'));
      }
      const first = typeof args.first === 'number' ? args.first : items.length;
      const page = items.slice(0, first);
      const connection: AnyObj = {
        __typename: 'PullRequestConnection',
        __items: page.map((p) => pullObj(ctx, repo, p)),
        __itemType: 'PullRequest',
        pageInfo: { __typename: 'PageInfo', hasNextPage: items.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
        totalCount: items.length,
      };
      return executeConnectionSelections(ctx, connection, selections, variables, path);
    }
    if (field.name === 'pullRequest') {
      const number = Number(args.number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return null;
      return executeSelections(ctx, 'PullRequest', pullObj(ctx, repo, pull), selections, variables, path);
    }
    if (field.name === 'owner') {
      return executeSelections(ctx, 'User', { __typename: 'User', login: repo.owner, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }, selections, variables, path);
    }
    if (field.name === 'defaultBranchRef') {
      const ref = source.defaultBranchRef as AnyObj | null;
      if (ref === null) return null;
      return executeSelections(ctx, 'Ref', ref, selections, variables, path);
    }
    return source[field.name] ?? null;
  }

  // PullRequest fields.
  if (typeName === 'PullRequest') {
    const repo = source.__repo as Repo;
    const pull = source.__pull as Pull;
    if (field.name === 'files') {
      const baseCommit = repo.objects.get(pull.baseSha);
      const headCommit = repo.objects.get(pull.headSha);
      let paths: string[] = [];
      if (baseCommit !== undefined && headCommit !== undefined) {
        paths = diffTrees(repo, parseCommit(baseCommit.data).tree, parseCommit(headCommit.data).tree).map((f) => f.filename);
      }
      const first = typeof args.first === 'number' ? args.first : paths.length;
      const page = paths.slice(0, first);
      const connection: AnyObj = {
        __typename: 'PullRequestFileConnection',
        __items: page.map((p) => ({ __typename: 'PullRequestFile', path: p })),
        __itemType: 'PullRequestFile',
        pageInfo: { __typename: 'PageInfo', hasNextPage: paths.length > first, hasPreviousPage: false, endCursor: null, startCursor: null },
        totalCount: paths.length,
      };
      return executeConnectionSelections(ctx, connection, selections, variables, path);
    }
    return source[field.name] ?? null;
  }

  // Mutations.
  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repo = repoById(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.', path });
        return null;
      }
      const title = String(input.title ?? '');
      if (title === '') {
        ctx.errors.push({ message: 'title is required', path });
        return null;
      }
      const ts = store.clock.next();
      const issue: Issue = {
        id: store.nextIssueId(),
        number: repo.nextIssue,
        title,
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdTs: ts,
        updatedTs: ts,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      const payload: AnyObj = { __typename: 'CreateIssuePayload', issue: issueObj(ctx, repo, issue) };
      return executeSelections(ctx, 'CreateIssuePayload', payload, field.selections, variables, path);
    }
    if (field.name === 'closeIssue') {
      const found = issueById(store, String(input.issueId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.', path });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedTs = store.clock.next();
      const payload: AnyObj = { __typename: 'CloseIssuePayload', issue: issueObj(ctx, found.repo, found.issue) };
      return executeSelections(ctx, 'CloseIssuePayload', payload, field.selections, variables, path);
    }
    if (field.name === 'createPullRequest') {
      const repo = repoById(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.', path });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        ctx.errors.push({ message: `head or base branch does not exist: ${head} -> ${base}`, path });
        return null;
      }
      const duplicate = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (duplicate !== undefined) {
        ctx.errors.push({ message: 'A pull request already exists for this head and base', path });
        return null;
      }
      const ts = store.clock.next();
      const pull: Pull = {
        id: store.nextIssueId(),
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      const payload: AnyObj = { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(ctx, repo, pull) };
      return executeSelections(ctx, 'CreatePullRequestPayload', payload, field.selections, variables, path);
    }
    if (field.name === 'mergePullRequest') {
      const found = pullById(store, String(input.pullRequestId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.', path });
        return null;
      }
      if (found.pull.state !== 'open') {
        ctx.errors.push({ message: 'Pull request is already closed', path });
        return null;
      }
      const merged = doSquashMerge(store, found.repo, found.pull);
      if (!merged.ok) {
        ctx.errors.push({ message: merged.message, path });
        return null;
      }
      const payload: AnyObj = { __typename: 'MergePullRequestPayload', pullRequest: pullObj(ctx, found.repo, found.pull) };
      return executeSelections(ctx, 'MergePullRequestPayload', payload, field.selections, variables, path);
    }
    if (field.name === 'addComment') {
      const found = issueById(store, String(input.subjectId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.', path });
        return null;
      }
      const comment = { id: store.nextCommentIdValue(), body: String(input.body ?? ''), createdTs: store.clock.next() };
      found.issue.comments.push(comment);
      found.issue.updatedTs = store.clock.next();
      const node: AnyObj = { __typename: 'IssueComment', id: commentGlobalId(found.repo, found.issue, comment), body: comment.body };
      const payload: AnyObj = {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) },
      };
      return executeSelections(ctx, 'AddCommentPayload', payload, field.selections, variables, path);
    }
    return null;
  }

  // Payload objects hold one raw nested object; resolve it with its type.
  const NESTED: Record<string, Record<string, string>> = {
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge' },
    IssueCommentEdge: { node: 'IssueComment' },
  };
  const nestedType = NESTED[typeName]?.[field.name];
  if (nestedType !== undefined) {
    const nested = source[field.name];
    if (nested === null || typeof nested !== 'object') return null;
    return executeSelections(ctx, nestedType, nested as AnyObj, selections, variables, path);
  }

  // Leaf / scalar passthrough for simple objects.
  if (field.selections.length === 0) return source[field.name] ?? null;
  const nested = source[field.name];
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedObj = nested as AnyObj;
    const nestedType = typeof nestedObj.__typename === 'string' ? nestedObj.__typename : typeName;
    return executeSelections(ctx, nestedType, nestedObj, selections, variables, path);
  }
  return nested ?? null;
}

/**
 * A connection object's own selections (nodes / pageInfo / totalCount): the
 * nodes were already executed; pick the requested pieces.
 */
function executeConnectionSelections(
  ctx: Ctx,
  connection: AnyObj,
  selections: Field[],
  variables: Record<string, unknown>,
  path: Array<string | number>,
): AnyObj {
  const out: AnyObj = {};
  for (const field of selections) {
    if (field.fragmentType !== null) continue;
    const key = field.alias ?? field.name;
    if (field.name === 'nodes') {
      const items = (connection.__items as AnyObj[] | undefined) ?? [];
      const itemType = String(connection.__itemType ?? 'Issue');
      out[key] = items.map((item, index) => executeSelections(ctx, itemType, item, field.selections, variables, [...path, key, index]));
    } else if (field.name === 'pageInfo') {
      const pageInfo = connection.pageInfo as AnyObj;
      out[key] = executeSelections(ctx, 'PageInfo', pageInfo, field.selections, variables, [...path, key]);
    } else if (field.name === 'totalCount') {
      out[key] = connection.totalCount ?? 0;
    } else if (field.name === '__typename') {
      out[key] = connection.__typename ?? null;
    } else {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${String(connection.__typename ?? 'Connection')}".`, path: [...path, key] });
      out[key] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  status: number;
  body: unknown;
}

function runOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObj = { __typename: rootType };
  let data: AnyObj | null;
  try {
    data = executeSelections(ctx, rootType, root, operation.selections, variables, []);
  } catch {
    data = {};
    if (ctx.errors.length === 0) ctx.errors.push({ message: 'Internal error while executing the operation.' });
  }
  const out: Record<string, unknown> = { data: data ?? {} };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: {}, errors: [{ message: 'Each operation must be an object with a query string.' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: {}, errors: [{ message: 'query must be a non-empty string.' }] };
    }
    const variables = (record.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (err) {
      return { data: {}, errors: [{ message: err instanceof Error ? err.message : 'Could not parse the query.' }] };
    }
    if (operations.length === 0) {
      return { data: {}, errors: [{ message: 'The document holds no operation.' }] };
    }
    // One operation per body in the suite's use; run the first (named by
    // operationName when given).
    let operation = operations[0];
    const wanted = record.operationName;
    if (typeof wanted === 'string' && wanted !== '') {
      operation = operations.find((op) => op.name === wanted) ?? operations[0];
    }
    return runOperation(store, operation, variables);
  };

  if (Array.isArray(body)) {
    return { status: 200, body: body.map(runOne) };
  }
  return { status: 200, body: runOne(body) };
}
