import { performance } from 'perf_hooks';
import si from 'systeminformation';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import logger, { createBenchmarkLogger } from './logger.js';
import storage from './storage.js';
import orchestrator from './orchestrator.js';

async function getGpuMetrics() {
  try {
    const res = await axios.get('http://aion.home.lan:9999/gpu', { timeout: 3000 });
    const data = res.data;
    const card = Object.values(data).find(v => v['VRAM Total Used Memory (B)'] !== undefined);
    return {
      vram_used_mb: Math.round(parseInt(card['VRAM Total Used Memory (B)']) / 1024 / 1024),
      vram_total_mb: Math.round(parseInt(card['VRAM Total Memory (B)']) / 1024 / 1024),
      gpu_use_pct: parseInt(card['GPU use (%)'] ?? 0)
    };
  } catch {
    return { vram_used_mb: null, vram_total_mb: null, gpu_use_pct: null };
  }
}

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
    const client = orchestrator.getOpenAIClient();
    const modelName = (modelInfo.id || '').replace(/\.gguf$/i, '');

    // Modo RAG: messages pre-ensamblados por ragEngine.assembleMessages
    const hasRagMessages = Array.isArray(scenario._ragMessages);
    // Suites duales (prompt_system + prompt_user) y suites legacy (prompt)
    const hasPromptPair = !hasRagMessages && scenario.prompt_system && scenario.prompt_user;
    const systemPrompt = hasPromptPair ? scenario.prompt_system : null;
    const userPrompt = hasPromptPair ? scenario.prompt_user : scenario.prompt;

    const runSlot = async (promptOrMessages, slotType) => {
      // Acepta string prompt o array de messages pre-ensamblados (RAG)
      const messages = Array.isArray(promptOrMessages)
        ? promptOrMessages
        : [{ role: 'user', content: promptOrMessages }];
      const metrics = {
        slotType,
        startTime: performance.now(),
        endTime: null,
        ttft: null,
        tokens: 0,
        interTokenDelays: [],
        responseText: '',
        error: null,
        timeout: false
      };

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
          metrics.timeout = true;
        }, config.timeout || 60000);

        const maxTokens = scenario.max_tokens || 128;
        const temperature = slotType === 'system'
          ? (config.temperature_system ?? 0.1)
          : (config.temperature_user ?? config.temperature ?? 0.7);

        if (config.streaming === false) {
          // Modo no-streaming: respuesta única JSON
          const response = await client.chat.completions.create({
            model: modelName,
            messages,
            max_tokens: maxTokens,
            temperature,
            stream: false
          }, { signal: controller.signal });
          metrics.responseText = response.choices[0]?.message?.content || '';
          metrics.tokens = response.usage?.completion_tokens || 0;
        } else {
          // Modo streaming: fetch nativo + parsing SSE manual
          // (evita conflictos del pool de conexiones del SDK con streams concurrentes)
          const apiBase = orchestrator.getEndpoint();
          const response = await fetch(`${apiBase}/v1/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Bearer llama-rocks'
            },
            body: JSON.stringify({
              model: modelName,
              messages,
              max_tokens: maxTokens,
              temperature,
              stream: true
            }),
            signal: controller.signal
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${errText}`);
          }

          let firstTokenTime = null;
          let lastTokenTime = null;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const data = trimmed.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                try {
                  const chunk = JSON.parse(data);
                  const delta = chunk.choices?.[0]?.delta;
                  const text = delta?.content || delta?.reasoning_content;
                  if (text) {
                    const now = performance.now();
                    if (firstTokenTime === null) {
                      firstTokenTime = now;
                      metrics.ttft = now - metrics.startTime;
                      lastTokenTime = now;
                    } else {
                      metrics.interTokenDelays.push(now - lastTokenTime);
                      lastTokenTime = now;
                    }
                    metrics.tokens++;
                    metrics.responseText += text;
                  }
                } catch { /* chunk SSE malformado — ignorar */ }
              }
            }
          } finally {
            reader.releaseLock();
          }
        }

        clearTimeout(timeoutId);
      } catch (error) {
        if (error.name === 'AbortError') metrics.timeout = true;
        metrics.error = error.message;
        logger.error(`Inference failed [${slotType}]`, { error: error.message });
      }

      metrics.endTime = performance.now();
      return metrics;
    };

    if (hasRagMessages) {
      // Modo RAG: slot único con messages pre-ensamblados (system+context+user)
      const metrics = await runSlot(scenario._ragMessages, 'user');
      return { systemMetrics: null, userMetrics: metrics, concurrent: false };
    } else if (hasPromptPair) {
      // Lanzar ambos slots concurrentemente — simula parallel=2
      const [systemMetrics, userMetrics] = await Promise.all([
        runSlot(systemPrompt, 'system'),
        runSlot(userPrompt, 'user')
      ]);
      return { systemMetrics, userMetrics, concurrent: true };
    } else {
      // Suite legacy — comportamiento original
      const metrics = await runSlot(userPrompt, 'user');
      return { systemMetrics: null, userMetrics: metrics, concurrent: false };
    }
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
      responseTexts: [],
      errors: 0,
      timeouts: 0,
      resourceSnapshots: [],
      systemLatencies: [],
      systemTtfts: [],
      systemTokenCounts: [],
      systemInterTokenDelays: [],
      systemResponseTexts: []
    };

    // Run iterations
    for (let i = 0; i < config.iterations; i++) {
      if (progressCallback) {
        progressCallback({ modelId, scenario: scenario.name, iteration: i + 1, total: config.iterations });
      }

      const [resourcesBefore, gpuBefore] = await Promise.all([this.collectResourceMetrics(), getGpuMetrics()]);
      const inferenceResult = await this.runSingleInference(modelInfo, scenario, config);
      const [resourcesAfter, gpuAfter] = await Promise.all([this.collectResourceMetrics(), getGpuMetrics()]);

      const userM = inferenceResult.userMetrics;
      const sysM = inferenceResult.systemMetrics;
      const concurrent = inferenceResult.concurrent && sysM;

      // Wall-clock latency: for concurrent pairs, span both slots
      const pairStart = concurrent ? Math.min(sysM.startTime, userM.startTime) : userM.startTime;
      const pairEnd = concurrent ? Math.max(sysM.endTime, userM.endTime) : userM.endTime;
      const latency = pairEnd - pairStart;

      results.iterations.push(inferenceResult);

      // Count iteration as failed if either slot fails
      const iterHasTimeout = userM.timeout || (concurrent && sysM.timeout);
      const iterHasError = !iterHasTimeout && (userM.error || (concurrent && sysM.error));
      if (iterHasTimeout) results.timeouts++;
      else if (iterHasError) results.errors++;

      if (!iterHasTimeout && !iterHasError) {
        results.latencies.push(latency);
        if (userM.ttft !== null) results.ttfts.push(userM.ttft);
        // Tokens: sum both slots
        results.tokenCounts.push(userM.tokens + (concurrent ? (sysM.tokens || 0) : 0));
        // Inter-token delays: combine both slots
        if (userM.interTokenDelays.length > 0) results.allInterTokenDelays.push(...userM.interTokenDelays);
        if (userM.responseText) results.responseTexts.push(userM.responseText);

        if (concurrent) {
          results.systemLatencies.push(sysM.endTime - sysM.startTime);
          if (sysM.ttft !== null) results.systemTtfts.push(sysM.ttft);
          if (sysM.interTokenDelays.length > 0) results.allInterTokenDelays.push(...sysM.interTokenDelays);
          if (sysM.interTokenDelays.length > 0) results.systemInterTokenDelays.push(...sysM.interTokenDelays);
          results.systemTokenCounts.push(sysM.tokens || 0);
          if (sysM.responseText) results.systemResponseTexts.push(sysM.responseText);
        }
      }

      results.resourceSnapshots.push({
        before: resourcesBefore,
        after: resourcesAfter,
        gpu_vram_before_mb: gpuBefore.vram_used_mb,
        gpu_vram_after_mb: gpuAfter.vram_used_mb,
        gpu_vram_total_mb: gpuAfter.vram_total_mb,
        gpu_use_pct: gpuAfter.gpu_use_pct
      });
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

    const snapshots = results.resourceSnapshots;
    const vramValues = snapshots.map(s => s.gpu_vram_after_mb).filter(v => v !== null);
    const vramMax = vramValues.length > 0 ? Math.max(...vramValues) : null;
    const vramTotal = snapshots[0]?.gpu_vram_total_mb ?? null;

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
      vram_max_mb: vramMax,
      vram_total_mb: vramTotal,
      vram_pct: vramMax !== null && vramTotal ? +((vramMax / vramTotal) * 100).toFixed(1) : null,
      gpu_use_avg: snapshots.length > 0 ? +(snapshots.reduce((a, s) => a + (s.gpu_use_pct || 0), 0) / snapshots.length).toFixed(1) : null,
      total_tokens: totalTokens,
      total_iterations: config.iterations,
      successful_iterations: config.iterations - results.errors - results.timeouts,
      system_ttft: results.systemTtfts?.length > 0
        ? [...results.systemTtfts].sort((a, b) => a - b)[Math.floor(results.systemTtfts.length / 2)]
        : null,
      system_latency_p50: results.systemLatencies?.length > 0
        ? this.calculatePercentile([...results.systemLatencies].sort((a, b) => a - b), 50)
        : null,
      system_tps: (() => {
        const sysTok = results.systemTokenCounts?.reduce((s, t) => s + t, 0) ?? 0;
        const sysTime = (results.systemLatencies?.reduce((s, t) => s + t, 0) ?? 0) / 1000;
        return sysTime > 0 ? sysTok / sysTime : null;
      })(),
      system_tpot: results.systemInterTokenDelays?.length > 0
        ? results.systemInterTokenDelays.reduce((s, t) => s + t, 0) / results.systemInterTokenDelays.length
        : null,
      get system_gen_tps() { return this.system_tpot > 0 ? 1000 / this.system_tpot : null; },
      concurrent_slots: results.iterations[0]?.concurrent ? 2 : 1
    };

    benchmarkLogger.info('Scenario completed', { 
      scenario: scenario.name,
      tps: aggregated.tps.toFixed(2),
      p50: aggregated.latency_p50.toFixed(2)
    });

    return {
      aggregated,
      raw: {
        ...results,
        lastResponse: results.responseTexts.length > 0
          ? results.responseTexts[results.responseTexts.length - 1]
          : null,
        lastSystemResponse: results.systemResponseTexts?.length > 0
          ? results.systemResponseTexts[results.systemResponseTexts.length - 1]
          : null
      }
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
      progress: 0,
      pauseRequested: false,
      aborted: false
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
          const loadParams = model.load_params || {};

          if (!modelInfo) {
            benchmarkLogger.warn('Model not loaded in cache, attempting to load', { modelId, alias: model.alias, model_id: model.model_id });
            try {
              // Use model_id first (contains device-specific variant)
              modelInfo = await orchestrator.loadModel(modelId, model.model_id || model.alias, null, loadParams);
            } catch (err) {
              benchmarkLogger.error('Auto-load failed', { modelId, error: err.message });
              storage.saveLog('benchmark', runId, 'error', `Auto-load failed for ${model.model_id || model.alias}: ${err.message}`);
              return null;
            }
          }

          // Health check — retry loop up to 60s (covers slow models like Gemma-3-12B)
          let health = { healthy: false };
          const healthDeadline = Date.now() + 60000;
          const healthAlias = modelInfo.alias || model.alias || model.model_id;
          while (Date.now() < healthDeadline) {
            health = await orchestrator.checkModelHealth(healthAlias);
            if (health.healthy) break;
            benchmarkLogger.info('Model not ready yet, retrying health check', { modelId, alias: healthAlias, status: health.status });
            await new Promise(r => setTimeout(r, 3000));
          }

          if (!health.healthy) {
            storage.saveLog('benchmark', runId, 'error', `Model ${modelInfo.alias || model.alias} (${modelId}) service is unhealthy: ${health.error || health.status}`);
            return null;
          }

          return modelInfo;
        };

        // Espera a que llama-swap confirme que el modelo anterior ha quedado idle (VRAM libre)
        const waitForVramFree = async (modelId) => {
          return await orchestrator.waitForModelUnloaded(modelId);
        };

        // Helper to update progress (preserves pause/abort flags)
        let _currentModel = null;
        let _currentModelIndex = 0;
        const updateProgress = () => {
          const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
          const current = this.runningBenchmarks.get(runId) || {};
          this.runningBenchmarks.set(runId, {
            ...current,
            id: runId,
            progress,
            currentModel: _currentModel,
            currentModelIndex: _currentModelIndex,
            totalModels: modelIds.length
          });
          if (progressCallback) {
            progressCallback({ runId, progress });
          }
        };

        // Helper: check for pause/abort between scenarios
        const checkControl = async () => {
          const state = this.runningBenchmarks.get(runId);
          if (!state) return 'abort';
          if (state.aborted) return 'abort';
          if (state.pauseRequested) {
            // Enter paused state — wait until resumed or aborted
            const current = this.runningBenchmarks.get(runId);
            this.runningBenchmarks.set(runId, { ...current, status: 'paused', pauseRequested: false });
            benchmarkLogger.info('Benchmark paused', { runId });
            await new Promise(resolve => {
              const poll = setInterval(() => {
                const s = this.runningBenchmarks.get(runId);
                if (!s || s.status !== 'paused' || s.aborted) {
                  clearInterval(poll);
                  resolve();
                }
              }, 500);
            });
            const after = this.runningBenchmarks.get(runId);
            if (after?.aborted) return 'abort';
            benchmarkLogger.info('Benchmark resumed', { runId });
          }
          return 'continue';
        };

        // Inicializar RAG engine si la suite tiene config RAG
        let ragEngine = null;
        if (suite.rag) {
          const { RagEngine } = await import('./rag/ragEngine.js');
          ragEngine = new RagEngine(suite.rag);
          benchmarkLogger.info('RAG mode activado', {
            collection: suite.rag.collection,
            topK: suite.rag.top_k,
            embeddingsModel: suite.rag.embeddings_model
          });
        }

        // Run benchmarks for each model sequentially
        for (let i = 0; i < modelIds.length; i++) {
          const modelId = modelIds[i];

          // Unload previous model and wait for VRAM to be fully freed
          if (i > 0) {
            const prevId = modelIds[i - 1];
            const prevModel = storage.getModel(prevId);
            try {
              benchmarkLogger.info(`Unloading model ${prevId} before loading next`);
              await orchestrator.unloadModel(prevId, prevModel?.alias);
            } catch (e) {
              benchmarkLogger.warn(`Could not unload ${prevId}`, { error: e.message });
            }
            // Esperar a que llama-swap confirme idle del modelo anterior antes de cargar el siguiente
            await waitForVramFree(modelIds[i - 1]);
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

          // Brief settling pause — lets the model finish its internal initialization
          // and prevents inflated TTFT on the first inference after a fresh load
          await new Promise(r => setTimeout(r, 3000));

          // Run each scenario in the suite
          for (const scenario of suite.scenarios) {
            // Check pause/abort before starting each scenario
            if ((await checkControl()) === 'abort') break;

            try {
              // Modo RAG: recuperar contexto antes de la inferencia
              let augScenario = scenario;
              let ragResult = null;
              if (ragEngine && scenario.question) {
                try {
                  ragResult = await ragEngine.retrieve(scenario.question);
                  const messages = ragEngine.assembleMessages(
                    suite.system_prompt || '',
                    ragResult.chunks,
                    scenario.question
                  );
                  augScenario = { ...scenario, _ragMessages: messages };
                  benchmarkLogger.info(`RAG: ${ragResult.chunks.length} chunks en ${ragResult.latencyMs}ms`, {
                    scenario: scenario.name
                  });
                } catch (ragErr) {
                  benchmarkLogger.error('RAG retrieval falló — ejecutando sin contexto', {
                    scenario: scenario.name,
                    error: ragErr.message
                  });
                }
              }

              const result = await this.runScenario(
                modelId,
                augScenario,
                config,
                progressCallback
              );

              // Adjuntar chunks RAG al raw_data para auditoría
              if (ragResult) {
                result.raw.ragChunks = ragResult.chunks.map(c => ({
                  score: +c.score.toFixed(4),
                  pdf_name: c.payload.pdf_name,
                  page: c.payload.page,
                  text: c.payload.text.slice(0, 500)
                }));
                result.raw.ragRetrievalMs = ragResult.latencyMs;
              }

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
            await waitForVramFree(lastId, 10000);
          } catch (e) {
            benchmarkLogger.warn(`Could not unload last model ${lastId}`, { error: e.message });
          }
        }

        // Check if aborted
        const finalState = this.runningBenchmarks.get(runId);
        const wasAborted = finalState?.aborted;

        // Update run as completed or aborted
        storage.updateBenchmarkRun(runId, {
          status: wasAborted ? 'aborted' : 'completed',
          completed_at: Date.now()
        });

        this.runningBenchmarks.set(runId, {
          id: runId,
          status: wasAborted ? 'aborted' : 'completed',
          progress: wasAborted ? finalState?.progress : 100
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

  pauseBenchmark(runId) {
    const state = this.runningBenchmarks.get(runId);
    if (state && state.status === 'running') {
      this.runningBenchmarks.set(runId, { ...state, pauseRequested: true });
      return true;
    }
    return false;
  }

  resumeBenchmark(runId) {
    const state = this.runningBenchmarks.get(runId);
    if (state && state.status === 'paused') {
      this.runningBenchmarks.set(runId, { ...state, status: 'running', pauseRequested: false });
      return true;
    }
    return false;
  }

  abortBenchmark(runId) {
    const state = this.runningBenchmarks.get(runId);
    if (state && (state.status === 'running' || state.status === 'paused')) {
      // If paused, set status to running so the pause wait loop exits, then aborted flag triggers break
      this.runningBenchmarks.set(runId, { ...state, status: 'running', aborted: true, pauseRequested: false });
      return true;
    }
    return false;
  }
}

export default new BenchmarkEngine();