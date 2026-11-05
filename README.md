# realkb

Local knowledge bases for [Pi](https://github.com/earendil-works/pi) with session-scoped connections, structure-aware chunking, hybrid `sqlite-vec` + `FTS5` retrieval, and traceable page-level citations.

## Features

- **Persistent local library (`~/.pi/agent/realkb/`)**: Stored outside project working directories so knowledge bases are available across projects while keeping installed plugin code separate from user data.
- **Content-addressed original PDFs**: Original PDFs are stored once under `objects/<sha256>.pdf` and shared across knowledge bases when file bytes match.
- **Permanent numeric KB IDs**: Knowledge bases receive permanent IDs (`001`, `002`, ...) tracked via `state.json` and never reused after deletion.
- **Self-contained PDF extraction (`pdfjs-dist`)**: Extracts page text in reading order, strips running headers/footers and page numbers, and inserts page-numbered figure markers (`[FIG p7-1]`, `[FIG p7-2]`) without altering the original PDF.
- **Structure-aware sentence chunking**: Packs ~600-token chunks (soft window 500–800 tokens) with 1–3 sentence overlap (~80–120 tokens), keeping headings attached to following text and preserving exact per-page character span mappings.
- **Hybrid retrieval (`sqlite-vec` + SQLite `FTS5`)**: Combines cosine vector KNN and BM25 full-text search (with English, identifier, and CJK bigram tokenization), merges adjacent overlapping chunks, and degrades gracefully to keyword-only search if the embedding endpoint is unreachable.
- **Session-scoped connections & approval controls**:
  - New sessions start with no connected KBs.
  - Resumed sessions restore connections and session approval overrides.
  - Forked sessions inherit connections at the fork point while resetting session approval overrides to global settings.
  - Tree rewind restores connections and overrides at the selected branch point.
- **Traceable citations**: Cite documents as `[rkb:001_c676ea9]` and PDF pages as `[rkb:001_c676ea9p7]`, rendered with clickable `file://.../objects/<sha256>.pdf#page=7` links.

## Commands

- `/realkb list` — List local KBs, their permanent IDs, connection status, and source counts
- `/realkb status` — List only the knowledge bases currently connected to this session
- `/realkb create <name>` — Create a new knowledge base and connect it to the current session
- `/realkb connect [id-or-name]` — Connect a KB to the current session
- `/realkb disconnect [id-or-name]` — Disconnect a KB from the current session
- `/realkb jobs` — Show active and recent PDF import jobs and their live chunk-embedding progress
- `/realkb stop [job-id|all]` — Stop a running background PDF import job
- `/realkb config` — View or update global `approvalMode` (`ask` | `yolo`) and OpenAI-compatible embedding settings (`endpoint`, `model`, `apiKey`, `dimensions`)
- `/realkb cleanup` — Explicitly remove unreferenced PDFs in `objects/` that are not referenced by any KB

## Agent Tools

- `realkb_list` — List local KBs and their current-session connection status (without exposing disconnected KB contents)
- `realkb_create` — Create a new KB (asks for approval by default)
- `realkb_connect` — Connect or disconnect KBs for the current session
- `realkb_import` — Import `.pdf`, `.md`, or `.txt` files or directories recursively into an explicit target KB (single `.pdf`/`.md`/`.txt` files need no `allow_ext`; directories default to `.pdf` only unless `allow_ext: ["md", "txt"]` is passed; runs in the background by default when importing 2+ files)
- `realkb_search` — Hybrid vector + keyword search across connected KBs
- `realkb_read` — Read surrounding chunks (`chunk ± neighbors`) or PDF page ranges from a connected KB
- `realkb_source_info` — Resolve any `[rkb:001_c676ea9p7]`, `001_c676ea9`, or `001:c676ea9` reference to its metadata and original PDF path

## Configuration (`~/.pi/agent/realkb/config.json`)

```json
{
  "approvalMode": "ask",
  "embedding": {
    "endpoint": "https://api.openai.com/v1",
    "apiKey": "$OPENAI_API_KEY",
    "model": "text-embedding-3-large",
    "dimensions": 3072,
    "queryInstruction": "Instruct: Given a search query, retrieve relevant passages from the knowledge base\nQuery: ",
    "timeoutMs": 30000,
    "batchSize": 16
  }
}
```

## Development

```bash
bun install
bun run typecheck
bun test
```
