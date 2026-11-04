# Pi Knowledge Base — Design Notes

## Confirmed requirements

- Build a Pi plugin.
- V1 accepts PDFs and builds a persistent knowledge base that the agent can search and read.
- Store the knowledge base at `~/.local/share/realkb/`, outside the project directory (cwd), so the same library is available across projects.
- Keep original PDFs so the user can return to and verify the original source.
- V1 extracts existing PDF text, without OCR (recognizing text in scanned pages or images).
- Do not export images as separate files in V1 or attempt diagram understanding. Users consult the retained original PDF for figures.
- Keep simple figure markers such as `[FIG1]` where detectable, before splitting text into chunks, with a reference to the original page rather than an exported image. Exact syntax is not finalized; imperfect placement is acceptable in V1. Do not alter the original PDF.
- Provide an agent-facing import tool (tentative name: `rkb_importpdf`) accepting a list of paths. Each path may be a PDF or a directory; directory import includes PDFs recursively, including all subfolders.
- Before importing a directory, the agent should inspect its contents, including subfolders, and flag unexpected or unrelated files. Require PDF-only contents: do not import a mixed directory containing non-PDF files as-is.
- Content is not restricted to academic papers: books, manuals, reports, slides, and other PDF documents are welcome. This does not yet require support for every file format.
- Generate a hash identifier for each imported document, similar in presentation to a Git commit ID.
- The agent cites knowledge-base documents using a defined bracket syntax. The user's illustrative example was `[has4124...]`; exact grammar is not finalized.
- Keep v1 limited to PDF ingestion, knowledge-base retrieval, document identities, and citations.

## Future scope — not for v1

- Zotero-connect.
- Knowledge-connect (meaning and scope to be clarified).
- An in-Pi interface for managing the KB and sources, with possible commands such as `/realkb manage` and `/realkb import`. These are future UI ideas, not required for V1.

## User context

- The user is not a professional IT worker. Explain technical choices in practical, plain language.
- The user has access to an embedding API and wants its settings requested through configuration. Its provider, endpoint, model, and compatibility have not been confirmed.
- Keep these notes in this project, not global memory.

## Proposed interpretations — not yet approved

- Hash the original PDF bytes: identical files deduplicate; renames preserve IDs; changed file bytes produce new IDs.
- Retain page locations in extracted text.
- Scope image placeholders to their document so identical marker names in different PDFs do not collide.
- Target an OpenAI-compatible embedding API, with configurable API address, API key, and model; the user suggested compatibility tentatively. No provider or model has been selected.
- Store full hashes internally and display unambiguous short prefixes.
- Example citation forms: `[a81f924bc312]` and `[a81f924bc312:p7]`.
- Resolve citations back to stored documents and, optionally, specific pages.
- Use the embedding API for meaning-based retrieval, alongside keyword search; the Pi model reads retrieved passages and writes the answer.
- Clearly disclose that a remote embedding API receives extracted text before transmitting private documents.

## Open decisions

- Final citation grammar and page/section locators.
- Hash algorithm and exact identity/versioning semantics.
- Embedding provider and configuration; never store secret API keys in these notes.
- PDF text extraction and figure-marker detection, handling pages without extractable text (without OCR in V1), internal storage layout, and retrieval implementation.
- Final import tool name and remaining agent-facing tools.

## Handoff

The user requested discussion before implementation. No plugin implementation has begun. Original PDF retention and the KB location (`~/.local/share/realkb/`) are now confirmed. This file records the discussion; proposals above must not be treated as confirmed requirements.
