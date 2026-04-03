"""
Step 1: Flatten PDF (qpdf) → Docling extracts text + bboxes → Presidio detects PII → JSON for Node redaction.
"""
import json, sys, os, glob, subprocess, tempfile

from docling.document_converter import DocumentConverter
from presidio_analyzer import AnalyzerEngine

analyzer = AnalyzerEngine()

PII_ENTITIES = [
    "PERSON", "US_SSN", "PHONE_NUMBER", "EMAIL_ADDRESS",
    "US_ITIN", "CREDIT_CARD", "US_BANK_NUMBER", "US_PASSPORT", "US_DRIVER_LICENSE",
]


def flatten_pdf(pdf_path):
    """Flatten form fields + annotations. Two passes: qpdf (annotations) then gs (form widgets)."""
    # Pass 1: qpdf flattens annotations
    qpdf_path = tempfile.mktemp(suffix="_qpdf.pdf")
    r1 = subprocess.run(
        ["qpdf", "--flatten-annotations=all", pdf_path, qpdf_path],
        capture_output=True, text=True,
    )
    if r1.returncode != 0:
        print(f"  qpdf flatten failed: {r1.stderr}", file=sys.stderr)
        qpdf_path = pdf_path

    # Pass 2: Ghostscript re-renders to merge ALL layers (form widgets, XObjects) into page content
    gs_path = tempfile.mktemp(suffix="_gs.pdf")
    r2 = subprocess.run(
        ["gs", "-dNOPAUSE", "-dBATCH", "-dSAFER",
         "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/prepress",
         f"-sOutputFile={gs_path}", qpdf_path],
        capture_output=True, text=True,
    )
    if r2.returncode != 0:
        print(f"  gs flatten failed: {r2.stderr}", file=sys.stderr)
        # Fall back to qpdf-only result
        print(f"  Flattened (qpdf only): {os.path.getsize(pdf_path)} → {os.path.getsize(qpdf_path)} bytes", file=sys.stderr)
        return qpdf_path

    # Clean up intermediate
    if qpdf_path != pdf_path:
        os.unlink(qpdf_path)

    print(f"  Flattened (qpdf+gs): {os.path.getsize(pdf_path)} → {os.path.getsize(gs_path)} bytes", file=sys.stderr)
    return gs_path


def extract(pdf_path, output_dir):
    flat_path = flatten_pdf(pdf_path)

    # Keep the flattened PDF for redact.mjs to draw on (annotations removed)
    kept_flat = os.path.join(output_dir, os.path.basename(pdf_path).replace(".pdf", "_flat.pdf"))
    import shutil
    shutil.copy2(flat_path, kept_flat)
    if flat_path != pdf_path:
        os.unlink(flat_path)

    conv = DocumentConverter()
    result = conv.convert(kept_flat)
    doc = result.document

    pages = {}

    for item in doc.texts:
        if not item.prov:
            continue
        for p in item.prov:
            pg = p.page_no
            if pg not in pages:
                page_dim = doc.pages.get(pg)
                w = page_dim.size.width if page_dim and page_dim.size else 612
                h = page_dim.size.height if page_dim and page_dim.size else 792
                pages[pg] = {"page": pg, "width": w, "height": h, "items": []}

            bbox = p.bbox

            results = analyzer.analyze(
                text=item.text, entities=PII_ENTITIES, language="en",
            )
            pii_hits = [
                {
                    "type": r.entity_type,
                    "start": r.start,
                    "end": r.end,
                    "value": item.text[r.start:r.end],
                    "score": r.score,
                }
                for r in results
            ]

            pages[pg]["items"].append({
                "text": item.text,
                "x": bbox.l,
                "y": bbox.b,
                "width": bbox.r - bbox.l,
                "height": bbox.t - bbox.b,
                "pii": pii_hits,
            })

    # Point redact.mjs at the FLATTENED pdf (no annotations to paint over black boxes)
    return {"flatPath": kept_flat, "pages": sorted(pages.values(), key=lambda p: p["page"])}


def main():
    raw_dir = os.path.join(os.path.dirname(__file__), "raw")
    pdfs = [f for f in glob.glob(os.path.join(raw_dir, "*.pdf")) if "_flat" not in f]

    if not pdfs:
        print("No PDFs in raw/", file=sys.stderr)
        sys.exit(1)

    output_dir = os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(output_dir, exist_ok=True)

    all_docs = {}
    for pdf in pdfs:
        name = os.path.basename(pdf)
        print(f"Extracting + PII scan: {name}", file=sys.stderr)
        all_docs[pdf] = extract(pdf, output_dir)

    json.dump(all_docs, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
