import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.join(__dirname, '../../logs');

// Nos aseguramos de que la carpeta de logs exista en tu Ubuntu
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'llamaperformance' },
  transports: [
    // 1. Salida por Consola (Coloreada y legible para SSH)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
          return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
        })
      )
    }),
    
    // 2. Archivo para ERRORES (Crítico para debuggear fallos de GPU/VRAM)
    new winston.transports.File({ 
      filename: path.join(logDir, 'error.log'), 
      level: 'error',
      maxsize: 5242880, // 5MB por archivo
      maxFiles: 5 
    }),

    // 3. Archivo COMBINADO (Historial completo de benchmarks)
    new winston.transports.File({ 
      filename: path.join(logDir, 'combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5
    })
  ]
});

/**
 * Logger especializado para el motor de benchmarks
 */
export const createBenchmarkLogger = (benchmarkId) => {
  return logger.child({ 
    service: 'benchmark-engine',
    runId: benchmarkId 
  });
};

/**
 * Logger especializado para el Orchestrator (conexión con llama-server)
 */
export const createServiceLogger = (serviceName) => {
  return logger.child({ 
    service: 'gpu-orchestrator',
    model: serviceName 
  });
};

export { logger };
export default logger;
