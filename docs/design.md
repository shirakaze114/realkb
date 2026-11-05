# Pi Knowledge Base — Design

## Confirmed requirements

- Build a Pi plugin.
- Ship an agent skill alongside the tools, explaining when and how to use realkb: connecting KBs, importing into an explicit target, searching, reading evidence, locating original PDFs, and citing sources. The skill guides behavior; tool implementations enforce access and approval rules. Skill authoring remains implementation work, not something already completed.
- V1 accepts PDFs and builds persistent knowledge bases that the agent can search and read.
- Support multiple knowledge bases, each containing its own sources (imported documents).
- A Pi session can connect to zero, one, or multiple KBs. The agent may access only the KBs connected to that session; no connected KBs means no KB access.
- Store configuration and knowledge-base data under `~/.pi/agent/realkb/` by default, outside the project directory (cwd), so KBs are available across projects while session connections determine which are accessible. This replaces the earlier `~/.local/share/realkb/` decision.
- Keep this persistent data directory separate from installed plugin code. Uninstalling/removing the plugin must not delete KB data or configuration; do not add uninstall cleanup that removes them. Deleting data must be an explicit separate user action.
- Keep original PDFs so the user can return to and verify the original source.
- V1 extracts existing PDF text, without OCR (recognizing text in scanned pages or images).
- Do not export images as separate files in V1 or attempt diagram understanding. Users consult the retained original PDF for figures.
- Keep simple page-numbered figure markers such as `[FIG p7-1]`, `[FIG p7-2]` where detectable, before splitting text into chunks, with a reference to the original page rather than an exported image. Imperfect placement is acceptable in V1. Do not alter the original PDF.
- Use bundled `pdfjs-dist` inside the plugin for V1 PDF text extraction and figure-marker detection so extraction works self-contained in Pi without external CLI dependencies.
- Provide an agent-facing import tool (`realkb_import`) requiring an explicit target KB and a list of paths. Each path may be a source file (`.pdf`, `.md`, `.txt`) or a directory:
  - Single specific file paths (`.pdf`, `.md`, `.txt`) are imported directly without needing `allow_ext`.
  - Directory import includes `.pdf` files recursively by default. Pass `allow_ext: ["md", "txt"]` (or `["md"]`) to also include `.md` / `.txt` files from directories.
  - Do not guess the destination KB. If the target KB is not yet connected to the current session, connect it as part of an approved import.
- Before importing a directory, the agent should inspect its contents, including subfolders, and flag unexpected or unrelated files. Require only allowed extensions (`.pdf` by default, plus any in `allow_ext`) after skipping all files and directories whose names begin with `.` (including their contents), such as `.DS_Store` and `.git`. Do not import a mixed directory containing disallowed files as-is.
- Queue imports to avoid conflicting writes. Reuse a single stored original PDF across KBs when the original-file hash matches; create a source membership in the target KB rather than another PDF copy.
- Content is not restricted to academic papers: books, manuals, reports, slides, and other PDF documents are welcome. This does not yet require support for every file format.
- Use permanent numeric KB IDs, unique within the local library and never reused, including after deletion.
- Generate source identities by hashing the original PDF file bytes, with a short Git-like hash shown in citations. Renaming a file preserves its identity; importing an already-successful identical file again into the same KB skips the duplicate, while failed or unfinished imports are retried under the same identity; changed file bytes create a new source identity without overwriting the previous source.
- Cite a source as `[rkb:001_c676ea9]` and a specific PDF page as `[rkb:001_c676ea9p7]`: `001` is the KB ID, `c676ea9` is the short source hash, and `p7` means the seventh page in the PDF file, not necessarily the printed page number.
- V1 uses one globally configured embedding model across all KBs, for both document indexing and query embedding. No per-KB model selection or multi-model retrieval.
- Keep v1 limited to PDF ingestion, knowledge-base retrieval, document identities, citations, and the session connection mechanism needed to scope KB access.

## Design philosophy

- Keep sources safe, help the agent find evidence, and keep everything else simple.
- Original PDFs are the authority; extracted text and search data help locate and read evidence, not replace the source.
- Agent-facing tools first; a management UI can follow after V1.
- Keep the user's library local and independent of projects. Local storage does not imply offline processing when using a remote embedding API.
- Prefer a useful, focused V1 over perfect layout reconstruction or diagram understanding.
- Make sources traceable and limitations visible; do not silently present incomplete extraction as complete.
- Import deliberately, inspect directories first, and avoid surprising background behavior.

## Commands, tools, connection, and approval controls

- V1 user slash commands:
  - `/realkb create <name>`: create a new knowledge base.
  - `/realkb connect [id-or-name]`: connect a KB to the current session.
  - `/realkb disconnect [id-or-name]`: disconnect a KB from the current session.
  - `/realkb list`: list local KBs and their connection status.
  - `/realkb config`: view or update global settings (such as approval mode and embedding configuration status, without exposing secret keys).
  - `/realkb cleanup`: explicitly remove unreferenced shared PDF files under `objects/` that are not referenced by any KB.
- V1 agent-facing tools (unified `realkb_` prefix):
  - `realkb_list`: list local KBs (ID, name, and current-session connection status). Does not expose document titles or contents of disconnected KBs.
  - `realkb_create`: create a new KB (asks for approval by default).
  - `realkb_connect`: connect or disconnect KBs for the current session (asks for approval by default when connecting).
  - `realkb_import`: import PDFs or PDF-only directories into an explicit target KB (asks for approval by default; connects the target KB if not already connected).
  - `realkb_search`: hybrid search across connected KBs (or an optional subset of connected KBs).
  - `realkb_read`: read passages or PDF pages from a connected KB.
  - `realkb_source_info`: resolve a specific source reference (`001_c676ea9`, `[rkb:001_c676ea9]`, or `001:c676ea9`) and return its metadata and original PDF path.
- Ask for approval by default, unless the user enables YOLO mode through `/realkb config` or explicitly grants a session-only no-prompt override. An explicit user command such as `/realkb connect` or `/realkb create` does not need a redundant approval dialog; agent-requested actions follow the effective approval setting.
- Support both a saved global approval configuration (`"approvalMode": "ask" | "yolo"`, default `"ask"`) and current-session overrides.
- Separate session "do not ask again for this session" overrides by action category (connecting/creating KBs versus importing PDFs).
- Use a small approval dialog for agent-requested actions with three choices: "Yes, ...", "No" with an optional reason, and "Yes, and don't ask again for [connections/imports] this session".
- In the import approval prompt, clearly notify the user that extracted PDF text will be sent to the configured embedding API.
- YOLO mode skips approval prompts only; it does not automatically connect all KBs or bypass connected-KB access checks.
- A session override must not change the saved global preference.
- These basic commands and permission dialogs are needed in V1; the richer KB/source-management interface remains future scope.

## Approved session behavior

| Operation | Connected KBs | Session approval overrides |
| --- | --- | --- |
| Start a new session | None | No overrides; use global settings |
| Resume a saved session | Restore that session's connections | Restore that session's choices |
| Fork into a new session | Inherit connections at the fork point | Reset to global settings |
| Rewind within a session | Restore connections at the selected point | Restore choices at the selected point |
| Reload the plugin | Keep unchanged | Keep unchanged |

- Store connection state and session approval choices through Pi's session persistence, following the active conversation branch rather than abandoned histories. Do not introduce a separate session-storage system in the KB directory.
- Global settings still apply when session overrides are absent, including globally configured YOLO mode.
- Disconnecting a KB blocks further access through KB tools; it does not erase passages already retrieved into the conversation.
- Rewinding or branching the conversation does not undo library changes: imported PDFs remain stored. Only the session's connections and approval choices follow the rules above.

## Approved identities and citations

- Numeric KB IDs must remain unique even after KB deletion. Record `lastKbId` in `~/.pi/agent/realkb/state.json` (separate from user-edited `config.json`) and allocate each new KB ID as `max(lastKbId, highest numeric folder in kbs/) + 1`, formatted with at least three digits (`001`, `002`, ...).
- Renaming a KB does not change its ID. Deleting a KB must never make an old citation point to a different KB later.
- Hash original PDF file bytes with SHA-256 (`64`-character lowercase hex internally in `objects/<sha256>.pdf` and `sources/<sha256>/`).
- Citations use a 7-character hex prefix by default (`[rkb:001_c676ea9]`). At import time, check existing sources in that KB; if a different PDF shares the 7-character prefix, assign the new source the shortest longer prefix (`8+` characters) that is unique within that KB while preserving already-issued citation IDs.
- Page suffixes use `p` followed by a positive, one-based PDF page number, as in `[rkb:001_c676ea9p7]`. The document-only form remains `[rkb:001_c676ea9]`.
- Render `[rkb:001_c676ea9]` and `[rkb:001_c676ea9p7]` citations in Pi output as clickable hyperlinks (`file://` URLs pointing to the stored original PDF in `objects/<full-hash>.pdf`, with `#page=N` when a page suffix is present) so Ctrl-Click opens the PDF.

## Approved import failure and retry behavior

- Keep successful imports when another PDF fails, and continue processing the remaining files. Do not roll back the entire batch because one document fails.
- Preserve the original PDF and completed extraction if the embedding API fails, so retrying can reuse valid completed work rather than unnecessarily starting over.
- Never mark failed or unfinished documents as ready. Record and explain the failing step.
- Reimporting a failed or unfinished document retries it under the same source identity; only already-successful duplicates are skipped.
- Flag scanned or unreadable pages. If some pages provide usable text, clearly disclose incomplete coverage; if no usable text is extracted, do not claim a successful text import.
- Return a clear batch summary with per-document outcomes and reasons, separating ready, already imported, and failed/unfinished sources.
- Support background execution and live progress for `realkb_import` (modeled on `realtasks`):
  - `run_in_background` defaults to `true` when importing `>= 2` PDFs (and `false` for a single PDF unless overridden): starts the import in the background right after approval and returns a job ID (`imp-1`) immediately. Foreground imports stream live `onUpdate` progress and automatically promote to the background after `timeout` seconds (default `15s`) so slow embedding calls never block the session.
  - Display live per-file and per-chunk embedding progress (`[1/3] paper.pdf · embedding 16/48 chunks (33%)`) in a `realtasks`-style TUI dock widget (`realkb-dock`) and status bar (`📚 KB: 001 · ✱ imp-1 ...`), plus `/realkb jobs` and `/realkb stop [id|all]`.
  - Deliver a `<realkb-notification>` custom message (with compact TUI message rendering and `agent_before_settle` support) when a background import finishes.
- Keep V1 recovery simple: safe storage, honest status, and explicit retries, not an elaborate automatic recovery system.

## Approved retrieval and vector storage

- `realkb_search`: search only connected KBs (or an optional specified subset of connected KBs) and return relevant original-text passages with source references, `chunk_index`, and PDF page locations.
- `realkb_read`: read a passage or page range from a connected KB, accepting citation syntax (`[rkb:001_c676ea9p7]`, `001_c676ea9p7`) or colon syntax (`001:c676ea9p7`), plus optional `chunk` index (`± neighbors` surrounding chunks) or `pageEnd` range.
- `realkb_source_info`: resolve an explicit source reference (`001_c676ea9`, `[rkb:001_c676ea9]`, or `001:c676ea9`) and return its original PDF path and source metadata. Resolving a specified source reference is permitted even if that KB is not currently connected, and does not connect the KB or grant `realkb_search`/`realkb_read` access.
- Tool references and citations identify the same KB/source/page; for example, `001_0123abcp6` and `001:0123abcp6` correspond to `[rkb:001_0123abcp6]`.
- Embed chunks of original extracted text during import. Embed the query during search and compare it with stored chunk vectors; do not re-embed documents on every query.
- Do not generate or embed document summaries in V1, or use summaries to filter which documents can be searched.
- Use SQLite with `sqlite-vec`, with one `index/search.sqlite` database per KB holding chunks, vectors, and source/page associations. Store vectors as binary numeric data rather than large JSON files.
- Search the connected KB databases and merge their best results. Search data remains per-KB even when original PDF storage is shared.
- Before committing implementation to this backend, verify SQLite/`sqlite-vec` loads in Pi's actual runtime and test representative library sizes. Do not promise unbounded search performance.
- Detect incompatible embedding model/configuration changes rather than silently mixing old document vectors with incompatible query vectors. V1 still uses only one global model; multi-model routing is not required.

## Approved search approach — realctx as an implementation reference

- Reuse/adapt realctx's storage and search approach, not its memory-management behavior. This does not mean sharing realctx's database, requiring realctx at runtime, or copying its entire implementation.
- Use hybrid retrieval: vector similarity for meaning and SQLite full-text search for keywords. Combine ranked candidates and remove duplicate hits; exact fusion parameters remain implementation details.
- Keep keyword search available when query embedding is unavailable, and disclose that meaning-based search could not run. A query-embedding failure does not make unfinished imports ready.
- Cache embeddings for unchanged text using a text hash and embedding-configuration identity. Never reuse vectors from an incompatible embedding space.
- Keep original passages alongside their vectors: an embedding is a list of numbers used to find related text, not a written summary or an answer.
- realkb has its own behavior: connected-KB boundaries, source memberships, PDF-page citations, approvals, import queue, and failure/retry rules. Do not import realctx's usage/path-based memory ordering, importance judgments, automatic memory rewriting/merging, forgetting, or context compression.
- Reference source inspected at `~/.pi/agent/git/github.com/WtzLAS/realctx/`, especially `src/db.ts`, `src/api.ts`, `src/store.ts`, `src/shared.ts`, and `extensions/realctx/`. SQLite/vector storage, embedding requests/cache, and safe concurrent-write patterns are useful references, not a blanket mandate to copy them.

### Plain-language flow

```text
IMPORT
Original PDF -> extract page text -> split into chunks
                                        |
                         +--------------+--------------+
                         |                             |
                 Reuse cached vector           Prepare keyword index
                 or embed chunk text                   |
                         |                             |
                         +--------------+--------------+
                                        |
                        Store text, vectors, and page links
                        in this KB's search.sqlite

SEARCH (connected KBs only)
Search text
    |
    +-> Embed query -> compare with stored vectors -> meaning-ranked hits
    |
    +-> Search keyword index -----------------------> keyword-ranked hits
                                                       |
                         Combine rankings and remove duplicate hits
                                                       |
                              Return original passages + page citations
                                                       |
                                   Pi agent reads evidence and answers
```

- Document embeddings are prepared at import, not recalculated for every query. The query is embedded at search time, with compatible cached embeddings reused where available.
- Do not generate summaries before retrieval in V1, or use document summaries to exclude sources from search.

## Approved on-disk layout

```text
~/.pi/agent/realkb/
├── config.json
├── state.json
├── objects/
│   └── <full-hash>.pdf
├── kbs/
│   ├── 001/
│   │   ├── kb.json
│   │   ├── sources/
│   │   │   └── <source-hash>/
│   │   │       ├── source.json
│   │   │       └── pages.json
│   │   └── index/
│   │       └── search.sqlite
│   └── 002/
│       └── …
└── tmp/
```

- `config.json`: global preferences (`approvalMode`: `"ask" | "yolo"`, default `"ask"`, and OpenAI-compatible `embedding` settings); not session connections. Keep file permissions `0600`.
- `state.json`: internal durable state such as `lastKbId` so deleted KB numbers are never reused.
- `kbs/<kb-id>/kb.json`: the KB's name, permanent numeric ID, and details. Renaming the KB does not change its identity. `001` and `002` above illustrate the numeric IDs; their allocation must never reuse a deleted KB's number.
- `objects/<full-hash>.pdf`: one unchanged original PDF per unique SHA-256 file hash, shared across KBs and independent of the input file's continued existence. This supersedes storing `original.pdf` separately inside each KB source folder.
- `sources/<source-hash>/`: a source's membership and extracted data in this KB, using its full SHA-256 hash internally rather than a shortened citation prefix.
- `source.json`: references the shared original and holds document information such as original filename, full hash, assigned short hash, import date, and processing status. A metadata reference is sufficient; an operating-system symlink is not required.
- Sharing original storage does not connect KBs or grant access to unrelated sources. Never auto-delete PDFs in `objects/` when a source or KB is removed; `/realkb cleanup` explicitly removes unreferenced PDFs in `objects/` that are no longer referenced by any KB.
- `pages.json`: full extracted text organized by PDF page, retaining page-numbered figure markers (`[FIG p7-1]`). Keep this text, not just search chunks.
- `index/search.sqlite`: rebuildable chunks and vector-search data using SQLite with `sqlite-vec`; exact database schema remains open.
- `tmp/`: temporary import work, not searchable KB content.
- Discover KBs by scanning their directories and reading each `kb.json`. Do not maintain a separate `kbs.json` registry in V1. Each KB's own metadata is authoritative; any future cached catalog must be rebuildable.
- This is the approved storage design only. No KB directories or implementation files have been created.
- Installed Pi package-manager source was inspected: Git removal targets the package checkout under the managed Git install root; npm removal uninstalls the package under the managed npm root. Neither path inherently removes the sibling `realkb/` data directory. This is verified source behavior, not an uninstall experiment.
- Deleting the entire `~/.pi/agent/` directory would also delete `realkb/`; plugin removal and deleting Pi's whole data directory are different operations. Preserve that distinction in user-facing documentation.

## Future scope — not for v1

- **TODO — Interactive TUI Manager (`/realkb` or `/realkb manage`)**: Spawn an interactive TUI overlay (modeled after `realtasks`'s `/tasks` TUI) to browse KBs, inspect/remove sources, view running/completed import job logs, and toggle session connections interactively.
- Zotero-connect.
- Knowledge-connect (meaning and scope to be clarified).
- Per-KB embedding-model selection and multi-model retrieval.
- Document-summary generation/embedding and summary-first retrieval.
- An in-Pi interface for managing the KB and sources, with possible commands such as `/realkb manage` and `/realkb import`. These are future UI ideas, not required for V1.

## User context

- The user is not a professional IT worker. Explain technical choices in practical, plain language.
- Keep approved project requirements and design in `docs/design.md` (renamed from `docs/NOTES.md`). Store reusable operational knowledge and setup/API pitfalls in realctx instead of appending every discovery to this document; never store credentials.

## Chunking design

Chunking uses a deterministic, structure- and sentence-aware pipeline without extra LLM calls during import:

1. **Per-page text normalization and artifact cleanup**
   - Preserve page-level extracted text in `pages.json`; perform cleanup on a derived chunking/search representation with mappings back to source pages and text spans.
   - Remove confidently detected repeating page headers/footers and page-number artifacts from that derived representation before cross-page assembly. Do not remove arbitrary standalone numbers that might be document content; retain uncertain cases.
   - Normalize whitespace conservatively while keeping blank lines, list markers (`-`, `*`, `1.`, `(a)`), figure markers, and heading lines intact. Unicode compatibility normalization (`NFKC`) can change meaningful symbols: use it only in a mapped search representation where appropriate, not as a destructive rewrite of saved page text.
   - Reconstruct hard-wrapped lines within a paragraph:
     - De-hyphenate confidently identified line-break word splits (`inter-\nnational` -> `international`) while retaining compound hyphens (`self-\ncontained` -> `self-contained`). A lowercase next letter alone cannot distinguish these cases; preserve the hyphen when uncertain.
     - Join wrapped lines with a space for space-delimited scripts (Latin, Cyrillic, etc.) and without inserting spaces between adjacent CJK characters.

2. **Cross-page block and sentence stream with page provenance**
   - Represent extracted text as ordered blocks (heading, paragraph, list/table block) carrying `{ text, pageStart, pageEnd }` plus source-span mappings that locate text within its original pages. Page ranges alone are insufficient to identify which page supports a particular sentence.
   - Allow chunks to cross PDF page boundaries to preserve complete sentences while retaining accurate text-to-page mappings. Missing terminal punctuation and a lowercase/CJK continuation are hints, not proof: use available layout/block evidence and avoid merging headings, independent columns, or unrelated blocks. Preserve uncertain boundaries rather than inventing continuity.

3. **Natural sentence and word segmentation (`Intl.Segmenter`)**
   - Use the runtime's built-in `Intl.Segmenter` with `granularity: "sentence"` as the baseline for multilingual sentence segmentation without external NLP dependencies. Choose/document a locale policy rather than relying silently on the host default. Abbreviations, quotes, technical text, and punctuation remain heuristic; semicolons are not guaranteed sentence boundaries. Evaluate English and CJK examples instead of promising perfect segmentation.
   - Keep short lists/tables together where practical. When a single oversized sentence or unpunctuated block exceeds the chunk budget, fall back to clause punctuation (`,`, `;`, `：`, `，`, line breaks), then natural word boundaries via `Intl.Segmenter` with `granularity: "word"`. For a single oversized token-like string (for example, a long URL), allow a final Unicode-safe split; do not split inside a surrogate pair or grapheme cluster. Every fallback must make forward progress.
   - Use the embedding model's tokenizer/input limit where available. A fast model-agnostic token estimate may guide packing, but cannot guarantee a hard provider limit, especially for code, symbols, or uncommon scripts. Use conservative request sizes and bounded split-and-retry on explicit input-length errors; report unrecoverable failures rather than retrying indefinitely.

4. **Structure-aware greedy packing and whole-sentence overlap**
   - Target `~600 tokens` per chunk (flexible soft window `500–800 tokens`) and `~100 tokens` of overlap (`80–120 tokens`).
   - Prefer heading and paragraph boundaries: pack whole blocks into the current chunk as long as they fit within the target window, and keep a heading attached to the first paragraph or sentences that follow it so headings are never stranded at the end of a chunk.
   - If a single paragraph exceeds the remaining window, pack it sentence by sentence.
   - Start the next chunk by rewinding `1–3` complete trailing sentences from the previous chunk until the overlap reaches roughly `80–120 tokens` (do not rewind across a major heading boundary, and skip whole-sentence overlap if a single sentence alone exceeds the overlap budget).

5. **Chunk indexing, citations, and neighborhood reads**
   - Assign sequential `chunk_index` values (`0, 1, 2, ...`) per document and store `{ chunk_index, page_start, page_end, text }` plus source-span mappings in `search.sqlite`; the exact mapping schema is an implementation detail.
   - Expose the full `page_start..page_end` range and source-span mappings for multi-page hits. A single-page citation (`[rkb:001_c676ea9p7]`) must identify the page containing the cited evidence, not automatically the first or majority page. If evidence spans pages, return the relevant individual page citations; no new page-range citation grammar is required for V1.
   - Individual chunks do not need to preserve all meaning independently: use `chunk_index` in `realkb_search` and `realkb_read` to merge or deduplicate adjacent overlapping hits and to fetch `chunk_index ± k` when the agent reads surrounding context. Keep these operations within the same KB/source, preserve page mappings, bound response sizes, and guarantee progress even when overlap cannot fit.

## Configuration schema (`~/.pi/agent/realkb/config.json`)

- Keep V1 configuration small: OpenAI-compatible embedding-service connection details (`embedding`: `endpoint`, `apiKey`, `model`, `dimensions`, `queryInstruction`, `timeoutMs`, `batchSize`) plus `approvalMode` (`"ask"` by default, optional `"yolo"`).
- Keep `~/.pi/agent/realkb/config.json` with mode `0600`; never print or log secret API keys.
- Reuse Pi's active conversational model for answering; no separate chat/summarization model setup is needed for V1.
- Keep chunk sizes, overlap, ranking parameters, database details, retries, and cross-session file locking as sensible implementation defaults rather than required user decisions.
- Configuration and storage share the agreed default directory `~/.pi/agent/realkb/`; connected KBs and session approval overrides are stored in Pi's session persistence, and durable counter state (`lastKbId`) lives in `~/.pi/agent/realkb/state.json`.

## Remaining implementation details (non-blocking)

- Exact JSON field names inside `kb.json`, `source.json`, and `pages.json`.
- Exact SQLite table/index definitions in `index/search.sqlite`, vector similarity metric, and hybrid rank-fusion weights (adapting `realctx`'s FTS5 + `sqlite-vec` patterns).
- Cross-session file lock implementation under `~/.pi/agent/realkb/` to serialize concurrent imports and `state.json` updates across Pi processes.
- Runtime verification of `pdfjs-dist` and `sqlite-vec` inside Pi's runtime during implementation.

## Handoff

All core V1 product and design decisions are now confirmed in this document. No plugin or skill implementation has begun yet. When implementation starts, build the Pi extension (`realkb_*` tools and `/realkb` commands), the storage/extraction/chunking/search engine under `~/.pi/agent/realkb/`, and the bundled Pi skill teaching KB connection, directory inspection before import, hybrid retrieval, and citation formatting.
