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

    // llama.cpp espera el nombre sin extensión (igual que en las llamadas curl directas)
    const modelName = modelId.replace(/\.gguf$/i, '');

    try {
      const body = { model: modelName, n_gpu_layers: -1 };

      if (mmproj) {
        body.mmproj = `${this.modelsDir}/${mmproj}`;
        logger.info(`>>> CARGA VL: incluyendo mmproj: ${body.mmproj}`);
      }

      // Parámetros de carga opcionales definidos por el usuario
      if (loadParams.n_ctx)        body.n_ctx        = Number(loadParams.n_ctx);
      if (loadParams.n_batch)      body.n_batch      = Number(loadParams.n_batch);
      if (loadParams.flash_attn)   body.flash_attn   = true;
      if (loadParams.cache_type_k) body.cache_type_k = loadParams.cache_type_k;
      if (loadParams.cache_type_v) body.cache_type_v = loadParams.cache_type_v;
      if (Object.values(loadParams).some(v => v)) {
        logger.info(`>>> Parámetros de carga personalizados aplicados: n_ctx=${body.n_ctx ?? '—'} n_batch=${body.n_batch ?? '—'} flash_attn=${body.flash_attn ?? false} kv=${body.cache_type_k ?? '—'}/${body.cache_type_v ?? '—'}`);
      }

      logger.info(`>>> SOLICITANDO CARGA AL ROUTER: ${modelName}`);

      const response = await axios.post(`${this.llamaHost}/models/load`, body, {
        timeout: 300000,
        headers: { "Content-Type": "application/json" }
      });

      if (response.data && response.data.success === true) {
        logger.info(`>>> CONFIRMACIÓN RECIBIDA: [SUCCESS: TRUE]`);

        // Marcar todos los demás modelos running como stopped (llama.cpp solo admite uno a la vez)
        const allModels = storage.getAllModels();
        for (const m of allModels) {
          if (m.status === 'running' && m.id !== modelId) {
            storage.saveModel({ ...m, status: 'stopped', updated_at: Date.now() });
            logger.info(`>>> Modelo anterior marcado como stopped: ${m.id}`);
          }
        }

        this.loadedModels.clear();
        this.loadedModels.set(modelId, { id: modelId, alias: alias });

        storage.saveModel({
          id: modelId,
          model_id: modelId,
          alias: alias || modelName,
          status: 'running',
          updated_at: Date.now()
        });

        return { id: modelId, alias, status: 'running' };
      } else {
        logger.error(`>>> RECHAZO DEL SERVIDOR:`, response.data);
        throw new Error(`El servidor llama.cpp devolvió success: false`);
      }
    } catch (error) {
      // Error 404: el servidor llama.cpp no reconoce ese nombre de modelo
      if (error.response?.status === 404) {
        const msg = `Model "${modelName}" not found in the llama.cpp server. Make sure the model is configured and the name matches exactly (without .gguf extension).`;
        logger.error(msg);
        throw new Error(msg);
      }
      logger.error('Error en proceso de carga', {
        msg: error.message,
        details: error.response?.data
      });
      throw error;
    }
  }

  /**
   * DESCARGA: Usa /models/unload
   */
  async unloadModel(modelId, alias) {
    await this.initialize();

    const modelName = modelId.replace(/\.gguf$/i, '');

    try {
      logger.info(`>>> SOLICITANDO DESCARGA: ${modelName}`);

      const response = await axios.post(`${this.llamaHost}/models/unload`, {
        model: modelName
      });

      if (response.data && response.data.success === true) {
        logger.info(`>>> CONFIRMACIÓN RECIBIDA: [SUCCESS: TRUE] - VRAM liberada para ${modelName}`);
        
        this.loadedModels.delete(modelId);
        
        const model = storage.getModel(modelId);
        if (model) {
          storage.saveModel({ ...model, status: 'stopped', updated_at: Date.now() });
        }
        return { success: true, status: 'stopped' };
      } else {
        logger.warn(`>>> AVISO: El servidor no encontró el modelo ${modelName} para descargar`);
        return { success: false };
      }
    } catch (error) {
      logger.error('Error al solicitar descarga', { 
        error: error.message,
        details: error.response?.data 
      });
      return { success: false };
    }
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
      const res = await axios.get(`${this.llamaHost}/v1/models`, { timeout: 5000 });
      const models = res.data?.data || [];
      const healthy = models.length > 0;
      return {
        healthy,
        status: healthy ? 'running' : 'no_model_loaded',
        models
      };
    } catch (error) {
      return { healthy: false, status: 'error', error: error.message };
    }
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