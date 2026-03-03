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
Load the model into llama-swap (sends `/models/load` to the remote server).
For vision models the `mmproj` path is automatically included.

```json
{ "success": true }
```

### POST /models/:id/stop
Unload the model from llama-swap.

### POST /models/:id/test
Run a single inference request to verify the model responds.

```json
{ "success": true, "response": "Hello! ...", "latency": 890 }
```

### GET /models/:id/health
Check whether the model is currently loaded and healthy on the remote server.

### GET /models/:id/logs
Get log entries for this model. Query param: `limit` (default 100).

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
Start an async benchmark run. Returns immediately; poll `/benchmarks/runs` for status.

**Body:**
```json
{
  "modelIds": ["model_abc123"],
  "suiteName": "default",
  "config": {
    "iterations": 5,
    "concurrency": 1,
    "timeout": 60000,
    "temperature": 0.7,
    "streaming": true
  }
}
```

**Response:** `{ "success": true, "runId": "run_xyz", "message": "Benchmark started" }`

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
      "gpu_avg": 68.5
    }
  ]
}
```

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
