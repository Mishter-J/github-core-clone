# Forge — a standalone GitHub-compatible git forge

One Node 22 process, standard library only, no git binary, no outside
service, no proxy. It speaks the four surfaces a GitHub-compatible forge
needs, all backed by the same in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — `git-upload-pack` protocol
  v2 (and v0 when the client does not ask for v2), `git-receive-pack` v0,
  shallow fetch, deepen, packfiles built from scratch (SHA-1 objects,
  plain-object packs, no deltas).
- **REST v3** at `/api/v3` — repositories, branches, git refs, commits,
  contents (create/update/delete as real git commits), labels, issues,
  comments, pull requests, squash merge.
- **GraphQL v4** at `/api/graphql` — viewer, repository, issues and pull
  requests with cursor pagination, the five mutations
  (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`), `node(id:)` round-trips and `__type` introspection.
- **MCP** at `/mcp` — Streamable HTTP JSON-RPC 2.0: `server/discover` for
  the 2026-07-28 era, the legacy `initialize` handshake, and eight tools
  (`create_repo`, `get_repo`, `list_repos`, `create_issue`, `get_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`).

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<env url> node main.ts
```

The server binds an ephemeral port on 127.0.0.1, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, long-polls `$MAKEFUN_ENV_URL/done` and exits 0
when the trial ends. Without `MAKEFUN_ENV_URL` it exits 1.

`MAKEFUN_SHOP_TOKEN` is the Bearer token the REST, GraphQL and MCP
surfaces require; the git endpoints are unauthenticated, as in real git
hosting. `GET /healthz` answers `{"ok": true}`.

## Determinism

Nothing sent to the environment or a model uses the wall clock or unseeded
randomness. Timestamps come from a monotonic clock seeded by
`MAKEFUN_TRIAL_NOW` (fallback: a fixed constant); ids come from counters.
The same trial seed replays byte-for-byte.

## Layout

| File | What it holds |
| --- | --- |
| `main.ts` | Lifecycle: bind, register, poll `/done`, exit. |
| `app.ts` | HTTP routing, auth, JSON body parsing, request ids. |
| `store.ts` | Git objects, packs, reachability, the data model, the clock. |
| `git.ts` | pkt-line codec, protocol v0/v2 advertisements, fetch, receive-pack. |
| `rest.ts` | REST v3 handlers. |
| `graphql.ts` | GraphQL parser and executor. |
| `mcp.ts` | MCP JSON-RPC dispatch and tools. |

## License

MIT — see `LICENSE`.
