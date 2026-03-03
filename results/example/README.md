# Example Results

This directory contains example benchmark results to demonstrate the output format of LlamaPerformance.

## Files

- `benchmark-example.json` - Complete benchmark run with results for 2 models across 2 scenarios

## Result Structure

### Benchmark Run Metadata
- **run_id**: Unique identifier for the benchmark run
- **suite_name**: Name of the benchmark suite used
- **model_ids**: Array of model identifiers that were tested
- **config**: Configuration parameters (iterations, timeout, temperature, etc.)
- **hardware_info**: System hardware snapshot (CPU, RAM, GPU, OS)
- **status**: Run status (running, completed, failed)
- **timestamps**: Started and completed timestamps

### Individual Results
Each result record contains:
- **model_id**: Identifier of the model tested
- **scenario**: Name of the benchmark scenario
- **tps**: Tokens per second (overall throughput)
- **ttft**: Time to first token in milliseconds (streaming only)
- **tpot**: Time per output token - average inter-token delay in milliseconds (streaming only)
- **gen_tps**: Generation tokens per second after first token (1000/TPOT, streaming only)
- **latency_p50/p95/p99**: Latency percentiles in milliseconds
- **error_rate**: Percentage of failed requests
- **timeout_rate**: Percentage of timed-out requests
- **cpu_avg/ram_avg/gpu_avg**: Average resource utilization percentages
- **total_tokens**: Total tokens generated across all iterations
- **total_iterations**: Number of iterations run
- **successful_iterations**: Number of successful iterations

## Understanding the Metrics

### Throughput (TPS)
Higher is better. Indicates how many tokens the model can generate per second. Useful for comparing overall generation speed.

### Latency (P50/P95/P99)
Lower is better. Indicates response time:
- **P50 (median)**: 50% of requests completed in this time or less
- **P95**: 95% of requests completed in this time or less
- **P99**: 99% of requests completed in this time or less

P95 and P99 show tail latency and are important for user experience consistency.

### Time to First Token (TTFT)
Lower is better. Time until the first token is generated (streaming mode only). Important for perceived responsiveness.

### Time Per Output Token (TPOT)
Lower is better. Average time between consecutive tokens after the first token (streaming mode only). Indicates token generation consistency. Formula: average of all inter-token delays.

### Generation TPS (GenTPS)
Higher is better. Token generation rate after the first token (streaming mode only). Calculated as 1000/TPOT. Shows pure generation throughput excluding initial response time.

### Error Rate & Timeout Rate
Lower is better. Indicates reliability:
- **Error rate**: Percentage of requests that failed with errors
- **Timeout rate**: Percentage of requests that exceeded the timeout limit

### Resource Utilization
Context-dependent. Shows:
- **CPU**: Processor utilization percentage
- **RAM**: Memory usage percentage
- **GPU**: Graphics processor utilization percentage (if available)

Higher utilization may indicate heavier computational requirements.

## Example Interpretation

From `benchmark-example.json`:

**Best Throughput:** Llama 3.2 1B with 62.1 TPS on simple Q&A
**Best Latency:** Llama 3.2 1B with 650ms P50 on simple Q&A
**Most Stable:** Both models with 0% error rate
**Most Efficient:** Llama 3.2 1B with lower GPU usage (52-59% vs 68-72%)

**Scenario Complexity:** Reasoning tasks show ~2x higher latency than simple Q&A for both models, indicating increased computational complexity.

## Creating Your Own Results

After running a benchmark through the LlamaPerformance UI:

1. Navigate to the **Results** tab
2. Select your benchmark run
3. Click **Export JSON** or **Export CSV**
4. Save to `/results/` directory for archival

Results are also automatically stored in `/results/benchmarks.db` (SQLite database).
