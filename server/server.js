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
 */

'use strict';

const express    = require('express');
const http       = require('http');
const path       = require('path');
const WebSocket  = require('ws');

let SerialPort, ReadlineParser;
try {
  ({ SerialPort } = require('serialport'));
  ({ ReadlineParser } = require('@serialport/parser-readline'));
} catch (_) {
  console.warn('[SERIAL] serialport não instalado — use: npm install');
}

// Argumentos de linha de comando
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const MOCK_MODE   = args.includes('--mock');
const SERIAL_PORT = getArg('--port') || null;
const HTTP_PORT   = parseInt(getArg('--http') || '3000', 10);
const BAUD_RATE   = parseInt(getArg('--baud') || '115200', 10);
const HISTORY_MAX = 500;

// Estado global
const state = {
  connected:    false,
  boardInfo:    null,
  lastData:     null,
  history:      [],
  totalEnergy:  0,      // energia total acumulada (mJ)
  startTime:    Date.now(),
  portName:     SERIAL_PORT || 'não conectada',
  mock:         MOCK_MODE,
};

// Express + HTTP
const app    = express();
const server = http.createServer(app);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// WebSocket
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] cliente conectado — ${req.socket.remoteAddress}`);
  ws.send(JSON.stringify({
    type:      'init',
    connected: state.connected,
    boardInfo: state.boardInfo,
    lastData:  state.lastData,
    history:   state.history.slice(-60),
    portName:  state.portName,
    mock:      state.mock,
    uptime:    Math.round((Date.now() - state.startTime) / 1000),
  }));
});

// Processamento de linha JSON do Arduino
function processLine(raw) {
  raw = raw.trim();
  if (!raw.startsWith('{')) return;

  let data;
  try { data = JSON.parse(raw); } catch (e) { return; }

  if (data.event === 'boot') {
    state.boardInfo = data;
    state.connected = true;
    console.log(`[ARDUINO] board: ${data.board} | capacitância=${data.capacitance_f}F | divisores: piezo=${data.divider_piezo}, vcap=${data.divider_vcap}`);
    broadcast({ type: 'boot', boardInfo: data });
    return;
  }

  if (data.event === 'cmd' || data.event === 'status') {
    broadcast({ type: 'cmd', data });
    return;
  }

  // Dado de telemetria
  const record = {
    ts:          data.ts,
    uptime:      data.uptime,
    vcap:        data.vcap,
    vpiezo:      data.vpiezo,
    charge_pct:  data.charge_pct,
    power_mw:    data.power_mw,
    energy_mj:   data.energy_mj,
    raw_adc_vcap:   data.raw_adc_vcap,
    raw_adc_vpiezo: data.raw_adc_vpiezo,
    server_ts:   Date.now(),
  };

  state.lastData = record;
  state.history.push(record);
  if (state.history.length > HISTORY_MAX) state.history.shift();

  broadcast({ type: 'data', data: record });

  process.stdout.write(`\r[ARD] Vcap=${data.vcap?.toFixed(2)}V | Vpiezo=${data.vpiezo?.toFixed(1)}V | P=${data.power_mw?.toFixed(1)}mW | E=${data.energy_mj?.toFixed(0)}mJ  `);
}

// Conexão Serial
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

  let portPath = SERIAL_PORT;
  if (!portPath) {
    try {
      const ports = await SerialPort.list();
      const arduino = ports.find(p =>
        p.manufacturer?.toLowerCase().includes('arduino') ||
        p.manufacturer?.toLowerCase().includes('wch') ||
        p.vendorId === '2341' ||
        p.vendorId === '1a86'
      );
      if (arduino) {
        portPath = arduino.path;
        console.log(`[SERIAL] Arduino detectado em: ${portPath}`);
      } else {
        console.log('[SERIAL] Portas disponíveis:');
        ports.forEach(p => console.log(`  ${p.path} — ${p.manufacturer || 'desconhecido'}`));
        console.log('\n[SERIAL] Use: node server.js --port <PORTA>');
        console.log('[SERIAL] Ou:  node server.js --mock');
        process.exit(1);
      }
    } catch (err) {
      console.error('[SERIAL] Erro ao listar portas:', err.message);
      process.exit(1);
    }
  }

  state.portName = portPath;

  const port = new SerialPort({ path: portPath, baudRate: BAUD_RATE, autoOpen: false });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));

  port.open(err => {
    if (err) {
      console.error(`[SERIAL] Erro ao abrir ${portPath}:`, err.message);
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

  app._serialPort = port;
}

// Modo mock
function startMockGenerator() {
  state.connected = true;
  state.boardInfo = {
    event:    'boot',
    board:    'Arduino Due (MOCK)',
    adc_bits: 12,
    vref:     3.3,
    capacitance_f: 2.0,
    divider_piezo: 11,
    divider_vcap: 2,
  };

  let vcap    = 1.5;
  let vpiezo  = 0.0;
  let energy  = 0;
  let t       = 0;

  broadcast({ type: 'boot', boardInfo: state.boardInfo });

  setInterval(() => {
    t += 0.5;
    const loading = Math.sin(t * 0.3) > -0.2;
    const deltaV = loading ? (Math.random() * 0.08 + 0.03) : ( -0.02 - Math.random() * 0.03 );
    vcap = Math.max(0, Math.min(5.5, vcap + deltaV));
    vpiezo = loading ? (Math.random() * 10 + 8) : (Math.random() * 2 + 0.2);

    const power = loading ? (Math.random() * 4 + 0.5) : 0;
    energy += power * 0.5;

    const record = {
      ts:          Math.round(t * 1000),
      uptime:      t,
      vcap:        parseFloat(vcap.toFixed(3)),
      vpiezo:      parseFloat(vpiezo.toFixed(1)),
      charge_pct:  parseFloat(((vcap / 5.5) * 100).toFixed(1)),
      power_mw:    parseFloat(power.toFixed(2)),
      energy_mj:   parseFloat(energy.toFixed(2)),
      raw_adc_vcap: Math.round((vcap / 2) * 4095 / 3.3),
      raw_adc_vpiezo: Math.round((vpiezo / 11) * 4095 / 3.3),
      server_ts:   Date.now(),
    };

    state.lastData = record;
    state.history.push(record);
    if (state.history.length > HISTORY_MAX) state.history.shift();
    broadcast({ type: 'data', data: record });
  }, 500);
}

// REST API
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
  const validCmds = ['RESET_ENERGY', 'STATUS'];

  if (!validCmds.includes(command)) {
    return res.status(400).json({ error: 'Comando inválido', valid: validCmds });
  }

  if (MOCK_MODE) {
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