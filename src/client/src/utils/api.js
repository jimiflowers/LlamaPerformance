import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Models API
export const modelsAPI = {
  getAvailable: () => api.get('/models/available'),
  getAll: () => api.get('/models'),
  add: (model) => api.post('/models', model),
  delete: (id) => api.delete(`/models/${id}`),
  start: (id) => api.post(`/models/${id}/start`),
  stop: (id) => api.post(`/models/${id}/stop`),
  load: (id) => api.post(`/models/${id}/load`),
  test: (id, data) => api.post(`/models/${id}/test`, data),
  health: (id) => api.get(`/models/${id}/health`),
  logs: (id, limit = 100) => api.get(`/models/${id}/logs`, { params: { limit } })
};

// Benchmarks API
export const benchmarksAPI = {
  getSuites: () => api.get('/benchmarks/suites'),
  run: (data) => api.post('/benchmarks/run', data),
  getRuns: () => api.get('/benchmarks/runs'),
  getRun: (id) => api.get(`/benchmarks/runs/${id}`),
  getResults: (params = {}) => api.get('/benchmarks/results', { params }),
  exportJSON: (id) => api.get(`/benchmarks/runs/${id}/export/json`, { responseType: 'blob' }),
  exportCSV: (id) => api.get(`/benchmarks/runs/${id}/export/csv`, { responseType: 'blob' }),
  logs: (id, limit = 100) => api.get(`/benchmarks/runs/${id}/logs`, { params: { limit } }),
  status: (id) => api.get(`/benchmarks/runs/${id}/status`),
  deleteRun: (id) => api.delete(`/benchmarks/runs/${id}`)
};

// Settings API
export const settingsAPI = {
  get: () => api.get('/settings'),
  update: (data) => api.put('/settings', data),
  sshScan: () => api.post('/settings/ssh-scan'),
  syncModels: (models) => api.post('/settings/sync-models', { models })
};

// System API
export const systemAPI = {
  health: () => api.get('/system/health'),
  stats: () => api.get('/system/stats')
};

// Cache API
export const cacheAPI = {
  getLocation: async () => {
    const response = await api.get('/cache/location');
    return response.data;
  },
  switchCache: async (location) => {
    const response = await api.post('/cache/switch', { location });
    return response.data;
  },
  listModels: async () => {
    const response = await api.get('/cache/models');
    return response.data;
  }
};

export default api;
