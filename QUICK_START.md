# Quick Start: Run Your First Benchmark

## Prerequisites checklist

Before running a benchmark, verify:

- [ ] **llama.cpp / llama-swap is running** on your GPU server and reachable
- [ ] **Settings configured**: Llama API URL saved in the Settings tab
- [ ] **models.json populated**: at least one model via SSH scan, or manually edited
- [ ] **Backend is running**: terminal shows `LlamaPerformance server ready on port 3001`
- [ ] **Frontend is running**: browser at `http://localhost:3000`

---

## Step 1: Load a model

1. Go to **Models** tab
2. Find a model in the list (from `models.json`)
3. Click **Load** — llama-swap will load the GGUF file into VRAM
4. Wait for status to change to **running** (can take 10–60 seconds depending on model size)
5. Click **Test** to confirm inference works before benchmarking

If Test fails, benchmark will also fail. Check the backend logs for the error.

---

## Step 2: Quick benchmark (1 scenario)

Go to **Benchmarks** and set:

```
Iterations:  1
Concurrency: 1
Timeout:     60000 ms
Temperature: 0.7
Streaming:   ✓
```

Select **1 scenario** (e.g. *Simple Q&A - Short*) and your running model, then click **Run Benchmark**.

Expected time: 30–90 seconds.

---

## Step 3: View results

Go to **Results** tab. Select the run from the dropdown. You should see:

| Metric | Typical range | Meaning |
|--------|--------------|---------|
| TPS | 10–100+ t/s | Overall tokens per second |
| GenTPS | 15–150+ t/s | Generation speed after first token |
| TTFT | 200–5000 ms | Time to first token |
| P50 Latency | 500–10000 ms | Median response time |
| P95 Latency | 1000–30000 ms | 95th-percentile response time |
| Error Rate | 0% | Target: zero errors |
| Score | 0–100 | Weighted composite (TPS 40%, P95 40%, reliability 20%) |

---

## Full benchmark (9 scenarios)

Once the quick test succeeds:

```
Iterations:  5
Concurrency: 1
Timeout:     60000 ms
```

Select all 9 scenarios. Expected time: 15–30 minutes.

---

## Common issues

### 100% error rate
- Click **Test** on the model first — if it fails, the model isn't responding
- Check VRAM: the model may be too large to load
- Increase timeout if the GPU server is slow to start generating

### Timeout errors
- Increase timeout to `120000` ms (2 minutes) for large models
- Run 1 scenario / 1 iteration first to find a safe baseline

### Model won't load
- Verify the `id` in `models.json` matches exactly what llama-swap expects (no path prefix)
- For VL models, confirm `mmproj` filename is correct and `modelsDir` in Settings is set

### TPS = 0
- All iterations failed — set **Log Level** to `debug` in **Settings → Connection Settings** and check backend logs

---

## Pro tips

- **Always warm up**: run 1 iteration first; subsequent runs will be faster as the KV cache is warm
- **Compare models**: select multiple running models in the same benchmark run for side-by-side charts
- **Export results**: JSON and CSV export available on the Results tab; filename includes model name and datetime
- **SSH scan**: if you add new `.gguf` files to the remote server, use Settings → Scan Remote Models → Sync to update `models.json` without restarting

---

**Ready?** Go to the Models tab and load your first model.
