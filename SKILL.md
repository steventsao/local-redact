---
name: local-redact
description: >
  Redact PII from PDFs locally — nothing leaves the machine. Uses OpenRedaction
  for detection and pdf-lib for black-box rendering. Ghostscript burn-in makes
  redactions irrecoverable. Use when asked to "redact a PDF", "remove PII",
  "strip personal info from this document", or "anonymize this PDF".
---

# Local PDF Redaction

Redact PII from PDFs without uploading anywhere. Two-pass detection (structural
patterns + NER), black-box overlay, Ghostscript burn-in.

## Prerequisites

```bash
brew install ghostscript qpdf        # macOS
bun add openredaction pdf-lib         # or npm/pnpm
pip install presidio-analyzer docling  # optional: NER + bbox extraction
```

## Pipeline

```
PDF → flatten (qpdf+gs) → extract text+bboxes (Docling) → detect PII → draw black boxes (pdf-lib) → burn-in (gs)
```

### Step 1: Extract text with bounding boxes

Use Docling to get text items with page coordinates. Run Presidio on each item
for NER-based PII detection (names, SSN, etc).

```python
from docling.document_converter import DocumentConverter
from presidio_analyzer import AnalyzerEngine

analyzer = AnalyzerEngine()
result = DocumentConverter().convert("document.pdf")

for item in result.document.texts:
    for prov in item.prov:
        hits = analyzer.analyze(text=item.text, entities=["PERSON", "US_SSN", "PHONE_NUMBER", "EMAIL_ADDRESS"], language="en")
        # Each hit has: entity_type, start, end, score
        # prov.bbox gives: l, r, t, b (page coordinates)
```

### Step 2: Detect structural PII patterns

OpenRedaction catches patterns Presidio misses — SSNs, phone formats, IBANs,
credit cards, EINs, routing numbers.

```javascript
import { OpenRedaction } from "openredaction";

const redactor = new OpenRedaction({ redactionMode: "placeholder" });
const { detections } = await redactor.detect(pageText);
// Each detection: { type, value, position: [start, end], confidence }
```

### Step 3: Draw black boxes + burn in

```javascript
import { PDFDocument, rgb } from "pdf-lib";

const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
for (const det of detections) {
  doc.getPages()[det.page].drawRectangle({
    x: det.x, y: det.y, width: det.w, height: det.h,
    color: rgb(0, 0, 0),
  });
}
await writeFile("redacted_pre.pdf", await doc.save());
```

**Burn-in** (critical — without this, text is still selectable under boxes):

```bash
gs -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress \
  -sOutputFile=redacted.pdf redacted_pre.pdf
```

## Detection configs

Control what gets redacted by filtering detection types:

| Preset | Catches |
|--------|---------|
| Full PII | Names (NER), SSN, phone, email, tax IDs, credit cards, bank numbers |
| Structural only | SSN, phone, email, zip, credit card, IBAN, passport (no NER model) |
| Names only | Capitalized multi-word names via regex heuristic |

Presidio types: `PERSON`, `US_SSN`, `PHONE_NUMBER`, `EMAIL_ADDRESS`, `US_ITIN`,
`CREDIT_CARD`, `US_BANK_NUMBER`, `US_PASSPORT`, `US_DRIVER_LICENSE`

OpenRedaction types: `SSN`, `EMAIL`, `PHONE_US`, `PHONE_UK`, `PHONE_INTL`,
`CREDIT_CARD`, `IBAN`, `EIN`, `ITIN`, `BANK_ACCOUNT`, `ROUTING_NUMBER`

## Output

Always emit a JSON sidecar alongside the redacted PDF:

```json
{
  "input": "document.pdf",
  "output": "document_redacted.pdf",
  "timestamp": "2026-04-03T...",
  "detections": [{ "page": 1, "type": "PERSON", "value": "Jane Doe", "confidence": 0.85, "source": "presidio" }],
  "stats": { "total": 12, "boxesDrawn": 10, "byType": { "PERSON": 5, "US_SSN": 3 } }
}
```

## Key gotchas

- **Flatten first**: PDFs with form fields or annotations need `qpdf --flatten-annotations=all` before extraction, otherwise text hides in layers Docling can't reach
- **Burn-in is mandatory**: Without Ghostscript re-render, black boxes are cosmetic — text underneath is still copy-pasteable
- **Coordinate systems**: Docling bbox uses bottom-left origin (PDF native). pdf-lib also uses bottom-left. No conversion needed.
- **OpenRedaction is structural**: It matches regex patterns, not semantic meaning. Pair with Presidio NER for names and context-dependent PII.
