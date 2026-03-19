import axios from 'axios';
import logger from '../logger.js';

export class RagEngine {
  constructor(ragConfig) {
    this.embeddingsEndpoint = ragConfig.embeddings_endpoint;
    this.embeddingsModel = ragConfig.embeddings_model || 'nomic-embed-text-v1.5';
    this.qdrantEndpoint = ragConfig.qdrant_endpoint;
    this.qdrantApiKey = ragConfig.qdrant_api_key;
    this.collection = ragConfig.collection || 'benchmark_profesor';
    this.topK = ragConfig.top_k || 5;
  }

  get _qdrantHeaders() {
    return this.qdrantApiKey ? { 'api-key': this.qdrantApiKey } : {};
  }

  async embed(texts) {
    const input = Array.isArray(texts) ? texts : [texts];
    const res = await axios.post(
      `${this.embeddingsEndpoint}/v1/embeddings`,
      { model: this.embeddingsModel, input },
      { timeout: 30000 }
    );
    return res.data.data.map(d => d.embedding); // OpenAI format: data[].embedding
  }

  async retrieve(question) {
    const t0 = Date.now();
    const [vector] = await this.embed([question]);
    const res = await axios.post(
      `${this.qdrantEndpoint}/collections/${this.collection}/points/search`,
      { vector, limit: this.topK, with_payload: true },
      { headers: this._qdrantHeaders, timeout: 10000 }
    );
    const chunks = res.data.result || [];
    const latencyMs = Date.now() - t0;
    logger.info(`RAG retrieve: ${chunks.length} chunks en ${latencyMs}ms`, {
      collection: this.collection,
      topK: this.topK
    });
    return { chunks, latencyMs };
  }

  assembleMessages(systemPrompt, chunks, question) {
    const context = chunks
      .map(c => `[Fuente: ${c.payload.pdf_name}, p.${c.payload.page}]: ${c.payload.text}`)
      .join('\n\n');
    const systemWithContext = `${systemPrompt}\n\nMaterial de referencia:\n${context}`;
    return [
      { role: 'system', content: systemWithContext },
      { role: 'user', content: question }
    ];
  }
}
