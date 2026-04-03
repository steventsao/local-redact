/**
 * Reads docling+presidio JSON from stdin, optionally runs OpenRedaction for extra patterns,
 * draws black boxes over PII, emits redacted PDF + JSON sidecar.
 *
 * Usage: python3 extract.py | node redact.mjs --config configs/pii.json
 */
import { OpenRedaction } from "openredaction";
import { PDFDocument, rgb } from "pdf-lib";
import { readFile, writeFile } from "fs/promises";
import { join, basename } from "path";
import { parseArgs } from "util";
import { execSync } from "child_process";

const { values: args } = parseArgs({
  options: {
    config: { type: "string", short: "c", default: "configs/pii.json" },
  },
});

const configPath = join(import.meta.dirname, args.config);
const config = JSON.parse(await readFile(configPath, "utf8"));
console.log(`Config: ${config.name} — ${config.description}`);

// Presidio filter
const presidioTypes = new Set(config.presidioTypes || []);
const presidioMinScore = config.presidioMinScore ?? 0.4;

// OpenRedaction filter
const orTypes = new Set(config.openredactionTypes || []);
const orPatterns = (config.openredactionPatterns || []).map((p) => new RegExp(p));
function isOrType(type) {
  if (orTypes.has(type)) return true;
  return orPatterns.some((p) => p.test(type));
}

async function redactPdf(pdfPath, extraction, outputPath) {
  // Use the flattened PDF (annotations baked into page content) so black boxes render on top
  const drawPath = extraction.flatPath || pdfPath;
  console.log(`\n--- ${basename(pdfPath)} (drawing on ${basename(drawPath)}) ---`);

  const redactor = new OpenRedaction({ redactionMode: "placeholder" });
  const pdfDoc = await PDFDocument.load(await readFile(drawPath), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const pdfPages = pdfDoc.getPages();
  const allDetections = [];
  const drawnBoxes = new Set();

  function drawBox(pdfPage, item, pageNum) {
    const key = `${pageNum}:${item.x}:${item.y}`;
    if (drawnBoxes.has(key)) return;
    drawnBoxes.add(key);
    pdfPage.drawRectangle({
      x: item.x - 1,
      y: item.y - 1,
      width: item.width + 2,
      height: item.height + 2,
      color: rgb(0, 0, 0),
    });
  }

  for (const pageData of extraction.pages) {
    const pageIndex = pageData.page - 1;
    if (pageIndex >= pdfPages.length) continue;
    const pdfPage = pdfPages[pageIndex];
    const items = pageData.items;
    if (!items?.length) continue;

    // --- Pass 1: Presidio detections (already per-item from extract.py) ---
    for (const item of items) {
      if (!item.pii?.length) continue;
      for (const hit of item.pii) {
        if (!presidioTypes.has(hit.type)) continue;
        if (hit.score < presidioMinScore) continue;

        drawBox(pdfPage, item, pageData.page);
        allDetections.push({
          page: pageData.page,
          type: hit.type,
          value: hit.value,
          confidence: hit.score,
          source: "presidio",
          box: { x: item.x, y: item.y, w: item.width, h: item.height, blockText: item.text },
        });
        console.log(`  p${pageData.page} [${hit.type}] "${hit.value}" (presidio ${hit.score})`);
      }
    }

    // --- Pass 2: OpenRedaction on full page text for structural patterns ---
    let flatText = "";
    const charMap = [];
    for (let i = 0; i < items.length; i++) {
      const start = flatText.length;
      flatText += items[i].text;
      for (let c = start; c < flatText.length; c++) charMap[c] = i;
      if (i < items.length - 1) {
        flatText += " ";
        charMap[flatText.length - 1] = -1;
      }
    }

    const orResult = await redactor.detect(flatText);
    for (const det of orResult.detections) {
      if (!isOrType(det.type)) continue;

      const [start, end] = det.position;
      const itemIndices = new Set();
      for (let c = start; c < end; c++) {
        if (charMap[c] !== undefined && charMap[c] !== -1) itemIndices.add(charMap[c]);
      }

      for (const idx of itemIndices) {
        const item = items[idx];
        drawBox(pdfPage, item, pageData.page);
      }

      allDetections.push({
        page: pageData.page,
        type: det.type,
        value: det.value.trim(),
        confidence: det.confidence,
        source: "openredaction",
      });
      console.log(`  p${pageData.page} [${det.type}] "${det.value.trim()}" (openredaction)`);
    }
  }

  // Save intermediate PDF (black boxes drawn but text still underneath)
  const intermediatePath = outputPath.replace(/\.pdf$/i, "_pre-burnin.pdf");
  await writeFile(intermediatePath, await pdfDoc.save());

  // Burn-in: Ghostscript renders to images and reassembles → text under boxes is irrecoverable
  try {
    execSync(
      `gs -dNOPAUSE -dBATCH -dSAFER -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress -sOutputFile="${outputPath}" "${intermediatePath}"`,
      { stdio: "pipe" },
    );
    // Remove intermediate
    const { unlinkSync } = await import("fs");
    unlinkSync(intermediatePath);
    // Clean up the intermediate flat file from extract.py
    if (extraction.flatPath) {
      try { unlinkSync(extraction.flatPath); } catch {}
    }
    console.log(`  Burn-in: flattened via Ghostscript (text under boxes irrecoverable)`);
  } catch (e) {
    // Fallback: keep the pre-burnin as the output
    const { renameSync } = await import("fs");
    renameSync(intermediatePath, outputPath);
    console.log(`  Warning: Ghostscript burn-in failed, text under boxes may be extractable`);
  }

  // Save sidecar
  const sidecar = {
    input: pdfPath,
    output: outputPath,
    config: { path: args.config, ...config },
    timestamp: new Date().toISOString(),
    detections: allDetections,
    stats: {
      total: allDetections.length,
      boxesDrawn: drawnBoxes.size,
      byType: allDetections.reduce((a, d) => { a[d.type] = (a[d.type] || 0) + 1; return a; }, {}),
      bySource: allDetections.reduce((a, d) => { a[d.source] = (a[d.source] || 0) + 1; return a; }, {}),
    },
  };
  await writeFile(outputPath.replace(/\.pdf$/i, ".json"), JSON.stringify(sidecar, null, 2));

  console.log(`  → ${allDetections.length} detections, ${drawnBoxes.size} boxes → ${basename(outputPath)}`);
}

async function main() {
  const outDir = join(import.meta.dirname, "output");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const docs = JSON.parse(input);

  for (const [pdfPath, extraction] of Object.entries(docs)) {
    const suffix = config.name !== "default" ? `_${config.name}` : "";
    const name = basename(pdfPath).replace(/\.pdf$/i, `${suffix}_redacted.pdf`);
    await redactPdf(pdfPath, extraction, join(outDir, name));
  }
  console.log("\nDone.");
}

main().catch(console.error);
