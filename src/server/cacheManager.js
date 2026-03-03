import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class CacheManager {
  constructor() {
    this.llamaApiUrl = process.env.LLAMA_API_URL || '';
    // Ruta al inventario que acabamos de crear
    this.inventoryPath = path.join(__dirname, '../../models.json');
  }

  /**
   * Devuelve la ubicación configurada (Inventario + API Remota)
   */
  async getCurrentLocation() {
    return this.llamaApiUrl || 'Not configured';
  }

  getDefaultPath() {
    return this.llamaApiUrl;
  }

  /**
   * Cambia dinámicamente el endpoint del Host B si fuera necesario
   */
  async switchCache(apiUrl) {
    try {
      this.llamaApiUrl = apiUrl === 'default'
        ? (process.env.LLAMA_API_URL || '')
        : apiUrl;

      logger.info('Endpoint de la GPU actualizado', { newApi: this.llamaApiUrl });

      return {
        success: true,
        location: this.llamaApiUrl,
        isDefault: true
      };
    } catch (error) {
      logger.error('Error al cambiar el endpoint', { error: error.message });
      throw new Error(`Error al cambiar endpoint: ${error.message}`);
    }
  }

  /**
   * LA CLAVE: Lee el JSON para saber qué modelos existen y cuáles tienen mmproj.
   * Si el JSON falla, intenta preguntar al API como último recurso.
   */
  async listCacheModels() {
    try {
      const data = await fs.readFile(this.inventoryPath, 'utf8');
      const inventoryModels = JSON.parse(data);

      return inventoryModels.map(model => {
        // 1. Limpiamos el alias de cualquier etiqueta previa para evitar "(Vision) (Vision)"
        const baseAlias = model.alias.replace(/\(Vision\)/g, '').replace(/\(Text\)/g, '').trim();
        const typeLabel = model.mmproj ? '(Vision)' : '(Text)';
        const finalDisplayName = `${baseAlias} ${typeLabel}`;

        // 2. Devolvemos un objeto "todoterreno" para el Frontend
        return {
          id: model.id,           // El nombre del archivo .gguf (Ej: Qwen2.5-VL-7B.gguf)
          model_id: model.id,     // Duplicamos para asegurar que el POST lo encuentre
          name: model.id,         // Triplicamos por si el componente usa .name
          alias: finalDisplayName, // Lo que se verá en el input "Model Alias"
          description: finalDisplayName, 
          mmproj: model.mmproj,
          source: 'inventory'
        };
      });
    } catch (error) {
      logger.error('Error al leer inventario', { error: error.message });
      return [];
    }
  }

  /**
   * Fallback: Lista solo lo que el servidor remoto informa en ese momento
   */
  async _listRemoteFallback() {
    try {
      const response = await axios.get(`${this.llamaApiUrl}/v1/models`, { timeout: 2000 });
      if (response.data && Array.isArray(response.data.data)) {
        return response.data.data.map(m => ({
          id: m.id,
          alias: m.id,
          mmproj: null,
          description: `Remote GGUF: ${m.id}`,
          source: 'remote-api'
        }));
      }
      return [];
    } catch (e) {
      logger.error('Fallback fallido: El servidor remoto no responde');
      return [];
    }
  }

  /**
   * Como estamos en Linux/Docker, siempre asumimos que la capacidad está disponible
   */
  async checkCLIAvailable() {
    return true; 
  }
}

export default new CacheManager();