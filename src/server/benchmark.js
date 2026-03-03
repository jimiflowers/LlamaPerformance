import { performance } from 'perf_hooks';
import si from 'systeminformation';
import { v4 as uuidv4 } from 'uuid';
import logger, { createBenchmarkLogger } from './logger.js';
import storage from './storage.js';
import orchestrator from './orchestrator.js';

class BenchmarkEngine {
  constructor() {
    this.runningBenchmarks = new Map();
  }

  calculatePercentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0;
    const index = Math.ceil((percentile / 100) * sortedArray.length) - 1;
    return sortedArray[Math.max(0, index)];
  }

  /**
   * ADAPTADO: Recolección de métricas optimizada para Linux/AMD
   */
  async collectResourceMetrics() {
    try {
      const [cpu, mem, graphics] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.graphics().catch(() => ({ controllers: [] }))
      ]);

      // En NAVI 22/ROCm, si systeminformation falla, intentamos reportar 0 en lugar de null 
      // para no romper las gráficas del frontend
      return {
        cpu: cpu.currentLoad,
        ram: (mem.used / mem.total) * 100,
        gpu: graphics.controllers[0]?.utilizationGpu || 0 
      };
    } catch (error) {
      logger.warn('Failed to collect resource metrics', { error: error.message });
      return { cpu: 0, ram: 0, gpu: 0 };
    }
  }

  async getHardwareInfo() {
    try {
      const [cpu, mem, graphics, os] = await Promise.all([
        si.cpu(),
        si.mem(),
        si.graphics().catch(() => ({ controllers: [] })),
        si.osInfo()
      ]);

      return {
        cpu: {
          manufacturer: cpu.manufacturer,
          brand: cpu.brand,
          cores: cpu.cores,
          physicalCores: cpu.physicalCores
        },
        memory: {
          total: Math.round(mem.total / (1024 ** 3)) + ' GB'
        },
        gpu: graphics.controllers[0] ? {
          model: graphics.controllers[0].model,
          vram: graphics.controllers[0].vram + ' MB'
        } : { model: 'AMD NAVI 22 (ROCm)', vram: '12288 MB' }, // Fallback para tu GPU
        os: {
          platform: os.platform,
          distro: os.distro,
          release: os.release,
          arch: os.arch
        }
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * ADAPTADO: Inferencia optimizada para el stream de llama.cpp
   */
  async runSingleInference(modelInfo, scenario, config) {
    const metrics = {
      startTime: performance.now(),
      endTime: null,
      ttft: null,
      tokens: 0,
      interTokenDelays: [],
      error: null,
      timeout: false
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort();
        metrics.timeout = true;
      }, config.timeout || 60000); // 60s mejor para modelos grandes locales

      const client = orchestrator.getOpenAIClient();
      const modelName = (modelInfo.id || '').replace(/\.gguf$/i, '');

      // Usamos performance.now() para máxima precisión en el benchmark
      let firstTokenTime = null;
      let lastTokenTime = null;

      const stream = await client.chat.completions.create({
        model: modelName,
        messages: [{ role: 'user', content: scenario.prompt }],
        max_tokens: scenario.max_tokens || 128,
        temperature: config.temperature || 0.7,
        stream: true,
        stream_options: { include_usage: true }
      }, { signal: controller.signal });

      let finalUsage = null;

      for await (const chunk of stream) {
        // El último chunk de llama.cpp incluye usage si se pidió con include_usage
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) {
          const currentTokenTime = performance.now();
          if (!firstTokenTime) {
            firstTokenTime = currentTokenTime;
            metrics.ttft = firstTokenTime - metrics.startTime;
            lastTokenTime = currentTokenTime;
          } else {
            metrics.interTokenDelays.push(currentTokenTime - lastTokenTime);
            lastTokenTime = currentTokenTime;
          }
          metrics.tokens++;
        }
      }

      // Usar el conteo exacto del servidor si está disponible
      if (finalUsage?.completion_tokens) {
        metrics.tokens = finalUsage.completion_tokens;
      }

      clearTimeout(timeoutId);
      metrics.endTime = performance.now();

    } catch (error) {
      if (error.name === 'AbortError') metrics.timeout = true;
      metrics.error = error.message;
      metrics.endTime = performance.now();
      logger.error('Llama.cpp Inference failed', { error: error.message });
    }

    return metrics;
  }


  /**
   * Run benchmark scenario for a model
   */
  async runScenario(modelId, scenario, config, progressCallback) {
    const benchmarkLogger = createBenchmarkLogger(modelId);
    
    // Get model info from storage first
    const model = storage.getModel(modelId);
    if (!model) {
      throw new Error(`Model ${modelId} not found in storage.`);
    }
    
    // Get model info from orchestrator (loaded model info)
const modelInfo = orchestrator.getLoadedModelInfo(modelId) || { 
      alias: model.alias || modelId, 
      id: model.model_id || modelId 
    };
    
    if (!modelInfo) {
      throw new Error(`Model ${modelId} is not loaded. Please load the model first.`);
    }

    benchmarkLogger.info('Running scenario', { 
      scenario: scenario.name,
      iterations: config.iterations,
      modelAlias: modelInfo.alias,
      modelId: model.model_id
    });

    const results = {
      iterations: [],
      latencies: [],
      ttfts: [],
      tokenCounts: [],
      allInterTokenDelays: [],
      errors: 0,
      timeouts: 0,
      resourceSnapshots: []
    };

    // Run iterations
    for (let i = 0; i < config.iterations; i++) {
      if (progressCallback) {
        progressCallback({
          modelId,
          scenario: scenario.name,
          iteration: i + 1,
          total: config.iterations
        });
      }

      // Collect resource metrics before inference
      const resourcesBefore = await this.collectResourceMetrics();
      
      // Run inference with modelInfo
      const metrics = await this.runSingleInference(modelInfo, scenario, config);
      
      // Collect resource metrics after inference
      const resourcesAfter = await this.collectResourceMetrics();

      const latency = metrics.endTime - metrics.startTime;
      
      results.iterations.push(metrics);

      if (!metrics.error && !metrics.timeout) {
        results.latencies.push(latency);
        if (metrics.ttft !== null) {
          results.ttfts.push(metrics.ttft);
        }
        results.tokenCounts.push(metrics.tokens);

        // Collect inter-token delays for TPOT calculation
        if (metrics.interTokenDelays.length > 0) {
          results.allInterTokenDelays.push(...metrics.interTokenDelays);
        }
      }

      if (metrics.error) results.errors++;
      if (metrics.timeout) results.timeouts++;

      results.resourceSnapshots.push({
        before: resourcesBefore,
        after: resourcesAfter
      });

      // Small delay between iterations
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Calculate aggregate metrics
    const sortedLatencies = [...results.latencies].sort((a, b) => a - b);
    const sortedTtfts = [...results.ttfts].sort((a, b) => a - b);

    const totalTokens = results.tokenCounts.reduce((sum, t) => sum + t, 0);
    const totalTime = results.latencies.reduce((sum, t) => sum + t, 0) / 1000; // Convert to seconds
    const tps = totalTime > 0 ? totalTokens / totalTime : 0;

    // Calculate TPOT (Time Per Output Token) - average inter-token delay in ms
    const tpot = results.allInterTokenDelays.length > 0
      ? results.allInterTokenDelays.reduce((sum, t) => sum + t, 0) / results.allInterTokenDelays.length
      : null;

    // Calculate GenTPS (Generation Tokens Per Second) - 1000/TPOT
    const gen_tps = tpot > 0 ? 1000 / tpot : null;

    const avgCpu = results.resourceSnapshots
      .filter(r => r.after.cpu !== null)
      .reduce((sum, r) => sum + r.after.cpu, 0) / results.resourceSnapshots.length || null;
    
    const avgRam = results.resourceSnapshots
      .filter(r => r.after.ram !== null)
      .reduce((sum, r) => sum + r.after.ram, 0) / results.resourceSnapshots.length || null;
    
    const avgGpu = results.resourceSnapshots
      .filter(r => r.after.gpu !== null)
      .reduce((sum, r) => sum + r.after.gpu, 0) / 
      results.resourceSnapshots.filter(r => r.after.gpu !== null).length || null;

    const aggregated = {
      tps,
      ttft: sortedTtfts.length > 0 ? sortedTtfts[Math.floor(sortedTtfts.length / 2)] : null,
      tpot,
      gen_tps,
      latency_p50: this.calculatePercentile(sortedLatencies, 50),
      latency_p95: this.calculatePercentile(sortedLatencies, 95),
      latency_p99: this.calculatePercentile(sortedLatencies, 99),
      error_rate: (results.errors / config.iterations) * 100,
      timeout_rate: (results.timeouts / config.iterations) * 100,
      cpu_avg: avgCpu,
      ram_avg: avgRam,
      gpu_avg: avgGpu,
      total_tokens: totalTokens,
      total_iterations: config.iterations,
      successful_iterations: config.iterations - results.errors - results.timeouts
    };

    benchmarkLogger.info('Scenario completed', { 
      scenario: scenario.name,
      tps: aggregated.tps.toFixed(2),
      p50: aggregated.latency_p50.toFixed(2)
    });

    return {
      aggregated,
      raw: results
    };
  }

  /**
   * Run complete benchmark suite
   */
  async runBenchmark(modelIds, suiteName, suite, config, progressCallback, options = { returnImmediately: false }) {
    const runId = uuidv4();
    const benchmarkLogger = createBenchmarkLogger(runId);
    
    benchmarkLogger.info('Starting benchmark run', { 
      runId, 
      models: modelIds,
      suite: suiteName 
    });

    // Initialize running state
    this.runningBenchmarks.set(runId, {
      id: runId,
      status: 'running',
      progress: 0
    });

    const runTask = async () => {
      try {
        // Collect hardware info
        const hardwareInfo = await this.getHardwareInfo();

        // Save benchmark run
        const run = {
          id: runId,
          suite_name: suiteName,
          model_ids: modelIds,
          config,
          hardware_info: hardwareInfo,
          status: 'running',
          started_at: Date.now()
        };
        
        storage.saveBenchmarkRun(run);

        const allResults = [];
        const totalTasks = modelIds.length * (suite.scenarios?.length || 0);
        let completedTasks = 0;

        // Helper to ensure model is loaded and healthy
        const ensureModelReady = async (modelId, model) => {
          // Try cache first
          let modelInfo = orchestrator.getLoadedModelInfo(modelId);

          if (!modelInfo) {
            benchmarkLogger.warn('Model not loaded in cache, attempting to load', { modelId, alias: model.alias, model_id: model.model_id });
            try {
              // Use model_id first (contains device-specific variant)
              modelInfo = await orchestrator.loadModel(modelId, model.model_id || model.alias);
            } catch (err) {
              benchmarkLogger.error('Auto-load failed', { modelId, error: err.message });
              storage.saveLog('benchmark', runId, 'error', `Auto-load failed for ${model.model_id || model.alias}: ${err.message}`);
              return null;
            }
          }

          // Health check
          let health = await orchestrator.checkModelHealth(modelInfo.alias || model.alias || model.model_id);
          if (!health.healthy) {
            benchmarkLogger.warn('Model unhealthy, retrying load', { modelId, alias: modelInfo.alias, health });
            try {
              // Use model_id first (contains device-specific variant)
              await orchestrator.loadModel(modelId, model.model_id || model.alias);
              health = await orchestrator.checkModelHealth(modelInfo.alias || model.alias || model.model_id);
            } catch (err) {
              benchmarkLogger.error('Reload failed', { modelId, error: err.message });
            }
          }

          if (!health.healthy) {
            storage.saveLog('benchmark', runId, 'error', `Model ${modelInfo.alias || model.alias} (${modelId}) service is unhealthy: ${health.error || health.status}`);
            return null;
          }

          return modelInfo;
        };

        // Helper to update progress
        let _currentModel = null;
        let _currentModelIndex = 0;
        const updateProgress = () => {
          const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
          this.runningBenchmarks.set(runId, {
            id: runId,
            status: 'running',
            progress,
            currentModel: _currentModel,
            currentModelIndex: _currentModelIndex,
            totalModels: modelIds.length
          });
          if (progressCallback) {
            progressCallback({ runId, progress });
          }
        };

        // Run benchmarks for each model sequentially
        for (let i = 0; i < modelIds.length; i++) {
          const modelId = modelIds[i];

          // Unload previous model before loading next one
          if (i > 0) {
            const prevId = modelIds[i - 1];
            const prevModel = storage.getModel(prevId);
            try {
              benchmarkLogger.info(`Unloading model ${prevId} before loading next`);
              await orchestrator.unloadModel(prevId, prevModel?.alias);
            } catch (e) {
              benchmarkLogger.warn(`Could not unload ${prevId}`, { error: e.message });
            }
          }

          benchmarkLogger.info('Benchmarking model', { modelId });

          // Get model from storage to get alias
          const model = storage.getModel(modelId);
          if (!model) {
            benchmarkLogger.error('Model not found in storage', { modelId });
            storage.saveLog('benchmark', runId, 'error',
              `Model ${modelId} not found in storage`
            );
            completedTasks += suite.scenarios.length;
            updateProgress();
            continue;
          }

          // Update progress with current model info
          _currentModel = model.alias || modelId;
          _currentModelIndex = i + 1;
          updateProgress();

          const modelInfo = await ensureModelReady(modelId, model);
          if (!modelInfo) {
            benchmarkLogger.error('Model not ready, skipping', { modelId, alias: model.alias });
            completedTasks += suite.scenarios.length;
            updateProgress();
            continue;
          }

          benchmarkLogger.info('Model ready', {
            modelId,
            alias: modelInfo.alias,
            endpoint: orchestrator.getEndpoint()
          });

          // Run each scenario in the suite
          for (const scenario of suite.scenarios) {
            try {
              const result = await this.runScenario(
                modelId,
                scenario,
                config,
                progressCallback
              );

              // Save result
              const resultRecord = {
                id: uuidv4(),
                run_id: runId,
                model_id: modelId,
                scenario: scenario.name,
                ...result.aggregated,
                raw_data: result.raw
              };

              storage.saveBenchmarkResult(resultRecord);
              allResults.push(resultRecord);

            } catch (error) {
              benchmarkLogger.error('Scenario failed', {
                modelId,
                scenario: scenario.name,
                error: error.message
              });

              storage.saveLog('benchmark', runId, 'error',
                `Scenario ${scenario.name} failed for ${modelId}: ${error.message}`
              );
            } finally {
              completedTasks += 1;
              updateProgress();
            }
          }
        }

        // Unload the last model after all benchmarks complete (clean VRAM state)
        if (modelIds.length > 0) {
          const lastId = modelIds[modelIds.length - 1];
          const lastModel = storage.getModel(lastId);
          try {
            benchmarkLogger.info(`Unloading last model ${lastId} after benchmark completion`);
            await orchestrator.unloadModel(lastId, lastModel?.alias);
          } catch (e) {
            benchmarkLogger.warn(`Could not unload last model ${lastId}`, { error: e.message });
          }
        }

        // Update run as completed
        storage.updateBenchmarkRun(runId, {
          status: 'completed',
          completed_at: Date.now()
        });

        this.runningBenchmarks.set(runId, {
          id: runId,
          status: 'completed',
          progress: 100
        });

        benchmarkLogger.info('Benchmark run completed', { runId, resultsCount: allResults.length });

        return {
          runId,
          results: allResults
        };

      } catch (error) {
        benchmarkLogger.error('Benchmark run failed', { runId, error: error.message });
        
        storage.updateBenchmarkRun(runId, {
          status: 'failed',
          completed_at: Date.now()
        });

        this.runningBenchmarks.set(runId, {
          id: runId,
          status: 'failed',
          progress: 0,
          error: error.message
        });

        throw error;
      }
    };

    if (options.returnImmediately) {
      // Fire and forget
      runTask();
      return { runId };
    }

    return await runTask();
  }

  /**
   * Get benchmark run status
   */
  getBenchmarkStatus(runId) {
    return this.runningBenchmarks.get(runId);
  }
}

export default new BenchmarkEngine();