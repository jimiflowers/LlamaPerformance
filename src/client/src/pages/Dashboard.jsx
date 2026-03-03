import React, { useState, useEffect } from 'react';
import { systemAPI, modelsAPI, benchmarksAPI } from '../utils/api';

function Dashboard() {
  const [stats, setStats] = useState(null);
  const [systemHealth, setSystemHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadDashboardData();
    const interval = setInterval(loadDashboardData, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, []);

  const loadDashboardData = async () => {
    try {
      const [statsRes, healthRes] = await Promise.all([
        systemAPI.stats(),
        systemAPI.health()
      ]);
      setStats(statsRes.data);
      setSystemHealth(healthRes.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div className="loading">Loading dashboard...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  return (
    <div>
      <h2 style={{ marginBottom: '1.5rem', fontSize: '2rem' }}>Dashboard</h2>

      {systemHealth && systemHealth.status === 'unhealthy' && (
        <div className="error">
          System Health: unhealthy — {systemHealth.error || 'Llama.cpp server is not responding'}
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-label">Total Models</div>
          <div className="stat-value">{stats?.totalModels || 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Running Services</div>
          <div className="stat-value">{stats?.runningServices || 0}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total Benchmark Runs</div>
          <div className="stat-value">{stats?.totalRuns || 0}</div>
        </div>
        <div className="stat-card" style={{ borderLeftColor: '#27ae60' }}>
          <div className="stat-label">Best TPS Model</div>
          <div className="stat-value" style={{ fontSize: '1.2rem' }}>
            {stats?.bestTpsModel ? `${stats.bestTpsModel.tps.toFixed(2)} tps` : 'N/A'}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#7f8c8d', marginTop: '0.5rem' }}>
            {stats?.bestTpsModel?.modelId || ''}
          </div>
        </div>
        <div className="stat-card" style={{ borderLeftColor: '#e74c3c' }}>
          <div className="stat-label">Lowest P95 Latency</div>
          <div className="stat-value" style={{ fontSize: '1.2rem' }}>
            {stats?.bestLatencyModel ? `${stats.bestLatencyModel.p95.toFixed(0)}ms` : 'N/A'}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#7f8c8d', marginTop: '0.5rem' }}>
            {stats?.bestLatencyModel?.modelId || ''}
          </div>
        </div>
      </div>

      {stats?.lastRun && (
        <div className="card">
          <div className="card-header">Last Benchmark Run</div>
          <table className="table">
            <tbody>
              <tr>
                <td><strong>Run ID:</strong></td>
                <td>{stats.lastRun.id}</td>
              </tr>
              <tr>
                <td><strong>Suite:</strong></td>
                <td>{stats.lastRun.suite_name}</td>
              </tr>
              <tr>
                <td><strong>Status:</strong></td>
                <td>
                  <span className={`badge badge-${stats.lastRun.status === 'completed' ? 'success' : 'warning'}`}>
                    {stats.lastRun.status}
                  </span>
                </td>
              </tr>
              <tr>
                <td><strong>Started:</strong></td>
                <td>{new Date(stats.lastRun.started_at).toLocaleString()}</td>
              </tr>
              <tr>
                <td><strong>Models:</strong></td>
                <td>{stats.lastRun.model_ids?.length || 0} models tested</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <div className="card-header">Quick Actions</div>
        <div>
          <a href="/models" className="btn btn-primary">Manage Models</a>
          <a href="/benchmarks" className="btn btn-success">Run Benchmark</a>
          <a href="/results" className="btn btn-secondary">View Results</a>
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
