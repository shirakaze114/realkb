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
- Keep simple figure markers such as `[FIG1]` where detectable, before splitting text into chunks, with a reference to the original page rather than an exported image. Exact syntax is not finalized; imperfect placement is acceptable in V1. Do not alter the original PDF.
- Provide an agent-facing import tool (tentative name: `rkb_importpdf`) requiring an explicit target KB and a list of paths. Each path may be a PDF or a directory; directory import includes PDFs recursively, including all subfolders. Do not guess the destination KB.
- Before importing a directory, the agent should inspect its contents, including subfolders, and flag unexpected or unrelated files. Require PDF-only contents after skipping all files and directories whose names begin with `.` (including their contents), such as `.DS_Store` and `.git`. Do not import a mixed directory containing other non-PDF files as-is.
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

## Connection and approval controls

- V1 includes a user command such as `/realkb connect` and an agent-facing tool that can request KB connections.
- Ask for approval by default, unless the user enables YOLO mode through `/realkb config` or explicitly grants a session-only no-prompt override.
- Support both a saved global approval configuration and a current-session override, including review and YOLO/no-prompt behavior.
- Use a small approval dialog for agent-requested actions. The user's import example has three choices: "Yes, import", "No" with an optional reason, and "Yes and do not ask me for this session". Apply the corresponding wording to connection requests.
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

- Numeric KB IDs must remain unique even after KB deletion. Keep durable allocation history rather than deriving the next ID solely from surviving KB folders; exact counter storage is not yet selected.
- Renaming a KB does not change its ID. Deleting a KB must never make an old citation point to a different KB later.
- Retain full source hashes internally; citation hashes may be shortened.
- Page suffixes use `p` followed by a positive, one-based PDF page number, as in `[rkb:001_c676ea9p7]`. The document-only form remains `[rkb:001_c676ea9]`.
- The user considers hash collisions unlikely and wants to avoid an elaborate collision-handling system in V1. A minimal safety check is proposed below, not yet approved.

## Approved import failure and retry behavior

- Keep successful imports when another PDF fails, and continue processing the remaining files. Do not roll back the entire batch because one document fails.
- Preserve the original PDF and completed extraction if the embedding API fails, so retrying can reuse valid completed work rather than unnecessarily starting over.
- Never mark failed or unfinished documents as ready. Record and explain the failing step.
- Reimporting a failed or unfinished document retries it under the same source identity; only already-successful duplicates are skipped.
- Flag scanned or unreadable pages. If some pages provide usable text, clearly disclose incomplete coverage; if no usable text is extracted, do not claim a successful text import.
- Return a clear batch summary with per-document outcomes and reasons, separating ready, already imported, and failed/unfinished sources.
- Keep V1 recovery simple: safe storage, honest status, and explicit retries, not an elaborate automatic recovery system.

## Approved retrieval and vector storage

- `realkb_search`: search only connected KBs and return relevant original-text passages with source references and PDF page locations.
- `realkb_read`: read a passage identified by a search result or a specified PDF page. Example source/page reference: `001:0123abcp6`; exact argument schema and passage handles remain to be designed.
- `realkb_source_info`: resolve a source reference such as `001:0123abc` and return its original PDF path and source information. This does not connect or grant access to an otherwise disconnected KB.
- Tool references and citations identify the same KB/source/page; for example, `001:0123abcp6` corresponds to `[rkb:001_0123abcp6]`.
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

- `config.json`: global preferences, including approval mode and embedding-service settings; not session connections.
- `kbs/<kb-id>/kb.json`: the KB's name, permanent numeric ID, and details. Renaming the KB does not change its identity. `001` and `002` above illustrate the numeric IDs; their allocation must never reuse a deleted KB's number.
- `objects/<full-hash>.pdf`: one unchanged original PDF per unique file hash, shared across KBs and independent of the input file's continued existence. This supersedes storing `original.pdf` separately inside each KB source folder.
- `sources/<source-hash>/`: a source's membership and extracted data in this KB, using its full hash internally rather than a shortened citation prefix.
- `source.json`: references the shared original and holds document information such as original filename, hash, import date, and processing status; exact schema remains open. A metadata reference is sufficient; an operating-system symlink is not required.
- Sharing original storage does not connect KBs or grant access to unrelated sources. Removing a source membership must not delete a PDF still referenced by another KB.
- `pages.json`: full extracted text organized by PDF page, retaining simple figure markers. Keep this text, not just search chunks.
- `index/search.sqlite`: rebuildable chunks and vector-search data using SQLite with `sqlite-vec`; exact database schema remains open.
- `tmp/`: temporary import work, not searchable KB content.
- Discover KBs by scanning their directories and reading each `kb.json`. Do not maintain a separate `kbs.json` registry in V1. Each KB's own metadata is authoritative; any future cached catalog must be rebuildable.
- This is the approved storage design only. No KB directories or implementation files have been created.
- Installed Pi package-manager source was inspected: Git removal targets the package checkout under the managed Git install root; npm removal uninstalls the package under the managed npm root. Neither path inherently removes the sibling `realkb/` data directory. This is verified source behavior, not an uninstall experiment.
- Deleting the entire `~/.pi/agent/` directory would also delete `realkb/`; plugin removal and deleting Pi's whole data directory are different operations. Preserve that distinction in user-facing documentation.

## Future scope — not for v1

- Zotero-connect.
- Knowledge-connect (meaning and scope to be clarified).
- Per-KB embedding-model selection and multi-model retrieval.
- Document-summary generation/embedding and summary-first retrieval.
- An in-Pi interface for managing the KB and sources, with possible commands such as `/realkb manage` and `/realkb import`. These are future UI ideas, not required for V1.

## User context

- The user is not a professional IT worker. Explain technical choices in practical, plain language.
- The user has access to an embedding API and wants its settings requested through configuration. Its provider, endpoint, model, and compatibility have not been confirmed.
- Keep approved project requirements and design in `docs/design.md` (renamed from `docs/NOTES.md`). Store reusable operational knowledge and setup/API pitfalls in realctx instead of appending every discovery to this document; never store credentials.

## Proposed interpretations — not yet approved

- Scope image placeholders to their document so identical marker names in different PDFs do not collide.
- Target an OpenAI-compatible embedding API, with configurable API address, API key, and model; the user suggested compatibility tentatively. No provider or model has been selected.
- Use a minimal short-hash collision check at import time rather than elaborate collision machinery. If necessary, give the new source a longer short ID while preserving already issued citation IDs; exact assignment and lookup behavior remain open.
- Enforce session-connected KB scope in KB tools, not merely through instructions to the model. This is a plugin access boundary, not a sandbox for unrestricted filesystem tools.
- Resolve citations back to stored documents and, optionally, specific pages.
- Clearly disclose that a remote embedding API receives extracted text before transmitting private documents.
- A session's "do not ask again" approval applies to that action type (for example, connecting versus importing), not every possible action; confirm permission granularity with the user.
- YOLO skips approval prompts only; it does not automatically connect all KBs or bypass connected-KB access checks.
- An explicit user `/realkb connect` command does not need a redundant approval dialog; agent-requested connections follow the effective approval setting.
- Retain unreferenced shared originals in V1 instead of introducing automatic garbage collection; exact deletion/cleanup behavior is not yet approved.
- The import queue must coordinate writers across Pi sessions, with safe metadata/ID writes. A per-session queue alone does not prevent cross-session races; exact locking/queue mechanism is an implementation detail.

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

## Configuration discussion — proposed user-facing scope

- Keep V1 configuration small: embedding-service connection details plus approval mode (ask by default, optional YOLO).
- Embedding setup needs the API address, model name, and credentials if the service requires them. Decide secure credential handling during implementation; never put real keys in these notes or logs.
- Reuse Pi's active conversational model for answering; no separate chat/summarization model setup is needed for V1.
- Keep chunk sizes, overlap, ranking parameters, database details, retries, and similar machinery as sensible implementation defaults rather than required user decisions.
- Configuration and storage share the agreed default directory `~/.pi/agent/realkb/`; connected KBs and import destinations are session/action state, not extra required global setup.
- This section records the current configuration proposal, not a finalized config schema or a created configuration file.

## Open decisions

- Numeric KB ID allocation and durable counter storage; citation syntax and component meanings are approved above. Section and page-range locators are not specified.
- Exact KB creation and connect/disconnect command/tool interfaces; their session-lifecycle behavior is approved above.
- Action-specific versus shared approval settings and global/session configuration syntax. The user explicitly deferred the follow-up on permission enforcement and approval before remote transmission; do not treat that follow-up as settled.
- Hash algorithm, initial short-hash length, and minimal collision-check behavior. Original-file-byte identity and duplicate/version behavior are approved above.
- Embedding provider and configuration for the single global model; never store secret API keys in these notes.
- PDF text extraction and figure-marker detection methods, exact metadata/database schemas, result limits, passage handles, similarity metric, and hybrid rank-fusion parameters. SQLite with `sqlite-vec` is approved, subject to runtime and scale checks; failure/retry behavior and disclosure of pages without usable text are approved above.
- Final import/connection tool names and exact retrieval-tool argument schemas; retrieval tool roles and names are approved above.
- Shared-original deletion/cleanup policy; never delete an original still referenced by a KB.

## Handoff

The user requested discussion before implementation. No plugin implementation has begun. The approved layout now shares original PDFs under `objects/` and discovers KBs via per-KB `kb.json` files rather than a separate registry. Default approval mode, explicit import destinations, session lifecycle behavior, permanent numeric KB IDs, original-file-byte identity, `p`-suffixed citations, failure/retry behavior, queued imports, dot-entry exclusions, and retrieval-tool roles are confirmed. V1 uses one global embedding model, original-text chunk embeddings without summaries, and per-KB SQLite/`sqlite-vec` search databases, subject to runtime and scale validation. Hybrid meaning/keyword retrieval and adapting realctx's storage/search infrastructure are approved; realkb's behavior remains independent, without realctx's memory-management or context-compression features. Permission-enforcement follow-up remains deferred. This file records the discussion; proposals above must not be treated as confirmed requirements.
