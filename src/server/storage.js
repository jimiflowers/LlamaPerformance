import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Intentamos cargar SQLite, si no, usamos JSON (ideal para entornos Docker rápidos)
let Database = null;
try {
  const module = await import('better-sqlite3');
  Database = module.default;
} catch (err) {
  logger.warn('SQLite no disponible, usando fallback de archivos JSON');
}

class Storage {
  constructor() {
    const resultsDir = path.join(__dirname, '../../results');
    if (!fs.existsSync(resultsDir)) fs.mkdirSync(resultsDir, { recursive: true });

    if (Database) {
      this.db = new Database(path.join(resultsDir, 'benchmarks.db'));
      this.initDatabase();
      this.useJson = false;
      logger.info('Base de datos SQLite lista para registros AMD/GGUF');
    } else {
      this.jsonPath = path.join(resultsDir, 'storage.json');
      this.data = this.loadJsonData();
      this.useJson = true;
    }
  }

  // --- Lógica de Base de Datos ---
  initDatabase() {
    // Modelos GGUF locales con métricas de hardware
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT DEFAULT 'stopped',
        vram_usage INTEGER,      -- Uso de VRAM en MB
        compute_unit TEXT,      -- 'ROCm/NAVI22' o 'CPU'
        created_at INTEGER
      )
    `);

    // Sesiones de Benchmark
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id TEXT PRIMARY KEY,
        suite_name TEXT NOT NULL,
        model_ids TEXT NOT NULL,
        hardware_info TEXT,
        status TEXT,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);

    // Resultados detallados (todas las métricas de inferencia y hardware)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS benchmark_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        scenario TEXT,
        tps REAL,
        ttft REAL,
        tpot REAL,
        gen_tps REAL,
        latency_p50 REAL,
        latency_p95 REAL,
        latency_p99 REAL,
        error_rate REAL,
        timeout_rate REAL,
        cpu_avg REAL,
        ram_avg REAL,
        gpu_avg REAL,
        total_tokens INTEGER,
        total_iterations INTEGER,
        successful_iterations INTEGER,
        raw_data TEXT,
        created_at INTEGER
      )
    `);

    // Migración: load_params en tabla models
    try { this.db.exec(`ALTER TABLE models ADD COLUMN load_params TEXT`); }
    catch (e) { /* ya existe */ }

    // Migración: añade columnas nuevas a bases de datos existentes
    const newColumns = [
      'tpot REAL', 'gen_tps REAL', 'latency_p50 REAL', 'latency_p95 REAL',
      'latency_p99 REAL', 'error_rate REAL', 'timeout_rate REAL',
      'cpu_avg REAL', 'ram_avg REAL', 'gpu_avg REAL',
      'total_tokens INTEGER', 'total_iterations INTEGER', 'successful_iterations INTEGER'
    ];
    for (const col of newColumns) {
      try { this.db.exec(`ALTER TABLE benchmark_results ADD COLUMN ${col}`); }
      catch (e) { /* la columna ya existe */ }
    }

    // Logs de eventos asociados a runs de benchmark
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        run_id TEXT,
        level TEXT,
        message TEXT,
        created_at INTEGER
      )
    `);
  }

  // --- Operaciones de Modelos ---
 /**
   * Guarda o actualiza el estado del modelo, incluyendo telemetría de GPU
   */
  _parseModel(m) {
    if (!m || typeof m.load_params !== 'string') return m;
    try { m.load_params = JSON.parse(m.load_params); } catch { m.load_params = null; }
    return m;
  }

  saveModel(model) {
    const now = Date.now();
    const vram = model.vram_usage || 0;
    const unit = model.compute_unit || 'Unknown';
    const loadParamsJson = model.load_params
      ? JSON.stringify(model.load_params)
      : null;

    if (this.useJson) {
      this.data.models[model.id] = {
        ...model,
        vram_usage: vram,
        compute_unit: unit,
        created_at: now
      };
      this.saveJsonData();
    } else {
      this.db.prepare(`
        INSERT OR REPLACE INTO models (id, alias, model_id, status, vram_usage, compute_unit, load_params, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        model.id,
        model.alias,
        model.model_id,
        model.status || 'stopped',
        vram,
        unit,
        loadParamsJson,
        now
      );
    }
    return model;
  }

  getAllModels() {
    if (this.useJson) return Object.values(this.data.models).sort((a, b) => b.created_at - a.created_at);
    return this.db.prepare('SELECT * FROM models ORDER BY created_at DESC').all().map(m => this._parseModel(m));
  }

  getModel(id) {
    if (this.useJson) return this.data.models[id] || null;
    return this._parseModel(this.db.prepare('SELECT * FROM models WHERE id = ?').get(id));
  }

  deleteModel(id) {
    if (this.useJson) {
      delete this.data.models[id];
      this.saveJsonData();
    } else {
      this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
    }
  }

  // --- Operaciones de Benchmark ---
  saveBenchmarkRun(run) {
    const now = Date.now();
    if (this.useJson) {
      this.data.benchmark_runs[run.id] = { ...run, started_at: now };
      this.saveJsonData();
    } else {
      this.db.prepare(`
        INSERT INTO benchmark_runs (id, suite_name, model_ids, hardware_info, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(run.id, run.suite_name, JSON.stringify(run.model_ids), JSON.stringify(run.hardware_info), 'running', now);
    }
    return run;
  }

  saveBenchmarkResult(result) {
    const now = Date.now();
    if (this.useJson) {
      if (!this.data.benchmark_results[result.run_id]) this.data.benchmark_results[result.run_id] = [];
      this.data.benchmark_results[result.run_id].push({ ...result, created_at: now });
      this.saveJsonData();
    } else {
      this.db.prepare(`
        INSERT INTO benchmark_results (
          id, run_id, model_id, scenario,
          tps, ttft, tpot, gen_tps,
          latency_p50, latency_p95, latency_p99,
          error_rate, timeout_rate,
          cpu_avg, ram_avg, gpu_avg,
          total_tokens, total_iterations, successful_iterations,
          raw_data, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id, result.run_id, result.model_id, result.scenario,
        result.tps, result.ttft, result.tpot, result.gen_tps,
        result.latency_p50, result.latency_p95, result.latency_p99,
        result.error_rate, result.timeout_rate,
        result.cpu_avg, result.ram_avg, result.gpu_avg,
        result.total_tokens, result.total_iterations, result.successful_iterations,
        JSON.stringify(result.raw_data), now
      );
    }
  }

  getAllBenchmarkRuns() {
    if (this.useJson) return Object.values(this.data.benchmark_runs).sort((a, b) => b.started_at - a.started_at);
    const runs = this.db.prepare('SELECT * FROM benchmark_runs ORDER BY started_at DESC').all();
    return runs.map(r => ({ ...r, model_ids: JSON.parse(r.model_ids), hardware_info: JSON.parse(r.hardware_info || '{}') }));
  }

  deleteBenchmarkRun(id) {
    if (this.useJson) {
      delete this.data.benchmark_runs[id];
      delete this.data.benchmark_results[id];
      this.data.logs = this.data.logs.filter(l => l.run_id !== id);
      this.saveJsonData();
    } else {
      this.db.prepare('DELETE FROM benchmark_results WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM logs WHERE run_id = ?').run(id);
      this.db.prepare('DELETE FROM benchmark_runs WHERE id = ?').run(id);
    }
  }

  getBenchmarkRun(id) {
    if (this.useJson) return this.data.benchmark_runs[id] || null;
    const run = this.db.prepare('SELECT * FROM benchmark_runs WHERE id = ?').get(id);
    if (!run) return null;
    return { ...run, model_ids: JSON.parse(run.model_ids), hardware_info: JSON.parse(run.hardware_info || '{}') };
  }

  updateBenchmarkRun(id, updates) {
    if (this.useJson) {
      if (this.data.benchmark_runs[id]) {
        this.data.benchmark_runs[id] = { ...this.data.benchmark_runs[id], ...updates };
        this.saveJsonData();
      }
    } else {
      const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), id];
      this.db.prepare(`UPDATE benchmark_runs SET ${fields} WHERE id = ?`).run(...values);
    }
  }

  saveLog(type, runId, level, message) {
    const entry = { type, run_id: runId, level, message, created_at: Date.now() };
    if (this.useJson) {
      this.data.logs.push(entry);
      this.saveJsonData();
    } else {
      this.db.prepare(
        'INSERT INTO logs (type, run_id, level, message, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(type, runId, level, message, entry.created_at);
    }
  }

  getBenchmarkResults(runId) {
    if (this.useJson) return this.data.benchmark_results[runId] || [];
    return this.db.prepare('SELECT * FROM benchmark_results WHERE run_id = ?').all(runId);
  }

  // --- Utilidades JSON Fallback ---
  loadJsonData() {
    if (fs.existsSync(this.jsonPath)) {
      try { return JSON.parse(fs.readFileSync(this.jsonPath, 'utf8')); }
      catch (e) { logger.error('Error cargando JSON storage'); }
    }
    return { models: {}, benchmark_runs: {}, benchmark_results: {}, logs: [] };
  }

  saveJsonData() {
    if (this.useJson) fs.writeFileSync(this.jsonPath, JSON.stringify(this.data, null, 2));
  }

  close() {
    if (!this.useJson && this.db) this.db.close();
  }
}

export default new Storage();