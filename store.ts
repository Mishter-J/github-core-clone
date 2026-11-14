// store.ts — the forge's in-memory store: git objects, packs, trees, commits,
// repositories, issues, pull requests, labels and comments.
//
// Everything is deterministic: timestamps come only from the trial's fixed
// opening time (MAKEFUN_TRIAL_NOW) plus a monotonic sequence, never the wall
// clock, and there is no unseeded randomness anywhere in this file.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export function buildCommit(tree: string, parents: string[], message: string, author: string, timestamp: number): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${msg}`, 'utf8');
}

// ---------------------------------------------------------------------------
// packs
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain (undeltified) objects, in the given order. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Inflate exactly one object out of a pack at `offset`, whose uncompressed size
 * is `size`. inflateSync tolerates trailing bytes, so the compressed length is
 * found by binary search for the smallest slice that inflates cleanly.
 */
function inflateAt(pack: Buffer, offset: number, size: number): { data: Buffer; next: number } {
  let lo = 1;
  let hi = pack.length - offset;
  // Exponential probe first: most objects are small.
  let probe = 16;
  let found = -1;
  while (probe <= hi) {
    try {
      const out = inflateSync(pack.subarray(offset, offset + probe));
      if (out.length === size) { found = probe; break; }
    } catch { /* too short, or not a clean end yet */ }
    probe *= 2;
  }
  if (found < 0) {
    // Binary search over [probe/2, hi] for the smallest working length.
    let a = Math.floor(probe / 2);
    let b = hi;
    while (a < b) {
      const mid = Math.floor((a + b) / 2);
      try {
        const out = inflateSync(pack.subarray(offset, offset + mid));
        if (out.length === size) b = mid;
        else a = mid + 1;
      } catch {
        a = mid + 1;
      }
    }
    found = a;
  } else {
    // Shrink: find the smallest length that still works.
    let a = 1;
    let b = found;
    while (a < b) {
      const mid = Math.floor((a + b) / 2);
      try {
        const out = inflateSync(pack.subarray(offset, offset + mid));
        if (out.length === size) b = mid;
        else a = mid + 1;
      } catch {
        a = mid + 1;
      }
    }
    found = a;
  }
  const data = inflateSync(pack.subarray(offset, offset + found));
  if (data.length !== size) throw new Error(`pack object inflated to ${data.length} bytes, expected ${size}`);
  return { data, next: offset + found };
}

export interface ParsedPack {
  objects: GitObject[];
  version: number;
}

/** Parse a packfile: plain objects only (the suite's client never sends deltas). */
export function readPack(pack: Buffer): ParsedPack {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  const objects: GitObject[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack object type ${typeCode} is not supported`);
    if (typeCode === 6 || typeCode === 7) throw new Error('delta packs are not supported');
    const { data, next } = inflateAt(pack, offset, size);
    offset = next;
    objects.push({ type, data });
  }
  return { objects, version };
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const actual = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  return actual === expected;
}

// ---------------------------------------------------------------------------
// reachability and shallow boundaries
// ---------------------------------------------------------------------------

/** All objects reachable from `roots` (commits, trees, tags, blobs). */
export function collectReachable(lookup: (oid: string) => GitObject | undefined, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && !seen.has(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      for (const parent of view.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` following commit parents. */
export function isAncestor(lookup: (oid: string) => GitObject | undefined, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/**
 * Commits reachable from `wants` within `depth` generations (depth 1 = the tips
 * only). A commit the client already has is not re-sent — except that the
 * ancestors of a commit listed in `oldShallow` are sendable again: a deepen
 * request lists its old boundary as a have, and the parent beyond it is exactly
 * what deepening must deliver. The walk traverses through excluded commits.
 * Returns the included commit oids, the new shallow boundary (included commits
 * whose parent is not included), and old boundaries that are now unshallowed.
 */
export function depthLimitedCommits(
  lookup: (oid: string) => GitObject | undefined,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): { commits: Set<string>; shallow: string[]; unshallow: string[] } {
  const ancestorsOf = (roots: string[]): Set<string> => {
    const out = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (out.has(oid)) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  };
  // Everything the client holds: the haves and their whole history, except the
  // history beyond a listed shallow boundary, which deepening re-opens.
  const haveClosure = new Set<string>();
  for (const have of haves) {
    haveClosure.add(have);
    for (const oid of ancestorsOf([have])) haveClosure.add(oid);
  }
  const shallowAncestors = new Set<string>();
  for (const boundary of oldShallow) {
    const object = lookup(boundary);
    if (object !== undefined && object.type === 'commit') {
      for (const oid of ancestorsOf(parseCommit(object.data).parents)) shallowAncestors.add(oid);
    }
  }
  const excluded = new Set<string>();
  for (const oid of haveClosure) if (!shallowAncestors.has(oid)) excluded.add(oid);

  const commits = new Set<string>();
  const queue: Array<{ oid: string; dist: number }> = wants.map((oid) => ({ oid, dist: 0 }));
  const seenDist = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    const prev = seenDist.get(oid);
    if (prev !== undefined && prev <= dist) continue;
    seenDist.set(oid, dist);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    for (const parent of parents) queue.push({ oid: parent, dist: dist + 1 });
    if (depth !== null && dist >= depth) continue;
    if (!excluded.has(oid)) commits.add(oid);
  }
  const shallow: string[] = [];
  for (const oid of commits) {
    const object = lookup(oid)!;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0 || parents.some((p) => !commits.has(p))) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const oid of oldShallow) {
    if (commits.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined && object.type === 'commit') {
      const parents = parseCommit(object.data).parents;
      if (parents.some((p) => commits.has(p))) unshallow.push(oid);
    }
  }
  return { commits, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// the forge's data model
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdTs: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdTs: number;
  updatedTs: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedTs: number | null;
  createdTs: number;
  updatedTs: number;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  createdTs: number;
  updatedTs: number;
  /** Pack cache: key -> built pack bytes, cleared whenever the repo changes. */
  packCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>;
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`forge:v1:${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const fields = text.split(':');
    if (fields.length < 4 || fields[0] !== 'forge' || fields[1] !== 'v1') return null;
    return { kind: fields[2], parts: fields.slice(3) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.dbId);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', repo.dbId, issue.number);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', repo.dbId, pull.number);
}

export function commentGlobalId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return globalId('IssueComment', repo.dbId, issue.number, comment.id);
}

/** A deterministic clock: the trial's opening time plus a monotonic sequence. */
export class Clock {
  private readonly base: number;
  private seq = 0;

  constructor(nowIso: string | undefined) {
    const parsed = nowIso === undefined || nowIso === '' ? NaN : Date.parse(nowIso);
    this.base = Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1763000000;
  }

  /** Next timestamp (unix seconds), strictly increasing. */
  next(): number {
    const ts = this.base + this.seq;
    this.seq += 1;
    return ts;
  }

  iso(ts: number): string {
    return new Date(ts * 1000).toISOString();
  }
}

export class Store {
  readonly clock: Clock;
  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private nextObjectId = 1;
  private nextCommentId = 1;

  constructor(nowIso: string | undefined) {
    this.clock = new Clock(nowIso);
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const ts = this.clock.next();
    const repo: Repo = {
      dbId: this.nextDbId,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      createdTs: ts,
      updatedTs: ts,
      packCache: new Map(),
    };
    this.nextDbId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): void {
    this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.dbId - b.dbId);
    return out;
  }

  nextIssueId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** Store an object, returning its id (idempotent). */
  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Invalidate the pack cache after any object/ref change. */
  touch(repo: Repo): void {
    repo.packCache.clear();
  }
}

// ---------------------------------------------------------------------------
// flat trees: path -> {mode, oid}
// ---------------------------------------------------------------------------

export interface FlatEntry {
  mode: string;
  oid: string;
}

/** The full file map of the tree at `treeOid` (empty when the tree is missing). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, FlatEntry> {
  const out = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the tree object for a flat file map. */
export function buildTreeFromFlat(store: Store, repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Create a commit on `branch` that applies `changes` (path -> blob bytes, or
 * null to delete) onto the branch tip's tree. Returns the new commit oid.
 */
export function commitFileChange(
  store: Store,
  repo: Repo,
  branch: string,
  message: string,
  changes: Map<string, Buffer | null>,
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const flat = new Map<string, FlatEntry>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const commit = repo.objects.get(tip);
    if (commit !== undefined && commit.type === 'commit') {
      const view = parseCommit(commit.data);
      for (const [path, entry] of flattenTree(repo, view.tree)) flat.set(path, entry);
      parents.push(tip);
    }
  }
  for (const [path, content] of changes) {
    if (content === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: store.putObject(repo, 'blob', content) });
  }
  const tree = buildTreeFromFlat(store, repo, flat);
  const ts = store.clock.next();
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
  const commitData = buildCommit(tree, parents, message, author, ts);
  const oid = store.putObject(repo, 'commit', commitData);
  repo.refs.set(ref, oid);
  store.touch(repo);
  return oid;
}

/** The blob oid and bytes of `path` at a commit (or branch tip), or null. */
export function fileAtCommit(store: Store, repo: Repo, commitOid: string, path: string): { oid: string; data: Buffer } | null {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const flat = flattenTree(repo, parseCommit(commit.data).tree);
  const entry = flat.get(path);
  if (entry === undefined) return null;
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { oid: entry.oid, data: blob.data };
}

/** Resolve a ref name (branch) or commit oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

// ---------------------------------------------------------------------------
// three-way merge and diff
// ---------------------------------------------------------------------------

export interface MergeResult {
  ok: boolean;
  /** The merged flat tree (valid when ok). */
  tree: Map<string, FlatEntry>;
  /** Paths where both sides changed the same file differently. */
  conflicts: string[];
}

/** Merge head's changes (vs merge-base) onto base's tree. */
export function threeWayMerge(
  repo: Repo,
  baseOid: string,
  headOid: string,
  mergeBaseOid: string,
): MergeResult {
  const baseTree = flattenTree(repo, parseCommit(repo.objects.get(baseOid)!.data).tree);
  const headTree = flattenTree(repo, parseCommit(repo.objects.get(headOid)!.data).tree);
  const ancestorTree = flattenTree(repo, parseCommit(repo.objects.get(mergeBaseOid)!.data).tree);
  const tree = new Map<string, FlatEntry>(baseTree);
  const conflicts: string[] = [];
  const paths = new Set<string>([...ancestorTree.keys(), ...headTree.keys()]);
  for (const path of paths) {
    const anc = ancestorTree.get(path);
    const head = headTree.get(path);
    const base = baseTree.get(path);
    const headChanged = (anc?.oid ?? null) !== (head?.oid ?? null);
    const baseChanged = (anc?.oid ?? null) !== (base?.oid ?? null);
    if (!headChanged) continue;
    if (!baseChanged) {
      if (head === undefined) tree.delete(path);
      else tree.set(path, head);
    } else if ((head?.oid ?? null) !== (base?.oid ?? null)) {
      conflicts.push(path);
    }
  }
  return { ok: conflicts.length === 0, tree, conflicts };
}

/** The merge-base of two commits: the newest common ancestor (by walk order). */
export function mergeBase(store: Store, repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  {
    const queue = [a];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  return null;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A small LCS line diff: added/deleted line counts between two blobs. */
export function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldData === null ? [] : countLines(oldData);
  const newLines = newData === null ? [] : countLines(newData);
  if (oldLines.length === 0) return { additions: newLines.length, deletions: 0 };
  if (newLines.length === 0) return { additions: 0, deletions: oldLines.length };
  // LCS dynamic programming; files here are small.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i += 1) dp.push(new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}

/** The file-level diff between two trees, by path. */
export function diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
  const base = flattenTree(repo, baseTreeOid);
  const head = flattenTree(repo, headTreeOid);
  const out: FileChange[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldData = b === undefined ? null : repo.objects.get(b.oid)?.data ?? null;
    const newData = h === undefined ? null : repo.objects.get(h.oid)?.data ?? null;
    const { additions, deletions } = lineDiff(oldData, newData);
    const status = b === undefined ? 'added' : h === undefined ? 'deleted' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** All commits reachable from `tip`, newest first (by creation order). */
export function listCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}
