// git.ts — git smart HTTP: pkt-line codec, v0/v2 advertisements, ls-refs,
// fetch (v2 and v0) and receive-pack. No git binary; packs are built and
// parsed here, on node:zlib and node:crypto only.

import {
  collectReachable,
  depthLimitedCommits,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from `buf`; returns packets and the offset of the first byte after them. */
export function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, offset };
}

function pktLinesText(packets: Pkt[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------

interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
}

function sortedRefs(repo: Repo): RefInfo[] {
  const out: RefInfo[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const info: RefInfo = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') info.peeled = target;
    }
    out.push(info);
  }
  return out;
}

function defaultTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack agent=forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** v0 ref advertisement lines (without the service preamble). */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const tip = defaultTip(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    return parts;
  }
  const headOid = tip ?? refs[0].oid;
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  for (const ref of refs) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
  }
  return parts;
}

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function notFound(): HttpResult {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, wantsV2: boolean): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== repo.owner) return notFound();
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const parts: Buffer[] = [
        pktLine('version 2\n'),
        pktLine('agent=forge/1.0\n'),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow filter\n'),
        pktLine('object-format=sha1\n'),
        FLUSH,
      ];
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
    }
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH, ...v0RefLines(repo, UPLOAD_V0_CAPS), FLUSH];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(parts) };
  }
  if (service === 'git-receive-pack') {
    const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH, ...v0RefLines(repo, RECEIVE_V0_CAPS), FLUSH];
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: Buffer.concat(parts) };
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// fetch: object selection
// ---------------------------------------------------------------------------

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** The objects a fetch must send, in deterministic (oid-sorted) order. */
function selectFetchObjects(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // A want may name an annotated tag: the tag object itself must travel, and
  // the walk starts at the commit it points to.
  const tagObjects: string[] = [];
  const peeledWants: string[] = [];
  for (const want of wants) {
    let current = want;
    for (;;) {
      const object = lookup(current);
      if (object === undefined || object.type !== 'tag') break;
      tagObjects.push(current);
      current = parseTag(object.data).object;
    }
    peeledWants.push(current);
  }
  const { commits, shallow, unshallow } = depthLimitedCommits(lookup, peeledWants, haves, depth, oldShallow);
  const candidate = new Set<string>(tagObjects);
  for (const commitOid of commits) {
    candidate.add(commitOid);
    const commit = repo.objects.get(commitOid);
    if (commit === undefined) continue;
    const treeOid = parseCommit(commit.data).tree;
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (candidate.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      candidate.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      }
    }
  }
  // What the client already holds: everything reachable from its haves,
  // except the objects beyond a listed shallow boundary — a deepen lists its
  // old boundary as a have, and the parent beyond it is exactly what must be
  // delivered now. depthLimitedCommits already applies the same rule to
  // commits; apply it here to trees and blobs too.
  const haveClosure = collectReachable(lookup, haves);
  const beyondBoundary = new Set<string>();
  for (const boundary of oldShallow) {
    const object = lookup(boundary);
    if (object !== undefined && object.type === 'commit') {
      for (const oid of collectReachable(lookup, parseCommit(object.data).parents)) beyondBoundary.add(oid);
    }
  }
  const send: GitObject[] = [];
  for (const oid of [...candidate].sort()) {
    if (haveClosure.has(oid) && !beyondBoundary.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  return { objects: send, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

function packCacheKey(wants: string[], haves: string[], depth: number | null, oldShallow: string[]): string {
  return `${[...wants].sort().join(',')}|${[...haves].sort().join(',')}|${depth ?? ''}|${[...oldShallow].sort().join(',')}`;
}

/** Sideband pkt-lines carrying pack bytes (band 1), chunked under the pkt-line cap. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxChunk));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function fetchPackFor(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = packCacheKey(wants, haves, depth, oldShallow);
  const cached = repo.packCache.get(key);
  if (cached !== undefined) {
    // A hit serves the stored pack and shallow lists as-is; re-selecting the
    // objects on every identical clone would redo the whole history walk.
    return { pack: cached.pack, shallow: cached.shallow, unshallow: cached.unshallow };
  }
  const selection = selectFetchObjects(repo, wants, haves, depth, oldShallow);
  const pack = writePack(selection.objects);
  repo.packCache.set(key, { pack, shallow: selection.shallow, unshallow: selection.unshallow });
  return { pack, shallow: selection.shallow, unshallow: selection.unshallow };
}

function handleUploadPackV2(store: Store, repo: Repo, body: Buffer): HttpResult {
  const { packets } = decodePktLines(body);
  const lines = pktLinesText(packets);
  const commandLine = lines[0] ?? '';
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const args = lines.slice(delimIndex < 0 ? 1 : 1).filter((line) => line !== 'delim');
  // Arguments live after the delim packet; rebuild from packet order.
  const argLines: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { pastDelim = true; continue; }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data' && pastDelim) argLines.push(packet.payload.toString('utf8'));
  }
  void args;

  if (commandLine.startsWith('command=ls-refs')) {
    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    let unborn = false;
    for (const raw of argLines) {
      const line = raw.replace(/\n$/, '');
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    const parts: Buffer[] = [];
    const refs = sortedRefs(repo);
    const tip = defaultTip(repo);
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
    if (refs.length === 0) {
      if (unborn && keep('HEAD')) parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
    } else {
      if (symrefs && keep('HEAD') && tip !== undefined) {
        parts.push(pktLine(`${tip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
      for (const ref of refs) {
        if (!keep(ref.name)) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
        parts.push(pktLine(`${line}\n`));
      }
    }
    parts.push(FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  if (commandLine.startsWith('command=fetch')) {
    const wants: string[] = [];
    const haves: string[] = [];
    const oldShallow: string[] = [];
    let depth: number | null = null;
    for (const raw of argLines) {
      const line = raw.replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) oldShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    }
    const { pack, shallow, unshallow } = fetchPackFor(repo, wants, haves, depth, oldShallow);
    const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM];
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    parts.push(pktLine('packfile\n'), ...sidebandPack(pack), FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }

  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"unknown upload-pack command"}\n', 'utf8') };
}

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer): HttpResult {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const oldShallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) oldShallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const { pack, shallow, unshallow } = fetchPackFor(repo, wants, haves, depth, oldShallow);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack), FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, wantsV2: boolean): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== repo.owner) return notFound();
  try {
    if (body.length === 0) throw new Error('empty upload-pack request');
    return wantsV2 ? handleUploadPackV2(store, repo, body) : handleUploadPackV0(store, repo, body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"malformed git request"}\n', 'utf8') };
  }
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): HttpResult {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined || owner !== repo.owner) return notFound();
  const resultType = 'application/x-git-receive-pack-result';
  const report = (unpack: string, lines: string[]): HttpResult => {
    const inner: Buffer[] = [pktLine(`unpack ${unpack}\n`)];
    for (const line of lines) inner.push(pktLine(`${line}\n`));
    inner.push(FLUSH);
    const innerBuf = Buffer.concat(inner);
    const outer: Buffer[] = [];
    const maxChunk = 65515;
    for (let offset = 0; offset < innerBuf.length; offset += maxChunk) {
      const chunk = innerBuf.subarray(offset, Math.min(innerBuf.length, offset + maxChunk));
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    outer.push(FLUSH);
    return { status: 200, contentType: resultType, body: Buffer.concat(outer) };
  };

  try {
    const { packets, offset } = decodePktLines(body);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const fields = text.split(' ');
      if (fields.length < 3 || !isOid(fields[0]) || !isOid(fields[1])) throw new Error('bad push command');
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields[2] });
    }
    if (commands.length === 0) throw new Error('no push commands');
    const packBytes = body.subarray(offset);
    if (packBytes.length > 0) {
      if (!verifyPackChecksum(packBytes)) return report('index-pack failed', []);
      const parsed = readPack(packBytes);
      for (const object of parsed.objects) {
        const oid = hashObject(object.type as ObjType, object.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: object.type as ObjType, data: object.data });
      }
    }
    const lines: string[] = [];
    let changed = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | null = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'old oid does not match';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else {
          const object = repo.objects.get(command.newOid);
          if (object === undefined) reason = 'object not found';
          else if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') reason = 'not a commit';
        }
      } else {
        // Update.
        if (current === undefined) reason = 'ref does not exist';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else {
          const object = repo.objects.get(command.newOid);
          if (object === undefined) reason = 'object not found';
          else if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') reason = 'not a commit';
          else if (!isAncestor((oid) => repo.objects.get(oid), command.oldOid, command.newOid)) reason = 'non-fast-forward';
        }
      }
      if (reason !== null) {
        lines.push(`ng ${command.ref} ${reason}`);
        continue;
      }
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      changed = true;
      lines.push(`ok ${command.ref}`);
    }
    if (changed) store.touch(repo);
    return report('ok', lines);
  } catch {
    return report('index-pack failed', []);
  }
}

/** Peel a tag ref to its commit, for ls-refs. (Unused helper kept for clarity.) */
export function peelTag(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  return targetObject !== undefined && targetObject.type === 'commit' ? target : undefined;
}

export { flattenTree };
