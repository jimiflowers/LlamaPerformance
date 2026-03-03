import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import logger, { logger as loggerInstance } from './logger.js';
import storage from './storage.js';
import orchestrator from './orchestrator.js';
import benchmark from './benchmark.js';
import cacheManager from './cacheManager.js';
import settingsManager from './settingsManager.js';
import { Client as SshClient } from 'ssh2';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = settingsManager.get().port || parseInt(process.env.PORT || '3001');

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ============================================================================
// Models API (ADAPTADO PARA LLAMA.CPP / GGUF)
// ============================================================================

/**
 * GET /api/models/available
 * Antes: { models: [] } -> Ahora: []
 */
app.get('/api/models/available', async (req, res) => {
  try {
    const models = await cacheManager.listCacheModels();
    res.json(models || []); // <-- ARRAY DIRECTO
  } catch (error) {
    res.json([]);
  }
});

/**
 * GET /api/models/loaded
 * ADAPTADO: Consulta al orchestrator qué modelo está activo en llama-server
 */
app.get('/api/models/loaded', async (req, res) => {
  try {
    const models = await orchestrator.listLoadedModels();
    res.json({ models });
  } catch (error) {
    logger.error('Error al consultar modelos cargados', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/models/:id/stop
 * Este es el puente entre el Frontend y el Orchestrator
 */
app.post('/api/models/:id(*)/stop', async (req, res) => {
  try {
    // 1. Extraemos el ID de la URL (ej: Qwen2.5-7b-Instruct-Q6_K.gguf)
    const { id } = req.params;
    
    logger.info(`>>> API: Petición de parada recibida para: ${id}`);

    // 2. Buscamos el alias o info extra en el storage si fuera necesario
    const model = storage.getModel(id);
    const alias = model ? model.alias : id;

    // 3. LLAMADA CRÍTICA: Aquí le pasamos el 'id' a la función unloadModel
    const result = await orchestrator.unloadModel(id, alias);
    
    if (result.success) {
      res.json({ success: true, status: 'stopped' });
    } else {
      res.status(500).json({ success: false, message: 'Llama.cpp no pudo descargar el modelo' });
    }
  } catch (error) {
    logger.error('Error en el endpoint /stop', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/models
 * Antes: { models: [] } -> Ahora: []
 */
app.get('/api/models', async (req, res) => {
  try {
    const models = storage.getAllModels();
    res.json(models || []); // <-- ARRAY DIRECTO
  } catch (error) {
    res.json([]);
  }
});

/**
 * POST /api/models/:id/start
 * ADAPTADO: Ordena a llama.cpp cargar el archivo GGUF seleccionado
 */
app.post('/api/models/:id/start', async (req, res) => {
  try {
    const { id } = req.params;
    const model = storage.getModel(id);
    
    if (!model) return res.status(404).json({ error: 'Modelo no encontrado' });

    // Buscar mmproj en el inventario (models.json) si el modelo lo requiere
    const inventory = await cacheManager.listCacheModels();
    const inventoryEntry = inventory.find(m => m.id === id);
    const mmproj = inventoryEntry?.mmproj || null;

    const loadParams = model.load_params || {};
    const modelInfo = await orchestrator.loadModel(id, model.model_id || model.alias, mmproj, loadParams);

    res.json({
      success: true,
      modelInfo,
      endpoint: orchestrator.getEndpoint()
    });
  } catch (error) {
    logger.error('Error al cargar modelo en llama-server', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/models/:id/test
 * Ejecuta una prueba rápida de inferencia
 */
app.post('/api/models/:id(*)/test', async (req, res) => {
  try {
    const { id } = req.params;
    const { prompt } = req.body;

    // Usamos el ID de la URL directamente — no depende del Map en memoria
    const modelName = id.replace(/\.gguf$/i, '');
    const storedModel = storage.getModel(id);

    const client = orchestrator.getOpenAIClient();
    const testPrompt = prompt || 'Responde brevemente: ¿Estás funcionando correctamente?';

    const startTime = performance.now();
    const response = await client.chat.completions.create({
      model: modelName,
      messages: [{ role: 'user', content: testPrompt }],
      max_tokens: 50
    });

    const latency = performance.now() - startTime;

    res.json({
      success: true,
      response: response.choices[0]?.message?.content,
      usage: response.usage,
      latency,
      model: storedModel?.alias || modelName
    });
  } catch (error) {
    logger.error('Error en test de inferencia', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Benchmarks API (Conserva la lógica, usa el motor nuevo)
// ============================================================================

app.post('/api/benchmarks/run', async (req, res) => {
  try {
    const { modelIds, suiteName, selectedScenarios, config } = req.body;
    
    // 1. Ruta absoluta más robusta
    const suitePath = path.resolve(__dirname, '../../benchmarks/suites', `${suiteName}.json`);
    
    if (!fs.existsSync(suitePath)) {
      throw new Error(`La suite de benchmark '${suiteName}' no existe en ${suitePath}`);
    }

    const suite = JSON.parse(fs.readFileSync(suitePath, 'utf8'));

    // 2. Filtrado de escenarios
    if (selectedScenarios?.length > 0) {
      suite.scenarios = suite.scenarios.filter(s => selectedScenarios.includes(s.name));
    }

    // 3. Lanzamiento (aquí el motor hace todo el trabajo sucio)
    const result = await benchmark.runBenchmark(
      modelIds, 
      suiteName, 
      suite, 
      config || { iterations: 3 }, // Valor por defecto si no viene
      (p) => p.progress != null && logger.info(`[BENCHMARK] Progreso: ${p.progress}%`),
      { returnImmediately: true }
    );

    // 4. Respuesta inmediata al frontend
    res.json({ 
      success: true, 
      runId: result.runId, 
      message: 'Benchmark iniciado en segundo plano' 
    });

  } catch (error) {
    logger.error('Fallo al iniciar benchmark:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Los demás endpoints de resultados y exportación (JSON/CSV) se mantienen 
// igual porque dependen de storage.js, que no ha cambiado.
app.get('/api/benchmarks/runs', async (req, res) => {
  try {
    const runs = storage.getAllBenchmarkRuns();
    const enriched = runs.map(run => {
      const aliases = (run.model_ids || []).map(id => {
        const m = storage.getModel(id);
        return m?.alias || id.replace(/\.gguf$/i, '');
      });
      return { ...run, model_aliases: aliases };
    });
    res.json({ runs: enriched });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/benchmarks/runs/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!storage.getBenchmarkRun(id)) return res.status(404).json({ error: 'Run not found' });
    storage.deleteBenchmarkRun(id);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/benchmarks/runs/:id', async (req, res) => {
  try {
    const run = storage.getBenchmarkRun(req.params.id);
    const results = storage.getBenchmarkResults(req.params.id).map(r => {
      let lastResponse = null;
      try {
        const rd = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : r.raw_data;
        lastResponse = rd?.lastResponse ?? null;
      } catch {}
      const { raw_data, ...rest } = r;
      return { ...rest, lastResponse };
    });
    res.json({ run, results });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ============================================================================
// System API & Cache (GGUF Management)
// ============================================================================

app.get('/api/system/health', async (req, res) => {
  try {
    const health = await orchestrator.checkServiceHealth();
    const status = health.status === 'not_initialized'
      ? 'not_configured'
      : health.healthy ? 'healthy' : 'unhealthy';
    res.json({
      status,
      gpuServer: health.healthy ? 'online' : 'offline',
      endpoint: health.endpoint,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

/**
 * GET /api/cache/location
 * Muestra la ruta de Linux donde están tus modelos .gguf
 */
app.get('/api/cache/location', async (req, res) => {
  try {
    const location = await cacheManager.getCurrentLocation();
    res.json({ location, isDefault: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/**
 * POST /api/cache/switch
 * Cambia el endpoint remoto de llama.cpp en tiempo de ejecución
 */
app.post('/api/cache/switch', async (req, res) => {
  try {
    const { location } = req.body;
    if (!location) return res.status(400).json({ error: 'Se requiere el campo location (URL)' });
    await cacheManager.switchCache(location);
    orchestrator.updateHost(location === 'default'
      ? (settingsManager.get().llamaApiUrl || '')
      : location
    );
    res.json({ success: true, location });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/models
 * Recibe la configuración del modelo desde la UI y la guarda en SQLite/JSON
 */
app.post('/api/models', async (req, res) => {
  try {
    const modelData = req.body;

    // CAPTURA FLEXIBLE: Buscamos el ID en cualquier campo posible
    const effectiveId = modelData.id || modelData.model_id || modelData.name;

    if (!effectiveId) {
      logger.error('Error 400: No se encontró ID en el cuerpo de la petición', { body: modelData });
      return res.status(400).json({ error: 'El ID del modelo (archivo .gguf) es obligatorio' });
    }

    const savedModel = storage.saveModel({
      id: effectiveId,
      alias: modelData.alias || effectiveId,
      model_id: effectiveId,
      status: 'stopped'
    });

    res.status(201).json(savedModel);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/models/:id(*)
 * Permite eliminar modelos de la lista configurada
 */
app.delete('/api/models/:id(*)', async (req, res) => {
  try {
    const { id } = req.params;
    storage.deleteModel(id);
    logger.info('Modelo eliminado de la configuración', { id });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/models/:id/params
 * Guarda los parámetros de carga personalizados (n_ctx, n_batch, flash_attn, cache_type_k/v)
 */
app.put('/api/models/:id(*)/params', async (req, res) => {
  try {
    const { id } = req.params;
    const model = storage.getModel(id);
    if (!model) return res.status(404).json({ error: 'Modelo no encontrado' });

    const { n_ctx, n_batch, flash_attn, cache_type_k, cache_type_v } = req.body;
    const loadParams = {};
    if (n_ctx)        loadParams.n_ctx        = Number(n_ctx);
    if (n_batch)      loadParams.n_batch      = Number(n_batch);
    if (flash_attn)   loadParams.flash_attn   = true;
    if (cache_type_k) loadParams.cache_type_k = cache_type_k;
    if (cache_type_v) loadParams.cache_type_v = cache_type_v;

    storage.saveModel({ ...model, load_params: Object.keys(loadParams).length ? loadParams : null });
    logger.info('Parámetros de carga actualizados', { id, loadParams });
    res.json({ success: true, load_params: loadParams });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Endpoints faltantes requeridos por el frontend
// ============================================================================

/**
 * GET /api/benchmarks/suites
 * Lee los archivos JSON de suites disponibles en benchmarks/suites/
 */
app.get('/api/benchmarks/suites', (req, res) => {
  try {
    const suitesDir = path.resolve(__dirname, '../../benchmarks/suites');
    const files = fs.readdirSync(suitesDir).filter(f => f.endsWith('.json'));
    const suites = files.map(file => {
      const suite = JSON.parse(fs.readFileSync(path.join(suitesDir, file), 'utf8'));
      return {
        name: file.replace('.json', ''),
        description: suite.description || '',
        scenarios: suite.scenarios || []
      };
    });
    res.json({ suites });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/benchmarks/runs/:id/status
 * Estado en tiempo real de un run (en memoria o en DB)
 */
app.get('/api/benchmarks/runs/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const inMemory = benchmark.getBenchmarkStatus(id);
    if (inMemory) return res.json(inMemory);
    const run = storage.getBenchmarkRun(id);
    res.json(run
      ? { status: run.status, progress: run.status === 'completed' ? 100 : 0 }
      : { status: 'not_found' }
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/benchmarks/runs/:id/logs
 * Logs asociados a un run
 */
app.get('/api/benchmarks/runs/:id/logs', (req, res) => {
  res.json({ logs: [] });
});

/**
 * GET /api/benchmarks/runs/:id/export/json
 */
app.get('/api/benchmarks/runs/:id/export/json', (req, res) => {
  try {
    const { id } = req.params;
    const run = storage.getBenchmarkRun(id);
    const results = storage.getBenchmarkResults(id);
    res.setHeader('Content-Disposition', `attachment; filename=benchmark-${id}.json`);
    res.json({ run, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/benchmarks/runs/:id/export/csv
 */
app.get('/api/benchmarks/runs/:id/export/csv', (req, res) => {
  try {
    const { id } = req.params;
    const results = storage.getBenchmarkResults(id);
    const header = 'model_id,scenario,tps,ttft,tpot,gen_tps,latency_p50,latency_p95,latency_p99,error_rate\n';
    const rows = results.map(r =>
      [r.model_id, r.scenario, r.tps ?? '', r.ttft ?? '', r.tpot ?? '', r.gen_tps ?? '',
       r.latency_p50 ?? '', r.latency_p95 ?? '', r.latency_p99 ?? '', r.error_rate ?? ''].join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=benchmark-${id}.csv`);
    res.send(header + rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/system/stats
 * Estadísticas agregadas para el Dashboard
 */
app.get('/api/system/stats', (req, res) => {
  try {
    const models = storage.getAllModels();
    const runs = storage.getAllBenchmarkRuns();
    const lastRun = runs[0] || null;
    const lastResults = lastRun ? storage.getBenchmarkResults(lastRun.id) : [];

    let bestTpsModel = null, bestLatencyModel = null;
    if (lastResults.length > 0) {
      const byTps = [...lastResults].sort((a, b) => (b.tps || 0) - (a.tps || 0))[0];
      const byP95 = [...lastResults].filter(r => r.latency_p95).sort((a, b) => a.latency_p95 - b.latency_p95)[0];
      if (byTps?.tps) bestTpsModel = { modelId: byTps.model_id, tps: byTps.tps };
      if (byP95) bestLatencyModel = { modelId: byP95.model_id, p95: byP95.latency_p95 };
    }

    res.json({
      totalModels: models.length,
      runningServices: models.filter(m => m.status === 'running').length,
      totalRuns: runs.length,
      lastRun,
      bestTpsModel,
      bestLatencyModel
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/models/:id/logs
 * Estado en tiempo real del slot de llama.cpp + props del servidor + últimos benchmarks del modelo
 */
app.get('/api/models/:id(*)/logs', async (req, res) => {
  const modelId = req.params.id;
  const result = { slots: null, props: null, recentBenchmarks: [] };

  const host = orchestrator.llamaHost;
  // El router de llama.cpp requiere el nombre del modelo sin extensión
  const modelName = modelId.replace(/\.gguf$/i, '');

  // Slot state en tiempo real
  try {
    const slotsRes = await axios.get(`${host}/slots`, {
      params: { model: modelName },
      timeout: 5000
    });
    result.slots = Array.isArray(slotsRes.data) ? slotsRes.data : slotsRes.data;
    logger.debug(`/slots OK: ${JSON.stringify(result.slots)}`);
  } catch (e) {
    result.slotsError = `${e.response?.status ?? ''} ${e.message}`.trim();
    logger.warn(`/slots failed: ${result.slotsError}`);
  }

  // Propiedades del servidor (contexto, temperatura por defecto, etc.)
  try {
    const propsRes = await axios.get(`${host}/props`, {
      params: { model: modelName },
      timeout: 5000
    });
    result.props = propsRes.data || null;
    logger.debug(`/props OK`);
  } catch (e) {
    result.propsError = `${e.response?.status ?? ''} ${e.message}`.trim();
    logger.warn(`/props failed: ${result.propsError}`);
  }

  // Últimos 10 resultados de benchmark para este modelo
  try {
    const allRuns = storage.getAllBenchmarkRuns();
    const modelRuns = allRuns.filter(r => {
      const ids = typeof r.model_ids === 'string' ? JSON.parse(r.model_ids) : (r.model_ids || []);
      return ids.includes(modelId);
    }).slice(0, 10);
    for (const run of modelRuns) {
      const results = storage.getBenchmarkResults(run.id).filter(r => r.model_id === modelId);
      for (const r of results) {
        result.recentBenchmarks.push({
          runId: run.id,
          suiteName: run.suite_name,
          startedAt: run.started_at,
          scenario: r.scenario,
          tps: r.tps,
          genTps: r.gen_tps,
          ttft: r.ttft,
          latencyP95: r.latency_p95,
          errorRate: r.error_rate
        });
      }
    }
    result.recentBenchmarks.sort((a, b) => b.startedAt - a.startedAt);
  } catch { /* sin datos */ }

  res.json(result);
});

/**
 * GET /api/cache/models
 * Lista de modelos disponibles en el inventario (alias de /api/models/available)
 */
app.get('/api/cache/models', async (req, res) => {
  try {
    const models = await cacheManager.listCacheModels();
    res.json({ models: models || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Settings API
// ============================================================================

/**
 * GET /api/settings
 * Devuelve la configuración actual (sin exponer la contraseña en claro)
 */
app.get('/api/settings', (req, res) => {
  try {
    const s = settingsManager.get();

    // Detectar claves SSH disponibles en ~/.ssh/
    const sshDir = path.join(os.homedir(), '.ssh');
    const keyNames = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'];
    const availableSshKeys = keyNames
      .map(name => path.join(sshDir, name))
      .filter(p => { try { fs.accessSync(p); return true; } catch { return false; } });

    res.json({
      ...s,
      isDefault: settingsManager.isDefault,
      availableSshKeys,
      ssh: {
        ...s.ssh,
        password: s.ssh.password ? '***' : ''
      }
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/**
 * PUT /api/settings
 * Guarda la configuración y aplica los cambios inmediatamente
 */
app.put('/api/settings', async (req, res) => {
  try {
    const patch = req.body;

    // Si el cliente envía '***' es que no cambió la contraseña — la dejamos como está
    if (patch.ssh?.password === '***') {
      delete patch.ssh.password;
    }

    const currentPort = settingsManager.get().port;
    const updated = settingsManager.update(patch);

    // Aplicar cambios en caliente
    if (patch.llamaApiUrl) {
      orchestrator.updateHost(patch.llamaApiUrl);
      cacheManager.llamaApiUrl = patch.llamaApiUrl;
    }
    if (patch.logLevel) {
      loggerInstance.level = patch.logLevel;
    }
    if (patch.modelsDir) {
      orchestrator.modelsDir = patch.modelsDir;
    }

    const portChanged = patch.port !== undefined && patch.port !== currentPort;
    res.json({
      success: true,
      settings: { ...updated, ssh: { ...updated.ssh, password: updated.ssh.password ? '***' : '' } },
      portChanged,
      restartRequired: portChanged
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

/**
 * POST /api/settings/ssh-scan
 * Lista los .gguf en modelsDir — localmente o por SSH según el modo configurado
 */
app.post('/api/settings/ssh-scan', (req, res) => {
  const s = settingsManager.get();
  const modelsDir = s.modelsDir;

  if (!modelsDir) return res.status(400).json({ error: 'Models directory not configured. Set it in SSH & Model Discovery settings.' });

  // Leer inventario actual para marcar existentes vs nuevos
  let existing = [];
  try {
    const inv = JSON.parse(fs.readFileSync(path.join(__dirname, '../../models.json'), 'utf8'));
    existing = inv.map(m => m.id);
  } catch { existing = []; }

  const buildResult = (filenames) => {
    const all = filenames.filter(f => f.endsWith('.gguf'));
    const mmprojs = all.filter(f => f.toLowerCase().includes('mmproj'));
    const models = all.filter(f => !f.toLowerCase().includes('mmproj'));
    const result = models.map(filename => {
      const isVL = filename.toLowerCase().includes('vl');
      const mmproj = isVL && mmprojs.length > 0 ? mmprojs[0] : null;
      const alias = filename.replace(/\.gguf$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return { id: filename, alias, mmproj, isNew: !existing.includes(filename) };
    });
    return { models: result, mmprojs };
  };

  // Detectar modo local
  let isLocal = false;
  try {
    const { hostname } = new URL(s.llamaApiUrl);
    isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch { /* URL inválida — tratar como remoto */ }

  if (isLocal) {
    // Escaneo local del sistema de archivos
    try {
      const files = fs.readdirSync(modelsDir);
      return res.json(buildResult(files));
    } catch (err) {
      return res.status(500).json({ error: `Cannot read directory "${modelsDir}": ${err.message}` });
    }
  }

  // Escaneo remoto por SSH
  const { username, password, sshPort, trustRelationship } = s.ssh;
  let host;
  try {
    host = new URL(s.llamaApiUrl).hostname;
  } catch {
    return res.status(400).json({ error: 'llamaApiUrl no es una URL válida' });
  }

  if (!username) return res.status(400).json({ error: 'Falta el nombre de usuario SSH en la configuración' });

  let authOptions;
  if (trustRelationship) {
    const sshKeyPath = s.ssh.sshKeyPath;
    const keyPath = sshKeyPath && sshKeyPath.trim()
      ? sshKeyPath.trim()
      : (['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa']
          .map(n => path.join(os.homedir(), '.ssh', n))
          .find(p => { try { fs.accessSync(p); return true; } catch { return false; } })
        );
    if (!keyPath) return res.status(500).json({ error: 'No SSH private key found in ~/.ssh/ — configure the key path in SSH settings.' });
    authOptions = { privateKey: fs.readFileSync(keyPath) };
  } else {
    authOptions = { password };
  }

  const conn = new SshClient();
  let responded = false;

  conn.on('ready', () => {
    conn.exec(`ls -1 "${modelsDir}" 2>/dev/null`, (err, stream) => {
      if (err) {
        conn.end();
        if (!responded) { responded = true; res.status(500).json({ error: err.message }); }
        return;
      }
      let output = '';
      stream.on('data', d => { output += d; });
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        conn.end();
        const filenames = output.split('\n').map(f => f.trim()).filter(Boolean);
        if (!responded) { responded = true; res.json(buildResult(filenames)); }
      });
    });
  });

  conn.on('error', err => {
    if (!responded) { responded = true; res.status(500).json({ error: `SSH error: ${err.message}` }); }
  });

  conn.connect({ host, port: sshPort || 22, username, ...authOptions });
});

/**
 * POST /api/settings/sync-models
 * Reemplaza models.json con la lista enviada desde el frontend
 */
app.post('/api/settings/sync-models', (req, res) => {
  try {
    const { models } = req.body;
    if (!Array.isArray(models)) return res.status(400).json({ error: 'models debe ser un array' });

    const inventory = models.map(({ id, alias, mmproj }) => ({
      id,
      alias,
      mmproj: mmproj || null
    }));

    const inventoryPath = path.join(__dirname, '../../models.json');
    fs.writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2), 'utf8');

    // Invalida la caché de cacheManager si la tiene
    if (cacheManager._cache) cacheManager._cache = null;

    logger.info(`models.json actualizado: ${inventory.length} modelos`);
    res.json({ success: true, count: inventory.length });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Producción: Servir archivos estáticos del frontend (React/Vite)
//if (process.env.NODE_ENV === 'production') {
  const clientBuildPath = path.join(__dirname, '../client/dist');
  app.use(express.static(clientBuildPath));
  app.get('*', (req, res) => res.sendFile(path.join(clientBuildPath, 'index.html')));
//}

// Inicio del servidor
const server = app.listen(PORT, () => {
  logger.info(`LlamaPerformance server ready on port ${PORT}`);

  // Apply persisted settings (settings.json overrides env-var defaults)
  const s = settingsManager.get();
  if (s.logLevel) loggerInstance.level = s.logLevel;
  if (s.llamaApiUrl) {
    orchestrator.updateHost(s.llamaApiUrl);
    cacheManager.llamaApiUrl = s.llamaApiUrl;
  }
  if (s.modelsDir) orchestrator.modelsDir = s.modelsDir;

  // Only attempt connection if a URL is configured
  if (s.llamaApiUrl) {
    orchestrator.initialize()
      .then(() => logger.info('Connected to Llama.cpp server'))
      .catch(err => logger.warn('Could not connect to Llama.cpp server (will retry on first use)', { error: err.message }));
  } else {
    logger.info('No Llama API URL configured — open the Settings page to set it up');
  }
});

// Apagado limpio
const shutdown = async () => {
  logger.info('Cerrando servidor...');
  server.close();
  await orchestrator.cleanup();
  storage.close();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default app;