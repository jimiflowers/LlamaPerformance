# Changelog

## 2026-03-18 — RAG mode (Retrieval-Augmented Generation)

### Context

Adds full RAG support: PDF ingestion into Qdrant, retrieval before each benchmark scenario, and display of retrieved chunks in Results.

---

### New files

#### `src/server/rag/ragEngine.js`

Class `RagEngine` with three methods:

- `embed(texts)` — batched call to `POST /api/embed` on the Ollama embeddings server (e.g. nomic-embed-text-v1.5). Returns a 2D array of float vectors.
- `retrieve(question)` — embeds the question, then calls `POST /collections/{name}/points/search` on Qdrant (with `api-key` header). Returns `{ chunks, latencyMs }` where `chunks` is an array of objects `{ text, score }`.
- `assembleMessages(systemPrompt, chunks, question)` — returns an OpenAI-compatible messages array: system message = `systemPrompt + '\n\nMaterial:\n' + context`, user message = `question`.

Constructor takes a `ragConfig` object (see suite format below).

#### `src/server/rag/ingest.js`

Standalone ingestion pipeline. Exported function `ingestPdf(pdfPath, ragConfig, onProgress)`:

1. Parses the PDF with `pdf-parse` (optional import — graceful error if not installed).
2. Chunks the extracted text by character count (1 token ≈ 4 chars) with configurable `chunk_size` and `chunk_overlap` (in tokens).
3. Embeds chunks in batches of 32 via Ollama.
4. Deletes and recreates the Qdrant collection to ensure a clean ingest.
5. Uploads points in batches of 100.

Returns `{ chunks, vectorDim, pdfName, pages }`.

Uses a top-level `await` try/catch for the optional `pdf-parse` import (ESM).

---

### Suite format — RAG suites

Suites that include a `rag` object at the top level activate RAG mode. Each scenario should use a `question` field instead of `prompt_system` / `prompt_user`:

```json
{
  "name": "profesor_alia",
  "rag": {
    "embeddings_endpoint": "http://10.0.0.1:8081",
    "embeddings_model": "nomic-embed-text-v1.5",
    "qdrant_endpoint": "http://10.0.0.2:6333",
    "qdrant_api_key": "...",
    "collection": "benchmark_profesor",
    "top_k": 5,
    "chunk_size": 512,
    "chunk_overlap": 64,
    "source_pdf": "/path/to/file.pdf"
  },
  "system_prompt": "Eres un profesor universitario...",
  "scenarios": [
    { "name": "Concepto fundamental", "question": "¿Cuál es...?", "max_tokens": 400, ... }
  ]
}
```

New example suite: **`benchmarks/suites/profesor_alia.json`** — 4 scenarios for evaluating a RAG-backed university professor assistant.

---

### benchmark.js — RAG integration

- At the start of `runBenchmark`, if `suite.rag` is present, a `RagEngine` instance is created with the suite's RAG config (dynamic import).
- Before each scenario, if `ragEngine` is active: `ragEngine.retrieve(scenario.question)` is called; returned chunks are assembled into an OpenAI messages array via `ragEngine.assembleMessages(suite.system_prompt, chunks, question)`; the scenario is augmented with `_ragMessages`.
- `ragChunks` and `ragRetrievalMs` are attached to `result.raw` for persistence and API exposure.
- In `runSingleInference`, when `scenario._ragMessages` is present, the messages array is used directly (no dual-slot), returning a single slot result.

---

### index.js — RAG ingest endpoint

Static import at the top of the file:

```js
import { ingestPdf } from './rag/ingest.js';
```

New endpoint:

```
POST /api/rag/ingest
Body: { suiteName, skipIngest }
```

Reads the named suite JSON, calls `ingestPdf` with progress callback, returns `{ success, chunks, vectorDim, pdfName, pages, progress }`. If `skipIngest` is `true`, skips the PDF parsing and returns immediately with `{ success: true, skipped: true }`.

Also: `GET /benchmarks/runs/:id` now extracts `ragChunks` and `ragRetrievalMs` from `raw_data` and includes them in each result object.

---

### package.json

Added `"pdf-parse": "^1.1.1"` to `dependencies`.

---

### api.js (frontend)

Added `ragAPI`:

```js
export const ragAPI = {
  ingest: (suiteName, skipIngest = false) =>
    api.post('/rag/ingest', { suiteName, skipIngest }, { timeout: 300000 })
};
```

---

### Benchmarks.jsx

- `ragAPI` imported.
- `ragLoading` and `ragStatus` state added.
- `handleIngest(skipIngest)` calls `ragAPI.ingest(suiteName, skipIngest)` and updates `ragStatus` with the result.
- Suite selector: RAG badge (teal, labelled "RAG") shown next to description when `currentSuite.rag` is set.
- Scenario cards: `question` field previewed (italic, teal label) when present, as first condition before `prompt_system`/`prompt_user` or `prompt`.
- **RAG ingest panel** added below the suite detail card when `currentSuite.rag` is truthy: shows collection name, top_k, chunk_size, source PDF path; status message (green/red); **Ingest PDF** and **Skip** buttons.
- JSX fix: `{currentSuite && (...)}` now wraps its two sibling elements (suite detail div + RAG panel div) in a `<>` fragment.

---

### Results.jsx

- `getResponseMatrix` updated: also builds `ragByScenario` — a map of `scenario → { chunks, latencyMs }` from `r.ragChunks` / `r.ragRetrievalMs` (first model's result per scenario, since chunks are identical for all models given the same question).
- New **🔍 RAG — Contexto Recuperado** card, rendered after Model Responses when `ragByScenario` has data:
  - One block per scenario (separated by a thin border).
  - Each chunk shown as a bordered card with `Chunk N · score: X.XXXX` header.
  - Retrieval latency (ms) shown next to the scenario name.

---

### Files changed this session

| File | Changes |
|---|---|
| `src/server/rag/ragEngine.js` | New — RAG query engine (embed + retrieve + assemble) |
| `src/server/rag/ingest.js` | New — PDF ingest pipeline (chunk → embed → Qdrant) |
| `src/server/index.js` | Static import of `ingestPdf`; `POST /api/rag/ingest` endpoint; `ragChunks`/`ragRetrievalMs` in `GET /benchmarks/runs/:id` |
| `src/server/benchmark.js` | RAG engine init; per-scenario retrieval; `_ragMessages` augmentation; RAG single-slot path in `runSingleInference`; `ragChunks`/`ragRetrievalMs` in `raw` |
| `src/client/src/utils/api.js` | `ragAPI.ingest` added |
| `src/client/src/pages/Benchmarks.jsx` | RAG state/handlers; RAG badge; `question` preview; RAG ingest panel; JSX fragment fix |
| `src/client/src/pages/Results.jsx` | `ragByScenario` in `getResponseMatrix`; RAG Contexto Recuperado card |
| `benchmarks/suites/profesor_alia.json` | New — 4-scenario RAG suite (ES, university professor assistant) |
| `package.json` | `pdf-parse` dependency added |

---

## 2026-03-06 — llama-swap adaptation, dual-slot benchmarking, VRAM metrics

### Context

This session completes the adaptation of LlamaPerformance to **llama-swap** (a proxy/router for llama.cpp with implicit model loading via TTL) and adds concurrent dual-slot benchmarking and real GPU VRAM telemetry.

---

### Bug fixes (carried over from previous session)

**`src/server/benchmark.js`**

- `await waitForVramFree(10000)` at the end of `runBenchmark` was passing the timeout as the `modelId` argument, causing `modelId.replace is not a function`. Fixed to `await waitForVramFree(lastId, 10000)`.

**`src/server/orchestrator.js`**

- `waitForModelIdle`: `GET /upstream/{model}` returned HTTP 301 which axios did not follow by default. Added `maxRedirects: 5` to the axios options.

---

### orchestrator.js — llama-swap health probing

#### `checkModelHealth`

- Timeout increased `5000` → `30000` ms to accommodate slow llama-swap responses.
- URL changed from `/upstream/${modelName}` → `/upstream/${modelName}/health` (canonical endpoint, avoids the 301 redirect).
- `maxRedirects: 0` (the `/health` URL needs no redirect).
- Condition changed from `res.data?.status === 'running'` → `res.status === 200 && res.data?.status === 'ok'` to match the actual llama-swap `/upstream/{model}/health` response schema.

#### `waitForModelIdle`

- URL and options updated identically to `checkModelHealth` (same endpoint, `maxRedirects: 0`).
- Condition inverted: returns `true` (VRAM free) when `res.data?.status !== 'ok'` — i.e., the model is no longer active.

#### `waitForModelUnloaded` (new method)

Replaces `waitForModelIdle` as the primary VRAM-free confirmation mechanism:

```js
async waitForModelUnloaded(modelId, maxWaitMs = 60000)
```

- Polls `GET /running` every **500 ms** (vs. 2 s in the old method).
- Checks whether the model name appears in `res.data.running[]`.
- Returns `true` as soon as it disappears; returns `false` on timeout (60 s).
- The swap in llama-swap happens at the moment the **first request for the next model** arrives — `ensureModelReady` triggers that request via `checkModelHealth`, so polling `/running` correctly confirms VRAM is free before concurrent inference begins.

---

### benchmark.js — model health retry loop

#### `ensureModelReady`

Replaced the single `checkModelHealth` call (with a one-shot retry) with a **retry loop**:

```js
const healthDeadline = Date.now() + 60000;
while (Date.now() < healthDeadline) {
  health = await orchestrator.checkModelHealth(healthAlias);
  if (health.healthy) break;
  await new Promise(r => setTimeout(r, 3000));  // retry every 3 s
}
```

- Maximum wait: 60 s — covers Gemma-3-12B (slowest candidate); faster 7–8B models exit the loop immediately.
- The redundant reload attempt on first failure was removed (llama-swap loads implicitly on first request).

#### `waitForVramFree`

Simplified signature and now delegates to `waitForModelUnloaded`:

```js
const waitForVramFree = async (modelId) => orchestrator.waitForModelUnloaded(modelId);
```

---

### benchmark.js — concurrent dual-slot metrics

Previously only the **user slot** (natural language prompt) contributed to all aggregate metrics. The **system slot** (JSON prompt) was tracked separately in `systemLatencies` / `systemTtfts` but excluded from the main figures.

#### Iteration accumulation — what changed

| Metric | Before | After |
|---|---|---|
| **Latency** | `user.endTime - user.startTime` | `max(user.endTime, sys.endTime) - min(user.startTime, sys.startTime)` — wall-clock of the concurrent pair |
| **Tokens** | `user.tokens` | `user.tokens + sys.tokens` |
| **TPOT / GenTPS** | inter-token delays from user slot only | combined delays from both slots |
| **Errors / timeouts** | counted per slot independently | counted **per iteration**: 1 error if either slot fails |
| **System responses** | not stored | collected in `results.systemResponseTexts[]` |

`systemLatencies`, `systemTtfts`, `systemResponseTexts` are still tracked separately in `results` for per-slot breakdown.

#### `raw` output

```js
raw: {
  ...results,
  lastResponse: results.responseTexts[last],          // user slot
  lastSystemResponse: results.systemResponseTexts[last] // system slot (new)
}
```

---

### index.js — `GET /benchmarks/runs/:id`

Now extracts `lastSystemResponse` from `raw_data` and includes it in every result object returned to the frontend:

```js
lastSystemResponse = rd?.lastSystemResponse ?? null;
return { ...rest, lastResponse, lastSystemResponse };
```

---

### Results.jsx — Model Responses table

- `getResponseMatrix` now stores `{ user, system }` per cell instead of a bare string.
- `hasAnyResponse` triggers on either slot being present.
- Cells with both responses show them stacked, labelled **User** / **System** in small grey caps.
- `Show more / Show less` threshold uses combined length of both responses.

---

### benchmark.js + Results.jsx — VRAM metrics

#### Server side (`benchmark.js`)

New top-level helper function (module scope, outside the class):

```js
async function getGpuMetrics()
```

Queries `http://aion.home.lan:9999/gpu` with a 3 s timeout. Extracts:
- `vram_used_mb` — from `VRAM Total Used Memory (B)`
- `vram_total_mb` — from `VRAM Total Memory (B)`
- `gpu_use_pct` — from `GPU use (%)`

Returns `{ null, null, null }` on any error (non-blocking).

Snapshots are taken **before and after** each inference, in parallel with the existing CPU/RAM snapshot:

```js
const [resourcesBefore, gpuBefore] = await Promise.all([this.collectResourceMetrics(), getGpuMetrics()]);
// ... inference ...
const [resourcesAfter, gpuAfter] = await Promise.all([this.collectResourceMetrics(), getGpuMetrics()]);
```

`resourceSnapshots` entries now include: `gpu_vram_before_mb`, `gpu_vram_after_mb`, `gpu_vram_total_mb`, `gpu_use_pct`.

New fields in `aggregated`:

| Field | Description |
|---|---|
| `vram_max_mb` | Peak VRAM used (MB) across all iterations of this scenario |
| `vram_total_mb` | Total VRAM capacity of the card (MB) |
| `vram_pct` | `vram_max_mb / vram_total_mb × 100`, 1 decimal |
| `gpu_use_avg` | Average GPU utilisation % across all snapshots |

#### Frontend (`Results.jsx`)

- `ReferenceLine` added to recharts imports.
- `getModelAggregates` accumulates `vram_max_mb`, `vram_pct`, `gpu_use_avg`, `vram_total_mb` per model; exposes `vramMaxMb`, `vramPct`, `vramTotalMb`, `gpuUseAvg`, `vramFreeMarginMb` (= total − max).
- New **🖥️ VRAM Usage** section, inserted before Detailed Results, rendered only when data is available:
  - **Table** (sorted by `vramPct` descending): Model | VRAM máx (MB) | VRAM máx (%) | GPU uso medio (%) | Margen libre (MB). Colour coding: green < 75%, orange 75–90%, red > 90%; margin red if < 500 MB.
  - **Bar chart**: `vramPct` per model, Y axis 0–110%, red dashed `ReferenceLine` at 100% to visualise headroom.

---

### New benchmark suite

**`benchmarks/suites/mayordomo_spanish.json`**

8 scenarios in Spanish, each with two prompts:

| Field | Purpose |
|---|---|
| `prompt_system` | JSON instruction simulating the orchestrator slot (`parallel=0`) |
| `prompt_user` | Natural-language instruction simulating the user slot (`parallel=1`) |

`default_config` sets `temperature_system: 0.1` and `temperature_user: 0.7` to reflect the different determinism requirements of each role.

Scenarios: intent routing, short factual Q&A, task creation, context summarisation, casual conversation, structured data extraction, contextual reasoning, long structured generation.

---

### storage.js — nuevas columnas en benchmark_results

Los campos `vram_max_mb`, `vram_total_mb`, `vram_pct`, `gpu_use_avg`, `system_ttft`, `system_latency_p50` y `concurrent_slots` forman parte de `result.aggregated` pero el `INSERT` de `saveBenchmarkResult` sólo incluía las columnas originales — los nuevos campos se descartaban silenciosamente y nunca llegaban al frontend.

Cambios en `src/server/storage.js`:
- `CREATE TABLE benchmark_results`: añadidas 7 columnas nuevas (`REAL` / `INTEGER`)
- Bloque de migraciones (`newColumns`): añadidas las mismas 7 columnas para bases de datos existentes
- `saveBenchmarkResult` INSERT: actualizado con los 7 nuevos campos y sus valores correspondientes (`?? null` para evitar `undefined`)

`getBenchmarkResults` usa `SELECT *`, así que una vez añadidas las columnas se incluyen automáticamente en la respuesta de `GET /benchmarks/runs/:id` sin más cambios en `index.js`.

---

### Files changed this session

| File | Changes |
|---|---|
| `src/server/orchestrator.js` | `checkModelHealth`: timeout, URL, condition; `waitForModelIdle`: URL, condition; `waitForModelUnloaded` (new) |
| `src/server/benchmark.js` | `waitForVramFree` bug fix; `ensureModelReady` retry loop; dual-slot metric accumulation; `getGpuMetrics` helper; GPU snapshot in iterations; `vram_*` / `gpu_use_avg` in `aggregated`; `lastSystemResponse` in `raw` |
| `src/server/storage.js` | `benchmark_results` schema: 7 new columns; migration block updated; `saveBenchmarkResult` INSERT updated |
| `src/server/index.js` | `GET /benchmarks/runs/:id`: extract and return `lastSystemResponse` |
| `src/client/src/pages/Results.jsx` | `ReferenceLine` import; `getModelAggregates` VRAM fields; VRAM section (table + chart); Model Responses dual-slot display |
| `benchmarks/suites/mayordomo_spanish.json` | New dual-prompt benchmark suite (8 scenarios, ES) |
