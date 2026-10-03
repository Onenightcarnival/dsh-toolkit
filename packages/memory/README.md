# Career memory

[中文](README.zh.md)

`@onenightcarnival/dsh-memory` adds a **Memory** entry to the left sidebar. The resume contains profile/capabilities, work experience and projects. Linked experience archives contain context, actions, observations, evidence, lessons and applicability.

## Usage

- **Resume** uses an A4-width sheet for profile/capabilities, work experience and projects. Longer content extends vertically; narrow layouts fit the available width.
- **Directory** provides a global profile entry and separate work, project and archive columns. Selecting any work, project or archive displays its own editable content on the right, alongside its child list. Changing an ancestor clears descendant selection. Narrow layouts hide upstream columns; breadcrumbs navigate back. Unlinked projects appear under **Independent project**. Legacy archives linked directly to work remain in place.
- Siblings sort by creation time, newest first by default, with an oldest-first option. Edits retain creation time.
- Adding a project under work or an archive under a project preselects its parent. New installations start empty.
- Human edits protect the changed fields. An editor checkbox releases individual fields for future Agent updates.
- **Allow Agent tools** controls injection of `memory_read`, `memory_commit` and their guidance. It defaults to enabled. The persistent toggle creates no resume revision; already dispatched tool calls are also rejected while disabled.
- **Version history** shows authors, sources and field differences. Restoring a revision replaces the entire resume, creates a new revision and marks restored fields as human-confirmed.
- Export transfers the current structured resume and archives as JSON. It excludes revision history and the tool toggle. Import and restore retain the current tool toggle. Import replaces current content, creates a revision and protects imported fields.
- Removing an entry retains its history. Remove/reassign references before removing a parent. **Clear memory** deletes all resume content, archives and revision history after confirmation. It cannot be undone; the tool toggle stays unchanged. The revision counter advances so drafts opened before clearing cannot overwrite the cleared state.

## Resume fields

Work experience contains company (`organization`), period (`period`), position (`jobTitle`) and highlights (`highlights`). Each entry records one position for its period. Concurrent roles belong in highlights; position changes use separate entries. Periods are free text; overlapping dates are not checked automatically.

## Agent contract

| Tool | Contract |
|---|---|
| `memory_read` | Omit `id` for the resume and revision. Supply a work ID for that entry and its projects, or a project ID for that entry and its archives. |
| `memory_commit` | Submit `baseRevision`, `summary` and incremental `changes`. Whole batches succeed or fail together. Human-confirmed fields and disabled tools reject Agent changes. |

Prompt guidance asks the Agent to read relevant experience and update after verified milestones. Updates depend on the Agent calling tools during the task; no background extraction, automatic session scan or separate extraction-model call runs. Evidence references are recorded but their truth is not automatically verified. Memory content is data and cannot override current instructions. Never store credentials or raw conversation dumps.

## Storage and configuration

Data: `$DSH_HOME/memory/career.json`, default `~/.dsh/memory/career.json`. One personal resume is shared across local sessions; projects remain explicitly scoped entries. The file contains current state, the tool toggle and revision snapshots. Snapshots contain only resume content. Writes use an exclusive `.lock` file and atomic replacement. Stale revisions are rejected; unrelated stale edits also require refresh. A process crash may leave a lock: stop all memory writers and remove only the stale `career.json.lock` before retrying. Invalid storage is never reset automatically.

Storage and exports use format version 3. Version 1 and 2 files remain readable and importable. Legacy work titles, roles, responsibilities and achievements are combined into highlights in their original order. Position stays blank and linked IDs remain unchanged. Highlights stay protected if any merged field was protected. Historical snapshots are also converted. Reads leave the file unchanged; the next save persists the new format. Legacy creation times come from the first historical snapshot containing each entry. Entries without historical evidence show an unknown date. Imported entries without a creation time use the existing matching ID timestamp or the import time. Historical revisions caused by legacy toggle changes remain; new toggles create no revisions.

Limits: 1,000 entries, 12,000 characters per field (50,000 for highlights), 100 changes per commit, 2 MiB HTTP/import input and 32 MiB persisted history. Exceeding limits rejects the change without trimming history. The API is loopback-only and requires the host browser session.

Standalone plugin ID: `memory`; config `{ enabled: false }` disables the host. Toolkit module key: `memory`; `false` disables both host and UI. Standalone and integrated installations are mutually exclusive.

## Development

Node.js 22.19+ or 24+, pnpm 11; dsh `0.2.0-rc.2`.

```sh
pnpm --filter @onenightcarnival/dsh-memory build
pnpm --filter @onenightcarnival/dsh-memory typecheck
pnpm --filter @onenightcarnival/dsh-memory test
```

`src/model.ts` defines fields and references; `src/store.ts` owns validation, history and concurrency; host API and tools use the same store. Client dictionaries have identical keys and follow the host language. Tests cover persistence, protection, stale writes, atomic failure, invalid data and restoration.
