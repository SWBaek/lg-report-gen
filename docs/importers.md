# Source importer limits and provenance

The Main-process source importer accepts PDF, DOCX, PPTX, XLSX, CSV, TXT, Markdown, PNG,
JPEG, and WebP files. It copies each source with a streaming SHA-256 calculation and a
100 MiB per-file limit. The extension is checked against a file signature; OOXML files are
also checked as ZIP archives before a parser runs. The untrusted parser runs in a fresh,
one-shot Node child process (`parser-worker`) for every source. Electron Main receives only
an allowlisted path below the report's `source-originals`/`assets` root; source bytes never
cross IPC. The child has no application network client or credentials and is started with
`windowsHide` on Windows. Packaged builds include the worker as `out/main/parser-worker.js`.

Each parser job has a 30-second hard timeout and can be cancelled through the import
`AbortSignal`; timeout, cancellation, worker crash, malformed IPC, and oversized results are
contained as a failed extraction. Requests are bounded to 4,096-character paths and results
to 32 MiB. The worker is intentionally one-shot so a parser crash cannot affect another job.

For compatibility with existing reports, originals continue to be stored below
`reports/<id>/source-originals/` and extraction JSON below `reports/<id>/source-extracted/`.
The immutable original is a content-addressed blob at
`source-originals/blobs/sha256/<sha256>`. Extraction is cached at
`source-extracted/cache/<sha256>-<extractor-version>-<extension>.json`; attaching the same
bytes again reuses both paths and does not invoke a parser. Changing the extractor version
invalidates this cache and creates a new extraction snapshot. Each manifest entry still has
its own `sourceId` and name while linking to the shared evidence/derived paths.
These directories are treated as the immutable `evidence/` and app-managed `derived/`
domains respectively. The importer does not copy either into `agent-work/`; that directory
is reserved for the Codex writable `agent-output/` domain. Manifest metadata therefore uses
`evidenceLocator` and `derivedLocator`, never `agentWorkOriginal` or `agentWorkExtracted`.

OOXML preflight rejects path traversal, more than 20,000 entries, more than 200 MiB of
expanded data, a single entry over 50 MiB, or an expansion ratio over 1,000:1. PDF extraction
is bounded to 500 pages and 10 MiB of text, with a per-page operation timeout. CSV parsing
supports quoted multi-line records and detects delimiters across a sample of multiple rows;
it is bounded to 100,000 records, 1,000 fields per record, and 1,000,000 characters per field.
The manifest records an estimated row count and truncation state. UTF-8 (with optional BOM) is
supported; CP949/EUC-KR is intentionally unsupported and is reported with a conversion hint.

Parser limits are represented as `extractionStatus: "partial"` and a warning in the manifest.
Hard file/signature/archive failures are represented as `failed` (or reject the import before
copying for a file that exceeds the source-size limit). A source's metadata contains:

```json
{
  "provenance": {
    "schema": "lg-report-agent.source-extraction.v2",
    "extractor": "source-importer",
    "extractorPackage": "@lg-report-agent/source-importer",
    "version": "2.0.0",
    "extractorVersion": "2.0.0",
    "config": { "maxSourceBytes": 104857600, "maxPdfPages": 500 },
    "sourceHash": "<sha256>",
    "extractedAt": "<ISO-8601 timestamp>",
    "time": "<ISO-8601 timestamp>",
    "partialReasons": []
  }
}
```

PDF pages preserve text item bounding boxes, deterministic top-to-bottom/left-to-right reading
order, per-page hashes, and text-density diagnostics. Low-density or empty pages are warned as
possible scans; OCR is not performed. DOCX output is semantic blocks (heading, paragraph, list,
and table). PPTX output includes shape text/placeholder/bounds, minimal table rows, and notes.
XLSX output includes formulas with cached results, headers/units, hidden sheets/rows/columns,
merged ranges, and named ranges. Image provenance records original and normalized hashes and
the metadata-stripping normalization transform. Image dimensions and total pixels are checked
before extraction; if a safe display cannot be generated, no editor preview is exposed.
