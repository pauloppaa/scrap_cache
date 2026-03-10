/**
 * ================================================================================
 * MQTT SUBSCRIBER - ISENTO CSV (ENVIO CSV MENSAL DICIL)
 * ================================================================================
 *
 * @fileoverview Subscriber MQTT que recebe gatilho para ENVIO de CSV isento
 *
 * @description Este script (versão isento CSV):
 *   - Conecta ao broker MQTT
 *   - Inscreve-se no tópico `dici/envia/mensal/isento`
 *   - Recebe payload JSON com CNPJ único e URL do CSV
 *   - Envia DIRETAMENTE para API de upload (porta 3011)
 *   - Inicia o UPLOAD do CSV para ANATEL via Playwright
 *
 * @version 1.0.0-isento-csv
 * @author Paulo Galdino
 * @date 2026-02-01
 *
 * PAYLOAD ESPERADO (MQTT):
 * ------------------------
 * {
 *   "cnpj": "33795866000195",
 *   "ano": "2026",
 *   "mes": "01",
 *   "url": "/home/paulo/Área de Trabalho/.../mensal_33795866000195_01_2026_1769955107510.csv"
 * }
 *
 * PAYLOAD ENVIADO (Fila):
 * -----------------------
 * {
 *   "cnpjs": ["33795866000195"],
 *   "mes_referencia": "01",
 *   "mes_destino": "01",
 *   "caminho_csv": "/path/to/file.csv",
 *   "referencia_recorrencia": true
 * }
 *
 * FLUXO:
 * ------
 * MQTT (dici/envia/mensal/isento)
 *   → mqtt-isento-sub-csv
 *   → api-dici-mensal (porta 3011) - DIRETO
 *   → UPLOAD CSV para ANATEL via Playwright
 *
 * ================================================================================
 */

const mqtt = require('mqtt');
const axios = require('axios');
const fs = require('fs');

/**
 * Configurações do broker MQTT
 */
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://195.200.1.71:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'dici/envia/mensal/isento';
const API_UPLOAD_URL = process.env.API_UPLOAD_URL || 'http://localhost:3001';

/**
 * Client ID único para conexão MQTT
 */
const clientId = `mqtt_isento_csv_${Math.random().toString(16).substr(2, 8)}`;

/**
 * Cliente MQTT
 */
let client = null;

/**
 * Stats de processamento
 */
const stats = {
  messagesReceived: 0,
  cnpjsProcessed: 0,
  errors: 0,
  lastMessageAt: null,
  lastCNPJ: null,
  lastURL: null
};

/**
 * ================================================================================
 * FUNÇÕES AUXILIARES
 * ================================================================================
 */

/**
 * Envia CSV diretamente para API de upload (api-dici-mensal porta 3011)
 * @param {string} cnpj - CNPJ para enviar
 * @param {string} mes - Mês (ex: "01")
 * @param {string} ano - Ano (ex: "2026")
 * @param {string} urlCsv - Caminho do CSV
 * @returns {Promise<Object>} Resultado da operação
 */
async function enviarParaAPI(cnpj, mes, ano, urlCsv) {
  try {
    console.log(`\n📋 Enviando CSV para API ANATEL (UPLOAD DIRETO)...`);
    console.log(`   📦 CNPJ: ${cnpj}`);
    console.log(`   📅 Mês Destino: ${mes}/${ano}`);
    console.log(`   📄 CSV: ${urlCsv}`);

    const FormData = require('form-data');
    const fs = require('fs');

    // Criar FormData com o arquivo CSV
    const form = new FormData();
    form.append('csv', fs.createReadStream(urlCsv));
    form.append('mes_destino', `${mes}/${ano}`);

    console.log(`   🎯 Enviando para: ${API_UPLOAD_URL}/api/coleta/${cnpj}`);

    const response = await axios.post(
      `${API_UPLOAD_URL}/api/coleta/${cnpj}?mes_destino=${mes}/${ano}`,
      form,
      {
        headers: {
          ...form.getHeaders()
        },
        timeout: 600000 // 10 minutos (timeout maior para upload)
      }
    );

    console.log(`   ✓ Upload iniciado com sucesso!`);
    console.log(`   Resposta:`, response.data);

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    console.error(`   ✗ Erro ao enviar para API: ${error.message}`);
    if (error.response) {
      console.error(`   Status: ${error.response.status}`);
      console.error(`   Data:`, error.response.data);
    }
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Valida se o CNPJ está no formato correto (14 dígitos)
 * @param {string} cnpj - CNPJ para validar
 * @returns {boolean} True se válido
 */
function validarCNPJ(cnpj) {
  const cnpjLimpo = cnpj.replace(/[^\d]/g, '');
  return cnpjLimpo.length === 14;
}

/**
 * Valida se o arquivo CSV existe no caminho fornecido
 * @param {string} url - Caminho do arquivo
 * @returns {boolean} True se arquivo existe
 */
function validarArquivo(url) {
  try {
    return fs.existsSync(url);
  } catch (e) {
    return false;
  }
}

/**
 * Formata timestamp para exibição
 * @param {Date} date - Data para formatar
 * @returns {string} Data formatada
 */
function formatTimestamp(date = new Date()) {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Exibe stats do subscriber
 */
function exibirStats() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📊 STATS - MQTT SUBSCRIBER ISENTO CSV`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Mensagens recebidas: ${stats.messagesReceived}`);
  console.log(`CNPJs processados:   ${stats.cnpjsProcessed}`);
  console.log(`Erros:                ${stats.errors}`);
  console.log(`Última mensagem:      ${stats.lastMessageAt || 'Nenhuma'}`);
  if (stats.lastCNPJ) {
    console.log(`Último CNPJ:          ${stats.lastCNPJ}`);
  }
  if (stats.lastURL) {
    console.log(`Última URL:           ${stats.lastURL}`);
  }
  console.log(`${'='.repeat(60)}\n`);
}

/**
 * ================================================================================
 * HANDLER DE MENSAGENS MQTT
 * ================================================================================
 */

/**
 * Processa mensagem recebida do tópico MQTT
 * @param {string} topic - Tópico da mensagem
 * @param {Buffer} message - Conteúdo da mensagem
 */
function handleMessage(topic, message) {
  try {
    stats.messagesReceived++;
    stats.lastMessageAt = formatTimestamp();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📡 MENSAGEM RECEBIDA (ISENTO CSV)`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Tópico:     ${topic}`);
    console.log(`Timestamp:  ${stats.lastMessageAt}`);
    console.log(`Payload:    ${message.toString()}`);

    // Parse do payload JSON
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (e) {
      console.error(`   ✗ Erro ao parsear JSON: ${e.message}`);
      stats.errors++;
      return;
    }

    // Validar estrutura do payload (formato isento)
    if (!payload.cnpj || !payload.ano || !payload.mes || !payload.url) {
      console.error(`   ✗ Payload inválido: deve conter {cnpj, ano, mes, url}`);
      console.error(`   Recebido:`, payload);
      stats.errors++;
      return;
    }

    // Validar e limpar CNPJ
    const cnpjLimpo = payload.cnpj.replace(/[^\d]/g, '');
    if (!validarCNPJ(cnpjLimpo)) {
      console.error(`   ✗ CNPJ inválido: ${payload.cnpj} (deve ter 14 dígitos)`);
      stats.errors++;
      return;
    }

    console.log(`   ✓ CNPJ válido: ${cnpjLimpo}`);
    console.log(`   📅 Mês Referência: ${payload.mes}/${payload.ano}`);

    // Validar arquivo CSV
    const urlCsv = payload.url;
    if (!validarArquivo(urlCsv)) {
      console.error(`   ✗ Arquivo não encontrado: ${urlCsv}`);
      stats.errors++;
      return;
    }
    console.log(`   ✓ Arquivo CSV encontrado: ${urlCsv}`);

    // Atualizar stats
    stats.lastCNPJ = cnpjLimpo;
    stats.lastURL = urlCsv;

    // Enviar diretamente para API de upload (sem passar pela fila)
    enviarParaAPI(cnpjLimpo, payload.mes, payload.ano, urlCsv).then(resultado => {
      if (resultado.success) {
        stats.cnpjsProcessed++;
        console.log(`\n   ✅ PROCESSAMENTO CONCLUÍDO - Upload para ANATEL iniciado`);
      } else {
        stats.errors++;
        console.log(`\n   ❌ FALHA NO PROCESSAMENTO`);
      }
      exibirStats();
    });

  } catch (error) {
    console.error(`\n❌ ERRO AO PROCESSAR MENSAGEM: ${error.message}`);
    stats.errors++;
  }
}

/**
 * ================================================================================
 * CONEXÃO MQTT
 * ================================================================================
 */

/**
 * Conecta ao broker MQTT e configura handlers
 */
function conectarMQTT() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔌 CONECTANDO AO BROKER MQTT (ISENTO CSV)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Broker:     ${MQTT_BROKER}`);
  console.log(`Tópico:     ${MQTT_TOPIC}`);
  console.log(`Client ID:  ${clientId}`);
  console.log(`API Upload: ${API_UPLOAD_URL}/api/coleta/:cnpj`);
  console.log(`${'='.repeat(60)}\n`);

  client = mqtt.connect(MQTT_BROKER, {
    clientId: clientId,
    clean: true,
    connectTimeout: 30000,
    reconnectPeriod: 5000,
    keepalive: 60
  });

  // Event: Connect
  client.on('connect', () => {
    console.log(`\n✅ CONECTADO AO BROKER MQTT!\n`);

    // Inscrever no tópico (isento)
    client.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
      if (err) {
        console.error(`✗ Erro ao inscrever no tópico: ${err.message}`);
      } else {
        console.log(`✅ INSCRITO NO TÓPICO: ${MQTT_TOPIC}`);
        console.log(`\n🎯 AGUARDANDO MENSAGEMS...`);
        console.log(`\n📋 PAYLOAD ESPERADO:`);
        console.log(`   {`);
        console.log(`     "cnpj": "33795866000195",`);
        console.log(`     "ano": "2026",`);
        console.log(`     "mes": "01",`);
        console.log(`     "url": "/caminho/do/arquivo.csv"`);
        console.log(`   }\n`);
      }
    });
  });

  // Event: Message
  client.on('message', (topic, message) => {
    handleMessage(topic, message);
  });

  // Event: Error
  client.on('error', (err) => {
    console.error(`\n❌ ERRO MQTT: ${err.message}`);
    stats.errors++;
  });

  // Event: Reconnect
  client.on('reconnect', () => {
    console.log(`\n🔄 Reconectando ao broker MQTT...`);
  });

  // Event: Close
  client.on('close', () => {
    console.log(`\n⚠ Conexão MQTT fechada`);
  });

  // Event: Offline
  client.on('offline', () => {
    console.log(`\n⚠ Cliente MQTT offline`);
  });
}

/**
 * ================================================================================
 * HANDLERS DE SINAL
 * ================================================================================
 */

/**
 * Cleanup ao encerrar o processo
 */
function cleanup() {
  console.log(`\n\n${'='.repeat(60)}`);
  console.log(`🛑 ENCERRANDO MQTT SUBSCRIBER ISENTO CSV`);
  console.log(`${'='.repeat(60)}`);
  exibirStats();

  if (client) {
    client.end();
    console.log(`✅ Cliente MQTT encerrado`);
  }

  console.log(`${'='.repeat(60)}\n`);
  process.exit(0);
}

// Registrar handlers
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('SIGUSR2', cleanup); // nodemon restart

/**
 * ================================================================================
 * INICIALIZAÇÃO
 * ================================================================================
 */

// Exibir banner de inicialização
console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║                 MQTT SUBSCRIBER - ISENTO CSV v1.0.0                          ║
║                                                                              ║
║            Sistema de Recebimento de Envio CSV Isento via MQTT               ║
║                     (Tópico: dici/envia/mensal/isento)                       ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
`);

// Iniciar conexão
conectarMQTT();

// Exibir stats a cada 5 minutos
setInterval(() => {
  if (stats.messagesReceived > 0) {
    exibirStats();
  }
}, 5 * 60 * 1000);
