# API Reference

**Base URL:** `http://localhost:3001/api`

All error responses use the format `{ "error": "message" }` with an appropriate 4xx/5xx status code.

---

## Models

### GET /models/available
Returns the model inventory from `models.json` as a direct array. Returns `[]` if `models.json` does not exist.

```json
[
  {
    "id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
    "model_id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
    "alias": "Llama 3.1 8B Instruct Q6 K (Text)",
    "mmproj": null,
    "source": "inventory"
  }
]
```

### GET /models
Returns all models in the application database with runtime status, as a direct array.

```json
[
  {
    "id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
    "alias": "Llama 3.1 8B",
    "model_id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
    "status": "running",
    "created_at": 1705670000,
    "updated_at": 1705680000
  }
]
```

### POST /models
Add a model to the database.

**Body:** `{ "alias": "My Model", "model_id": "model.gguf" }`

### DELETE /models/:id
Remove a model from the database.

### POST /models/:id/start
Registers the model as `running` in local storage. When using **llama-swap**, the actual model load is triggered implicitly by the first inference request — no explicit load call is made to the server.
For vision models the `mmproj` path is automatically included in any subsequent direct llama.cpp load calls.
Any load parameters previously saved via `PUT /models/:id/params` are forwarded automatically.

```json
{ "success": true }
```

### PUT /models/:id/params
Save per-model load parameters. These are persisted in storage and forwarded to llama.cpp on every subsequent load of this model (manual or benchmark-triggered).

**Body** (all fields optional — omit or set to `null`/`false` to revert to server default):
```json
{
  "n_ctx":        8192,
  "n_batch":      512,
  "flash_attn":   true,
  "cache_type_k": "q8_0",
  "cache_type_v": "q8_0"
}
```

| Field | Type | Description |
|---|---|---|
| `n_ctx` | integer | Context window size in tokens |
| `n_batch` | integer | Prompt processing batch size |
| `flash_attn` | boolean | Enable Flash Attention (`true` only — omit to disable) |
| `cache_type_k` | string | KV-cache quantisation for K matrix: `q4_0`, `q8_0`, `fp16` |
| `cache_type_v` | string | KV-cache quantisation for V matrix: `q4_0`, `q8_0`, `fp16` |

**Response:** `{ "success": true, "load_params": { ... } }`

### POST /models/:id/stop
Send an unload request to the llama.cpp server (`POST /models/unload`).

### POST /models/:id/test
Run a single inference request to verify the model responds.

```json
{ "success": true, "response": "Hello! ...", "latency": 890 }
```

### GET /models/:id/health
Check whether the model is currently loaded and healthy on the remote server.

### GET /models/:id/logs
Returns live runtime data for the model from the llama.cpp server, plus recent benchmark history.

```json
{
  "slots": [
    {
      "id": 0,
      "state": 0,
      "n_ctx": 4096,
      "n_past": 0,
      "timings": {
        "predicted_per_second": 42.3,
        "prompt_per_second": 210.5,
        "predicted_n": 128,
        "prompt_n": 64
      }
    }
  ],
  "props": {
    "total_slots": 1,
    "default_generation_settings": {
      "n_ctx": 4096,
      "temperature": 0.8,
      "top_p": 0.95,
      "top_k": 40
    }
  },
  "recentBenchmarks": [
    {
      "runId": "run_xyz",
      "suiteName": "default",
      "startedAt": 1705680000,
      "scenario": "Simple Q&A - Short",
      "tps": 45.3,
      "genTps": 52.1,
      "ttft": 320,
      "latencyP95": 1050,
      "errorRate": 0
    }
  ]
}
```

`slots` is `null` if llama.cpp is not reachable or the model is not loaded. `props` is `null` if the `/props` endpoint is unavailable. Requires llama.cpp to be started without `--no-slots`.

---

## Benchmarks

### GET /benchmarks/suites
List available benchmark suites from `benchmarks/suites/`.

```json
{
  "suites": [
    { "name": "default", "description": "Default benchmark suite", "scenarios": [...] }
  ]
}
```

### POST /benchmarks/run
Start an async benchmark run. Returns immediately; poll `/benchmarks/runs/:id/status` for progress.

**Body:**
```json
{
  "modelIds": ["model_abc123", "model_def456"],
  "suiteName": "default",
  "selectedScenarios": ["Simple Q&A - Short", "Code Generation"],
  "config": {
    "iterations": 5,
    "concurrency": 1,
    "timeout": 60000,
    "temperature": 0.7,
    "temperature_system": 0.1,
    "temperature_user": 0.7,
    "streaming": true
  }
}
```

- `modelIds` — any model IDs from the database, regardless of `status`. Stopped models will be loaded implicitly by llama-swap on first inference.
- `selectedScenarios` — optional; if omitted, all scenarios in the suite are run.
- `temperature_system` / `temperature_user` — per-slot temperatures for dual-prompt suites. If omitted, fall back to `temperature` for both slots.

**Execution order for each model:**
1. Send first health probe to `/upstream/{model}/health` to trigger implicit load in llama-swap; retry every 3 s for up to 60 s until `status: ok`
2. Wait 3 seconds for the model to settle before the first timed inference
3. Run all selected scenarios. For dual-prompt suites (`prompt_system` + `prompt_user`), both slots are sent concurrently via `Promise.all`
4. Between models: poll `GET /running` every 500 ms until the previous model disappears (≤ 60 s), confirming VRAM is free
5. After the last model finishes, unload it and confirm via `GET /running` (≤ 60 s)

**Response:** `{ "success": true, "runId": "run_xyz", "message": "Benchmark iniciado en segundo plano" }`

### GET /benchmarks/runs
List all benchmark runs, enriched with `model_aliases`.

```json
{
  "runs": [
    {
      "id": "run_xyz",
      "suite_name": "default",
      "model_ids": ["model_abc123"],
      "model_aliases": ["Llama 3.1 8B"],
      "status": "completed",
      "started_at": 1705680000,
      "completed_at": 1705681000
    }
  ]
}
```

### GET /benchmarks/runs/:id
Get a specific run with its results.

```json
{
  "run": { ... },
  "results": [
    {
      "model_id": "model_abc123",
      "scenario": "Simple Q&A - Short",
      "tps": 45.3,
      "gen_tps": 52.1,
      "ttft": 320,
      "tpot": 19.2,
      "latency_p50": 890,
      "latency_p95": 1050,
      "latency_p99": 1180,
      "error_rate": 0,
      "cpu_avg": 35.2,
      "ram_avg": 42.1,
      "gpu_avg": 68.5,
      "vram_max_mb": 9216,
      "vram_total_mb": 12288,
      "vram_pct": 75.0,
      "gpu_use_avg": 82.3,
      "system_ttft": 210,
      "system_latency_p50": 740,
      "concurrent_slots": 2,
      "lastResponse": "Hello! How can I assist you today?...",
      "lastSystemResponse": "{\"role\": \"profesor\", \"confidence\": 0.95}"
    }
  ]
}
```

| Field | Description |
|---|---|
| `lastResponse` | Last successful user-slot response text. `null` if all iterations failed |
| `lastSystemResponse` | Last successful system-slot response text (dual-prompt suites only). `null` for legacy suites |
| `vram_max_mb` | Peak VRAM used (MB) across all iterations. `null` if GPU stats endpoint was unreachable |
| `vram_total_mb` | Total VRAM of the card (MB) |
| `vram_pct` | `vram_max_mb / vram_total_mb × 100` |
| `gpu_use_avg` | Average GPU utilisation % |
| `system_ttft` | Median TTFT of the system slot (ms). `null` for legacy suites |
| `system_latency_p50` | P50 latency of the system slot (ms). `null` for legacy suites |
| `concurrent_slots` | `2` for dual-prompt suites, `1` for legacy |

`raw_data` itself is not returned. All response and VRAM fields are extracted from it server-side.

### GET /benchmarks/runs/:id/status
Poll status of an in-progress benchmark run.

```json
{
  "id": "run_xyz",
  "status": "running",
  "progress": 42,
  "currentModel": "Gemma 3 12B Instruct Q5 K M (Text)",
  "currentModelIndex": 2,
  "totalModels": 3
}
```

- `progress` — 0–100 percentage of completed scenario×iteration tasks
- `currentModel` — alias of the model currently under test (only while `status === "running"`)
- `currentModelIndex` / `totalModels` — position in the sequential queue

When `status` is `"completed"` or `"failed"` the record is also available from `GET /benchmarks/runs/:id`.

### DELETE /benchmarks/runs/:id
Permanently delete a benchmark run and all associated results and logs.

### GET /benchmarks/runs/:id/export/json
Download run results as a JSON file.

### GET /benchmarks/runs/:id/export/csv
Download run results as a CSV file.

### GET /benchmarks/runs/:id/logs
Get log entries for a benchmark run. Query param: `limit` (default 100).

### GET /benchmarks/results
Get all results. Query params: `runId`, `modelId` (both optional).

---

## Settings

### GET /settings
Return current configuration. Password is masked as `"***"` if set.
Includes `isDefault: true` when `settings.json` has not been created yet.

```json
{
  "llamaApiUrl": "http://gpu-host.lan:8000",
  "port": 3001,
  "logLevel": "info",
  "modelsDir": "/docker/models",
  "isDefault": false,
  "ssh": {
    "username": "ubuntu",
    "password": "***",
    "sshPort": 22,
    "trustRelationship": true
  }
}
```

### PUT /settings
Save settings and apply changes immediately (except `port`, which requires a restart).

Applied immediately on save:
- `llamaApiUrl` → updates the llama.cpp target for orchestrator and cache manager
- `logLevel` → updates Winston log level without restart
- `modelsDir` → updates the path used for mmproj construction on model load

**Response:** `{ ...updatedSettings, restartRequired: true|false }`

### POST /settings/ssh-scan
Scan `modelsDir` for `.gguf` files. The scan method is selected automatically based on `llamaApiUrl`:

- **Local mode** (`localhost` / `127.0.0.1`) — reads the directory directly from the local filesystem.
- **Remote mode** — connects to the GPU server via SSH (host derived from `llamaApiUrl` hostname).

**Response:**
```json
{
  "models": [
    {
      "id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
      "alias": "Llama 3.1 8B Instruct Q6 K",
      "mmproj": null,
      "isNew": true
    }
  ],
  "mmprojs": ["mmproj-Qwen2.5-VL-7B-F16.gguf"]
}
```

### POST /settings/sync-models
Replace `models.json` completely with the provided list.

**Body:** `{ "models": [{ "id": "...", "alias": "...", "mmproj": null }] }`

**Response:** `{ "success": true, "count": 5 }`

---

## Cache

### GET /cache/location
Returns the current llama.cpp API endpoint and default path.

### POST /cache/switch
Change the active API endpoint for the current session (not persisted to `settings.json`).

**Body:** `{ "location": "http://other-host:8000" }` or `{ "location": "default" }` to restore the saved URL.

### GET /cache/models
List models from `models.json` (same as `/models/available`).

---

## System

### GET /system/health
Returns service health and llama.cpp connectivity status.

`status` values:
- `healthy` — llama.cpp server is reachable
- `unhealthy` — URL is configured but server is not responding
- `not_configured` — no Llama API URL has been saved in Settings yet

```json
{
  "status": "healthy",
  "gpuServer": "online",
  "endpoint": "http://gpu-host.lan:8000/v1",
  "timestamp": 1705680000
}
```

### GET /system/stats
Dashboard statistics.

```json
{
  "totalModels": 3,
  "runningServices": 1,
  "totalRuns": 12,
  "lastRun": { ... },
  "bestTpsModel": { "modelId": "model_abc", "tps": 62.1 },
  "bestLatencyModel": { "modelId": "model_abc", "p95": 780 }
}
```
