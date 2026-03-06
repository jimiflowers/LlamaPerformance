# LlamaPerformance

> **Fork** of [leestott/FLPerformance](https://github.com/leestott/FLPerformance), adapted to benchmark GGUF models served by a remote **llama-swap** / **llama.cpp** server instead of Microsoft Foundry Local.

A full-stack web application for measuring and comparing the inference performance of multiple LLMs running on a GPU server.

---

## What this fork changes

The original FLPerformance was built around Microsoft Foundry Local (Windows, ONNX models). This fork replaces that backend with:

| Original | This fork |
|----------|-----------|
| Microsoft Foundry Local SDK | Direct HTTP to llama-swap / llama.cpp OpenAI-compatible API |
| ONNX models | GGUF models |
| Windows-centric | Linux (tested on Ubuntu + AMD ROCm) |
| Hardcoded local service | Remote GPU server via configurable URL |
| No SSH integration | SSH scan to discover `.gguf` files on remote server |
| Configuration via `.env` only | Settings UI persisted to `settings.json` |
| Single-prompt scenarios | Dual-slot concurrent benchmarking (system + user prompts) |

---

## Features

- **Model management**: Add and track GGUF models; llama-swap loads them implicitly on first inference request
- **Benchmark engine**: Runs standardised prompt suites and collects:
  - TTFT (time to first token) — per slot
  - TPOT (time per output token) — combined across both slots
  - TPS / GenTPS (throughput) — combined token count over wall-clock time
  - P50 / P95 / P99 latency percentiles — wall-clock of the concurrent pair
  - CPU, RAM, GPU utilisation
  - VRAM peak usage (MB and %) and free margin
  - Error rate and performance score
- **Dual-slot concurrent benchmarking**: Suites can define `prompt_system` (JSON, low temperature) and `prompt_user` (natural language, higher temperature) pairs — both slots are sent concurrently via `Promise.all`, mirroring a `parallel=2` llama-swap setup. All metrics (tokens, delays, latency) aggregate both slots
- **Multi-model sequential benchmarking**: Select any number of models — including stopped ones — and the engine tests each in sequence, waiting for VRAM to clear between models, then shows a side-by-side comparison
- **Multi-model comparison**: Side-by-side charts and a radar overview
- **VRAM usage section**: Bar chart and table of peak VRAM consumption per model, with a 100% reference line and colour-coded margin alerts
- **Vision model support**: Automatic mmproj pairing for VL models
- **SSH model discovery**: Scan a remote directory for `.gguf` files and sync to `models.json` without leaving the UI; llama-swap model list also queried as a fallback
- **Settings UI**: All runtime configuration (API URL, SSH credentials, log level) stored in `settings.json` — no need to restart for most changes
- **Export**: JSON and CSV download of any benchmark run
- **Storage**: SQLite (preferred) with automatic JSON fallback

---

## Requirements

| Component | Notes |
|-----------|-------|
| Node.js ≥ 18 | Backend and Vite dev server |
| llama-swap or llama.cpp | Running on a GPU machine, accessible by HTTP |
| SSH access to GPU machine | Only needed for the model discovery scan |
| GPU stats endpoint (optional) | `http://<gpu-host>:9999/gpu` — used for real-time VRAM telemetry during benchmarks |

The application does **not** need to run on the GPU machine itself. The backend can run on any Linux host that has network access to the llama.cpp server.

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/jimmiflowers/LlamaPerformance.git
cd LlamaPerformance

# 2. Install all dependencies (backend + frontend)
npm run setup
```

---

## Starting the application

### Normal use (single port)

```bash
./START_APP.sh
```

Builds the React frontend and serves everything from the Express server on **port 3001**.
Open `http://localhost:3001` once the server is ready.

### Development (hot-reload on both ends)

```bash
./START_APP.sh --dev
# or: npm run dev
```

Skips the build and starts Vite dev server alongside Express:
- **Frontend (Vite, hot-reload)**: `http://localhost:3000`
- **Backend API**: `http://localhost:3001`

Open `http://localhost:3000` for the hot-reloading dev UI.

### Manual production build

```bash
npm run build    # builds the React app into src/client/dist/
npm run server   # serves the built UI from the Express server on port 3001
```

---

## First-time configuration

1. Open **http://localhost:3000** (dev mode) or **http://localhost:3001** (production) in your browser.
2. A blue **"Setup required"** banner will appear on every page until settings are saved.
3. Go to **Settings → Connection Settings**:

   **Option A — Remote server (default)**
   - Set **Llama API URL** to the address of your llama.cpp / llama.cpp server (e.g. `http://gpu-host.lan:8000`)
   - Adjust **Server Port** if needed (restart required to take effect)
   - Choose **Log Level**
   - Click **Save Connection Settings**

   **Option B — Local llama.cpp on the same machine**
   - Tick **Use local llama.cpp instance**
   - Set the port where llama.cpp is listening (default `8080`)
   - Click **Save Connection Settings** (SSH section is hidden in local mode)

4. Go to **Settings → Local/SSH Model Discovery**:

   **Option A — Remote server (SSH)**
   - Set **Remote Models Directory** (full path on the GPU server where `.gguf` files are stored)
   - Set **SSH Username**
   - Either tick **SSH Trust Relationship** (uses `~/.ssh/id_rsa`) or enter the SSH password
   - Click **Save SSH Settings**
   - Click **Scan Remote Models** — a table of `.gguf` files found on the remote server appears

   **Option B — Local llama.cpp**
   - Set **Local Models Directory** (full path on this machine where `.gguf` files are stored)
   - Click **Save Directory**
   - Click **Scan Local Models** — a table of `.gguf` files found in that directory appears

   In both cases: click **Sync all N to models.json** to replace the model inventory.

---

## Using the application

### Models tab

- Lists all models from `models.json`
- **Load**: sends a load request to llama.cpp for that model. If another model is already loaded, a dialog offers three choices: unload first, keep both (advanced — may hang on single-GPU hardware), or cancel.
- **Unload**: unloads the model and frees VRAM
- **Test**: runs a single inference request to verify the model responds
- **Info**: shows live slot status from llama.cpp (`/slots`), server configuration (`/props`), and recent benchmark results for that model
- **Params**: opens a per-model dialog to configure the llama.cpp load parameters that will be sent every time this model is loaded (manually or during a benchmark run):

  | Parameter | Control | Description |
  |---|---|---|
  | `n_ctx` | Dropdown + custom input | Context window size: 4k, 8k, 16k, 24k, 32k, or any custom value in tokens |
  | `n_batch` | Dropdown + custom input | Prompt batch size: 128, 256, 512, 1024, or custom |
  | `flash_attn` | Checkbox | Enable Flash Attention |
  | `cache_type_k` | Dropdown | KV-cache quantisation for K: `q4_0`, `q8_0`, `fp16` |
  | `cache_type_v` | Dropdown | KV-cache quantisation for V: `q4_0`, `q8_0`, `fp16` |

  Leave any field at *Server default* to let llama.cpp use its own startup value. Models with custom params show a **Params \*** button (highlighted in blue) as a reminder.

### Benchmarks tab

1. Select a benchmark suite. The `default` suite has 9 single-prompt scenarios; `mayordomo_spanish` has 8 dual-slot scenarios in Spanish (each sends a JSON system prompt and a natural-language user prompt concurrently)
2. Tick one or more models — **any model can be selected, regardless of whether it is currently loaded**
3. Configure iterations, timeout, and temperature. Dual-prompt suites expose two separate temperature fields: **System temperature** (for JSON prompts, default 0.1) and **User temperature** (for natural-language prompts, default 0.7)
4. Click **Run Benchmark** — the engine will:
   - For each model in order: send the first inference request (triggering implicit load in llama-swap), then retry `GET /upstream/{model}/health` every 3 s for up to 60 s until the model reports `status: ok`
   - For dual-slot suites: send system and user prompts concurrently (`Promise.all`) — wall-clock latency and total tokens aggregate both slots
   - Apply a 3-second settling pause after model confirmation to avoid inflated TTFT on the first timed inference
   - Between models: poll `GET /running` every 500 ms until the previous model disappears (up to 60 s), confirming VRAM is free before triggering the next load
   - Unload the last model when its tests are done
5. The progress card shows the model currently under test and its position in the queue (e.g. "Testing Gemma-3-12B (2 of 3)")

### Results tab

- Select any past benchmark run from the dropdown
- View performance cards, comparison charts, and a detailed metrics table
- **Export JSON / CSV** — filename includes model name and datetime
- **Export PDF** — triggers the browser's print dialog; the UI (sidebar, controls) is hidden and a report header is injected automatically, so the printed output contains only charts and data tables. Use "Save as PDF" in the browser print dialog to get a PDF file.
- **Delete Run** — permanently removes a run from storage
- **VRAM Usage section** — table (Model | VRAM peak MB | VRAM peak % | GPU avg % | Free margin MB) and bar chart with a red 100% reference line. Sorted by consumption descending. Colour-coded: green < 75%, orange 75–90%, red > 90%; margin red if < 500 MB. Only shown when VRAM telemetry data is present
- **Model Responses table** — below the Detailed Results table, a cross-table shows the actual text returned by each model for every scenario (rows = scenarios, columns = models). For dual-slot suites, each cell shows both the **User** and **System** responses, labelled. Cells are truncated to ~5 lines with a **Show more / Show less** toggle. The full text is always shown when printing.

### Settings tab

Three sections, each saved independently:

- **Connection Settings** — Local/remote toggle, Llama API URL (or local port), server port, log level
- **Local/SSH Model Discovery** — Models directory path; SSH credentials and remote scan in remote mode, local filesystem scan in local mode
- **System Information** — Live display of active configuration

---

## Project structure

```
LlamaPerformance/
├── src/
│   ├── server/
│   │   ├── index.js           # Express server + all API routes
│   │   ├── orchestrator.js    # llama-swap connection manager (health, idle detection)
│   │   ├── benchmark.js       # Benchmark engine (dual-slot, VRAM metrics)
│   │   ├── storage.js         # SQLite + JSON persistence
│   │   ├── cacheManager.js    # Model inventory (models.json)
│   │   ├── settingsManager.js # Persistent settings (settings.json)
│   │   └── logger.js          # Winston structured logging
│   └── client/
│       └── src/
│           ├── pages/         # Dashboard, Models, Benchmarks, Results, Settings, Cache
│           └── utils/api.js   # Axios client
├── benchmarks/
│   └── suites/
│       ├── default.json           # 9 single-prompt benchmark scenarios
│       └── mayordomo_spanish.json # 8 dual-slot scenarios (ES) for role-model selection
├── docs/
│   ├── api.md                 # Full API reference
│   └── changelog.md           # Detailed changelog per session
├── models.json                # GGUF model inventory — gitignored, created via Settings → SSH scan
├── settings.json              # Runtime configuration — gitignored, created on first Settings save
├── results/                   # Benchmark results (SQLite or JSON)
└── logs/                      # Winston log files
```

---

## Configuration reference

All settings are stored in `settings.json` at the project root and are editable from the Settings UI. On first run, if `settings.json` does not exist, values fall back to environment variables from `.env`.

| Setting | Env fallback | Description |
|---------|-------------|-------------|
| `llamaApiUrl` | `LLAMA_API_URL` | URL of the llama.cpp / llama.cpp server |
| `port` | `PORT` | Backend Express port (restart required) |
| `logLevel` | `LOG_LEVEL` | Winston log level — applied immediately |
| `modelsDir` | `MODELS_DIR` | Remote directory scanned for `.gguf` files |
| `ssh.username` | — | SSH user on the GPU server |
| `ssh.sshPort` | — | SSH port (default 22) |
| `ssh.trustRelationship` | — | Use `~/.ssh/id_rsa` instead of password |

`VITE_API_URL` must remain in `.env` — it is a Vite build-time variable and cannot be stored in `settings.json`.

---

## models.json format

```json
[
  {
    "id": "Llama-3.1-8B-Instruct-Q6_K.gguf",
    "alias": "Llama 3.1 8B Instruct Q6 K"
  },
  {
    "id": "Qwen2.5-VL-7B-Instruct-Q5_K_M.gguf",
    "alias": "Qwen2.5 VL 7B Instruct Q5 K M",
    "mmproj": "mmproj-Qwen2.5-VL-7B-F16.gguf"
  }
]
```

- `id` — filename of the `.gguf` file as known to llama.cpp (path excluded, extension included)
- `alias` — display name shown in the UI
- `mmproj` — (optional) mmproj filename for vision-language models

The Settings → SSH scan automatically detects mmproj files and assigns them to models whose filename contains `vl`.

---

## Troubleshooting

### Cannot connect to the llama.cpp server
- Verify the URL in **Settings → Connection Settings**
- Confirm the llama.cpp / llama.cpp process is running: `curl http://<host>:8000/health`

### SSH scan fails
- Verify SSH username and port are correct in Settings
- If using trust relationship, confirm `~/.ssh/id_rsa` exists on the machine running the Node.js server and the public key is authorised on the GPU server
- Test manually: `ssh -p <port> <user>@<host> ls /path/to/models`

### Model fails to load
- The `id` in `models.json` must match exactly what llama.cpp expects (no path prefix)
- For VL models, verify the `mmproj` filename is correct and that `modelsDir` in Settings points to the directory containing both files

### Benchmark timeouts
- Increase the timeout in the Benchmarks tab configuration
- Reduce concurrency to 1
- Large models may require more time for TTFT on first load

### Multi-model benchmark slower than individual runs
This is expected: the engine intentionally waits for VRAM to be fully freed between models (polls `GET /running` every 500 ms, up to 60 s) and adds a 3-second settling pause after model confirmation. If you run benchmarks individually you skip these safety delays. The results should be comparable — if they are still significantly worse, check that no other process is using GPU memory during the run.

### VRAM section does not appear in Results
The GPU stats endpoint (`http://aion.home.lan:9999/gpu`) must be reachable during the benchmark run. If it is not available, `getGpuMetrics()` returns nulls silently and the section is hidden. Check connectivity to the stats service on the GPU host.

---

## License

MIT — see [LICENSE](LICENSE)

Original project: [leestott/FLPerformance](https://github.com/leestott/FLPerformance) (MIT)
