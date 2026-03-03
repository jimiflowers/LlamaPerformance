# LlamaPerformance

> **Fork** of [leestott/FLPerformance](https://github.com/leestott/FLPerformance), adapted to benchmark GGUF models served by a remote **llama.cpp** or **llama-swap** server instead of Microsoft Foundry Local.

A full-stack web application for measuring and comparing the inference performance of multiple LLMs running on a GPU server.

---

## What this fork changes

The original FLPerformance was built around Microsoft Foundry Local (Windows, ONNX models). This fork replaces that backend with:

| Original | This fork |
|----------|-----------|
| Microsoft Foundry Local SDK | Direct HTTP to llama.cpp OpenAI-compatible API |
| ONNX models | GGUF models |
| Windows-centric | Linux (tested on Ubuntu + AMD ROCm) |
| Hardcoded local service | Remote GPU server via configurable URL |
| No SSH integration | SSH scan to discover `.gguf` files on remote server |
| Configuration via `.env` only | Settings UI persisted to `settings.json` |

---

## Features

- **Model management**: Load and unload GGUF models via the llama-swap router
- **Benchmark engine**: Runs standardised prompt suites and collects:
  - TTFT (time to first token)
  - TPOT (time per output token)
  - TPS / GenTPS (throughput)
  - P50 / P95 / P99 latency percentiles
  - CPU, RAM, GPU utilisation
  - Error rate and performance score
- **Multi-model comparison**: Side-by-side charts and a radar overview
- **Vision model support**: Automatic mmproj pairing for VL models
- **SSH model discovery**: Scan a remote directory for `.gguf` files and sync to `models.json` without leaving the UI
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
   - Set **Llama API URL** to the address of your llama.cpp / llama-swap server (e.g. `http://gpu-host.lan:8000`)
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
- **Load**: sends a load request to llama-swap for that model
- **Stop**: unloads the model
- **Test**: runs a single inference request to verify the model responds

Models must be in **Running** state before they can be benchmarked.

### Benchmarks tab

1. Select a benchmark suite (the default suite has 9 scenarios)
2. Tick one or more running models
3. Configure iterations, concurrency, and timeout
4. Click **Run Benchmark** — progress updates every 2 seconds

### Results tab

- Select any past benchmark run from the dropdown
- View performance cards, comparison charts, and a detailed metrics table
- **Export JSON / CSV** — filename includes model name and datetime
- **Delete Run** — permanently removes a run from storage

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
│   │   ├── orchestrator.js    # llama.cpp connection manager
│   │   ├── benchmark.js       # Benchmark execution engine
│   │   ├── storage.js         # SQLite + JSON persistence
│   │   ├── cacheManager.js    # Model inventory (models.json)
│   │   ├── settingsManager.js # Persistent settings (settings.json)
│   │   └── logger.js          # Winston structured logging
│   └── client/
│       └── src/
│           ├── pages/         # Dashboard, Models, Benchmarks, Results, Settings, Cache
│           └── utils/api.js   # Axios client
├── benchmarks/
│   └── suites/default.json    # 9 benchmark scenarios
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
| `llamaApiUrl` | `LLAMA_API_URL` | URL of the llama.cpp / llama-swap server |
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

- `id` — filename of the `.gguf` file as known to llama-swap (path excluded, extension included)
- `alias` — display name shown in the UI
- `mmproj` — (optional) mmproj filename for vision-language models

The Settings → SSH scan automatically detects mmproj files and assigns them to models whose filename contains `vl`.

---

## Troubleshooting

### Cannot connect to the llama.cpp server
- Verify the URL in **Settings → Connection Settings**
- Confirm the llama.cpp / llama-swap process is running: `curl http://<host>:8000/health`

### SSH scan fails
- Verify SSH username and port are correct in Settings
- If using trust relationship, confirm `~/.ssh/id_rsa` exists on the machine running the Node.js server and the public key is authorised on the GPU server
- Test manually: `ssh -p <port> <user>@<host> ls /path/to/models`

### Model fails to load
- The `id` in `models.json` must match exactly what llama-swap expects (no path prefix)
- For VL models, verify the `mmproj` filename is correct and that `modelsDir` in Settings points to the directory containing both files

### Benchmark timeouts
- Increase the timeout in the Benchmarks tab configuration
- Reduce concurrency to 1
- Large models may require more time for TTFT on first load

---

## License

MIT — see [LICENSE](LICENSE)

Original project: [leestott/FLPerformance](https://github.com/leestott/FLPerformance) (MIT)
