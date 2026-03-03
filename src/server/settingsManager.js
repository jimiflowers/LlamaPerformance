import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, '../../settings.json');

const defaults = {
  llamaApiUrl: process.env.LLAMA_API_URL || '',
  port: parseInt(process.env.PORT || '3001'),
  logLevel: process.env.LOG_LEVEL || 'info',
  modelsDir: process.env.MODELS_DIR || '',
  ssh: {
    username: '',
    password: '',
    sshPort: 22,
    trustRelationship: true
  }
};

class SettingsManager {
  constructor() {
    this._cache = null;
    this._fileExists = fs.existsSync(SETTINGS_PATH);
  }

  get isDefault() {
    return !this._fileExists;
  }

  get() {
    if (!this._cache) {
      try {
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
        const saved = JSON.parse(raw);
        this._cache = {
          ...defaults,
          ...saved,
          ssh: { ...defaults.ssh, ...(saved.ssh || {}) }
        };
        this._fileExists = true;
      } catch {
        this._cache = JSON.parse(JSON.stringify(defaults));
      }
    }
    return this._cache;
  }

  update(patch) {
    const current = this.get();
    this._cache = {
      ...current,
      ...patch,
      ssh: patch.ssh ? { ...current.ssh, ...patch.ssh } : current.ssh
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this._cache, null, 2), 'utf8');
    this._fileExists = true;
    return this._cache;
  }
}

export default new SettingsManager();
