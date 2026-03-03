import React, { useState, useEffect } from 'react';
import { settingsAPI } from '../utils/api';

function Settings() {
  const [conn, setConn] = useState({
    llamaApiUrl: '',
    port: 3001,
    logLevel: 'info'
  });
  const [ssh, setSsh] = useState({
    modelsDir: '',
    username: '',
    password: '',
    sshPort: 22,
    trustRelationship: true
  });
  const [loading, setLoading] = useState(true);
  const [connSaving, setConnSaving] = useState(false);
  const [sshSaving, setSshSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [scanResults, setScanResults] = useState(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [isDefault, setIsDefault] = useState(false);
  const [localMode, setLocalMode] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await settingsAPI.get();
      const s = res.data;
      setConn({
        llamaApiUrl: s.llamaApiUrl || '',
        port: s.port || 3001,
        logLevel: s.logLevel || 'info'
      });
      setSsh({
        modelsDir: s.modelsDir || '',
        username: s.ssh?.username || '',
        password: s.ssh?.password || '',
        sshPort: s.ssh?.sshPort || 22,
        trustRelationship: s.ssh?.trustRelationship !== false
      });
      setIsDefault(s.isDefault === true);
      const url = s.llamaApiUrl || '';
      setLocalMode(url.includes('localhost') || url.includes('127.0.0.1'));
    } catch (err) {
      setError('Error loading settings: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  };

  const showMessage = (msg, isError = false) => {
    if (isError) { setError(msg); setTimeout(() => setError(null), 6000); }
    else { setSuccess(msg); setTimeout(() => setSuccess(null), 4000); }
  };

  const handleSaveConn = async () => {
    setConnSaving(true);
    try {
      const res = await settingsAPI.update({
        llamaApiUrl: conn.llamaApiUrl,
        port: conn.port,
        logLevel: conn.logLevel
      });
      setRestartRequired(res.data.restartRequired);
      setIsDefault(false);
      showMessage('Connection settings saved' + (res.data.restartRequired ? ' — restart required for port change' : ''));
    } catch (err) {
      showMessage(err.response?.data?.error || err.message, true);
    } finally {
      setConnSaving(false);
    }
  };

  const handleSaveSsh = async () => {
    setSshSaving(true);
    try {
      await settingsAPI.update({
        modelsDir: ssh.modelsDir,
        ssh: {
          username: ssh.username,
          password: ssh.password === '***' ? undefined : ssh.password,
          sshPort: ssh.sshPort,
          trustRelationship: ssh.trustRelationship
        }
      });
      setIsDefault(false);
      showMessage(localMode ? 'Directory saved' : 'SSH settings saved');
    } catch (err) {
      showMessage(err.response?.data?.error || err.message, true);
    } finally {
      setSshSaving(false);
    }
  };

  const handleLocalModeChange = (checked) => {
    setLocalMode(checked);
    if (checked) {
      setConn(c => ({ ...c, llamaApiUrl: 'http://localhost:8080' }));
    } else {
      setConn(c => ({ ...c, llamaApiUrl: '' }));
    }
  };

  const handleSshScan = async () => {
    setScanning(true);
    setScanResults(null);
    setError(null);
    try {
      const res = await settingsAPI.sshScan();
      setScanResults(res.data);
    } catch (err) {
      showMessage(err.response?.data?.error || err.message, true);
    } finally {
      setScanning(false);
    }
  };

  const handleSyncModels = async () => {
    if (!scanResults) return;
    setSyncing(true);
    try {
      const models = scanResults.models.map(({ id, alias, mmproj }) => ({ id, alias, mmproj }));
      const res = await settingsAPI.syncModels(models);
      showMessage(`models.json updated — ${res.data.count} models`);
      setScanResults(null);
    } catch (err) {
      showMessage(err.response?.data?.error || err.message, true);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <div className="loading">Loading settings...</div>;

  return (
    <div>
      <h2 style={{ marginBottom: '1.5rem', fontSize: '2rem' }}>Settings</h2>

      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}
      {isDefault && (
        <div className="error" style={{ background: '#e8f4fd', borderLeftColor: '#2980b9', color: '#1a5276' }}>
          <strong>Configuration required</strong> — These are default values and have not been customised yet.
          {localMode
            ? ' Set the local port and save Connection Settings.'
            : ' Set the Llama API URL and SSH credentials, then save each section.'}
        </div>
      )}
      {restartRequired && (
        <div className="error" style={{ background: '#fff3cd', borderLeftColor: '#ffc107', color: '#856404' }}>
          Port change saved — restart the server for it to take effect.
        </div>
      )}

      {/* ── Section A: Connection ── */}
      <div className="card">
        <div className="card-header">Connection Settings</div>

        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={localMode}
              onChange={e => handleLocalModeChange(e.target.checked)}
            />
            <span>Use local llama.cpp instance (running on this machine)</span>
          </label>
          <small style={{ color: '#7f8c8d', marginTop: '0.25rem', display: 'block' }}>
            When checked, connects to localhost. SSH model discovery is not available in local mode.
          </small>
        </div>

        {localMode ? (
          <div className="form-group">
            <label className="form-label">Local llama.cpp Port</label>
            <input
              type="number"
              className="form-control"
              value={parseInt(conn.llamaApiUrl.split(':').pop()) || 8080}
              onChange={e => setConn({ ...conn, llamaApiUrl: `http://localhost:${e.target.value}` })}
              min={1024}
              max={65535}
            />
            <small style={{ color: '#7f8c8d' }}>
              Port where llama.cpp / llama-swap is listening on this machine
            </small>
          </div>
        ) : (
          <div className="form-group">
            <label className="form-label">Llama API URL</label>
            <input
              type="text"
              className="form-control"
              value={conn.llamaApiUrl}
              onChange={e => setConn({ ...conn, llamaApiUrl: e.target.value })}
              placeholder="http://gpu-host.lan:8000"
            />
            <small style={{ color: '#7f8c8d' }}>
              Host and port of the remote llama-swap / llama.cpp server
            </small>
          </div>
        )}

        <div style={{ display: 'flex', gap: '1rem' }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Server Port</label>
            <input
              type="number"
              className="form-control"
              value={conn.port}
              onChange={e => setConn({ ...conn, port: parseInt(e.target.value) })}
              min={1024}
              max={65535}
            />
            <small style={{ color: '#7f8c8d' }}>Requires restart to take effect</small>
          </div>

          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Log Level</label>
            <select
              className="form-control"
              value={conn.logLevel}
              onChange={e => setConn({ ...conn, logLevel: e.target.value })}
            >
              <option value="error">error</option>
              <option value="warn">warn</option>
              <option value="info">info</option>
              <option value="debug">debug</option>
            </select>
            <small style={{ color: '#7f8c8d' }}>Applied immediately (no restart needed)</small>
          </div>
        </div>

        <button
          className="btn btn-primary"
          onClick={handleSaveConn}
          disabled={connSaving}
        >
          {connSaving ? 'Saving…' : 'Save Connection Settings'}
        </button>
      </div>

      {/* ── Section B: Model Discovery ── */}
      <div className="card">
        <div className="card-header">{localMode ? 'Local Model Discovery' : 'SSH & Model Discovery'}</div>

        <div className="form-group">
          <label className="form-label">{localMode ? 'Local Models Directory' : 'Remote Models Directory'}</label>
          <input
            type="text"
            className="form-control"
            value={ssh.modelsDir}
            onChange={e => setSsh({ ...ssh, modelsDir: e.target.value })}
            placeholder={localMode ? '/home/user/models' : '/docker/models/candidates'}
          />
          <small style={{ color: '#7f8c8d' }}>
            {localMode
              ? 'Full path on this machine where .gguf files are stored'
              : 'Full path on the GPU server where .gguf files are stored (SSH host is derived from Llama API URL)'}
          </small>
        </div>

        {!localMode && <>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div className="form-group" style={{ flex: 2 }}>
              <label className="form-label">SSH Username</label>
              <input
                type="text"
                className="form-control"
                value={ssh.username}
                onChange={e => setSsh({ ...ssh, username: e.target.value })}
                placeholder="ubuntu"
                autoComplete="username"
              />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">SSH Port</label>
              <input
                type="number"
                className="form-control"
                value={ssh.sshPort}
                onChange={e => setSsh({ ...ssh, sshPort: parseInt(e.target.value) })}
                min={1}
                max={65535}
              />
            </div>
          </div>

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={ssh.trustRelationship}
                onChange={e => setSsh({ ...ssh, trustRelationship: e.target.checked })}
              />
              <span>SSH Trust Relationship (use <code>~/.ssh/id_rsa</code>)</span>
            </label>
            <small style={{ color: '#7f8c8d', marginTop: '0.25rem', display: 'block' }}>
              When checked, uses the local private key for authentication. Uncheck to use password.
            </small>
          </div>

          {!ssh.trustRelationship && (
            <div className="form-group">
              <label className="form-label">SSH Password</label>
              <input
                type="password"
                className="form-control"
                value={ssh.password}
                onChange={e => setSsh({ ...ssh, password: e.target.value })}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
          )}
        </>}

        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-secondary"
            onClick={handleSaveSsh}
            disabled={sshSaving}
          >
            {sshSaving ? 'Saving…' : localMode ? 'Save Directory' : 'Save SSH Settings'}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSshScan}
            disabled={scanning || (!localMode && !ssh.username)}
            title={!localMode && !ssh.username ? 'Enter SSH username first' : ''}
          >
            {scanning ? 'Scanning…' : localMode ? 'Scan Local Models' : 'Scan Remote Models'}
          </button>
        </div>

        {/* Scan Results */}
        {scanResults && (
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ marginBottom: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>
                Found {scanResults.models.length} model{scanResults.models.length !== 1 ? 's' : ''}
                {scanResults.mmprojs?.length > 0 && ` + ${scanResults.mmprojs.length} mmproj file`}
              </strong>
              <button
                className="btn btn-success"
                onClick={handleSyncModels}
                disabled={syncing || scanResults.models.length === 0}
              >
                {syncing ? 'Syncing…' : `Sync all ${scanResults.models.length} to models.json`}
              </button>
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Alias (auto)</th>
                  <th>mmproj</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {scanResults.models.map(m => (
                  <tr key={m.id}>
                    <td><code style={{ fontSize: '0.8rem' }}>{m.id}</code></td>
                    <td>{m.alias}</td>
                    <td>
                      {m.mmproj
                        ? <span style={{ color: '#27ae60', fontSize: '0.85rem' }}>{m.mmproj}</span>
                        : <span style={{ color: '#bdc3c7' }}>—</span>}
                    </td>
                    <td>
                      {m.isNew
                        ? <span className="badge badge-warning">NEW</span>
                        : <span className="badge badge-success">In inventory</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <small style={{ color: '#e74c3c' }}>
              Syncing will <strong>replace</strong> models.json completely with the list above.
            </small>
          </div>
        )}
      </div>

      {/* ── Section C: System Info ── */}
      <div className="card">
        <div className="card-header">System Information</div>
        <table className="table">
          <tbody>
            <tr>
              <td><strong>Application Version:</strong></td>
              <td>1.0.0</td>
            </tr>
            <tr>
              <td><strong>Active Llama API URL:</strong></td>
              <td>
                <code>{conn.llamaApiUrl}</code>
                {localMode && <span style={{ marginLeft: '0.5rem', color: '#27ae60', fontSize: '0.85rem' }}>(local)</span>}
              </td>
            </tr>
            <tr>
              <td><strong>Server Port:</strong></td>
              <td>{conn.port}</td>
            </tr>
            <tr>
              <td><strong>Log Level:</strong></td>
              <td>{conn.logLevel}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default Settings;
