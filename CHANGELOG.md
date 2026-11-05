# Changelog

All notable changes to `realkb` will be documented in this file.

## [0.2.1] - 2026-11-06

### Added
- `/realkb status` command to list only the knowledge bases currently connected to the active session.
- Support for `[1:abc1234,p2]` compact reference syntax in `parseReference` (`realkb_read` and `realkb_source_info`).

### Changed
- **Status bar indicator**: Changed footer status from `📚 KB: 001, 002` to compact `·📚 <count>` (e.g. `·📚 2`).
- **Context-clean citations**: Removed `file://` URLs and raw object paths from `realkb_import`, `realkb_search`, and `realkb_read` tool outputs so LLM context and prompt caching remain compact (`[rkb:001_c676ea9p7]`).
- **Frontend-only clickable links**: `pi.registerMarkdownTransformer` now renders bare `[rkb:001_c676ea9p7]` tags in the Pi TUI as compact clickable `[1:c676ea9,p7]` links pointing to `file:///.../objects/<sha256>.pdf#page=7` without modifying the LLM context.

## [0.2.0] - 2026-11-06

### Added
- **Background imports & live progress**: `realkb_import` runs in the background by default when importing 2+ files (and auto-promotes foreground single-file imports after `timeout` seconds), with a live TUI dock widget (`realkb-dock`), `<realkb-notification>` wakeup messages, `/realkb jobs`, and `/realkb stop [id|all]`.
- **Markdown (`.md`) and plain-text (`.txt`) support**:
  - Single specific `.pdf`, `.md`, or `.txt` files can be imported directly without `allow_ext`.
  - Directory imports default to `.pdf` only unless `allow_ext: ["md", "txt"]` is passed.

## [0.1.0] - 2026-11-05

### Added
- Initial release of `realkb` local PDF knowledge bases (`~/.pi/agent/realkb/`):
  - Permanent 3-digit KB IDs (`001`, `002`, ...) and content-addressed `objects/<sha256>.pdf` storage with `/realkb cleanup`.
  - Self-contained PDF text extraction (`pdfjs-dist`) with `[FIG pX-Y]` figure markers and structure-aware ~600-token sentence chunking.
  - Hybrid `sqlite-vec` cosine KNN + SQLite `FTS5` BM25 search with graceful keyword fallback.
  - Session-scoped KB connections (`new`, `resume`, `fork`, and `tree` rewind rules) and `ask`/`yolo` approval controls.
