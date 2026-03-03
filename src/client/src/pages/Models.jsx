import React, { useState, useEffect, useMemo } from 'react';
import { modelsAPI } from '../utils/api';

function Models() {
  const [models, setModels] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [selectedModel, setSelectedModel] = useState(null);
  const [modelInfo, setModelInfo] = useState(null);
  const [newModel, setNewModel] = useState({ alias: '', model_id: '' });
  const [conflictModal, setConflictModal] = useState(null); // { runningModel, targetId }

  // Memoize model filtering to avoid recalculation on every render
  const { catalogModels, customModels } = useMemo(() => {
    const catalog = availableModels.filter(m => !m.isCustom);
    const custom = availableModels.filter(m => m.isCustom);
    return { catalogModels: catalog, customModels: custom };
  }, [availableModels]);

  useEffect(() => {
    loadModels();
    loadAvailableModels();
    
    // Auto-refresh every 3 seconds to show status updates
    const interval = setInterval(() => {
      loadModels();
    }, 3000);
    
    return () => clearInterval(interval);
  }, []);

  const loadModels = async () => {
    try {
      const res = await modelsAPI.getAll();
      setModels(Array.isArray(res.data) ? res.data : (res.data.models || []));
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadAvailableModels = async () => {
    try {
      const res = await modelsAPI.getAvailable();
      setAvailableModels(Array.isArray(res.data) ? res.data : (res.data.models || []));
    } catch (err) {
      console.error('Failed to load available models:', err);
    }
  };

  const handleAddModel = async (e) => {
    e.preventDefault();
    try {
      await modelsAPI.add(newModel);
      setSuccess('Model added successfully');
      setShowAddModal(false);
      setNewModel({ alias: '', model_id: '' });
      loadModels();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDeleteModel = async (id) => {
    if (!confirm('Are you sure you want to delete this model?')) return;
    try {
      await modelsAPI.delete(id);
      setSuccess('Model deleted successfully');
      loadModels();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  // Core load logic — called after conflict resolution
  const doLoadModel = async (id, unloadFirst = null) => {
    if (unloadFirst) {
      try {
        setSuccess(`Unloading "${unloadFirst.alias}"...`);
        await modelsAPI.stop(unloadFirst.id);
        loadModels();
      } catch (err) {
        setError(`Failed to unload "${unloadFirst.alias}": ${err.response?.data?.error || err.message}`);
        setTimeout(() => setError(null), 5000);
        return;
      }
    }
    try {
      setSuccess('Loading model... First-time download may take 2-5 minutes.');
      await modelsAPI.start(id);
      setSuccess('Model loaded and running!');
      loadModels();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      loadModels();
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleStartService = async (id) => {
    const running = models.find(m => m.status === 'running' && m.id !== id);
    if (running) {
      setConflictModal({ runningModel: running, targetId: id });
      return;
    }
    await doLoadModel(id);
  };

  const handleStopService = async (id) => {
    try {
      setSuccess('Unloading model...');
      await modelsAPI.stop(id);
      setSuccess('Model stopped successfully');
      loadModels();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setTimeout(() => setError(null), 5000);
    }
  };

  const handleLoadModel = async (id) => {
    try {
      setSuccess('Loading model... this may take a while on first download');
      await modelsAPI.load(id);
      setSuccess('Model loaded successfully');
      loadModels();
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleViewLogs = async (model) => {
    try {
      const res = await modelsAPI.logs(model.id);
      setModelInfo(res.data);
      setSelectedModel(model);
      setShowLogsModal(true);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleTestModel = async (model) => {
    try {
      setSuccess('Testing model inference...');
      const res = await modelsAPI.test(model.id, { prompt: 'Say hello in one sentence.' });
      setSuccess(`✅ Test successful! Response: "${res.data.response}" (${res.data.latency}ms)`);
      setTimeout(() => setSuccess(null), 8000);
    } catch (err) {
      setError(`❌ Test failed: ${err.response?.data?.error || err.message}`);
      setTimeout(() => setError(null), 8000);
    }
  };

  const getStatusBadge = (status) => {
    const badgeClass = {
      running: 'badge-success',
      stopped: 'badge-warning',
      downloading: 'badge-info',
      error: 'badge-danger'
    }[status] || 'badge-info';
    
    const displayStatus = status === 'downloading' ? 'Downloading...' : status;
    
    return <span className={`badge ${badgeClass}`}>{displayStatus}</span>;
  };

  if (loading) return <div className="loading">Loading models...</div>;

  return (
    <div>
      <h2 style={{ marginBottom: '1.5rem', fontSize: '2rem' }}>Models</h2>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div className="card-header" style={{ marginBottom: 0, paddingBottom: 0, border: 'none' }}>
            Configured Models
          </div>
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)}>
            Add Model
          </button>
        </div>

        {models.length === 0 ? (
          <p style={{ color: '#7f8c8d', padding: '1rem 0' }}>
            No models configured. Click "Add Model" to get started.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Model ID</th>
                <th>Status</th>
                <th>Endpoint</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map(model => (
                <tr key={model.id}>
                  <td><strong>{model.alias}</strong></td>
                  <td><code>{model.model_id}</code></td>
                  <td>{getStatusBadge(model.status)}</td>
                  <td>{model.endpoint || '-'}</td>
                  <td>
                    {model.status === 'stopped' || model.status === 'error' ? (
                      <button 
                        className="btn btn-success" 
                        onClick={() => handleStartService(model.id)}
                        title="Load model (auto-downloads if needed)"
                      >
                        Load Model
                      </button>
                    ) : model.status === 'downloading' ? (
                      <button 
                        className="btn btn-info" 
                        disabled
                        title="Model is downloading..."
                      >
                        Downloading...
                      </button>
                    ) : model.status === 'running' ? (
                      <>
                        <button 
                          className="btn btn-primary" 
                          onClick={() => handleTestModel(model)}
                          title="Test inference with a simple prompt"
                        >
                          Test
                        </button>
                        <button 
                          className="btn btn-danger" 
                          onClick={() => handleStopService(model.id)}
                          title="Unload model"
                        >
                          Unload
                        </button>
                      </>
                    ) : null}
                    <button 
                      className="btn btn-secondary" 
                      onClick={() => handleViewLogs(model)}
                      title="View live status and benchmark history"
                    >
                      Info
                    </button>
                    <button 
                      className="btn btn-danger" 
                      onClick={() => handleDeleteModel(model.id)}
                      title="Delete model configuration"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Model Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Add Model</div>
            <form onSubmit={handleAddModel}>
              <div className="form-group">
                <label className="form-label">Model Alias</label>
                <input
                  type="text"
                  className="form-control"
                  value={newModel.alias}
                  onChange={(e) => setNewModel({ ...newModel, alias: e.target.value })}
                  placeholder="e.g., phi-3-mini"
                  required
                />
              </div>
              <div className="form-group">
                <label className="form-label">Model ID</label>
                <select
                  className="form-control"
                  value={newModel.model_id}
                  onChange={(e) => {
                    const selected = availableModels.find(m => m.id === e.target.value);
                    setNewModel({
                      alias: selected?.alias || e.target.value,
                      model_id: e.target.value
                    });
                  }}
                  required
                >
                  <option value="">Select a model...</option>

                  {/* Catalog Models */}
                  {catalogModels.length > 0 && (
                    <optgroup label="Catalog Models">
                      {catalogModels.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.description || m.id}
                        </option>
                      ))}
                    </optgroup>
                  )}

                  {/* Custom Models */}
                  {customModels.length > 0 && (
                    <optgroup label="🔧 Custom Models">
                      {customModels.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.description || m.id}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <small style={{ color: '#7f8c8d', marginTop: '0.25rem', display: 'block' }}>
                  Custom models from cache directory are marked with 🔧. Visit the Cache tab to manage.
                </small>
              </div>
              <div style={{ marginTop: '1.5rem' }}>
                <button type="submit" className="btn btn-primary">Add Model</button>
                <button 
                  type="button" 
                  className="btn btn-secondary" 
                  onClick={() => setShowAddModal(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Model Info Modal */}
      {showLogsModal && (
        <div className="modal-overlay" onClick={() => setShowLogsModal(false)}>
          <div className="modal" style={{ maxWidth: '700px', width: '95%' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              Model Info: {selectedModel?.alias}
            </div>
            <div style={{ maxHeight: '520px', overflowY: 'auto' }}>

              {/* ── Slot state (llama.cpp /slots) ── */}
              {modelInfo?.slots != null && modelInfo.slots.length > 0 ? (() => {
                const activeSlots = modelInfo.slots.filter(s => s.is_processing);
                return (
                  <div style={{ marginBottom: '1.25rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem', color: '#2c3e50' }}>
                      Live Slot Status
                      <span style={{ fontWeight: 400, fontSize: '0.85rem', color: '#7f8c8d', marginLeft: '0.75rem' }}>
                        {modelInfo.slots.length} slots — {activeSlots.length} active
                      </span>
                    </strong>
                    {modelInfo.slots.map(slot => {
                      const active = slot.is_processing;
                      const p = slot.params || {};
                      const nt = slot.next_token || {};
                      return (
                        <div key={slot.id} style={{
                          background: active ? '#eaf4fb' : '#f8f9fa',
                          borderRadius: '6px', padding: '0.6rem 0.75rem', marginBottom: '0.4rem',
                          border: `1px solid ${active ? '#aed6f1' : '#ecf0f1'}`,
                          fontSize: '0.85rem'
                        }}>
                          <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
                            <span>
                              <strong>Slot {slot.id}</strong>
                              {' — '}
                              <span style={{ color: active ? '#e67e22' : '#27ae60' }}>
                                {active ? 'processing' : 'idle'}
                              </span>
                            </span>
                            <span style={{ color: '#7f8c8d' }}>ctx {slot.n_ctx} tokens</span>
                            {active && p.temperature != null && <span>temp <strong>{p.temperature.toFixed(2)}</strong></span>}
                            {active && p.top_k != null    && <span>top-k <strong>{p.top_k}</strong></span>}
                            {active && p.top_p != null    && <span>top-p <strong>{p.top_p.toFixed(2)}</strong></span>}
                            {active && p.n_predict != null && <span>max tokens <strong>{p.n_predict}</strong></span>}
                            {active && p.chat_format      && <span>format <strong>{p.chat_format}</strong></span>}
                            {active && nt.n_decoded != null && nt.n_decoded > 0 && (
                              <span>decoded <strong>{nt.n_decoded}</strong>{nt.n_remain != null ? ` / ${nt.n_decoded + nt.n_remain} remaining` : ''}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })() : (
                <div style={{ background: '#f8f9fa', borderRadius: '6px', padding: '0.75rem', marginBottom: '1.25rem', fontSize: '0.9rem' }}>
                  <span style={{ color: '#7f8c8d' }}>Slot data not available.</span>
                  {modelInfo?.slotsError && (
                    <span style={{ color: '#e74c3c', marginLeft: '0.5rem' }}>
                      Error: <code>{modelInfo.slotsError}</code>
                    </span>
                  )}
                </div>
              )}

              {/* ── Server props (llama.cpp /props) ── */}
              {modelInfo?.props && (() => {
                const dg = modelInfo.props.default_generation_settings || {};
                const rows = [
                  ['Total slots',  modelInfo.props.total_slots],
                  ['Context size', dg.n_ctx ?? modelInfo.props.n_ctx],
                  ['Max predict',  dg.n_predict],
                  ['Temperature',  dg.temperature != null ? dg.temperature.toFixed(3) : undefined],
                  ['Top-P',        dg.top_p      != null ? dg.top_p.toFixed(3) : undefined],
                  ['Top-K',        dg.top_k],
                  ['Min-P',        dg.min_p      != null ? dg.min_p.toFixed(3) : undefined],
                  ['Chat template', modelInfo.props.chat_template ? '✓ present' : undefined],
                ].filter(([, v]) => v !== undefined && v !== null);
                if (rows.length === 0) return null;
                return (
                  <div style={{ marginBottom: '1.25rem' }}>
                    <strong style={{ display: 'block', marginBottom: '0.5rem', color: '#2c3e50' }}>Server Configuration</strong>
                    <div style={{ background: '#f8f9fa', borderRadius: '6px', padding: '0.75rem', border: '1px solid #ecf0f1' }}>
                      <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                        <tbody>
                          {rows.map(([label, value]) => (
                            <tr key={label}>
                              <td style={{ color: '#7f8c8d', paddingRight: '1rem', paddingBottom: '0.2rem', whiteSpace: 'nowrap' }}>{label}</td>
                              <td style={{ fontWeight: 500 }}>{String(value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* ── Recent benchmark results ── */}
              {modelInfo?.recentBenchmarks?.length > 0 ? (
                <div>
                  <strong style={{ display: 'block', marginBottom: '0.5rem', color: '#2c3e50' }}>Recent Benchmark Results</strong>
                  <table className="table" style={{ fontSize: '0.8rem' }}>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Suite</th>
                        <th>Scenario</th>
                        <th>TPS</th>
                        <th>GenTPS</th>
                        <th>TTFT</th>
                        <th>P95</th>
                        <th>Errors</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelInfo.recentBenchmarks.map((b, i) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: 'nowrap' }}>{new Date(b.startedAt).toLocaleDateString()}</td>
                          <td>{b.suiteName}</td>
                          <td style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.scenario}</td>
                          <td>{b.tps != null ? b.tps.toFixed(1) : '—'}</td>
                          <td>{b.genTps != null ? b.genTps.toFixed(1) : '—'}</td>
                          <td>{b.ttft != null ? `${b.ttft.toFixed(0)}ms` : '—'}</td>
                          <td>{b.latencyP95 != null ? `${b.latencyP95.toFixed(0)}ms` : '—'}</td>
                          <td>{b.errorRate != null ? `${(b.errorRate * 100).toFixed(0)}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: '#7f8c8d', fontSize: '0.9rem' }}>
                  No benchmark results yet for this model.
                </div>
              )}

            </div>
            <div style={{ marginTop: '1rem' }}>
              <button className="btn btn-secondary" onClick={() => setShowLogsModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Conflict modal — model already running */}
      {conflictModal && (
        <div className="modal-overlay" onClick={() => setConflictModal(null)}>
          <div className="modal" style={{ maxWidth: '480px' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">Model already loaded</div>
            <div style={{ marginBottom: '1.25rem', lineHeight: '1.6' }}>
              <p>
                <strong>"{conflictModal.runningModel.alias}"</strong> is currently loaded.
                What would you like to do?
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button
                className="btn btn-danger"
                onClick={() => {
                  const { runningModel, targetId } = conflictModal;
                  setConflictModal(null);
                  doLoadModel(targetId, runningModel);
                }}
              >
                Unload "{conflictModal.runningModel.alias}" and load new model
              </button>
              <button
                className="btn btn-warning"
                onClick={() => {
                  const { targetId } = conflictModal;
                  setConflictModal(null);
                  doLoadModel(targetId, null);
                }}
                title="May cause llama.cpp to hang if your hardware cannot handle two models simultaneously"
              >
                Keep both loaded
                <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 400, color: '#7f6000', marginTop: '0.15rem' }}>
                  Warning: may hang if hardware does not support concurrent models
                </span>
              </button>
              <button className="btn btn-secondary" onClick={() => setConflictModal(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Models;
