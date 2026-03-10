/**
 * ================================================================================
 * MQTT SUBSCRIBER - FLUXO COMPLETO ENVIO MENSAL
 * ================================================================================
 *
 * @fileoverview Subscriber MQTT que recebe notificações de download CSV
 *             e executa automaticamente o envio para a Anatel
 *
 * @description Este script:
 *   - Conecta ao broker MQTT
 *   - Inscreve-se no tópico `auto/mensal/resultado`
 *   - Recebe payloads JSON com resultado do download mensal
 *   - Quando status é "sucesso", encontra o CSV e executa o fluxo de envio
 *
 * @version 1.0.0
 * @author Paulo Galdino
 * @date 2026-03-10
 *
 * PAYLOAD ESPERADO (publicado por AUTO_DICI_MENSAL):
 * ---------------------------------------------------
 * {
 *   "cnpj": "06923091000113",
 *   "mes_baixar": "11",
 *   "ano_baixar": "2025",
 *   "mes_referencia": "12",
 *   "ano_referencia": "2025",
 *   "status": "sucesso",
 *   "timestamp": "2026-01-27T19:36:58.794Z"
 * }
 *
 * FLUXO:
 * ------
 * AUTO_DICI_MENSAL (baixar_e_atualizar_mensal.js)
 *   ↓ Baixa CSV e publica em auto/mensal/resultado
 *   ↓
 * mqtt_subscriber_fluxo_completo.cjs
 *   ↓ Inscreve em auto/mensal/resultado
 *   ↓
 * Recebe payload { cnpj, mes_referencia, ano_referencia }
 *   ↓
 * Encontra CSV: api/downloads/${cnpj}_${mes_referencia}_${ano_referencia}.csv
 *   ↓
 * Executa: fluxo_completo_envio_mensal.js cnpj csv mes_destino
 *   ↓
 * Envia CSV para Anatel
 *
 * ================================================================================
 */

const mqtt = require('mqtt');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * Configurações do broker MQTT
 */
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://195.200.1.71:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'auto/mensal/resultado';
const PROJECT_DIR = '/home/paulo/Área de Trabalho/PRONTO_ENVIA_CSV_DICI';
const DOWNLOADS_DIR = path.join(PROJECT_DIR, 'api/downloads');

/**
 * Client ID único para conexão MQTT
 */
const clientId = `mqtt_fluxo_completo_${Math.random().toString(16).substr(2, 8)}`;

/**
 * Cliente MQTT
 */
let client = null;

/**
 * Stats de processamento
 */
const stats = {
  messagesReceived: 0,
  enviosExecutados: 0,
  enviosSucesso: 0,
  enviosErro: 0,
  ignorados: 0,
  lastMessageAt: null,
  lastExecutionAt: null
};

/**
 * ================================================================================
 * FUNÇÕES AUXILIARES
 * ================================================================================
 */

/**
 * Encontra o CSV baseado no CNPJ e mês de referência
 * @param {string} cnpj - CNPJ da empresa
 * @param {string} mesReferencia - Mês de referência (ex: "02")
 * @param {string} anoReferencia - Ano de referência (ex: "2026")
 * @returns {Promise<string>} Caminho completo do CSV encontrado
 */
async function encontrarCSV(cnpj, mesReferencia, anoReferencia) {
  console.log(`\n🔍 Procurando CSV para CNPJ ${cnpj}...`);

  // Padrão 1: ${cnpj}_${mesReferencia}_${anoReferencia}.csv
  const padrao1 = path.join(DOWNLOADS_DIR, `${cnpj}_${mesReferencia}_${anoReferencia}.csv`);
  if (fs.existsSync(padrao1)) {
    console.log(`   ✓ CSV encontrado (padrão 1): ${padrao1}`);
    return padrao1;
  }

  // Padrão 2: ${cnpj}_${mesReferencia}_${anoReferencia}_*.csv (variações como _crlf, _fixed)
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const regex = new RegExp(`^${cnpj}_${mesReferencia}_${anoReferencia}(_[a-z]+)?\\.csv$`);
    const csvMatch = files.find(f => regex.test(f));

    if (csvMatch) {
      const csvPath = path.join(DOWNLOADS_DIR, csvMatch);
      console.log(`   ✓ CSV encontrado (padrão 2): ${csvPath}`);
      return csvPath;
    }
  } catch (error) {
    console.error(`   ✗ Erro ao listar diretório: ${error.message}`);
  }

  // Padrão 3: Buscar CSV mais recente com o CNPJ no nome
  try {
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const csvComCNPJ = files
      .filter(f => f.includes(cnpj) && f.endsWith('.csv'))
      .map(f => ({
        name: f,
        path: path.join(DOWNLOADS_DIR, f),
        mtime: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime)[0];

    if (csvComCNPJ) {
      console.log(`   ✓ CSV encontrado (padrão 3 - mais recente): ${csvComCNPJ.path}`);
      console.log(`   ⚠ Usando CSV mais recente (pode não ser do mês desejado)`);
      return csvComCNPJ.path;
    }
  } catch (error) {
    console.error(`   ✗ Erro ao buscar CSV por CNPJ: ${error.message}`);
  }

  throw new Error(`CSV não encontrado para CNPJ ${cnpj} (mês: ${mesReferencia}/${anoReferencia})`);
}

/**
 * Executa o fluxo completo de envio mensal
 * @param {string} cnpj - CNPJ da empresa
 * @param {string} csvPath - Caminho completo do CSV
 * @param {string} mesDestino - Mês de destino (ex: "02/2026")
 * @returns {Promise<Object>} Resultado da execução
 */
async function executarFluxoCompleto(cnpj, csvPath, mesDestino) {
  console.log(`\n🚀 Executando fluxo completo de envio...`);
  console.log(`   CNPJ: ${cnpj}`);
  console.log(`   CSV: ${csvPath}`);
  console.log(`   Mês: ${mesDestino}`);

  const command = `node fluxo_completo_envio_mensal.js "${cnpj}" "${csvPath}" "${mesDestino}"`;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: PROJECT_DIR,
      timeout: 180000 // 3 minutos
    });

    return {
      success: true,
      stdout: stdout,
      stderr: stderr
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout || '',
      stderr: error.stderr || ''
    };
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
  console.log(`📊 STATS - MQTT SUBSCRIBER FLUXO COMPLETO`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Mensagens recebidas:  ${stats.messagesReceived}`);
  console.log(`Envios executados:    ${stats.enviosExecutados}`);
  console.log(`Envios com sucesso:   ${stats.enviosSucesso}`);
  console.log(`Envios com erro:      ${stats.enviosErro}`);
  console.log(`Ignorados:            ${stats.ignorados}`);
  console.log(`Última mensagem:      ${stats.lastMessageAt || 'Nenhuma'}`);
  console.log(`Última execução:      ${stats.lastExecutionAt || 'Nenhuma'}`);
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
async function handleMessage(topic, message) {
  try {
    stats.messagesReceived++;
    stats.lastMessageAt = formatTimestamp();

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📡 MENSAGEM RECEBIDA (FLUXO COMPLETO)`);
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

    // Verificar se foi sucesso
    if (payload.status !== 'sucesso') {
      console.log(`   ⚠ Status não é "sucesso" (${payload.status}), ignorando`);
      stats.ignorados++;
      return;
    }

    // Validar estrutura do payload
    if (!payload.cnpj) {
      console.error(`   ✗ Payload inválido: deve conter "cnpj"`);
      stats.errors++;
      return;
    }

    const { cnpj, mes_referencia, ano_referencia } = payload;

    if (!mes_referencia || !ano_referencia) {
      console.error(`   ✗ Payload inválido: deve conter "mes_referencia" e "ano_referencia"`);
      stats.errors++;
      return;
    }

    console.log(`   ✓ CNPJ: ${cnpj}`);
    console.log(`   ✓ Mês Ref: ${mes_referencia}/${ano_referencia}`);

    // Formatar mês destino (MM/YYYY)
    const mesDestino = `${mes_referencia}/${ano_referencia}`;

    // Encontrar CSV
    let csvPath;
    try {
      csvPath = await encontrarCSV(cnpj, mes_referencia, ano_referencia);
    } catch (error) {
      console.error(`   ✗ ${error.message}`);
      stats.enviosErro++;
      return;
    }

    // Executar fluxo completo
    stats.enviosExecutados++;
    stats.lastExecutionAt = formatTimestamp();

    const resultado = await executarFluxoCompleto(cnpj, csvPath, mesDestino);

    if (resultado.success) {
      stats.enviosSucesso++;
      console.log(`\n   ✅ ENVIO CONCLUÍDO COM SUCESSO`);
      if (resultado.stdout) {
        console.log(`   Output: ${resultado.stdout.substring(0, 200)}...`);
      }
    } else {
      stats.enviosErro++;
      console.error(`\n   ❌ ERRO NO ENVIO`);
      console.error(`   Erro: ${resultado.error}`);
      if (resultado.stderr) {
        console.error(`   Stderr: ${resultado.stderr.substring(0, 200)}...`);
      }
    }

    exibirStats();

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
  console.log(`🔌 CONECTANDO AO BROKER MQTT (FLUXO COMPLETO)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Broker:      ${MQTT_BROKER}`);
  console.log(`Tópico:      ${MQTT_TOPIC}`);
  console.log(`Client ID:   ${clientId}`);
  console.log(`Project Dir: ${PROJECT_DIR}`);
  console.log(`Downloads:   ${DOWNLOADS_DIR}`);
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

    // Inscrever no tópico
    client.subscribe(MQTT_TOPIC, { qos: 1 }, (err) => {
      if (err) {
        console.error(`✗ Erro ao inscrever no tópico: ${err.message}`);
      } else {
        console.log(`✅ INSCRITO NO TÓPICO: ${MQTT_TOPIC}`);
        console.log(`\n🎯 AGUARDANDO MENSAGENS DE DOWNLOAD SUCESSO...\n`);
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
  console.log(`🛑 ENCERRANDO MQTT SUBSCRIBER FLUXO COMPLETO`);
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
║              MQTT SUBSCRIBER - FLUXO COMPLETO v1.0.0                         ║
║                                                                              ║
║          Sistema de Envio Automático CSV para Anatel                          ║
║                   (via MQTT - auto/mensal/resultado)                         ║
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
