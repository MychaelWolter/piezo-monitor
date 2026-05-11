# Piezo Energy Harvesting Monitor

Sistema completo de monitoramento para o circuito de energy harvesting piezoeléctrico.
Lê dados do Arduino Due/Mega via Serial COM, transmite por WebSocket e exibe em dashboard HTML em tempo real.

---

## Estrutura do projeto

```
piezo-monitor/
├── arduino/
│   └── piezo_monitor.ino     ← firmware (Arduino IDE)
├── server/
│   ├── server.js             ← servidor Node.js
│   └── package.json
└── public/
    └── index.html            ← dashboard (servido pelo Node)
```

---

## 1. Firmware Arduino

### Hardware suportado
- **Arduino Due**  → ADC 12-bit, 3.3V lógico (detecção automática)
- **Arduino Mega** → ADC 10-bit, 5.0V lógico (detecção automática)

### Pinagem

| Pino   | Função                                      |
|--------|---------------------------------------------|
| `A0`   | Divisor de tensão — lê Vcap (R1=R2=10kΩ)   |
| `A1`   | Sensor de corrente (opcional)               |
| `D2`   | Pulso piezo via interrupção (INT0/FALLING)  |
| `D9`   | Controle MOSFET → fita LED                  |

### Protocolo Serial (JSON, 115200 baud)

**Dados enviados a cada 500ms:**
```json
{
  "ts": 12345,
  "uptime": 12.3,
  "vcap": 4.231,
  "vadc": 2.115,
  "raw_adc": 2614,
  "charge_pct": 76.9,
  "power_mw": 2.31,
  "energy_mj": 156.4,
  "pulses": 7,
  "led": true
}
```

**Comandos recebidos via Serial:**
| Comando        | Ação                          |
|----------------|-------------------------------|
| `LED_ON`       | Liga fita LED (força manual)  |
| `LED_OFF`      | Desliga fita LED              |
| `RESET_ENERGY` | Zera contador de energia      |
| `STATUS`       | Retorna estado atual          |

### Upload
1. Abra `arduino/piezo_monitor.ino` no Arduino IDE
2. Selecione a placa correta (**Tools > Board**)
3. Selecione a porta COM correta
4. Upload (**Ctrl+U**)

---

## 2. Servidor Node.js

### Instalação

```bash
cd server
npm install
```

### Execução

```bash
# Auto-detecta Arduino
node server.js

# Porta específica — Windows
node server.js --port COM3

# Porta específica — Linux/Mac (Due)
node server.js --port /dev/ttyACM0

# Porta específica — Linux/Mac (Mega com CH340)
node server.js --port /dev/ttyUSB0

# Modo demo (sem Arduino, dados simulados)
node server.js --mock
```

### Endpoints disponíveis

| Método | URL              | Descrição                          |
|--------|------------------|------------------------------------|
| GET    | `/`              | Dashboard HTML                     |
| GET    | `/api/data`      | Último snapshot JSON               |
| GET    | `/api/history`   | Histórico (query: `?limit=100`)    |
| POST   | `/api/command`   | Envia comando ao Arduino           |
| GET    | `/api/ports`     | Lista portas seriais disponíveis   |
| WS     | `/ws`            | Stream em tempo real (WebSocket)   |

**Exemplo — enviar comando via curl:**
```bash
curl -X POST http://localhost:3000/api/command \
     -H "Content-Type: application/json" \
     -d '{"command":"LED_ON"}'
```

---

## 3. Dashboard

Abra **http://localhost:3000** no navegador após iniciar o servidor.

### Funcionalidades
- **Gauge** circular com carga do supercapacitor (%)
- **KPIs** em tempo real: tensão, potência, energia, pulsos, uptime
- **Gráfico** de tensão histórica (últimos 30s)
- **Gráfico** de potência + pulsos sobrepostos
- **Controle** manual do LED (ON/OFF via botão → REST → Serial)
- **Terminal** com log JSON raw do Arduino
- **Reconexão automática** por WebSocket

---

## 4. Localizar a porta COM no Windows

1. Conecte o Arduino via USB
2. Abra **Gerenciador de Dispositivos** (Win+X → M)
3. Expanda **Portas (COM e LPT)**
4. Anote a porta: ex. `COM4`
5. Execute: `node server.js --port COM4`

---

## 5. Fluxo de dados completo

```
[Piezo] → [Ponte] → [Supercap] → [Step-Up 5V]
                                        ↓
                              [Arduino Due/Mega]
                              ADC lê Vcap / 2
                              ISR conta pulsos
                              GPIO controla LED
                                        ↓ Serial USB 115200
                              [Node.js server.js]
                              Parseia JSON linha a linha
                              Armazena histórico (500 pts)
                                        ↓ WebSocket
                              [Browser — index.html]
                              Atualiza UI em tempo real
```
