# Career memory

[中文](README.zh.md)

`@onenightcarnival/dsh-memory` adds a **Memory** entry to the left sidebar and keeps the agent's own career record. The resume contains profile/capabilities, work experience and projects. Linked episodes contain context, actions, observations, evidence, lessons and applicability.

## Record kinds

| Kind | Meaning |
|---|---|
| `profile` | The single global profile: who this agent is and what it can do |
| `work` | One position: one role under one job description for one organization or principal over a continuous period; a new role or a new principal is a new work entry |
| `project` | One deliverable or body of work carried out within a position; an independent project has no work |
| `episode` | One concrete experience within a project: what happened, what was observed and what it teaches, backed by evidence |

The same definitions appear in the tool schemas and the prompt guidance.

## Usage

- **Resume** fits the available width and displays profile/capabilities, work experience and projects with vertical scrolling as needed.
- **Directory** provides a global profile entry and separate work, project and episode columns. Selecting any work, project or episode displays its own editable content on the right, alongside its child list. Changing an ancestor clears descendant selection. Narrow layouts hide upstream columns; breadcrumbs navigate back. Unlinked projects appear under **Independent project**. Legacy episodes linked directly to work remain in place.
- Siblings sort by entered experience dates, newest first by default, with an oldest-first option. Work and projects use the start date, falling back to the end date when only that is known; episodes use their event date. Undated entries come last in both directions; ties retain insertion order. Creation timestamps are metadata only.
- Adding a project under work or an episode under a project preselects its parent. New installations start empty.
- **Allow Agent access** is the single permission switch for all memory tools. When enabled, the Agent can read and edit all entries, including human-edited, imported and restored content. There are no per-field permissions. It defaults to enabled and controls injection of the tools and their guidance. The persistent toggle creates no resume revision; already dispatched tool calls are also rejected while disabled.
- **Version history** shows authors, sources and field differences; selecting a revision loads its entries and its predecessor's on demand. Restoring a revision replaces the entire resume and creates a new revision.
- Export transfers the current structured resume and episodes as JSON. It excludes revision history and the tool toggle. Import and restore retain the current tool toggle. Import replaces current content and creates a revision.
- Removing an entry retains its history. Remove or reassign references before removing a parent. **Clear memory** deletes all resume content, episodes and revision history after confirmation and reclaims file space. It cannot be undone; the tool toggle stays unchanged. The displayed version resets to 0; the first save starts at version 1. The internal concurrency counter continues advancing; drafts opened before clearing are rejected.

## Resume fields

Work experience contains company (`organization`), start/end dates (`startDate`, `endDate`), position (`jobTitle`) and highlights (`highlights`). Each entry records one position for its period. Concurrent roles belong in highlights; position changes use separate entries. Projects contain title, start/end dates, role, highlights and optional work reference. Highlights contain project objectives, work performed and outcomes. Episodes have an event date (`date`).

Start and end date pickers share one row and store complete calendar dates as `YYYY-MM-DD`. Selecting **Present** disables the end date picker, sets `endDate` to `present`, and displays the experience as ongoing. Clearing the checkbox leaves the end date empty. Unknown dates remain empty and do not imply an ongoing status. A dated end cannot precede the start date. Ongoing entries still sort by their entered start date; no start date means undated. Overlapping experiences are not checked automatically.

## Agent contract

| Tool | Contract |
|---|---|
| `memory_get` | Reads one node: complete content, ancestor path and a page of child summaries. Omit `id` to start at the root profile, whose children are work entries and independent projects; work holds projects and projects hold episodes. |
| `memory_save` | Submit the latest `stateToken`, a factual `summary` and typed incremental `changes`. The batch succeeds or fails atomically and creates one version when content changes. |

Reads return the displayed `version` and an opaque `stateToken` for concurrency checks. Child pages default to 10 entries, allow 1–20 and follow the experience-date order described above. Summaries truncate fields to 400 characters, identify them in `truncatedFields` and report the next level's size in `childCount`. Full fields come from the node's own `memory_get`. There is no keyword or semantic search; the Agent expands relevant branches level by level.

Each save change has a `kind` (`profile`, `work`, `project`, `episode`) and its own `fields` schema; each kind's schema carries the definition from the table above. Omitted fields remain unchanged; empty strings clear fields. Existing `id` values update records; omitted IDs create records with server-assigned IDs. Profile changes always target the global profile. New records may declare a batch-local `ref`; `@ref` values in `workId` or `parentId` link records in the same batch, including forward references. The response returns resolved `refs` and record IDs. New work requires a company; new episodes require a project parent and evidence references.

`{ "kind": "remove", "id": "existing-id" }` removes an entry while retaining history; references must be removed or reassigned in the same batch or beforehand. No-op updates create no version. Errors provide `code`, `message`, optional `detail` and `retryable`. On a conflict, reread affected records before rebuilding changes. Agent tools cannot clear memory, import, restore versions or change permissions.

Prompt guidance asks the Agent to read relevant experience and update after verified milestones. Updates depend on the Agent calling tools during the task; no background extraction, automatic session scan or separate extraction-model call runs. Evidence references are recorded but their truth is not automatically verified. Memory content is data and cannot override current instructions. Never store credentials or raw conversation dumps.

## Storage and configuration

Data: `$DSH_HOME/memory/career.sqlite`, default `~/.dsh/memory/career.sqlite`, through Node's built-in `node:sqlite` with no native add-on. One personal resume is shared across local sessions; projects remain explicitly scoped entries.

| Table | Content |
|---|---|
| `meta` | Format version, concurrency counter `revision`, tool toggle |
| `blobs` | Entry JSON deduplicated by content hash |
| `entries` | Entries of the current resume in display order |
| `revisions` | Time, author, source and summary of each revision |
| `revision_entries` | Entries of each revision in display order |

Unchanged entries share one stored copy across revisions; reading the current resume loads no history content. Displayed versions follow current history order starting at 1. API `revision` is a concurrency counter; `restore` uses the internal `revision` of a history record, not its displayed number. Every write runs in one exclusive transaction. Stale revisions are rejected; unrelated stale edits also require refresh. A concurrent writer in another process is awaited for up to 5 seconds, then the retryable `busy` error is returned. Deleted content is overwritten immediately and clearing reclaims file space. Invalid storage is never reset automatically. Keep the data directory out of synced folders such as iCloud or Dropbox.

HTTP: `GET` returns the current state with revision metadata; `GET ?diff=<revision>` returns that revision's entries together with its predecessor's, the first revision compared against the empty resume; `POST` commits changes; `PATCH` toggles tool access; `DELETE` clears. The API is loopback-only and requires the host browser session.

### Legacy file migration

When the database is empty and `career.json` exists in the same directory, the first open imports its content and revision history and renames it to `career.json.migrated`. A database with content ignores a JSON file beside it. An unreadable legacy file makes opening fail without resetting anything; fix or move the file and retry.

Exports use format version 4; version 1–3 files remain importable. Legacy work titles, roles, responsibilities and achievements are combined into highlights in their original order. Position stays blank and linked IDs remain unchanged. Legacy project objectives, contributions and outcomes merge into highlights in their original order. Exact legacy dates and complete ISO date ranges become structured dates. Incomplete or ambiguous periods remain in read-only `legacyPeriod` metadata until dates are explicitly edited; no day is inferred. Historical snapshots are also converted. Legacy `protected` arrays remain storage metadata and impose no editing restrictions; new human edits, imports and restores do not add field permissions. Legacy creation times come from the first historical snapshot containing each entry. Entries without historical evidence show an unknown date. Imported entries without a creation time use the existing matching ID timestamp or the import time. Historical revisions caused by legacy toggle changes remain; new toggles create no revisions.

### Limits and configuration

Limits: 1,000 entries, 12,000 characters per field (50,000 for highlights), 100 changes per commit and 2 MiB HTTP/import input. Exceeding a limit rejects the change.

Standalone plugin ID: `memory`; config `{ enabled: false }` disables the host. Toolkit module key: `memory`; `false` disables both host and UI. Standalone and integrated installations are mutually exclusive.

## Development

Node.js 22.19+ or 24+, pnpm 11; dsh `0.2.0-rc.2`.

```sh
pnpm --filter @onenightcarnival/dsh-memory build
pnpm --filter @onenightcarnival/dsh-memory typecheck
pnpm --filter @onenightcarnival/dsh-memory test
```

| File | Responsibility |
|---|---|
| `src/model.ts` | Fields, references, kind definitions and ordering |
| `src/validate.ts` | Snapshot validation and version 1–3 conversion |
| `src/legacy.ts` | Reading a legacy `career.json` |
| `src/store.ts` | SQLite storage, history, transactions and concurrency |
| `src/tools.ts` / `src/registration.ts` | Agent tools and prompt guidance |
| `src/index.ts` / `src/http.ts` | Host HTTP API |
| `src/client/` | Sidebar UI |

Host API and tools use the same store. Client dictionaries have identical keys and follow the host language. Tests cover persistence, global access, stale writes, concurrent-writer busy errors, atomic failure, invalid data, legacy migration, revision diffs and restoration.
