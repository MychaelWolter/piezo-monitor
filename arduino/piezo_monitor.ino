/*
 * ============================================================
 *  PIEZO ENERGY HARVESTING MONITOR
 *  Hardware: Arduino Due
 *  Leitura de dois sinais analógicos:
 *    A0 - Tensão dos piezos (após diodo, antes do capacitor)
 *    A1 - Tensão do supercapacitor (após retificação e armazenamento)
 *  Comunicação: Serial USB (115200 baud)
 * ============================================================
 *
 *  PINAGEM (Due):
 *  ┌──────────────────────────────────────────────────────────┐
 *  │  A0  → Tensão dos piezos (divisor 100k/10k -> fator 11)  │
 *  │  A1  → Tensão do capacitor (divisor 10k/10k -> fator 2)  │
 *  │  GND → GND comum do circuito                             │
 *  └──────────────────────────────────────────────────────────┘
 *
 *  DIVISORES DE TENSÃO:
 *    Piezo (máx ~36V):  R1=100kΩ, R2=10kΩ → Vadc = Vpiezo / 11
 *    Capacitor (max 5.5V): R1=10kΩ, R2=10kΩ → Vadc = Vcap / 2
 *
 *  PROTOCOLO SERIAL (JSON, 1 linha por envio):
 *    {"ts":1234567,"vcap":4.23,"vpiezo":12.8,"power_mw":2.31,
 *     "energy_mj":156.4,"charge_pct":76.9,"raw_adc_vcap":2614,
 *     "raw_adc_vpiezo":512}
 * ============================================================
 */

// ── Configurações do Arduino Due ─────────────────────────────
#define BOARD_DUE
#define ADC_BITS      12
#define ADC_MAX       4095
#define VREF          3.3f

// ── Pinos ────────────────────────────────────────────────────
const uint8_t PIN_ADC_PIEZO   = A0;   // tensão dos piezos (com divisor)
const uint8_t PIN_ADC_VCAP    = A1;   // tensão do capacitor (com divisor)

// ── Parâmetros do circuito ───────────────────────────────────
const float DIVIDER_PIEZO      = 11.0f;   // R1=100k, R2=10k → Vpiezo = Vadc * 11
const float DIVIDER_VCAP       = 2.0f;    // R1=R2=10k → Vcap = Vadc * 2
const float VCAP_MAX           = 5.5f;    // tensão máxima do supercapacitor (5.5V)
const float CAPACITANCE        = 2.0f;    // dois capacitores de 1F em paralelo

// ── Temporização ─────────────────────────────────────────────
const unsigned long SEND_INTERVAL_MS   = 500;   // envio serial a cada 500 ms

// ── Variáveis globais ────────────────────────────────────────
float   vcapPrev        = 0.0f;
float   energyAccum_mJ  = 0.0f;    // energia acumulada estimada no capacitor
bool    firstSample     = true;

unsigned long lastSendTime   = 0;
unsigned long startTime      = 0;

// Média móvel para cada ADC (janela de 8 amostras)
const uint8_t ADC_WINDOW = 8;
float   adcBufferPiezo[ADC_WINDOW];
float   adcBufferVcap[ADC_WINDOW];
uint8_t adcIndex = 0;
bool    adcFull  = false;

// ── Setup ─────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }   // aguarda USB (necessário no Due)

  analogReadResolution(12);   // 12 bits no Due

  // Inicializa buffers com primeiras leituras
  float initPiezo = analogRead(PIN_ADC_PIEZO) * (VREF / ADC_MAX);
  float initVcap  = analogRead(PIN_ADC_VCAP)  * (VREF / ADC_MAX);
  for (uint8_t i = 0; i < ADC_WINDOW; i++) {
    adcBufferPiezo[i] = initPiezo;
    adcBufferVcap[i]  = initVcap;
  }

  startTime      = millis();
  lastSendTime   = millis();

  // Mensagem de boot
  Serial.print(F("{\"event\":\"boot\",\"board\":\"Arduino Due\","));
  Serial.print(F("\"adc_bits\":12,\"vref\":3.3,\"capacitance_f\":"));
  Serial.print(CAPACITANCE);
  Serial.println(F(",\"divider_piezo\":11,\"divider_vcap\":2}"));
}

// ── Leitura ADC com média móvel (retorna tensão real) ─────────
float readVoltage(uint8_t pin, float divider, float *buffer) {
  float raw = analogRead(pin);
  buffer[adcIndex] = raw;
  uint8_t count = adcFull ? ADC_WINDOW : adcIndex + 1;
  float sum = 0;
  for (uint8_t i = 0; i < count; i++) sum += buffer[i];
  float vadc = (sum / count) * (VREF / ADC_MAX);
  return vadc * divider;
}

// ── Estima potência gerada (variação de energia do capacitor) ─
float estimatePower_mW(float vcapNow, float vcapPrev, float dt_s) {
  if (dt_s <= 0.0f) return 0.0f;
  float dv = vcapNow - vcapPrev;
  float power = CAPACITANCE * ((vcapNow + vcapPrev) / 2.0f) * (dv / dt_s);
  return power * 1000.0f;   // em mW
}

// ── Loop principal ────────────────────────────────────────────
void loop() {
  unsigned long now = millis();

  // ── Leitura e atualização das médias móveis ──
  float rawPiezo = analogRead(PIN_ADC_PIEZO);
  float rawVcap  = analogRead(PIN_ADC_VCAP);
  adcBufferPiezo[adcIndex] = rawPiezo;
  adcBufferVcap[adcIndex]  = rawVcap;
  adcIndex = (adcIndex + 1) % ADC_WINDOW;
  if (adcIndex == 0) adcFull = true;

  // Cálculo das tensões reais (com média móvel)
  uint8_t count = adcFull ? ADC_WINDOW : adcIndex;
  float sumPiezo = 0, sumVcap = 0;
  for (uint8_t i = 0; i < count; i++) {
    sumPiezo += adcBufferPiezo[i];
    sumVcap  += adcBufferVcap[i];
  }
  float vadcPiezo = (sumPiezo / count) * (VREF / ADC_MAX);
  float vadcVcap  = (sumVcap  / count) * (VREF / ADC_MAX);
  float vpiezo = vadcPiezo * DIVIDER_PIEZO;
  float vcap   = vadcVcap  * DIVIDER_VCAP;

  // Atualiza energia a cada leitura (dt = SAMPLE_INTERVAL_MS, mas aqui estamos a cada loop)
  // Para manter a precisão, usamos o tempo real desde a última atualização.
  static unsigned long lastSampleTime = 0;
  float dt = (now - lastSampleTime) / 1000.0f;
  if (lastSampleTime != 0 && dt > 0.01f) {
    float power_mW = estimatePower_mW(vcap, vcapPrev, dt);
    if (power_mW > 0) energyAccum_mJ += power_mW * dt;
    vcapPrev = vcap;
  }
  lastSampleTime = now;

  // ── Envio serial periódico ──
  if (now - lastSendTime >= SEND_INTERVAL_MS) {
    float dt_s = (now - lastSendTime) / 1000.0f;
    float power_mW = estimatePower_mW(vcap, vcapPrev, dt_s);
    float chargePercent = constrain((vcap / VCAP_MAX) * 100.0f, 0.0f, 100.0f);
    float uptime_s = (now - startTime) / 1000.0f;

    // Valores raw para debug
    int rawAdcVcap  = (int)round(vadcVcap * ADC_MAX / VREF);
    int rawAdcPiezo = (int)round(vadcPiezo * ADC_MAX / VREF);

    // ── JSON output ──────────────────────────────────────────
    Serial.print(F("{"));
    Serial.print(F("\"ts\":"));        Serial.print(now);
    Serial.print(F(",\"uptime\":"));   Serial.print(uptime_s, 1);

    Serial.print(F(",\"vcap\":"));     Serial.print(vcap, 3);
    Serial.print(F(",\"vpiezo\":"));   Serial.print(vpiezo, 2);

    Serial.print(F(",\"raw_adc_vcap\":"));   Serial.print(rawAdcVcap);
    Serial.print(F(",\"raw_adc_vpiezo\":")); Serial.print(rawAdcPiezo);

    Serial.print(F(",\"charge_pct\":")); Serial.print(chargePercent, 1);
    Serial.print(F(",\"power_mw\":"));   Serial.print(power_mW, 2);
    Serial.print(F(",\"energy_mj\":"));  Serial.print(energyAccum_mJ, 2);

    Serial.println(F("}"));
    // ────────────────────────────────────────────────────────

    lastSendTime = now;
  }

  // ── Processa comandos recebidos via Serial ──
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();

    if (cmd == "RESET_ENERGY") {
      energyAccum_mJ = 0.0f;
      Serial.println(F("{\"event\":\"cmd\",\"action\":\"RESET_ENERGY\",\"ok\":true}"));

    } else if (cmd == "STATUS") {
      Serial.print(F("{\"event\":\"status\",\"energy_mj\":"));
      Serial.print(energyAccum_mJ, 2);
      Serial.println(F("}"));
    }
  }
}