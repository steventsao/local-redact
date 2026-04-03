# local-redact

Local PDF PII redaction pipeline. Extract text with bounding boxes, detect PII, draw black boxes, burn in with Ghostscript. **Nothing leaves your machine.**

## How it works

```
raw/*.pdf → extract.py (Docling + Presidio) → JSON → redact.mjs (OpenRedaction + pdf-lib) → output/*_redacted.pdf
```

1. **extract.py** — Flattens PDF (qpdf + Ghostscript), extracts text + bboxes via Docling, runs Presidio NER for PII detection
2. **redact.mjs** — Reads Presidio output, runs OpenRedaction for structural patterns (SSN, phone, email regex), draws black boxes over PII, burns in via Ghostscript so text is irrecoverable

## Prerequisites

```bash
brew install qpdf ghostscript
pip install docling presidio-analyzer
npm install
```

## Usage

Drop PDFs into `raw/`, then:

```bash
# Full PII redaction (names, SSN, phone, email, tax IDs, financial identifiers)
python3 extract.py | node redact.mjs --config configs/pii.json

# Standard structural patterns only (no NER model)
python3 extract.py | node redact.mjs --config configs/default.json

# Names only (regex heuristic)
python3 extract.py | node redact.mjs --config configs/names-only.json
```

Output lands in `output/` — one `_redacted.pdf` and one `.json` sidecar per input.

## Config files

Configs control which PII types to redact. See `configs/` for examples.

| Config | What it catches |
|--------|----------------|
| `pii.json` | Full: names (NER), SSN, phone, email, tax IDs, credit cards, bank numbers |
| `default.json` | Structural patterns: SSN, phone, email, zip, credit card, IBAN, passport, etc. |
| `names-only.json` | Capitalized multi-word names only (regex, no model) |

### Config format

```json
{
  "name": "pii",
  "description": "Full PII: names, SSN, phone, email, tax IDs",
  "presidioTypes": ["PERSON", "US_SSN", "PHONE_NUMBER", "EMAIL_ADDRESS"],
  "presidioMinScore": 0.4,
  "openredactionTypes": ["SSN", "EMAIL", "PHONE_US"],
  "openredactionPatterns": ["PHONE", "SSN"]
}
```

- `presidioTypes` — Presidio NER entity types to redact
- `presidioMinScore` — Minimum confidence threshold (0-1)
- `openredactionTypes` — OpenRedaction pattern types
- `openredactionPatterns` — Regex patterns to match against OpenRedaction type names

## Output

Each redacted PDF comes with a JSON sidecar:

```json
{
  "input": "raw/document.pdf",
  "output": "output/document_pii_redacted.pdf",
  "timestamp": "2026-04-03T...",
  "detections": [
    { "page": 1, "type": "PERSON", "value": "John Doe", "confidence": 0.85, "source": "presidio" }
  ],
  "stats": { "total": 12, "boxesDrawn": 10, "byType": { "PERSON": 5, "US_SSN": 3 } }
}
```

## How burn-in works

Black boxes alone don't remove text — a PDF viewer can still select text underneath. The pipeline:

1. Draws black rectangles over detected PII via pdf-lib
2. Re-renders the entire PDF through Ghostscript (`-sDEVICE=pdfwrite`)
3. This flattens all layers — text under boxes becomes pixels, irrecoverable

If Ghostscript isn't available, the pipeline warns that text may still be extractable.

## License

MIT
