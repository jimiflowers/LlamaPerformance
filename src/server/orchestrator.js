import axios from 'axios';
import OpenAI from 'openai';
import logger, { createServiceLogger } from './logger.js';
import storage from './storage.js';
import cacheManager from './cacheManager.js';

class LlamaOrchestrator {
  constructor() {
    this.manager = null;
    this.openaiClient = null;
    this.loadedModels = new Map();
    this.initialized = false;
    this.llamaHost = process.env.LLAMA_API_URL || '';
    this.modelsDir = process.env.MODELS_DIR || '';
  }

  async initialize() {
    if (this.initialized && this.manager) {
      return { endpoint: this.manager.endpoint, serviceUrl: this.manager.serviceUrl };
    }
    if (!this.llamaHost) {
      throw new Error('No Llama API URL configured. Open the Settings page to set it up.');
    }
    try {
      this.manager = {
        endpoint: `${this.llamaHost}/v1`,
        serviceUrl: this.llamaHost,
        apiKey: 'llama-rocks'
      };
      await axios.get(`${this.llamaHost}/health`);
      this.openaiClient = new OpenAI({ baseURL: this.manager.endpoint, apiKey: this.manager.apiKey });
      this.initialized = true;

      // Sincronizar modelos activos desde llama.cpp (sobrevive reinicios del backend)
      try {
        const res = await axios.get(`${this.llamaHost}/v1/models`);
        const active = res.data?.data || [];
        for (const m of active) {
          const fullId = m.id.endsWith('.gguf') ? m.id : `${m.id}.gguf`;
          this.loadedModels.set(fullId, { id: m.id, alias: m.id });
        }
        if (active.length > 0) {
          logger.info(`Modelos activos sincronizados desde llama.cpp: ${active.map(m => m.id).join(', ')}`);
        }
      } catch (e) {
        logger.warn('No se pudieron sincronizar modelos activos al arrancar', { error: e.message });
      }

      return this.manager;
    } catch (error) {
      logger.error('Failed to connect to Llama.cpp Server', { error: error.message });
      this.initialized = false;
      throw new Error(`No se pudo conectar al contenedor llama.cpp en ${this.llamaHost}`);
    }
  }

  // ... (isServiceRunning, listAvailableModels, etc., se mantienen igual) ...

  /**
   * Carga el modelo usando el endpoint /models/load del Router
   */
/**
   * CARGA: Solo marca como RUNNING si recibe success: true
   */
  async loadModel(modelId, alias, mmproj = null, loadParams = {}) {
    await this.initialize();
    const modelName = modelId.replace(/\.gguf$/i, '');
    logger.info(`>>> LLAMA-SWAP: Carga implícita registrada para ${modelName} — se activará en la primera request`);
    this.loadedModels.set(modelId, { id: modelId, alias: alias || modelName });
    storage.saveModel({
      id: modelId,
      model_id: modelId,
      alias: alias || modelName,
      status: 'running',
      updated_at: Date.now()
    });
    return { id: modelId, alias: alias || modelName, status: 'running' };
  }

  /**
   * DESCARGA: Usa /models/unload
   */
  async unloadModel(modelId, alias) {
    await this.initialize();
    const modelName = modelId.replace(/\.gguf$/i, '');
    logger.info(`>>> LLAMA-SWAP: Descarga delegada al TTL para ${modelName}`);
    this.loadedModels.delete(modelId);
    const model = storage.getModel(modelId);
    if (model) {
      storage.saveModel({ ...model, status: 'stopped', updated_at: Date.now() });
    }
    return { success: true, status: 'stopped' };
  }

  // ... (listLoadedModels, checkModelHealth, etc., se mantienen igual) ...

 async isServiceRunning() {
    if (!this.manager) return false;
    try {
      const res = await axios.get(`${this.llamaHost}/health`);
      return res.status === 200;
    } catch (error) { 
      return false; 
    }
  }

  async listAvailableModels() {
    await this.initialize();
    try {
      const cacheModels = await cacheManager.listCacheModels();
      return cacheModels.map(cacheModel => ({
        id: cacheModel.id,
        alias: cacheModel.alias,
        description: cacheModel.description || cacheModel.alias,
        version: 'GGUF',
        deviceType: 'GPU',
        executionProvider: 'ROCm',
        isCustom: true
      }));
    } catch (error) { 
      return []; 
    }
  }

  async listLoadedModels() {
    await this.initialize();
    try {
      const res = await axios.get(`${this.llamaHost}/v1/models`);
      const models = res.data.data || [];
      return models.map(m => ({ id: m.id, alias: m.id }));
    } catch (error) {
      return Array.from(this.loadedModels.values());
    }
  } // <--- ASEGÚRATE DE QUE ESTA LLAVE EXISTE

  async checkServiceHealth() {
    if (!this.initialized || !this.manager) {
      return { status: 'not_initialized', healthy: false };
    }
    try {
      const isRunning = await this.isServiceRunning();
      return {
        status: isRunning ? 'running' : 'stopped',
        healthy: isRunning,
        endpoint: this.manager.endpoint,
        lastCheck: Date.now()
      };
    } catch (error) {
      return { status: 'error', healthy: false, error: error.message };
    }
  }

  getEndpoint() {
    return this.manager?.serviceUrl || this.llamaHost;
  }

  /**
   * Devuelve el cliente OpenAI compatible con llama.cpp
   */
  getOpenAIClient() {
    if (!this.openaiClient) {
      this.openaiClient = new OpenAI({
        baseURL: `${this.llamaHost}/v1`,
        apiKey: 'llama-rocks'
      });
    }
    return this.openaiClient;
  }

  /**
   * Devuelve la info del modelo cargado por su ID, o null si no está en memoria
   */
  getLoadedModelInfo(id) {
    return this.loadedModels.get(id) || null;
  }

  /**
   * Verifica si el servidor llama.cpp responde y tiene algún modelo activo
   */
  async checkModelHealth(modelAlias) {
    try {
      const modelName = (modelAlias || '').replace(/\.gguf$/i, '');
      if (!modelName) {
        const res = await axios.get(`${this.llamaHost}/health`, { timeout: 5000 });
        return { healthy: res.status === 200, status: 'running' };
      }
      const res = await axios.get(`${this.llamaHost}/upstream/${modelName}`, { timeout: 5000 });
      const isRunning = res.data?.status === 'running';
      return {
        healthy: isRunning,
        status: res.data?.status || 'unknown',
        models: isRunning ? [{ id: modelName }] : []
      };
    } catch (error) {
      return { healthy: false, status: 'error', error: error.message };
    }
  }

  async waitForModelIdle(modelId, maxWaitMs = 180000) {
    const modelName = modelId.replace(/\.gguf$/i, '');
    const deadline = Date.now() + maxWaitMs;
    logger.info(`>>> LLAMA-SWAP: Esperando que ${modelName} quede idle antes de continuar`);
    while (Date.now() < deadline) {
      try {
        const res = await axios.get(`${this.llamaHost}/upstream/${modelName}`, { timeout: 5000 });
        if (res.data?.status === 'idle' || res.data?.status === 'stopped') {
          logger.info(`>>> LLAMA-SWAP: ${modelName} confirmado idle — VRAM libre`);
          return true;
        }
      } catch {
        // Si el endpoint falla, asumimos que el modelo ya no está activo
        logger.info(`>>> LLAMA-SWAP: ${modelName} no responde en /upstream — asumiendo idle`);
        return true;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    logger.warn(`>>> LLAMA-SWAP: Timeout esperando idle para ${modelName} — continuando de todos modos`);
    return false;
  }

  /**
   * Actualiza el host remoto de llama.cpp y fuerza reconexión
   */
  updateHost(url) {
    this.llamaHost = url;
    this.initialized = false;
    this.openaiClient = null;
    this.manager = null;
    logger.info(`Host de llama.cpp actualizado a ${url}`);
  }

  /**
   * Limpieza al apagar el servidor
   */
  async cleanup() {
    this.loadedModels.clear();
    this.initialized = false;
    this.openaiClient = null;
    this.manager = null;
    logger.info('Orchestrator: conexión con llama.cpp cerrada');
  }
}

export default new LlamaOrchestrator();