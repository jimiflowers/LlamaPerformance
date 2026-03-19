import fs from 'fs';
import path from 'path';
import axios from 'axios';
import logger from '../logger.js';

// pdf-parse es una dependencia opcional — npm install pdf-parse
let pdfParse = null;
try {
  const mod = await import('pdf-parse');
  pdfParse = mod.default;
} catch {
  // Not installed — will throw at runtime with clear message
}

/**
 * Divide texto en chunks con overlap.
 * Aproximación: 1 token ≈ 4 caracteres.
 */
function chunkText(text, chunkSizeTokens = 512, overlapTokens = 64) {
  const chunkSize = chunkSizeTokens * 4;
  const overlap = overlapTokens * 4;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) chunks.push({ text: chunkText, start, end });
    if (end >= text.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

/**
 * Ingesta un PDF en Qdrant.
 * @param {string} pdfPath - Ruta absoluta al PDF
 * @param {object} ragConfig - Config RAG del JSON de la suite
 * @param {function} onProgress - Callback opcional ({ step, message })
 * @returns {{ chunks, vectorDim, pdfName, pages }}
 */
export async function ingestPdf(pdfPath, ragConfig, onProgress) {
  if (!pdfParse) {
    throw new Error('pdf-parse no está instalado. Ejecuta: npm install pdf-parse');
  }

  const {
    embeddings_endpoint,
    embeddings_model = 'nomic-embed-text-v1.5',
    qdrant_endpoint,
    qdrant_api_key,
    collection = 'benchmark_profesor',
    chunk_size = 512,
    chunk_overlap = 64
  } = ragConfig;

  const qdrantHeaders = qdrant_api_key
    ? { 'api-key': qdrant_api_key, 'Authorization': `Bearer ${qdrant_api_key}` }
    : {};
  const pdfName = path.basename(pdfPath);

  // 1. Parsear PDF
  onProgress?.({ step: 'parse', message: `Leyendo PDF: ${pdfName}` });
  const buffer = fs.readFileSync(pdfPath);
  const parsed = await pdfParse(buffer);
  const { text, numpages } = parsed;
  logger.info(`RAG ingest: ${pdfName} — ${numpages} páginas, ${text.length} chars`);

  // 2. Chunking
  onProgress?.({ step: 'chunk', message: 'Dividiendo en chunks...' });
  const rawChunks = chunkText(text, chunk_size, chunk_overlap);
  const chunks = rawChunks.map((c, idx) => ({
    ...c,
    idx,
    pdf_name: pdfName,
    page: Math.max(1, Math.floor((c.start / text.length) * numpages) + 1)
  }));
  logger.info(`RAG ingest: ${chunks.length} chunks generados`);
  onProgress?.({ step: 'chunk', message: `${chunks.length} chunks generados` });

  // 3. Embeddings de uno en uno (llama.cpp no soporta batches)
  const allVectors = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i % 5 === 0) {
      onProgress?.({ step: 'embed', message: `Embebiendo ${i + 1}/${chunks.length} chunks...` });
    }
    const res = await axios.post(
      `${embeddings_endpoint}/v1/embeddings`,
      { model: embeddings_model, input: [chunks[i].text] },
      { timeout: 60000 }
    );
    allVectors.push(res.data.data[0].embedding);
  }
  const vectorDim = allVectors[0].length;
  logger.info(`RAG ingest: vector dim=${vectorDim}`);

  // 4. Borrar y recrear colección en Qdrant
  onProgress?.({ step: 'qdrant', message: `Recreando colección "${collection}" (dim=${vectorDim})...` });
  try {
    await axios.delete(`${qdrant_endpoint}/collections/${collection}`, {
      headers: qdrantHeaders, timeout: 10000
    });
  } catch { /* no existía aún */ }
  await axios.put(`${qdrant_endpoint}/collections/${collection}`, {
    vectors: { size: vectorDim, distance: 'Cosine' }
  }, { headers: qdrantHeaders, timeout: 10000 });

  // 5. Insertar puntos
  const insertBatch = 100;
  const points = chunks.map((c, i) => ({
    id: i + 1,
    vector: allVectors[i],
    payload: {
      pdf_name: c.pdf_name,
      page: c.page,
      chunk_idx: c.idx,
      text: c.text
    }
  }));
  for (let i = 0; i < points.length; i += insertBatch) {
    const done = Math.min(i + insertBatch, points.length);
    onProgress?.({ step: 'insert', message: `Insertando ${done}/${points.length} puntos...` });
    await axios.put(
      `${qdrant_endpoint}/collections/${collection}/points`,
      { points: points.slice(i, i + insertBatch) },
      { headers: qdrantHeaders, timeout: 30000 }
    );
  }

  logger.info(`RAG ingest: ${points.length} puntos en "${collection}" — completado`);
  return { chunks: points.length, vectorDim, pdfName, pages: numpages };
}
