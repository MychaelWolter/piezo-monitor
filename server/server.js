/**
 * ============================================================
 *  PIEZO ENERGY HARVESTING — Servidor Node.js
 *  ─────────────────────────────────────────────────────────
 *  Lê dados do Arduino via Serial COM, expõe:
 *    • HTTP  → http://localhost:3000          (dashboard HTML)
 *    • WS    → ws://localhost:3000/ws         (dados em tempo real)
 *    • REST  → GET  /api/data                 (último snapshot)
 *    • REST  → GET  /api/history              (últimos N registros)
 *    • REST  → POST /api/command              (enviar comando ao Arduino)
 *    • REST  → GET  /api/ports               (lista portas disponíveis)
 * ============================================================
 *
 *  USO:
 *    node server.js                        # usa porta padrão (auto-detect)
 *    node server.js --port COM3            # Windows
 *    node server.js --port /dev/ttyACM0   # Linux/Mac (Due)
 *    node server.js --port /dev/ttyUSB0   # Linux/Mac (Mega)
 *    node server.js --mock                 # modo demo sem Arduino
 * ============================================================
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const WebSocket  = require('ws');

// Tenta importar serialport (pode não estar instalado ainda)
let SerialPort, ReadlineParser;
try {
  ({ SerialPort }    = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (_) {
  console.warn('[SERIAL] serialport não instalado — use: npm install');
}

// ── Argumentos de linha de comando ───────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const MOCK_MODE   = args.includes('--mock');
const SERIAL_PORT = getArg('--port') || null;
const HTTP_PORT   = parseInt(getArg('--http') || '3000', 10);
const BAUD_RATE   = parseInt(getArg('--baud') || '115200', 10);
const HISTORY_MAX = 500;   // máximo de registros no histórico em memória

// ── Estado global ─────────────────────────────────────────────
const state = {
  connected:    false,
  boardInfo:    null,
  lastData:     null,
  history:      [],          // Array de snapshots
  totalPulses:  0,
  startTime:    Date.now(),
  portName:     SERIAL_PORT || 'não conectada',
  mock:         MOCK_MODE,
};

// ── Express + HTTP server ─────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── WebSocket server ──────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] cliente conectado — ${req.socket.remoteAddress}`);

  // Envia estado atual imediatamente ao conectar
  ws.send(JSON.stringify({
    type:      'init',
    connected: state.connected,
    boardInfo: state.boardInfo,
    lastData:  state.lastData,
    history:   state.history.slice(-60),   // últimos 60 pontos
    portName:  state.portName,
    mock:      state.mock,
    uptime:    Math.round((Date.now() - state.startTime) / 1000),
  }));

  ws.on('close', () => {
    console.log('[WS] cliente desconectado');
  });
});

// ── Processamento de uma linha JSON do Arduino ────────────────
function processLine(raw) {
  raw = raw.trim();
  if (!raw.startsWith('{')) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.warn('[SERIAL] JSON inválido:', raw);
    return;
  }

  // Evento de boot
  if (data.event === 'boot') {
    state.boardInfo = data;
    state.connected = true;
    console.log(`[ARDUINO] board: ${data.board} | ${data.adc_bits}-bit ADC | Vref=${data.vref}V`);
    broadcast({ type: 'boot', boardInfo: data });
    return;
  }

  // Evento de comando (eco)
  if (data.event === 'cmd' || data.event === 'status') {
    broadcast({ type: 'cmd', data });
    return;
  }

  // Dado de telemetria normal
  const record = {
    ...data,
    server_ts: Date.now(),
  };

  state.totalPulses += (data.pulses || 0);
  record.total_pulses = state.totalPulses;

  state.lastData = record;
  state.history.push(record);
  if (state.history.length > HISTORY_MAX) {
    state.history.shift();
  }

  broadcast({ type: 'data', data: record });

  // Log resumido no console
  process.stdout.write(
    `\r[ARD] Vcap=${data.vcap?.toFixed(2)}V | ` +
    `${data.charge_pct?.toFixed(0)}% | ` +
    `P=${data.power_mw?.toFixed(1)}mW | ` +
    `LED=${data.led ? 'ON' : 'off'} | ` +
    `pulsos=${data.pulses}  `
  );
}

// ── Conexão Serial com o Arduino ─────────────────────────────
async function connectSerial() {
  if (MOCK_MODE) {
    console.log('[MOCK] Modo demonstração ativo — dados simulados');
    startMockGenerator();
    return;
  }

  if (!SerialPort) {
    console.error('[SERIAL] Instale as dependências: npm install');
    process.exit(1);
  }

  // Auto-detecta porta Arduino se não especificada
  let portPath = SERIAL_PORT;
  if (!portPath) {
    try {
      const ports = await SerialPort.list();
      const arduino = ports.find(p =>
        p.manufacturer?.toLowerCase().includes('arduino') ||
        p.manufacturer?.toLowerCase().includes('wch') ||
        p.vendorId === '2341' ||    // Arduino oficial
        p.vendorId === '1a86'       // CH340 (clone)
      );
      if (arduino) {
        portPath = arduino.path;
        console.log(`[SERIAL] Arduino detectado em: ${portPath}`);
      } else {
        console.log('[SERIAL] Portas disponíveis:');
        ports.forEach(p => console.log(`  ${p.path} — ${p.manufacturer || 'fabricante desconhecido'}`));
        console.log('\n[SERIAL] Use: node server.js --port <PORTA>');
        console.log('[SERIAL] Ou:  node server.js --mock  (modo demo)');
        process.exit(1);
      }
    } catch (err) {
      console.error('[SERIAL] Erro ao listar portas:', err.message);
      process.exit(1);
    }
  }

  state.portName = portPath;

  const port = new SerialPort({
    path:     portPath,
    baudRate: BAUD_RATE,
    autoOpen: false,
  });

  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.open(err => {
    if (err) {
      console.error(`[SERIAL] Erro ao abrir ${portPath}:`, err.message);
      console.log('[SERIAL] Verifique se o Arduino está conectado e a porta correta.');
      console.log('[SERIAL] Tente: node server.js --mock');
      process.exit(1);
    }
    state.connected = true;
    console.log(`[SERIAL] Conectado em ${portPath} @ ${BAUD_RATE} baud`);
    broadcast({ type: 'connected', portName: portPath });
  });

  parser.on('data', processLine);

  port.on('error', err => {
    console.error('\n[SERIAL] Erro:', err.message);
    state.connected = false;
    broadcast({ type: 'disconnected', error: err.message });
  });

  port.on('close', () => {
    console.log('\n[SERIAL] Porta fechada');
    state.connected = false;
    broadcast({ type: 'disconnected' });
  });

  // Expõe porta para API de comandos
  app._serialPort = port;
}

// ── Gerador de dados mock (modo demo) ─────────────────────────
function startMockGenerator() {
  state.connected = true;
  state.boardInfo = {
    event:    'boot',
    board:    'Arduino Due (MOCK)',
    adc_bits: 12,
    vref:     3.3,
  };

  let vcap         = 1.5;
  let energyAccum  = 0;
  let totalPulses  = 0;
  let ledOn        = false;
  let t            = 0;

  broadcast({ type: 'boot', boardInfo: state.boardInfo });

  setInterval(() => {
    t += 0.5;

    // Simula ciclo de carga/descarga realista
    const charging   = Math.sin(t * 0.3) > -0.3;
    const pulsesNow  = charging ? Math.floor(Math.random() * 8 + 2) : Math.floor(Math.random() * 2);
    const deltaV     = charging
      ? (Math.random() * 0.08 + 0.02)          // carregando
      : (ledOn ? -0.12 - Math.random() * 0.05  // descarregando com LED
               : -0.01 - Math.random() * 0.02); // auto-descarga

    vcap = Math.max(0, Math.min(5.5, vcap + deltaV));

    // Histerese do LED
    if (!ledOn  && vcap >= 3.8) ledOn = true;
    if (ledOn   && vcap <= 2.8) ledOn = false;

    const power_mW = charging ? (Math.random() * 3 + 0.5) : 0;
    energyAccum   += power_mW * 0.5;   // dt = 0.5s
    totalPulses   += pulsesNow;

    const record = {
      ts:          Math.round(t * 1000),
      uptime:      t,
      vcap:        parseFloat(vcap.toFixed(3)),
      vadc:        parseFloat((vcap / 2).toFixed(3)),
      raw_adc:     Math.round((vcap / 2) * 4095 / 3.3),
      charge_pct:  parseFloat(((vcap / 5.5) * 100).toFixed(1)),
      power_mw:    parseFloat(power_mW.toFixed(2)),
      energy_mj:   parseFloat(energyAccum.toFixed(2)),
      pulses:      pulsesNow,
      led:         ledOn,
      server_ts:   Date.now(),
      total_pulses: totalPulses,
    };

    state.lastData = record;
    state.history.push(record);
    if (state.history.length > HISTORY_MAX) state.history.shift();

    broadcast({ type: 'data', data: record });
  }, 500);
}

// ── REST API ──────────────────────────────────────────────────
app.get('/api/ports', async (req, res) => {
  if (!SerialPort) return res.json({ ports: [], error: 'serialport não instalado' });
  try {
    const ports = await SerialPort.list();
    res.json({ ports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/data', (req, res) => {
  res.json({
    connected:   state.connected,
    boardInfo:   state.boardInfo,
    lastData:    state.lastData,
    totalPulses: state.totalPulses,
    uptime:      Math.round((Date.now() - state.startTime) / 1000),
    portName:    state.portName,
    mock:        state.mock,
  });
});

app.get('/api/history', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  res.json({ history: state.history.slice(-limit) });
});

app.post('/api/command', (req, res) => {
  const { command } = req.body;
  const validCmds = ['LED_ON', 'LED_OFF', 'RESET_ENERGY', 'STATUS'];

  if (!validCmds.includes(command)) {
    return res.status(400).json({ error: 'Comando inválido', valid: validCmds });
  }

  if (MOCK_MODE) {
    // Simula resposta no modo mock
    broadcast({ type: 'cmd', data: { event: 'cmd', action: command, ok: true } });
    return res.json({ sent: true, mock: true });
  }

  const port = app._serialPort;
  if (!port || !port.isOpen) {
    return res.status(503).json({ error: 'Serial não conectado' });
  }

  port.write(command + '\n', err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ sent: true, command });
  });
});

// ── Inicia servidor ───────────────────────────────────────────
server.listen(HTTP_PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     PIEZO ENERGY MONITOR — Servidor Node     ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Dashboard  →  http://localhost:${HTTP_PORT}         ║`);
  console.log(`║  API data   →  http://localhost:${HTTP_PORT}/api/data║`);
  console.log(`║  WebSocket  →  ws://localhost:${HTTP_PORT}/ws        ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');

  connectSerial();
});
