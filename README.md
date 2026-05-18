# Piezo Energy Harvesting Monitor

Sistema completo de monitoramento para circuito de energy harvesting piezoelétrico com 100 piezos (10 grupos em paralelo, cada grupo com 10 piezos em série), retificação, armazenamento em dois capacitores de 1F/5.5V e alimentação de LED 5V via step-up. O Arduino Due lê as tensões dos piezos e do capacitor e envia os dados via serial para um servidor Node.js, que os transmite em tempo real para um dashboard web.

---

## Estrutura do projeto
piezo-monitor/
├── arduino/
│ └── piezo_monitor.ino ← firmware (Arduino IDE)
├── server/
│ ├── server.js ← servidor Node.js
│ └── package.json
├── public/
│ └── index.html ← dashboard (servido pelo Node)
└── README.md

text

---

## 1. Firmware Arduino

### Hardware suportado
- **Arduino Due** – ADC 12-bit, 3.3V lógico (único testado)

### Pinagem atualizada

| Pino | Função                                        |
|------|-----------------------------------------------|
| `A0` | Tensão dos piezos (com divisor 100k/10k → fator 11) |
| `A1` | Tensão do capacitor (divisor 10k/10k → fator 2)     |
| GND  | GND comum                                      |

### Circuito de entrada
- **Piezos**: 100 unidades (10 grupos paralelo, cada grupo 10 piezos série) → saída AC retificada por 1 diodo → divisor resistivo (100k / 10k) → pino A0.
- **Capacitores**: dois capacitores de 5.5V / 1F em paralelo (Ctotal = 2F) → divisor resistivo (10k / 10k) → pino A1.
- **Step-up 5V**: alimenta o LED 5V (interruptor manual independente do Arduino).

### Protocolo Serial (JSON, 115200 baud)

**Enviado a cada 500 ms:**
```json
{
  "ts": 12345,
  "uptime": 12.3,
  "vcap": 4.231,
  "vpiezo": 28.4,
  "raw_adc_vcap": 2614,
  "raw_adc_vpiezo": 512,
  "charge_pct": 76.9,
  "power_mw": 2.31,
  "energy_mj": 156.4
}
Comandos aceitos (via Serial):

Comando	Ação
RESET_ENERGY	Zera o acumulador de energia
STATUS	Retorna energia atual
Upload do firmware
Abra arduino/piezo_monitor.ino no Arduino IDE.

Selecione Arduino Due (Tools > Board).

Selecione a porta COM correta.

Upload (Ctrl+U).

2. Servidor Node.js
Instalação
bash
cd server
npm install
Execução
bash
# Auto-detecta Arduino Due (ttyACM0 ou COM*)
node server.js

# Porta específica (Windows)
node server.js --port COM3

# Porta específica (Linux)
node server.js --port /dev/ttyACM0

# Modo demo (sem hardware)
node server.js --mock
Endpoints
Método	URL	Descrição
GET	/	Dashboard HTML
GET	/api/data	Último snapshot JSON
GET	/api/history	Histórico (query ?limit=100)
POST	/api/command	Envia comando ao Arduino
GET	/api/ports	Lista portas seriais disponíveis
WS	/ws	Stream em tempo real (WebSocket)
Exemplo de comando:

bash
curl -X POST http://localhost:3000/api/command \
     -H "Content-Type: application/json" \
     -d '{"command":"RESET_ENERGY"}'
3. Dashboard
Acesse http://localhost:3000 após iniciar o servidor.

Funcionalidades
Gauge circular com carga do supercapacitor (%)

KPIs em tempo real: tensão do capacitor, tensão dos piezos, potência estimada, energia acumulada, uptime

Gráfico histórico de tensões (Vcap + Vpiezo)

Gráfico de potência gerada

Terminal com log JSON raw do Arduino

Reconexão automática WebSocket

4. Localizar a porta serial
Windows: Gerenciador de Dispositivos → Portas (COM e LPT) → ex: COM4
Linux: ls /dev/ttyACM* ou ls /dev/ttyUSB*

5. Fluxo de dados completo
text
[100 piezos] → [diodo] → [divisor A0] → Arduino Due A0
                            ↓
                   [2× 1F capacitor] → [divisor A1] → Arduino Due A1
                            ↓
                      [step-up 5V] → LED 5V (interruptor manual)

Arduino Due lê A0 e A1 → calcula Vpiezo, Vcap, potência, energia → envia JSON via Serial USB
                                                                        ↓
                                                              Node.js server.js
                                                                        ↓ WebSocket
                                                              Browser dashboard
Observações finais
O divisor do piezo (100k/10k) permite medir até ~36V. Ajuste os valores se a tensão gerada for diferente.

O capacitor de 2F suporta até 5.5V. O step-up 5V deve ser ligado após o capacitor.

O Arduino não controla mais o LED – o interruptor manual no circuito do LED é independente.

text

As alterações estão completas. Agora é só substituir os arquivos e testar o sistema com o novo hardware.