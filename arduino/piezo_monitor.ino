/*
 * ============================================================
 *  PIEZO ENERGY HARVESTING MONITOR
 *  Hardware: Arduino Due ou Arduino Mega 2560
 *  Comunicação: Serial USB (Serial Monitor / Node.js)
 *  Baud Rate: 115200
 * ============================================================
 *
 *  PINAGEM (Due/Mega):
 *  ┌──────────────────────────────────────────────────────┐
 *  │  A0  → ADC Divisor de tensão (supercapacitor)        │
 *  │  A1  → Sensor de corrente (opcional, shunt 0.1Ω)     │
 *  │  D2  → Detecção de pulso piezo (interrupção)         │
 *  │  D9  → Controle do MOSFET (substitui GPIO5 do ESP32) │
 *  │  GND → GND comum do circuito                         │
 *  └──────────────────────────────────────────────────────┘
 *
 *  DIVISOR DE TENSÃO:
 *  Vcap (até 5.5V) → R1(10kΩ) → A0 → R2(10kΩ) → GND
 *  Vadc = Vcap / 2  →  Vcap = Vadc * 2
 *
 *  Due:  ADC 12 bits, Vref = 3.3V → resolução = 3.3/4096 ≈ 0.806 mV
 *  Mega: ADC 10 bits, Vref = 5.0V → resolução = 5.0/1024 ≈ 4.88 mV
 *
 *  PROTOCOLO SERIAL (JSON, 1 linha por envio):
 *  {"ts":1234567,"vcap":4.23,"vadc":2.11,"pulses":14,
 *   "power_mw":2.31,"energy_mj":156.4,"led":true,"raw_adc":2614}
 * ============================================================
 */

// ── Detectar placa automaticamente ──────────────────────────
#if defined(__SAM3X8E__)          // Arduino Due
  #define BOARD_DUE
  #define ADC_BITS      12
  #define ADC_MAX       4095
  #define VREF          3.3f
#else                             // Arduino Mega (default)
  #define BOARD_MEGA
  #define ADC_BITS      10
  #define ADC_MAX       1023
  #define VREF          5.0f
#endif

// ── Pinos ────────────────────────────────────────────────────
const uint8_t PIN_ADC_VCAP    = A0;   // divisor de tensão
const uint8_t PIN_ADC_CURRENT = A1;   // sensor de corrente (opcional)
const uint8_t PIN_PULSE_INT   = 2;    // detecção de pulso piezo (INT0)
const uint8_t PIN_MOSFET      = 9;    // controle da fita LED

// ── Parâmetros do circuito ───────────────────────────────────
const float DIVIDER_RATIO     = 2.0f; // R1=R2=10kΩ → Vcap = Vadc * 2
const float VCAP_MAX          = 5.5f; // tensão máxima do supercapacitor
const float VCAP_ON_THRESH    = 3.8f; // ligar LED acima deste valor
const float VCAP_OFF_THRESH   = 2.8f; // desligar LED abaixo deste valor
const float CAPACITANCE       = 1.0f; // supercapacitor em Farads

// ── Temporização ─────────────────────────────────────────────
const unsigned long SEND_INTERVAL_MS   = 500;   // envio serial a cada 500 ms
const unsigned long SAMPLE_INTERVAL_MS = 50;    // leitura ADC a cada 50 ms

// ── Variáveis globais ─────────────────────────────────────────
volatile uint32_t pulseCount       = 0;    // contagem de pulsos (ISR)
volatile uint32_t pulsesLastSend   = 0;

float   vcapPrev        = 0.0f;
float   energyAccum_mJ  = 0.0f;    // energia acumulada estimada
bool    ledState        = false;
bool    firstSample     = true;

unsigned long lastSendTime   = 0;
unsigned long lastSampleTime = 0;
unsigned long startTime      = 0;

// Média móvel para o ADC (janela de 8 amostras)
const uint8_t ADC_WINDOW = 8;
float   adcBuffer[ADC_WINDOW];
uint8_t adcIndex = 0;
bool    adcFull  = false;

// ── ISR: conta pulsos do piezo ────────────────────────────────
void IRAM_ATTR onPulse() {
  pulseCount++;
}

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }   // aguarda USB (necessário no Due)

  #ifdef BOARD_DUE
    analogReadResolution(12);   // habilita 12 bits no Due
  #endif

  pinMode(PIN_MOSFET,      OUTPUT);
  pinMode(PIN_PULSE_INT,   INPUT_PULLUP);
  digitalWrite(PIN_MOSFET, LOW);

  attachInterrupt(digitalPinToInterrupt(PIN_PULSE_INT),
                  onPulse, FALLING);

  // Inicializa buffer ADC com primeira leitura
  float initVal = analogRead(PIN_ADC_VCAP) * (VREF / ADC_MAX);
  for (uint8_t i = 0; i < ADC_WINDOW; i++) adcBuffer[i] = initVal;

  startTime      = millis();
  lastSendTime   = millis();
  lastSampleTime = millis();

  // Mensagem de boot (identificação da placa)
  Serial.print(F("{\"event\":\"boot\",\"board\":\""));
  #ifdef BOARD_DUE
    Serial.print(F("Arduino Due"));
  #else
    Serial.print(F("Arduino Mega"));
  #endif
  Serial.print(F("\",\"adc_bits\":"));
  Serial.print(ADC_BITS);
  Serial.print(F(",\"vref\":"));
  Serial.print(VREF, 2);
  Serial.println(F("}"));
}

// ── Leitura ADC com média móvel ───────────────────────────────
float readVcap() {
  float raw = analogRead(PIN_ADC_VCAP);
  adcBuffer[adcIndex] = raw;
  adcIndex = (adcIndex + 1) % ADC_WINDOW;
  if (adcIndex == 0) adcFull = true;

  uint8_t count = adcFull ? ADC_WINDOW : adcIndex;
  float sum = 0;
  for (uint8_t i = 0; i < count; i++) sum += adcBuffer[i];
  float vadc = (sum / count) * (VREF / ADC_MAX);
  return vadc * DIVIDER_RATIO;   // tensão real no supercapacitor
}

// ── Controle MOSFET com histerese ────────────────────────────
void updateLED(float vcap) {
  if (!ledState && vcap >= VCAP_ON_THRESH) {
    ledState = true;
    digitalWrite(PIN_MOSFET, HIGH);
  } else if (ledState && vcap <= VCAP_OFF_THRESH) {
    ledState = false;
    digitalWrite(PIN_MOSFET, LOW);
  }
}

// ── Estima potência gerada (variação de energia do capacitor) ─
float estimatePower_mW(float vcapNow, float vcapPrev, float dt_s) {
  // P = C * V * dV/dt
  if (dt_s <= 0.0f) return 0.0f;
  float dv = vcapNow - vcapPrev;
  float power = CAPACITANCE * ((vcapNow + vcapPrev) / 2.0f) * (dv / dt_s);
  return power * 1000.0f;   // em mW
}

// ── Loop principal ────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Amostragem periódica do ADC ──
  if (now - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    float vcap = readVcap();
    float dt   = (now - lastSampleTime) / 1000.0f;

    float power_mW = estimatePower_mW(vcap, vcapPrev, dt);
    // Acumula energia apenas quando está carregando
    if (power_mW > 0) {
      energyAccum_mJ += power_mW * dt;
    }

    vcapPrev       = vcap;
    lastSampleTime = now;

    updateLED(vcap);
  }

  // ── Envio serial periódico ──
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    float vcap = readVcap();
    float vadc = vcap / DIVIDER_RATIO;
    int   rawAdc = analogRead(PIN_ADC_VCAP);

    // Captura e zera contador de pulsos atomicamente
    noInterrupts();
    uint32_t pulses = pulseCount;
    pulseCount = 0;
    interrupts();

    float dt_s     = (now - lastSendTime) / 1000.0f;
    float power_mW = estimatePower_mW(vcap, vcapPrev, dt_s);
    float uptime_s = (now - startTime) / 1000.0f;

    // Taxa de carga em percentual (0..100)
    float chargePercent = constrain((vcap / VCAP_MAX) * 100.0f, 0.0f, 100.0f);

    // ── JSON output ──────────────────────────────────────────
    Serial.print(F("{"));

    Serial.print(F("\"ts\":"));        Serial.print(now);
    Serial.print(F(",\"uptime\":"));   Serial.print(uptime_s, 1);

    Serial.print(F(",\"vcap\":"));     Serial.print(vcap, 3);
    Serial.print(F(",\"vadc\":"));     Serial.print(vadc, 3);
    Serial.print(F(",\"raw_adc\":"));  Serial.print(rawAdc);

    Serial.print(F(",\"charge_pct\":")); Serial.print(chargePercent, 1);
    Serial.print(F(",\"power_mw\":"));   Serial.print(power_mW, 2);
    Serial.print(F(",\"energy_mj\":"));  Serial.print(energyAccum_mJ, 2);

    Serial.print(F(",\"pulses\":"));   Serial.print(pulses);
    Serial.print(F(",\"led\":"));      Serial.print(ledState ? F("true") : F("false"));

    Serial.println(F("}"));
    // ────────────────────────────────────────────────────────

    lastSendTime = now;
  }

  // ── Processa comandos recebidos via Serial ──
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "LED_ON") {
      ledState = true;
      digitalWrite(PIN_MOSFET, HIGH);
      Serial.println(F("{\"event\":\"cmd\",\"action\":\"LED_ON\",\"ok\":true}"));

    } else if (cmd == "LED_OFF") {
      ledState = false;
      digitalWrite(PIN_MOSFET, LOW);
      Serial.println(F("{\"event\":\"cmd\",\"action\":\"LED_OFF\",\"ok\":true}"));

    } else if (cmd == "RESET_ENERGY") {
      energyAccum_mJ = 0.0f;
      Serial.println(F("{\"event\":\"cmd\",\"action\":\"RESET_ENERGY\",\"ok\":true}"));

    } else if (cmd == "STATUS") {
      Serial.print(F("{\"event\":\"status\",\"led\":"));
      Serial.print(ledState ? F("true") : F("false"));
      Serial.print(F(",\"energy_mj\":"));
      Serial.print(energyAccum_mJ, 2);
      Serial.println(F("}"));
    }
  }
}
