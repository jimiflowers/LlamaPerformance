import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { settingsAPI } from './utils/api';
import Dashboard from './pages/Dashboard';
import Models from './pages/Models';
import Benchmarks from './pages/Benchmarks';
import Results from './pages/Results';
import Cache from './pages/Cache';
import Settings from './pages/Settings';

function Navigation() {
  const location = useLocation();
  const isActive = (path) => location.pathname === path ? 'active' : '';

  return (
    <nav className="sidebar">
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>Navigation</h2>
      </div>
      <Link to="/" className={`nav-link ${isActive('/')}`}>Dashboard</Link>
      <Link to="/models" className={`nav-link ${isActive('/models')}`}>Models</Link>
      <Link to="/benchmarks" className={`nav-link ${isActive('/benchmarks')}`}>Benchmarks</Link>
      <Link to="/results" className={`nav-link ${isActive('/results')}`}>Results</Link>
      <Link to="/cache" className={`nav-link ${isActive('/cache')}`}>Cache</Link>
      <Link to="/settings" className={`nav-link ${isActive('/settings')}`}>Settings</Link>
    </nav>
  );
}

function AppContent() {
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState(false);

  // Re-check on every route change so the banner disappears after saving settings
  useEffect(() => {
    settingsAPI.get()
      .then(res => setNeedsSetup(res.data.isDefault === true))
      .catch(() => setNeedsSetup(false));
  }, [location.pathname]);

  const onSettingsPage = location.pathname === '/settings';

  return (
    <div className="app">
      <header className="header">
        <h1>LlamaPerformance</h1>
        <p>llama.cpp LLM Benchmark Tool</p>
      </header>

      {needsSetup && !onSettingsPage && (
        <div style={{
          background: '#e8f4fd',
          borderLeft: '4px solid #2980b9',
          color: '#1a5276',
          padding: '0.75rem 1.5rem',
          fontSize: '0.9rem'
        }}>
          <strong>Setup required</strong> — No configuration found.{' '}
          <Link to="/settings" style={{ color: '#1a5276', fontWeight: 600 }}>Open Settings</Link>
          {' '}to configure the Llama API URL before using the app.
        </div>
      )}

      <div className="main-container">
        <Navigation />
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/models" element={<Models />} />
            <Route path="/benchmarks" element={<Benchmarks />} />
            <Route path="/results" element={<Results />} />
            <Route path="/cache" element={<Cache />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

export default App;
