---
name: realkb
description: Procedure for using realkb PDF knowledge bases — listing and connecting session-scoped KBs, inspecting directories before importing PDFs into an explicit target KB, hybrid vector + keyword retrieval, reading neighborhood chunks or PDF pages, resolving original PDF paths, and citing sources (`[rkb:001_c676ea9p7]`). Read whenever working with PDF knowledge bases or `[rkb:...]` citations.
---

# realkb: Local PDF Knowledge Bases

`realkb` manages persistent local PDF knowledge bases stored under `~/.pi/agent/realkb/`.
Original PDFs are preserved in `~/.pi/agent/realkb/objects/<sha256>.pdf` as the source of truth, while per-KB extracted pages and SQLite (`sqlite-vec` + `FTS5`) hybrid indexes power passage search and page-level citations.

## 1. Session-Scoped Connections (`realkb_list`, `realkb_connect`, `realkb_create`)

A Pi session starts with **no connected knowledge bases** (unless resumed or forked from a session with active connections). You may only search (`realkb_search`) or read (`realkb_read`) KBs that are connected to the current session.

1. **Check available KBs**: Call `realkb_list` to see local KB IDs (`001`, `002`, ...), names, and whether each is connected in this session. `realkb_list` intentionally hides document titles and contents of disconnected KBs.
2. **Connect KBs**: Call `realkb_connect(kbs=["001"])` (by ID or name) to connect one or more KBs to the current session. By default, Pi asks the user for approval unless YOLO mode or a session connection override is active.
3. **Disconnect KBs**: Call `realkb_connect(kbs=["001"], action="disconnect")` when a KB is no longer needed in the session.
4. **Create a new KB**: Call `realkb_create(name="...")` when the user wants a new knowledge base. Each KB receives a permanent numeric ID (`001`, `002`, ...) that is never reused.

## 2. Inspecting Directories and Importing PDFs (`realkb_import`)

Before importing into a KB:

1. **Require an explicit target KB**: Never guess which KB a PDF belongs in. If the user has not named or selected a target KB, call `realkb_list` and ask the user which existing KB to use or whether to create a new one.
2. **Inspect directories before importing**:
   - When the user asks to import a folder, first inspect its contents recursively (including all subfolders).
   - Files and directories whose names begin with `.` (such as `.DS_Store` and `.git`, including their contents) are ignored automatically.
   - If the directory contains **any other non-PDF files** or unrelated files, **stop and flag them to the user** before calling `realkb_import`. Do not import a mixed directory containing non-PDF files as-is.
3. **Call `realkb_import(kb="001", paths=[...])`**:
   - Each path may be a file (`.pdf`, `.md`, `.txt`) or a directory (imported recursively).
   - **Single specific files vs directories (`allow_ext`)**:
     - A single specific file path (`.pdf`, `.md`, or `.txt`) is imported directly without needing `allow_ext`.
     - Directories only import `.pdf` files by default. To import `.md` or `.txt` files inside a directory, pass `allow_ext=["md", "txt"]` (or `["md"]`). Any other unexpected files in a directory are rejected.
   - If the target KB is not yet connected to the current session, an approved `realkb_import` automatically connects it.
   - During import approval, the user is informed that extracted PDF text will be sent to the configured embedding API.
   - **Background execution (`run_in_background` defaults to `true` when importing `>= 2` PDFs) & live progress**: When importing 2 or more PDFs (or when `run_in_background=true` is passed), `realkb_import` starts in the background right after approval and returns a job ID (`imp-1`) immediately. Single-file imports run in the foreground streaming live progress and automatically move to the background if they exceed `timeout` seconds (default 15s). Live per-file and per-chunk progress (`embedding 16/48 chunks (33%)`) is displayed in the TUI dock and status bar (`/realkb jobs` to inspect, `/realkb stop <id>` to cancel), and you will receive one `<realkb-notification>` message when a background import finishes. Do not poll in a loop while waiting.
4. **Handling import outcomes and retries**:
   - `ready`: Extracted, chunked, embedded, and indexed. Check for any warnings about scanned/unreadable pages (`unreadablePages`).
   - `already_imported`: Identical PDF file bytes (`SHA-256`) already exist and are `ready` in this KB; skipped without duplicating work.
   - `failed`: Never claim a failed or unfinished PDF was imported. Report the `failingStep` (`extract`, `chunk`, `embed`, or `index`) and `reason`. Completed extraction in `pages.json` and cached chunk embeddings are preserved on disk, so re-running `realkb_import` on the same file retries cleanly under the same source identity.

## 3. Searching and Reading Evidence (`realkb_search`, `realkb_read`)

1. **Search across connected KBs (`realkb_search`)**:
   - Pass a clear natural-language question or keyword query: `realkb_search(query="...")`.
   - Optionally restrict the search to a subset of connected KBs with `kbs=["001"]`.
   - `realkb_search` combines vector similarity (`sqlite-vec`) and keyword BM25 (`FTS5`) and automatically merges adjacent overlapping chunks from the same document.
   - If the embedding API is unreachable or unconfigured, `realkb_search` falls back to keyword-only search and includes an explicit warning — disclose this limitation if relevant.
2. **Read surrounding context or specific pages (`realkb_read`)**:
   - **Surrounding chunks**: When a search hit is cut off or needs surrounding paragraphs, call `realkb_read(ref="001_c676ea9", chunk=12, neighbors=1)` to read `chunk_index ± neighbors` from that document.
   - **PDF pages**: To read full extracted page text, call `realkb_read(ref="[rkb:001_c676ea9p7]")` or `realkb_read(ref="001_c676ea9", pageStart=7, pageEnd=9)`.
3. **Figures and scanned pages**:
   - V1 extracts selectable PDF text without OCR and does not export images.
   - Inline figure markers like `[FIG p7-1]` indicate that a figure or image appears on PDF page 7. Point the user to the original PDF page (via the clickable citation link) when visual inspection of a diagram, chart, or scanned page is needed.

## 4. Resolving Citations and Original PDFs (`realkb_source_info`)

- Call `realkb_source_info(ref="001_c676ea9")` (or `[rkb:001_c676ea9p7]` or `001:c676ea9`) when the user asks what document a citation refers to, wants the local file path to the stored original PDF (`~/.pi/agent/realkb/objects/<full-hash>.pdf`), or wants to check extraction coverage.
- Resolving an explicit source reference with `realkb_source_info` is permitted even if that KB is not currently connected, and does not connect the KB or grant search/read access.

## 5. Citation Format (`[rkb:001_c676ea9p7]`)

Always cite sources whenever you state facts, numbers, definitions, or quotes retrieved from a knowledge base:

- **Document citation**: `[rkb:001_c676ea9]`
  - `001` = permanent KB ID
  - `c676ea9` = short SHA-256 hash of the original PDF bytes (`7` hex characters by default, or `8+` if extended to avoid a prefix collision in that KB)
- **Page citation**: `[rkb:001_c676ea9p7]`
  - `p7` = 1-based page number in the PDF file (the 7th page of the PDF, not necessarily the printed footer number).
  - Always cite the specific PDF page(s) containing the evidence (`evidencePages`), not automatically the first page of a multi-page chunk. If evidence spans two pages, cite both: `[rkb:001_c676ea9p7]`, `[rkb:001_c676ea9p8]`.
- **Automatic frontend linkification**: Always write bare `[rkb:001_c676ea9p7]` or `[rkb:001_c676ea9]` in your response. **Never** wrap `[rkb:...]` in a Markdown link (`[...](file://...)`) yourself — Pi's TUI frontend automatically transforms bare `[rkb:001_c676ea9p7]` into a compact clickable `[1:c676ea9,p7]` link for the user without polluting the LLM context.
