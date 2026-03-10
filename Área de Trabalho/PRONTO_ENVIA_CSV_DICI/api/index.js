/**
 * ================================================================================
 * API ANATEL COLETA DE DADOS
 * ================================================================================
 *
 * @fileoverview API REST para automatizar a consulta, download de comprovantes
 * e envio de arquivos CSV no sistema de Coleta de Dados da Anatel.
 *
 * @description Esta API utiliza Playwright para automação do navegador, permitindo:
 *   - Autenticação automática via cookies do Chrome do usuário
 *   - Navegação automatizada no portal de Coleta de Dados
 *   - Download de comprovantes PDF de arquivos processados
 *   - Upload de arquivos CSV para formulários da Anatel
 *   - Captura de screenshots para debug e auditoria
 *
 * @version 2.0.0
 * @author Paulo Galdino
 * @date 2026-01-16
 *
 * ENDPOINTS DISPONÍVEIS:
 * ----------------------
 *   POST /api/coleta/:cnpj - Processa CNPJ (com ou sem CSV)
 *   GET  /api/coleta/:cnpj - Processa CNPJ e baixa comprovante (sem CSV)
 *   GET  /api/health       - Verifica status da API
 *   GET  /api/downloads    - Lista arquivos baixados
 *   GET  /api/download/:file - Download de arquivo específico
 *
 * PARÂMETROS:
 * -----------
 *   POST /api/coleta/:cnpj:
 *     - FormData: csv (arquivo .csv) - Opcional
 *     - Query/Body: whatsapp (número WhatsApp)
 *
 *   GET /api/coleta/:cnpj:
 *     - Query: whatsapp (número WhatsApp)
 *
 * REQUISITOS:
 * -----------
 *   - Node.js 18+
 *   - Playwright instalado (npm install playwright)
 *   - Python 3 com browser_cookie3 instalado (pip install browser_cookie3)
 *   - Chrome com sessão ativa no portal Anatel
 *
 * FLUXO DE AUTOMAÇÃO (COM CSV):
 * -----------------------------
 *   1. Extrai cookies do Chrome via script Python
 *   2. Acessa página de Coleta de Dados Externa
 *   3. Preenche CNPJ no campo de pesquisa
 *   4. Clica em Pesquisar e aguarda grid carregar
 *   5. Seleciona registro "Acessos - SCM | Padrão"
 *   6. Seleciona período "2026    De 01/01/2026 a 31/03/2026    Em andamento"
 *   7. Encontra uploader "Leiaute: Estações | Status: Aguardando Envio"
 *   8. Clica em "Adicionar Arquivo" e envia o CSV
 *
 * FLUXO DE AUTOMAÇÃO (SEM CSV):
 * -----------------------------
 *   1. Extrai cookies do Chrome via script Python
 *   2. Acessa página de Coleta de Dados Externa
 *   3. Preenche CNPJ no campo de pesquisa
 *   4. Clica em Pesquisar e aguarda grid carregar
 *   5. Seleciona registro "Acessos - SCM | Padrão"
 *   6. Seleciona período "2026    De 01/01/2026 a 31/03/2026    Em andamento"
 *   7. Expande linha "Processado com sucesso"
 *   8. Baixa PDF do comprovante
 *   9. (Opcional) Envia PDF para WhatsApp
 *
 * ================================================================================
 */

const express = require("express");
const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const multer = require("multer");

/**
 * Instância do servidor Express
 * @type {Express}
 */
const app = express();

/**
 * Porta do servidor (default: 3001)
 * @constant {number}
 */
const PORT = process.env.PORT || 3001;

/**
 * Diretório para salvar downloads e screenshots
 * @constant {string}
 */
const DOWNLOADS_DIR = path.join(__dirname, "downloads");

// Cria diretório de downloads se não existir
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Configuração do Multer para upload de arquivos CSV
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, DOWNLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const cnpj = req.params.cnpj || req.body.cnpj || "unknown";
    const mesDestino = req.query.mes_destino || req.body?.mes_destino || '01/2026';
    const [mes, ano] = mesDestino.split('/');
    cb(null, `${cnpj}_${mes}_${ano}.csv`);
  },
});

const upload = multer({
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Aceitar apenas arquivos CSV
    if (
      file.mimetype === "text/csv" ||
      file.mimetype === "application/csv" ||
      file.originalname.toLowerCase().endsWith(".csv")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Apenas arquivos CSV são permitidos"));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

// ============================================================================
// SELETORES DA PÁGINA (OutSystems)
// ============================================================================
const SELECTORS = {
  // Campo de pesquisa Entidade (CNPJ)
  inputEntidade:
    "#wt105_OutSystemsUIWeb_wt2_block_wtContent_wtMainContent_OutSystemsUIWeb_wt54_block_wtContent_OutSystemsUIWeb_wt87_block_wtColumn1_wtSearchInput",

  // Botão Pesquisar
  btnPesquisar:
    "#wt105_OutSystemsUIWeb_wt2_block_wtContent_wtMainContent_OutSystemsUIWeb_wt54_block_wtContent_wt22",

  // Botão Limpar
  btnLimpar:
    "#wt105_OutSystemsUIWeb_wt2_block_wtContent_wtMainContent_OutSystemsUIWeb_wt54_block_wtContent_wt19",

  // Alternativas por valor/texto
  btnPesquisarAlt: 'input[value="Pesquisar"]',
  inputEntidadeAlt: 'input[placeholder*="CNPJ"]',
};

// ============================================================================
// FUNÇÕES AUXILIARES
// ============================================================================

/**
 * Extrai cookies do Chrome usando script Python
 */
function getChromeCoookies(domain = ".anatel.gov.br") {
  try {
    const scriptPath = path.join(__dirname, "export_cookies.py");
    const result = execSync(`python3 "${scriptPath}" "${domain}"`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return JSON.parse(result);
  } catch (error) {
    console.error("Erro ao extrair cookies:", error.message);
    return [];
  }
}

/**
 * Formata CNPJ removendo caracteres especiais
 */
function formatCNPJ(cnpj) {
  return cnpj.replace(/[^\d]/g, "");
}

/**
 * Aguarda elemento e retorna, ou null se não encontrar
 */
async function waitForSelector(page, selector, timeout = 10000) {
  try {
    return await page.waitForSelector(selector, {
      state: "visible",
      timeout,
    });
  } catch {
    return null;
  }
}

/**
 * Tenta clicar em múltiplos seletores até um funcionar
 */
async function clickAny(page, selectors, description = "") {
  for (const selector of selectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        await element.click();
        console.log(`   ✓ Clicado: ${description} (${selector})`);
        return true;
      }
    } catch (e) {
      // Continua tentando
    }
  }
  console.log(`   ✗ Não encontrado: ${description}`);
  return false;
}

/**
 * Envia arquivo PDF para WhatsApp via rota /sendm
 * @param {string} whatsappNumber - Número do WhatsApp (formato: 5511999999999)
 * @param {string} filePath - Caminho completo do arquivo PDF
 * @returns {Promise<Object>} Resultado do envio
 */
async function enviarParaWhatsApp(whatsappNumber, filePath) {
  try {
    const SENDM_URL = process.env.SENDM_URL || "http://localhost:3004/sendmessagev3";

    console.log(`\n📱 Enviando comprovante para WhatsApp...`);
    console.log(`   URL: ${SENDM_URL}`);
    console.log(`   Número: ${whatsappNumber}`);
    console.log(`   Arquivo: ${filePath}`);

    const response = await axios.post(SENDM_URL, {
      number: whatsappNumber,
      file: filePath
    }, {
      headers: {
        "Content-Type": "application/json"
      },
      timeout: 30000
    });

    console.log(`   ✓ Enviado com sucesso!`);
    console.log(`   Resposta:`, response.data);
    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    console.error(`   ✗ Erro ao enviar para WhatsApp: ${error.message}`);
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

// ============================================================================
// AUTOMAÇÃO PLAYWRIGHT
// ============================================================================

/**
 * Número padrão do WhatsApp para envio automático de comprovantes
 * @constant {string}
 */
const DEFAULT_WHATSAPP_NUMBER = "5517997695403";

async function processarColetaDados(cnpj, csvFilePath = null, whatsappNumber = DEFAULT_WHATSAPP_NUMBER, anoDestino = '2026') {
  const cnpjFormatado = formatCNPJ(cnpj);
  const timestamp = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROCESSANDO CNPJ: ${cnpjFormatado}`);
  if (csvFilePath) {
    console.log(`CSV: ${csvFilePath}`);
  }
  console.log(`ANO DESTINO: ${anoDestino}`);
  console.log(`${"=".repeat(60)}\n`);

  // Extrair cookies
  console.log("1. Extraindo cookies do Chrome...");
  const cookies = getChromeCoookies();
  console.log(`   Encontrados ${cookies.length} cookies`);

  if (cookies.length === 0) {
    return {
      success: false,
      error: "Não foi possível extrair cookies. Verifique se está logado no Chrome.",
    };
  }

  const browser = await chromium.launch({
    headless: true, // true para invisível (produção)
    slowMo: 0, // 0 para produção (sem delay)
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
    acceptDownloads: true,
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  // Configurar handler para downloads
  let downloadedFile = null;
  page.on("download", async (download) => {
    const fileName = `comprovante_${cnpjFormatado}_${timestamp}.pdf`;
    const filePath = path.join(DOWNLOADS_DIR, fileName);
    await download.saveAs(filePath);
    downloadedFile = filePath;
    console.log(`   ✓ Download salvo: ${fileName}`);
  });

  try {
    // =========================================================================
    // PASSO 2: Acessar página de Coleta de Dados
    // =========================================================================
    console.log("\n2. Acessando página de Coleta de Dados...");
    await page.goto(
      "https://apps.anatel.gov.br/ColetaDados/ColetasConsultaExterno.aspx",
      { waitUntil: "domcontentloaded", timeout: 60000 }
    );

    // Aguardar carregamento
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Verificar autenticação
    const pageTitle = await page.title();
    if (pageTitle.includes("Login") || pageTitle.includes("gov.br")) {
      throw new Error("Sessão não autenticada. Faça login no Chrome primeiro.");
    }
    console.log(`   ✓ Página carregada: ${pageTitle}`);

    // Screenshot
    await page.screenshot({
      path: path.join(DOWNLOADS_DIR, `01_pagina_inicial_${cnpjFormatado}.png`),
    });

    // =========================================================================
    // PASSO 3: Preencher CNPJ no campo Entidade
    // =========================================================================
    console.log("\n3. Preenchendo CNPJ no campo Entidade...");

    // Tentar encontrar o campo de input
    let inputEntidade =
      (await waitForSelector(page, SELECTORS.inputEntidade, 5000)) ||
      (await waitForSelector(page, SELECTORS.inputEntidadeAlt, 5000)) ||
      (await waitForSelector(page, 'input[type="text"]', 5000));

    if (!inputEntidade) {
      // Tentar por placeholder
      inputEntidade = await page.$('input[placeholder*="nome"]');
    }

    if (!inputEntidade) {
      throw new Error("Campo de pesquisa Entidade não encontrado");
    }

    await inputEntidade.click();
    await inputEntidade.fill("");
    await page.waitForTimeout(500);
    await inputEntidade.fill(cnpjFormatado);
    console.log(`   ✓ CNPJ digitado: ${cnpjFormatado}`);

    // =========================================================================
    // PASSO 4: Clicar em Pesquisar
    // =========================================================================
    console.log("\n4. Clicando em Pesquisar...");

    const pesquisarClicked = await clickAny(
      page,
      [SELECTORS.btnPesquisar, SELECTORS.btnPesquisarAlt, 'input[value="Pesquisar"]'],
      "Botão Pesquisar"
    );

    if (!pesquisarClicked) {
      throw new Error("Botão Pesquisar não encontrado");
    }

    // Aguardar carregamento do grid
    console.log("   Aguardando resultados...");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(5000);

    // Screenshot após pesquisa
    await page.screenshot({
      path: path.join(DOWNLOADS_DIR, `02_resultado_pesquisa_${cnpjFormatado}.png`),
    });

    // =========================================================================
    // PASSO 5: Clicar no registro do grid (botão com setinha)
    // =========================================================================
    console.log("\n5. Procurando registro no grid...");

    // Aguardar tabela carregar completamente
    await page.waitForTimeout(3000);

    // Procurar a linha que contém "Padrão" e "Acessos - SCM"
    // Os botões de ação têm classe "btn" e título "Selecionar"
    let gridClicked = false;

    // Estratégia 1: Encontrar a linha correta e clicar no botão de ação
    const rows = await page.$$("table tr");
    for (const row of rows) {
      const rowText = await row.textContent();
      // Procurar a linha com "Infraestrutura dos Serviços de Telecomunicações" e "Agenda Padrão" ou "Padrão"
      if (
        rowText &&
        rowText.includes("Infraestrutura dos Serviços de Telecomunicações") &&
        (rowText.includes("Agenda Padrão") || rowText.includes("Padrão"))
      ) {
        // Encontrar o botão de ação nesta linha
        const actionBtn = await row.$('a.btn[title="Selecionar"], a.btn');
        if (actionBtn) {
          await actionBtn.click();
          console.log('   ✓ Clicado no botão de ação da linha "Infraestrutura dos Serviços de Telecomunicações - Agenda Padrão"');
          gridClicked = true;
          break;
        }
      }
    }

    // Estratégia 2: Se não encontrou, clicar no segundo botão (índice 1)
    if (!gridClicked) {
      const actionButtons = await page.$$('a.btn[title="Selecionar"]');
      if (actionButtons.length > 1) {
        // O segundo botão corresponde a "Acessos - SCM | Padrão"
        await actionButtons[1].click();
        console.log("   ✓ Clicado no segundo botão de ação");
        gridClicked = true;
      } else if (actionButtons.length > 0) {
        await actionButtons[0].click();
        console.log("   ✓ Clicado no primeiro botão de ação disponível");
        gridClicked = true;
      }
    }

    // Estratégia 3: Clicar em qualquer botão .btn na tabela
    if (!gridClicked) {
      const anyBtn = await page.$("table a.btn");
      if (anyBtn) {
        await anyBtn.click();
        console.log("   ✓ Clicado em botão .btn da tabela");
        gridClicked = true;
      }
    }

    if (!gridClicked) {
      console.log("   ⚠ Nenhum botão de ação encontrado no grid");
    }

    // Aguardar navegação
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);

    // Screenshot
    await page.screenshot({
      path: path.join(DOWNLOADS_DIR, `03_detalhes_coleta_${cnpjFormatado}.png`),
    });

    // =========================================================================
    // PASSO 6: Extrair AgendaReferenciaId e navegar para página de upload
    // =========================================================================
    console.log(`\n6. Procurando registro do ano "${anoDestino}" com status "Aguardando envio"...`);

    // Aguardar nova página carregar
    await page.waitForTimeout(3000);

    let agendaReferenciaId = null;
    let found = false;

    // Scroll para baixo para garantir que todos os períodos estão visíveis
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);

    const periodRows = await page.$$("table tr");
    console.log(`   DEBUG: Encontradas ${periodRows.length} linhas na tabela de períodos`);

    // Estratégia 1: Procurar linha com o ano_destino E "Aguardando"
    for (const row of periodRows) {
      const rowText = await row.textContent();
      if (rowText && rowText.includes(anoDestino) && (rowText.includes("Aguardando") || rowText.includes("Aguardando Envio") || rowText.includes("Aguardando envio"))) {
        // Extrair o link ANTES de clicar
        const link = await row.$('a[href*="EnviarArquivoExterno"]');
        if (link) {
          const href = await link.getAttribute('href');
          if (href) {
            console.log(`   Link encontrado para ano ${anoDestino}: ${href.substring(0, 100)}...`);
            const match = href.match(/AgendaReferenciaId=(\d+)/);
            if (match) {
              agendaReferenciaId = match[1];
              console.log(`   ✓ AgendaReferenciaId extraído (${anoDestino}): ${agendaReferenciaId}`);
              found = true;
              break;
            }
          }
        }
      }
    }

    // Fallback: Procurar por ano_destino + "Em andamento" + "Aguardando"
    if (!found) {
      for (const row of periodRows) {
        const rowText = await row.textContent();
        if (rowText && rowText.includes(anoDestino) && rowText.includes("Em andamento") && (rowText.includes("Aguardando") || rowText.includes("Aguardando Envio"))) {
          const link = await row.$('a[href*="EnviarArquivoExterno"]');
          if (link) {
            const href = await link.getAttribute('href');
            if (href) {
              const match = href.match(/AgendaReferenciaId=(\d+)/);
              if (match) {
                agendaReferenciaId = match[1];
                console.log(`   ✓ AgendaReferenciaId extraído (${anoDestino} - Em andamento): ${agendaReferenciaId}`);
                found = true;
                break;
              }
            }
          }
        }
      }
    }

    // Fallback 2: Procurar apenas pelo ano_destino (sem verificar status)
    if (!found) {
      console.log(`   ⚠ Registro com ano "${anoDestino}" + "Aguardando" não encontrado, tentando buscar apenas pelo ano...`);
      for (const row of periodRows) {
        const rowText = await row.textContent();
        if (rowText && rowText.includes(anoDestino)) {
          const link = await row.$('a[href*="EnviarArquivoExterno"]');
          if (link) {
            const href = await link.getAttribute('href');
            if (href) {
              const match = href.match(/AgendaReferenciaId=(\d+)/);
              if (match) {
                agendaReferenciaId = match[1];
                console.log(`   ✓ AgendaReferenciaId extraído (${anoDestino} - fallback): ${agendaReferenciaId}`);
                found = true;
                break;
              }
            }
          }
        }
      }
    }

    if (!found) {
      console.log(`   ⚠ Registro com ano "${anoDestino}" não encontrado`);
    } else if (agendaReferenciaId) {
      // Navegar DIRETAMENTE para a página de upload (igual ao upload_direto.js)
      const uploadUrl = `https://apps.anatel.gov.br/ColetaDados/EnviarArquivoExterno.aspx?AgendaReferenciaId=${agendaReferenciaId}`;
      console.log(`   🎯 Navegando diretamente para página de upload...`);
      console.log(`   URL: ${uploadUrl}`);

      await page.goto(uploadUrl, {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      console.log(`   ✓ URL atual: ${currentUrl.substring(0, 100)}...`);

      if (currentUrl.includes('EnviarArquivoExterno')) {
        console.log('   ✅ Página de upload carregada com sucesso!');
      } else {
        console.log('   ⚠ Navegação pode não ter funcionado corretamente');
      }
    }

    // Screenshot
    await page.screenshot({
      path: path.join(DOWNLOADS_DIR, `04_periodo_${cnpjFormatado}.png`),
    });

    // =========================================================================
    // PASSO 7: Enviar CSV ou expandir linha do arquivo processado
    // =========================================================================
    let csvUploadResult = null;

    if (csvFilePath) {
      // =========================================================================
      // FLUXO COM CSV: Enviar arquivo (usando método simplificado que funciona)
      // =========================================================================
      console.log("\n7. Enviando CSV (método simplificado igual upload_direto.js)...");
      console.log(`   Arquivo CSV: ${csvFilePath}`);

      // Chamar função simplificada de upload (igual ao upload_direto.js)
      csvUploadResult = await uploadCSVSimplificado(page, csvFilePath, cnpjFormatado);
    } else {
      // FLUXO SEM CSV: Expandir linha "Processado com sucesso" e baixar PDF
      // =========================================================================
      console.log("\n7. Expandindo linha do arquivo processado...");

      // Procurar e clicar na linha azul que contém "Processado com sucesso"
      // Esta linha tem uma seta (chevron) que expande para mostrar o comprovante
      const expandableRows = await page.$$('[class*="accordion"], [class*="collapsible"], [class*="expandable"], div[onclick], a[onclick]');

      // Tentar clicar na linha que contém "Processado com sucesso"
      let expanded = false;

      // Estratégia 1: Clicar no elemento que contém "Processado com sucesso"
      const successElement = await page.$('text="Processado com sucesso"');
      if (successElement) {
        // Tentar clicar no elemento pai clicável
        try {
          const parentClicked = await page.evaluate((el) => {
            const parent = el.closest('div[onclick], a, button, [class*="row"], [class*="accordion"]');
            if (parent && parent !== el) {
              parent.click();
              return true;
            }
            return false;
          }, successElement);

          if (parentClicked) {
            console.log('   ✓ Clicado na linha pai de "Processado com sucesso"');
            expanded = true;
          } else {
            await successElement.click();
            console.log('   ✓ Clicado no texto "Processado com sucesso"');
            expanded = true;
          }
        } catch (e) {
          await successElement.click();
          console.log('   ✓ Clicado no texto "Processado com sucesso"');
          expanded = true;
        }
      }

      // Estratégia 2: Clicar no ícone chevron
      if (!expanded) {
        const chevron = await page.$('i.fa-chevron-down, i.fa-chevron-right, i.fa-angle-down, span[class*="chevron"]');
        if (chevron) {
          try {
            await page.evaluate((el) => {
              const parent = el.closest('a, button, div[onclick]');
              if (parent) {
                parent.click();
              } else {
                el.click();
              }
            }, chevron);
            console.log("   ✓ Clicado no ícone chevron");
            expanded = true;
          } catch (e) {
            await chevron.click();
            expanded = true;
          }
        }
      }

      // Estratégia 3: Clicar em qualquer elemento com classe de accordion/collapse
      if (!expanded) {
        const accordion = await page.$('[class*="accordion-header"], [class*="collapse-header"], [data-toggle="collapse"]');
        if (accordion) {
          await accordion.click();
          console.log("   ✓ Clicado no accordion");
          expanded = true;
        }
      }

      // Aguardar expansão
      await page.waitForTimeout(2000);

      // Screenshot após expansão
      await page.screenshot({
        path: path.join(DOWNLOADS_DIR, `05_expandido_${cnpjFormatado}.png`),
      });
    }

    // =========================================================================
    // PASSO 8: Baixar o comprovante PDF (apenas quando não há CSV)
    // =========================================================================
    if (!csvFilePath) {
      console.log("\n8. Procurando link do comprovante...");

      const pageText = await page.innerText("body");

      if (pageText.includes("Processado com sucesso")) {
        console.log("   ✓ Status: Processado com sucesso");
      }

      // Procurar link do comprovante/PDF
      // O link correto é "Ver Comprovante" com title="Ver Comprovante"
      const pdfSelectors = [
      'a[title="Ver Comprovante"]',
      'a:has-text("Ver Comprovante")',
      'a.Button[href*="Comprovante"]',
      'a[href*="PopUpComprovante"]',
      'a[href*="Comprovante"]',
      'a:has-text("Comprovante")',
      'a[href*=".pdf"]',
      'a:has-text("PDF")',
      'a:has-text("Download")',
      // Ícones
      'a:has(i.fa-download)',
      'a:has(i.fa-file-pdf)',
    ];

    let pdfFound = false;

    // Scroll para garantir que o conteúdo expandido está visível
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Procurar o link "Ver Comprovante" e extrair a URL
    let comprovanteUrl = null;

    for (const selector of pdfSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            // Extrair a URL do link
            comprovanteUrl = await element.getAttribute("href");
            console.log(`   Encontrado: ${selector}`);
            console.log(`   URL: ${comprovanteUrl}`);
            break;
          }
        }
      } catch (e) {
        // Continua tentando outros seletores
      }
    }

    // Se não encontrou com seletores específicos, procurar em todos os links
    if (!comprovanteUrl) {
      const allLinks = await page.$$("a");
      for (const link of allLinks) {
        try {
          const isVisible = await link.isVisible();
          if (!isVisible) continue;

          const text = await link.textContent();
          const href = await link.getAttribute("href");
          if (
            (text && text.toLowerCase().includes("ver comprovante")) ||
            (href && href.toLowerCase().includes("comprovante"))
          ) {
            comprovanteUrl = href;
            console.log(`   Encontrado link: ${text}`);
            console.log(`   URL: ${comprovanteUrl}`);
            break;
          }
        } catch (e) {
          // Continua
        }
      }
    }

    // Se encontrou a URL, navegar em nova aba e gerar PDF
    if (comprovanteUrl) {
      try {
        // Converter URL relativa para absoluta
        const baseUrl = "https://apps.anatel.gov.br/ColetaDados/";
        const fullUrl = comprovanteUrl.startsWith("http")
          ? comprovanteUrl
          : baseUrl + comprovanteUrl;

        console.log(`   Abrindo página do comprovante: ${fullUrl}`);

        // Abrir em nova aba
        const comprovantePage = await context.newPage();
        await comprovantePage.goto(fullUrl, { waitUntil: "networkidle", timeout: 30000 });
        await comprovantePage.waitForTimeout(2000);

        // Screenshot do comprovante
        await comprovantePage.screenshot({
          path: path.join(DOWNLOADS_DIR, `07_comprovante_${cnpjFormatado}.png`),
          fullPage: true,
        });

        // Gerar PDF do comprovante
        console.log("   Gerando PDF do comprovante...");
        const pdfPath = path.join(DOWNLOADS_DIR, `comprovante_${cnpjFormatado}_${timestamp}.pdf`);
        await comprovantePage.pdf({ path: pdfPath, format: "A4" });
        downloadedFile = pdfPath;
        console.log(`   ✓ PDF gerado: ${pdfPath}`);

        await comprovantePage.close();
        pdfFound = true;
      } catch (e) {
        console.log(`   Erro ao gerar PDF: ${e.message}`);
      }
    }

    if (!pdfFound && !comprovanteUrl) {
      console.log("   ⚠ Link do comprovante não encontrado");
    }
    } // Fim do if (!csvFilePath) - PASSO 8

    // Screenshot final
    await page.screenshot({
      path: path.join(DOWNLOADS_DIR, `06_final_${cnpjFormatado}.png`),
    });

    // =========================================================================
    // PASSO 9: Enviar para WhatsApp (automático)
    // =========================================================================
    let whatsappResult = null;
    if (downloadedFile) {
      whatsappResult = await enviarParaWhatsApp(whatsappNumber, downloadedFile);
    } else {
      console.log("\n⚠ Não há arquivo para enviar ao WhatsApp");
    }

    // =========================================================================
    // RESULTADO
    // =========================================================================
    const result = {
      success: true,
      cnpj: cnpjFormatado,
      message: "Processo concluído",
      downloadPath: downloadedFile,
      whatsappSent: whatsappResult?.success || false,
      whatsappResult: whatsappResult,
      csvUpload: csvUploadResult ? {
        success: csvUploadResult.success,
        status: csvUploadResult.status || 'N/A',
        method: csvUploadResult.method || 'N/A',
        screenshot: csvUploadResult.screenshot || null
      } : null,
      screenshots: fs
        .readdirSync(DOWNLOADS_DIR)
        .filter((f) => f.includes(cnpjFormatado)),
    };

    console.log("\n" + "=".repeat(60));
    console.log("PROCESSO CONCLUÍDO");
    console.log("=".repeat(60));
    console.log(`CNPJ: ${cnpjFormatado}`);
    console.log(`PDF: ${downloadedFile || "Não baixado"}`);
    console.log(`CSV Upload: ${csvUploadResult?.status || 'N/A'}`);
    console.log(`Screenshots: ${result.screenshots.length} arquivos`);

    return result;
  } catch (error) {
    console.error(`\n❌ ERRO: ${error.message}`);

    await page
      .screenshot({
        path: path.join(DOWNLOADS_DIR, `error_${cnpjFormatado}_${timestamp}.png`),
      })
      .catch(() => {});

    return {
      success: false,
      cnpj: cnpjFormatado,
      error: error.message,
    };
  } finally {
    // Manter navegador aberto por 10 segundos para visualização
    console.log("\n⏳ Fechando navegador em 10 segundos...");
    await page.waitForTimeout(10000);
    await browser.close();
  }
}

// ============================================================================
// FUNÇÃO DE UPLOAD COM INSTRUMENTAÇÃO COMPLETA DE DEBUG
// ============================================================================
/**
 * Faz upload de CSV usando a abordagem correta do OutSystems:
 * 1. Clicar no botão "Adicionar Arquivo" que abre um popup/dialog
 * 2. O popup contém um iframe "SelecionarArquivo.aspx"
 * 3. Dentro do iframe: usar #wtArquivo (input file) e #wtIncluirArquivo (botão)
 *
 * INSTRUMENTAÇÃO COMPLETA:
 * - Captura de console (page + frame)
 * - Captura de rede (APIs de upload)
 * - Screenshots em múltiplos pontos
 * - HTML dumps para análise
 * - Detecção de sinais de sucesso/falha
 * - Relatório final detalhado
 *
 * SELETORES CONFIRMADOS NO HTML DO IFRAME:
 * - input file:  #wtArquivo
 * - botão incluir: #wtIncluirArquivo
 * - overlay wait: #overlay_wait
 * - botões de erro: #wtErroCaractereInvalido, #wtErroDeExtensao, #wtErroTerminadorLinha, #wtErroArquivo
 */
async function uploadCSVSimplificado(page, csvFilePath, cnpjFormatado) {
  const timestamp = Date.now();
  const fileName = path.basename(csvFilePath);
  const fileExt = path.extname(csvFilePath).toLowerCase();

  console.log("\n" + "=".repeat(80));
  console.log("🎯 INICIANDO UPLOAD COM INSTRUMENTAÇÃO COMPLETA");
  console.log("=".repeat(80));
  console.log(`   Arquivo: ${fileName}`);
  console.log(`   Extensão: ${fileExt}`);
  console.log(`   Caminho: ${csvFilePath}`);
  console.log(`   Timestamp: ${timestamp}`);

  // =========================================================================
  // VERIFICAÇÃO PRÉVIA DO ARQUIVO
  // =========================================================================
  console.log("\n[PRÉ-CHECK] Verificando arquivo...");

  // Verificar caracteres proibidos no nome: /[~\/:*?|"<>]/
  const invalidChars = /[~\/:*?"<>|]/;
  const hasInvalidChars = invalidChars.test(fileName);
  console.log(`   Caracteres proibidos no nome: ${hasInvalidChars ? '❌ SIM' : '✅ NÃO'}`);

  // Verificar extensão
  const validExtensions = ['.csv', '.zip'];
  const hasValidExt = validExtensions.includes(fileExt);
  console.log(`   Extensão válida (${fileExt}): ${hasValidExt ? '✅ SIM' : '❌ NÃO'}`);

  // Verificar encoding BOM (para CSV)
  let hasBOM = false;
  let encodingInfo = 'N/A';
  if (fileExt === '.csv') {
    try {
      const buffer = fs.readFileSync(csvFilePath);
      hasBOM = buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF;
      encodingInfo = hasBOM ? 'UTF-8 BOM ✅' : 'UTF-8 sem BOM ⚠️';
      console.log(`   Encoding: ${encodingInfo}`);

      // Verificar terminadores de linha (CRLF vs LF)
      const content = buffer.toString('utf-8');
      const hasCRLF = content.includes('\r\n');
      const hasLFOnly = content.includes('\n') && !hasCRLF;
      console.log(`   Terminadores: ${hasCRLF ? 'CRLF ✅' : (hasLFOnly ? 'LF apenas ⚠️' : 'N/A')}`);
    } catch (e) {
      console.log(`   Encoding: Erro ao verificar - ${e.message}`);
    }
  }

  // =========================================================================
  // SETUP DE INSTRUMENTAÇÃO (Console + Rede)
  // =========================================================================
  console.log("\n[INSTRUMENTAÇÃO] Configurando captura de logs...");

  const consoleLogs = [];
  const networkResponses = [];
  const uploadApiRequests = [];
  const uploadApiResponses = [];

  // =========================================================================
  // 1️⃣ INTERCEPTAR BEARER TOKEN DAS REQUISIÇÕES REST (RECOMENDADO)
  // =========================================================================
  let capturedBearerToken = null;

  page.on('request', request => {
    const url = request.url();
    const headers = request.headers();

    // Capturar Authorization de chamadas à API REST
    if (url.includes('/ColetaDados_API/rest/')) {
      const authHeader = headers['authorization'] || headers['Authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        capturedBearerToken = authHeader;
        console.log(`\n   ✅ [TOKEN CAPTURADO] Bearer token interceptado:`);
        console.log(`      URL: ${url.substring(0, 80)}...`);
        console.log(`      Token: ${authHeader.substring(0, 30)}...`);
      }
    }
  });

  // Capturar console da página
  page.on('console', msg => {
    const logEntry = {
      type: msg.type(),
      text: msg.text(),
      source: 'page',
      timestamp: Date.now()
    };
    consoleLogs.push(logEntry);
    // Log apenas erros e avisos
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`   [CONSOLE PAGE] ${msg.type().toUpperCase()}: ${msg.text().substring(0, 200)}`);
    }
  });

  // Capturar requisições de rede (para capturar Authorization header)
  page.on('request', async request => {
    const url = request.url();
    const method = request.method();
    const headers = request.headers();

    // Capturar APIs de upload
    if (url.includes('/uploadCsv') || url.includes('/uploadZip') || url.includes('/coletadados/upload')) {
      const authorization = headers['authorization'] || headers['Authorization'] || null;

      console.log(`   [NETWORK REQUEST] ${method} ${url.substring(0, 100)}...`);
      if (authorization) {
        console.log(`   [NETWORK REQUEST] Authorization: ${authorization.substring(0, 50)}...`);

        // Extrair SID do Authorization header
        const sidMatch = authorization.match(/Bearer\s+(.+)/);
        if (sidMatch && sidMatch[1]) {
          const capturedSid = sidMatch[1];
          console.log(`   [NETWORK REQUEST] SID CAPTURADO: ${capturedSid.substring(0, 30)}...`);

          // Salvar SID no debugInfo
          debugInfo.capturedSid = capturedSid;
          debugInfo.capturedAuthorization = authorization;
        }
      } else {
        console.log(`   [NETWORK REQUEST] ⚠️ Sem Authorization header!`);
      }

      const requestInfo = {
        url: url,
        method: method,
        headers: headers,
        timestamp: Date.now()
      };
      uploadApiRequests.push(requestInfo);
    }
  });

  // Capturar respostas de rede
  page.on('response', async response => {
    const url = response.url();
    const status = response.status();

    // Capturar APIs de upload
    if (url.includes('/uploadCsv') || url.includes('/uploadZip') || url.includes('/coletadados/upload')) {
      let body = null;
      try {
        body = await response.text();
        body = body.substring(0, 1000); // Limitar a 1000 caracteres
      } catch (e) {
        body = 'Unable to capture body';
      }

      const responseInfo = {
        url: url,
        status: status,
        headers: response.headers(),
        body: body,
        timestamp: Date.now()
      };
      uploadApiResponses.push(responseInfo);
      networkResponses.push(responseInfo);

      console.log(`   [NETWORK RESPONSE] Status: ${status}`);
      if (body) {
        console.log(`   [NETWORK RESPONSE] Body: ${body.substring(0, 100)}...`);
      }
    }
  });

  // =========================================================================
  // VARIÁVEIS PARA RELATÓRIO FINAL
  // =========================================================================
  const debugInfo = {
    fileName,
    fileExt,
    hasInvalidChars,
    hasValidExt,
    encodingInfo,
    endpointCalled: null,
    uploadHttpStatus: null,
    uploadResponseBody: null,
    visualSignals: [],
    errorButtons: [],
    screenshots: [],
    htmlDumps: [],
    consoleLogCount: 0,
    networkLogCount: 0,
    uploadApiRequests: [],
    uploadApiResponses: [],
    capturedSid: null,
    capturedAuthorization: null
  };

  // Declare targetFrame outside try block so it's available in catch block
  let targetFrame = null;

  try {
    // =========================================================================
    // PASSO 1: Clicar no botão "Adicionar Arquivo" para abrir o popup
    // =========================================================================
    console.log("\n[1/8] Procurando e clicando no botão 'Adicionar Arquivo'...");

    let btnClicked = false;
    let buttonId = null;

    // Estratégia 1: Procurar input com valor "Adicionar Arquivo"
    const addBtns = await page.$$('input[value*="Adicionar Arquivo"], input[value*="AdicionarArquivo"]');
    console.log(`      Encontrados ${addBtns.length} botões 'Adicionar Arquivo'`);

    for (let i = 0; i < addBtns.length; i++) {
      try {
        const isVisible = await addBtns[i].isVisible();
        if (isVisible) {
          buttonId = await addBtns[i].getAttribute('id');
          console.log(`      Clicando no botão ${i} (ID: ${buttonId})...`);
          await addBtns[i].click();
          btnClicked = true;
          break;
        }
      } catch (e) {
        // Continua tentando
      }
    }

    // Estratégia 2: Usar JavaScript
    if (!btnClicked) {
      console.log("      Tentando estratégia alternativa via JavaScript...");
      const jsResult = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('input'))
          .filter(el => {
            const value = (el.value || el.getAttribute('value') || '').toLowerCase();
            const id = (el.id || '').toLowerCase();
            return value.includes('adicionar arquivo') || id.includes('adicionararquivo');
          });

        if (buttons.length > 0) {
          for (const btn of buttons) {
            try {
              const rect = btn.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                btn.click();
                return { clicked: true, id: btn.id };
              }
            } catch (e) {
              // Continua
            }
          }
        }
        return { clicked: false, found: buttons.length };
      });

      if (jsResult.clicked) {
        console.log(`      ✓ Clicado via JS (ID: ${jsResult.id})`);
        buttonId = jsResult.id;
        btnClicked = true;
      }
    }

    if (!btnClicked) {
      throw new Error('Botão Adicionar Arquivo não encontrado');
    }

    debugInfo.buttonId = buttonId;

    // =========================================================================
    // PASSO 2: Aguardar o popup/dialog aparecer + SCREENSHOT 1
    // =========================================================================
    console.log("\n[2/8] Aguardando popup 'Adicionar Arquivo' aparecer...");

    try {
      await page.waitForSelector('div[role="dialog"], .os-internal-ui-dialog, .ui-dialog', {
        timeout: 15000
      });
      console.log("      ✓ Popup/dialog detectado");
      debugInfo.visualSignals.push('popup_detected');
    } catch (e) {
      console.log("      ⚠ Popup/dialog não detectado");
    }

    await page.waitForTimeout(2000);

    // SCREENSHOT 1: Popup aberto (antes do iframe carregar)
    const screenshot1 = path.join(DOWNLOADS_DIR, `upload_1_popup_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshot1, fullPage: true });
    debugInfo.screenshots.push(screenshot1);
    console.log(`      📸 Screenshot 1: ${screenshot1}`);

    // =========================================================================
    // FUNÇÃO PARA OBTER O FRAME SEMPRE ATUALIZADO
    // =========================================================================
    async function getUploadFrame(page) {
      await page.waitForSelector('iframe[src*="SelecionarArquivo.aspx"]', {
        timeout: 15000
      });

      const iframeElement = await page.$('iframe[src*="SelecionarArquivo.aspx"]');

      const frame = await iframeElement.contentFrame();

      if (!frame) {
        throw new Error("Não foi possível obter o iframe de upload");
      }

      return frame;
    }

    // =========================================================================
    // FUNÇÃO PARA EVALUATE COM RETRY AUTOMÁTICO (UPLOAD COMPLETO)
    // =========================================================================
    async function evaluateWithRetry(page, bearerToken) {
      for (let i = 0; i < 3; i++) {
        try {
          const frame = await getUploadFrame(page);

          return await frame.evaluate(async (bearerToken) => {
            // Verificar se a variável global 'file' existe
            if (typeof window.file === 'undefined' || window.file === null) {
              return { success: false, error: 'Variável file não definida' };
            }

            console.log('[UPLOAD] Iniciando upload via AJAX com retry...');
            console.log('[UPLOAD] Arquivo:', window.file.name, 'Tamanho:', window.file.size);
            console.log('[UPLOAD] Bearer Token fornecido:', bearerToken ? bearerToken.substring(0, 20) + '...' : 'NENHUM');

            // Validar token Bearer fornecido
            if (!bearerToken) {
              return { success: false, error: 'Token Bearer não fornecido - aguarde a página carregar completamente' };
            }

            // =========================================================================
            // 3️⃣ EXTRAIR UID ATUALIZADO (pode ter mudado após refresh)
            // =========================================================================
            let currentUid = null;
            if (typeof window.csvUploader !== 'undefined' && window.csvUploader.uid) {
              currentUid = window.csvUploader.uid;
              console.log('[UPLOAD] UID obtido de csvUploader.uid:', currentUid);
            }

            // Fallback: Tentar dos scripts na página
            if (!currentUid) {
              const scripts = Array.from(document.querySelectorAll('script'));
              for (const script of scripts) {
                const text = script.textContent || '';
                const match = text.match(/csvUploader\.uid\s*=\s*['"]([^'"]+)['"]/);
                if (match) {
                  currentUid = match[1];
                  console.log('[UPLOAD] UID obtido dos scripts:', currentUid);
                  break;
                }
              }
            }

            if (!currentUid) {
              return { success: false, error: 'UID não encontrado' };
            }

            // =========================================================================
            // Parâmetros do upload (extraídos da URL)
            // =========================================================================
            const urlParams = new URLSearchParams(window.location.search);
            const leiauteId = urlParams.get('LeiauteId') || urlParams.get('leiauteId') || '1';
            const agendaReferenciaId = urlParams.get('AgendaReferenciaId') || urlParams.get('agendaReferenciaId');
            const uploadUrl = '/ColetaDados_API/rest/coletadados/uploadCsv';

            console.log('[UPLOAD] Parâmetros extraídos da URL:', {
              uid: currentUid,
              leiauteId,
              agendaReferenciaId,
              url: window.location.href
            });

            if (!agendaReferenciaId) {
              return { success: false, error: 'AgendaReferenciaId não encontrado na URL' };
            }

            // =========================================================================
            // Ler o arquivo e preparar para upload
            // =========================================================================
            const fileBuffer = await window.file.arrayBuffer();
            const bytes = new Uint8Array(fileBuffer);
            console.log('[UPLOAD] Arquivo lido, tamanho:', bytes.length, 'bytes');

            // Verificar BOM UTF-8
            let isUTF8BOM = false;
            let header = '';
            if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
              isUTF8BOM = true;
              const decoder = new TextDecoder();
              header = decoder.decode(bytes.slice(0, Math.min(1000, bytes.length)));
              console.log('[UPLOAD] Arquivo tem BOM UTF-8 ✓');
            } else {
              console.log('[UPLOAD] Arquivo NÃO tem BOM UTF-8');
              return { success: false, error: 'Arquivo não possui codificação UTF-8 BOM' };
            }

            // Extrair primeira e segunda linha do cabeçalho
            const headerLines = header.split('\r\n');
            const firstLine = headerLines[0] || '';
            const secondLine = headerLines[1] || '';

            // =========================================================================
            // 4️⃣ & 5️⃣ Calcular número de partes com RAND e TIMESTAMP atualizados
            // =========================================================================
            const pieceSize = 10857600;
            const numeroPartes = Math.ceil(bytes.length / pieceSize);
            const timestamp = Date.now(); // 5️⃣ Timestamp atual
            const rand = Math.floor(Math.random() * 1000000000); // 4️⃣ Rand aleatório

            console.log('[UPLOAD] Número de partes:', numeroPartes);
            console.log('[UPLOAD] Timestamp:', timestamp);
            console.log('[UPLOAD] Rand:', rand);

            // Função para codificar em Base64
            function base64Encode(str) {
              return btoa(unescape(encodeURIComponent(str)));
            }

            // Função para enviar uma parte
            function enviarParte(partIndex, partData) {
              return new Promise((resolve, reject) => {
                const params = {
                  'Hash': '',
                  'Content': partData,
                  'FileName': window.file.name,
                  'FileNumber': partIndex + 1,
                  'Of': numeroPartes,
                  'Size': window.file.size,
                  'Timestamp': timestamp,
                  'LeiauteId': leiauteId,
                  'AgendaReferenciaId': agendaReferenciaId,
                  'ValidFormat': 'UTF-8',
                  'UID': currentUid, // 3️⃣ UID atualizado
                  'Header': base64Encode(firstLine),
                  'FirstLine': base64Encode(secondLine),
                  'Rand': rand // 4️⃣ Rand aleatório
                };

                console.log('[UPLOAD] Enviando parte', partIndex + 1, 'de', numeroPartes);
                console.log('[UPLOAD] Content está em BASE64? SIM');
                console.log('[UPLOAD] Content length (chars):', partData.length);
                console.log('[UPLOAD] UID (atualizado):', currentUid);
                console.log('[UPLOAD] LeiauteId:', leiauteId);
                console.log('[UPLOAD] AgendaReferenciaId:', agendaReferenciaId);
                console.log('[UPLOAD] Header (base64):', params.Header.substring(0, 20) + '...');
                console.log('[UPLOAD] FirstLine (base64):', params.FirstLine.substring(0, 20) + '...');
                console.log('[UPLOAD] FileNumber:', params.FileNumber, 'Of:', params.Of);
                console.log('[UPLOAD] URL:', uploadUrl);
                console.log('[UPLOAD] Authorization:', bearerToken.substring(0, 30) + '...');
                console.log('[UPLOAD] Authorization: Bearer', authToken.substring(0, 20) + '...');

                jQuery.ajax({
                  url: uploadUrl,
                  type: 'POST',
                  data: JSON.stringify(params),
                  dataType: 'json',
                  contentType: 'application/json; charset=UTF-8',
                  headers: {
                    // 1️⃣ Authorization Bearer CAPTURADO do navegador
                    'Authorization': bearerToken,
                    'X-Requested-With': 'XMLHttpRequest',
                    // 6️⃣ Accept header
                    'Accept': 'application/json, text/javascript, */*; q=0.01'
                    // REMOVIDOS: Origin, Referer, sec-fetch-* (blocados pelo navegador)
                  },
                  xhrFields: {
                    withCredentials: true // 2️⃣ Envia cookies (SID, ASP.NET_SessionId)
                  },
                  processData: false,
                  success: function(data) {
                    if (data.Success === false) {
                      reject(new Error(data.Msg || 'Erro no servidor'));
                    } else {
                      resolve(data);
                    }
                  },
                  error: function(xhr, status, error) {
                    reject(new Error(xhr.responseText || error || 'Erro de rede'));
                  }
                });
              });
            }

            // Enviar todas as partes
            try {
              for (let i = 0; i < numeroPartes; i++) {
                const start = i * pieceSize;
                const end = Math.min(start + pieceSize, bytes.length);
                const partData = bytes.slice(start, end);

                // Converter para BASE64
                const binaryString = Array.from(partData, byte => String.fromCharCode(byte)).join('');
                const partBase64 = btoa(binaryString);

                await enviarParte(i, partBase64);
                console.log('[UPLOAD] Parte', i + 1, 'enviada com sucesso');
              }

              console.log('[UPLOAD] Todas as partes enviadas com sucesso!');
              return { success: true, method: 'direct_ajax_upload', partesEnviadas: numeroPartes };
            } catch (error) {
              console.log('[UPLOAD] Erro:', error.message);
              return { success: false, error: error.message };
            }
          });

        } catch (err) {
          if (err.message.includes("context") || err.message.includes("closed") || err.message.includes("destroyed") || err.message.includes("Target page")) {
            console.log(`⚠ Frame recarregou (OutSystems refresh), tentando novamente (${i + 1}/3)...`);
            await page.waitForTimeout(1500);
          } else {
            throw err;
          }
        }
      }

      throw new Error("Falha após 3 tentativas de upload");
    }

    // =========================================================================
    // PASSO 3.2: Obter frame e capturar informações iniciais
    // =========================================================================
    console.log("\n[3.2/8] Obtendo referência do iframe e capturando informações...");

    targetFrame = await getUploadFrame(page);

    const iframeUrl = targetFrame.url();
    console.log(`      URL do iframe: ${iframeUrl.substring(0, 100)}...`);
    debugInfo.iframeUrl = iframeUrl;

    // Capturar console do iframe (se possível)
    try {
      targetFrame.on('console', msg => {
        const logEntry = {
          type: msg.type(),
          text: msg.text(),
          source: 'iframe',
          timestamp: Date.now()
        };
        consoleLogs.push(logEntry);
        if (msg.type() === 'error' || msg.type() === 'warning') {
          console.log(`   [CONSOLE FRAME] ${msg.type().toUpperCase()}: ${msg.text().substring(0, 200)}`);
        }
      });
    } catch (e) {
      console.log("      ⚠ Não foi possível capturar console do iframe");
    }

    // Aguardar o iframe estar pronto
    await page.waitForTimeout(2000);

    // SCREENSHOT 2: Iframe carregado + HTML dump
    const screenshot2 = path.join(DOWNLOADS_DIR, `upload_2_iframe_loaded_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshot2, fullPage: true });
    debugInfo.screenshots.push(screenshot2);
    console.log(`      📸 Screenshot 2: ${screenshot2}`);

    // HTML dump do iframe ANTES do upload
    try {
      const iframeHtmlBefore = await targetFrame.content();
      const htmlDump1Path = path.join(DOWNLOADS_DIR, `upload_html_antes_${timestamp}_${cnpjFormatado}.html`);
      fs.writeFileSync(htmlDump1Path, iframeHtmlBefore, 'utf8');
      debugInfo.htmlDumps.push(htmlDump1Path);
      console.log(`      📄 HTML dump (antes): ${htmlDump1Path}`);
    } catch (e) {
      console.log(`      ⚠ Não foi possível capturar HTML do iframe: ${e.message}`);
    }

    // =========================================================================
    // PASSO 3.5: Injetar scripts necessários (csvUploader, Base64)
    // =========================================================================
    console.log("\n[3.5/8] Injetando scripts necessários no iframe...");

    try {
      // Ler os scripts do disco
      const base64Script = fs.readFileSync(path.join(__dirname, 'WB_Base64.js'), 'utf8');
      const uploaderScript = fs.readFileSync(path.join(__dirname, 'WB_EnvioArquivoJS.js'), 'utf8');

      // Injetar os scripts no contexto do iframe
      await targetFrame.evaluate((base64Code) => {
        // Criar elemento script e injetar Base64
        const base64Script = document.createElement('script');
        base64Script.textContent = base64Code;
        document.head.appendChild(base64Script);
        console.log('[INJEÇÃO] Base64 injetado com sucesso');
      }, base64Script);

      await targetFrame.evaluate((uploaderCode) => {
        // Criar elemento script e injetar csvUploader
        const uploaderScriptEl = document.createElement('script');
        uploaderScriptEl.textContent = uploaderCode;
        document.head.appendChild(uploaderScriptEl);
        console.log('[INJEÇÃO] csvUploader injetado com sucesso');
      }, uploaderScript);

      console.log("      ✓ Scripts injetados com sucesso");
      debugInfo.visualSignals.push('scripts_injected');
    } catch (e) {
      console.log(`      ⚠ Erro ao injetar scripts: ${e.message}`);
    }

    // =========================================================================
    // PASSO 4: Selecionar arquivo no input file (#wtArquivo) + SCREENSHOT 3
    // =========================================================================
    console.log("\n[4/8] Selecionando arquivo no input #wtArquivo...");

    // =========================================================================
    // FLUXO CORRIGIDO: Reobter frame após recarregamento do OutSystems
    // =========================================================================

    // 1. Pegar o frame inicial
    let frame = await getUploadFrame(page);

    // 2. Esperar input aparecer
    await frame.waitForSelector('#wtArquivo', { timeout: 10000 });
    console.log("      ✓ Input #wtArquivo encontrado");
    debugInfo.visualSignals.push('wtArquivo_found');

    // 3. Selecionar o arquivo
    await frame.setInputFiles('#wtArquivo', csvFilePath);
    console.log(`      ✓ Arquivo selecionado: ${csvFilePath}`);
    debugInfo.visualSignals.push('file_selected');

    // 4. Aguardar o recarregamento do frame pelo OutSystems
    console.log("\n      [AGUARDANDO] OutSystems recarregar o iframe...");
    await page.waitForTimeout(1500);

    console.log("\n      [REOBTENDO] Frame atualizado após recarregamento...");
    frame = await getUploadFrame(page);

    // 5. Garantir que o DOM carregou
    await frame.waitForSelector('#wtArquivo', { timeout: 10000 });
    console.log("      ✓ Frame atualizado e DOM pronto");

    // 6. Definir variável global 'file' que o JavaScript espera
    console.log("\n      Definindo variável global 'file'...");
    await frame.evaluate((filePath) => {
      // Criar um objeto File simulado
      const fileName = filePath.split('/').pop();
      window.file = {
        name: fileName,
        path: filePath,
        size: 1000, // tamanho simulado
        type: 'text/csv'
      };
    }, csvFilePath);
    console.log("      ✓ Variável global 'file' definida");
    debugInfo.visualSignals.push('global_file_defined');

    // 7. Disparar evento 'change' para ativar o csvUploader
    console.log("\n      Disparando evento 'change' no #wtArquivo...");
    try {
      await frame.evaluate(() => {
        const input = document.querySelector('#wtArquivo');
        const event = new Event('change', { bubbles: true });
        input.dispatchEvent(event);
      });

      console.log("      ✓ Evento 'change' disparado");
      debugInfo.visualSignals.push('change_event_triggered');

      // Aguardar para o JavaScript processar o evento e criar csvUploader
      await page.waitForTimeout(1000);

      // 8. Extrair SID do csvUploader após o evento change
      console.log("\n      Extraindo SID do csvUploader...");
      const csvUploaderInfo = await frame.evaluate(() => {
        const info = {
          sid: null,
          uid: null,
          leiauteId: null,
          agendaReferenciaId: null,
          csvUploaderExists: false,
          getSIDExists: false
        };

        // Check no contexto do iframe
        if (typeof window.csvUploader !== 'undefined') {
          info.csvUploaderExists = true;
          info.sid = window.csvUploader.sid;
          info.uid = window.csvUploader.uid;
          info.leiauteId = window.csvUploader.leiauteId;
          info.agendaReferenciaId = window.csvUploader.agendaReferenciaId;
        }

        // Check if getSID function exists no iframe
        if (typeof window.getSID === 'function') {
          info.getSIDExists = true;
          try {
            const sid = window.getSID();
            if (sid && !info.sid) {
              info.sid = sid;
            }
          } catch (e) {
            // getSID might require parameters or context
          }
        }

        return info;
      });

      console.log(`      📊 csvUploader info:`, csvUploaderInfo);
      if (csvUploaderInfo.sid) {
        console.log(`      ✅ SID CAPTURADO: ${csvUploaderInfo.sid.substring(0, 30)}...`);
        debugInfo.extractedSid = csvUploaderInfo.sid;
      } else {
        console.log(`      ⚠️ SID não encontrado no csvUploader`);
        console.log(`         csvUploaderExists: ${csvUploaderInfo.csvUploaderExists}`);
        console.log(`         getSIDExists: ${csvUploaderInfo.getSIDExists}`);

        // Se csvUploader existe mas não tem SID, tentar obter via getSID e injetar
        if (csvUploaderInfo.csvUploaderExists) {
          console.log("\n      Tentando obter SID via getSID() e injetar no csvUploader...");
          await frame.evaluate(() => {
            if (typeof window.getSID === 'function' && typeof window.csvUploader !== 'undefined') {
              try {
                const sid = window.getSID();
                if (sid) {
                  window.csvUploader.sid = sid;
                  console.log("[INJEÇÃO] SID injetado no csvUploader: " + sid.substring(0, 20) + "...");
                }
              } catch (e) {
                console.log("[INJEÇÃO] Erro ao obter SID: " + e.message);
              }
            }
          });
        }
      }
      debugInfo.csvUploaderInfo = csvUploaderInfo;

    } catch (evalError) {
      console.log(`      ⚠ Erro ao processar csvUploader: ${evalError.message}`);
    }

    // ⚠️ OutSystems faz refresh do frame aqui
    // Aguardar e reobter o frame atualizado
    console.log("\n      [AGUARDANDO] OutSystems recarregar o iframe...");
    await page.waitForTimeout(1500);

    console.log("\n      [REOBTENDO] Frame atualizado após recarregamento...");
    frame = await getUploadFrame(page);

    // 5. Garantir que o DOM carregou
    await frame.waitForSelector('#wtArquivo', { timeout: 10000 });
    console.log("      ✓ Frame atualizado e DOM pronto");

    // =========================================================================
    // IMPORTANTE: Garantir que a variável global 'file' está definida
    // =========================================================================
    console.log("\n      Garantindo variável global 'file' está definida...");

    const fileCheckResult = await frame.evaluate((csvFileName) => {
      const input = document.querySelector('#wtArquivo');
      if (!input || !input.files || input.files.length === 0) {
        return { success: false, error: 'Nenhum arquivo no input' };
      }

      const selectedFile = input.files[0];
      console.log('[JS] Arquivo no input.files:', selectedFile.name);

      // DEFINIR a variável global 'file'
      window.file = selectedFile;
      console.log('[JS] Variável global window.file DEFINIDA:', window.file.name);

      // Disparar evento change
      const changeEvent = new Event('change', { bubbles: true });
      input.dispatchEvent(changeEvent);
      console.log('[JS] Evento change disparado');

      return {
        success: true,
        fileName: selectedFile.name,
        fileSize: selectedFile.size
      };
    }, path.basename(csvFilePath));

    if (!fileCheckResult.success) {
      throw new Error(fileCheckResult.error);
    }

    console.log(`      ✓ Variável global 'file' definida: ${fileCheckResult.fileName}`);
    debugInfo.visualSignals.push('global_file_defined');

    await page.waitForTimeout(1000);

    await page.waitForTimeout(2000);

    // SCREENSHOT 3: Após setInputFiles
    const screenshot3 = path.join(DOWNLOADS_DIR, `upload_3_after_select_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshot3, fullPage: true });
    debugInfo.screenshots.push(screenshot3);
    console.log(`      📸 Screenshot 3: ${screenshot3}`);

    // =========================================================================
    // PASSO 5: Clicar no botão Incluir Arquivo (#wtIncluirArquivo) + SCREENSHOT 4
    // =========================================================================
    console.log("\n[5/8] Clicando no botão #wtIncluirArquivo...");

    try {
      await frame.waitForSelector('#wtIncluirArquivo', {
        timeout: 5000,
        state: 'visible'
      });
      console.log("      ✓ Botão #wtIncluirArquivo encontrado");
      debugInfo.visualSignals.push('wtIncluirArquivo_found');
    } catch (e) {
      console.log("      ⚠ Botão #wtIncluirArquivo não está visível");
    }

    // SCREENSHOT 4: Antes de clicar
    const screenshot4 = path.join(DOWNLOADS_DIR, `upload_4_before_click_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshot4, fullPage: true });
    debugInfo.screenshots.push(screenshot4);
    console.log(`      📸 Screenshot 4: ${screenshot4}`);

    // =========================================================================
    // EXTRAIR SID/TOKEN DO OUTSYSTEMS
    // =========================================================================
    console.log("\n      [TOKEN] Extraindo SID/token do OutSystems...");

    try {
      const tokenData = await frame.evaluate(() => {
        const tokens = {
          localStorage: {},
          sessionStorage: {},
          windowVars: {},
          allSessionStorageKeys: []
        };

        // Extrair localStorage
        try {
          if (typeof localStorage !== 'undefined') {
            for (let i = 0; i < localStorage.length; i++) {
              const key = localStorage.key(i);
              tokens.localStorage[key] = localStorage.getItem(key);
            }
          }
        } catch (e) {
          tokens.localStorageError = e.message;
        }

        // Extrair sessionStorage COMPLETO
        try {
          if (typeof sessionStorage !== 'undefined') {
            for (let i = 0; i < sessionStorage.length; i++) {
              const key = sessionStorage.key(i);
              const value = sessionStorage.getItem(key);
              tokens.sessionStorage[key] = value;
              tokens.allSessionStorageKeys.push(key);
            }
          }
        } catch (e) {
          tokens.sessionStorageError = e.message;
        }

        // Verificar variáveis globais específicas do OutSystems
        try {
          if (typeof window.$public !== 'undefined') {
            tokens.windowVars.$public = Object.keys(window.$public);
          }
          if (typeof window.$public !== 'undefined' && window.$public.SecurityToken) {
            tokens.windowVars.$public_SecurityToken = window.$public.SecurityToken;
          }
          if (typeof window.OSRuntime !== 'undefined') {
            tokens.windowVars.OSRuntime_exists = true;
            if (window.OSRuntime && window.OSRuntime.CSSToken) {
              tokens.windowVars.OSRuntime_CSSToken = window.OSRuntime.CSSToken;
            }
          }
          if (typeof window.csvUploader !== 'undefined') {
            tokens.windowVars.csvUploader_exists = true;
            tokens.windowVars.csvUploader_sid = window.csvUploader.sid;
            tokens.windowVars.csvUploader_props = Object.keys(window.csvUploader || {});
          }
        } catch (e) {
          tokens.windowVarsError = e.message;
        }

        return tokens;
      });

      // Procurar por tokens comuns
      const possibleKeys = ['accessToken', 'authToken', 'sid', 'jwt', 'SecurityToken', 'OSVSTATE'];

      console.log("      🔍 Tokens encontrados:");
      console.log(`         localStorage: ${Object.keys(tokenData.localStorage).length} itens`);
      console.log(`         sessionStorage: ${Object.keys(tokenData.sessionStorage).length} itens`);
      console.log(`         window vars: ${Object.keys(tokenData.windowVars).length} itens`);

      // Mostrar TODAS as chaves do sessionStorage (não filtrar)
      if (tokenData.allSessionStorageKeys && tokenData.allSessionStorageKeys.length > 0) {
        console.log(`      📋 TODAS as chaves do sessionStorage:`);
        for (const key of tokenData.allSessionStorageKeys) {
          const value = tokenData.sessionStorage[key];
          console.log(`         sessionStorage.${key} = ${value ? value.substring(0, 100) : 'null'}...`);
        }
      }

      // Mostrar chaves do window.csvUploader
      if (tokenData.windowVars.csvUploader_exists) {
        console.log(`      ✅ csvUploader existe!`);
        console.log(`         sid: ${tokenData.windowVars.csvUploader_sid}`);
        console.log(`         props: ${tokenData.windowVars.csvUploader_props.join(', ')}`);
      }

      // Tentar encontrar o SID específico
      let sid = null;
      if (tokenData.windowVars.csvUploader_sid) {
        sid = tokenData.windowVars.csvUploader_sid;
        console.log(`      ✅ SID encontrado (csvUploader.sid): ${sid}`);
      }

      debugInfo.extractedTokens = tokenData;
      debugInfo.sid = sid;

    } catch (tokenError) {
      console.log(`      ⚠ Erro ao extrair tokens: ${tokenError.message}`);
    }

    // =========================================================================
    // CLICAR NO BOTÃO INCLUIR ARQUIVO
    // =========================================================================
    console.log("\n[5/8] Clicando no botão #wtIncluirArquivo...");

    try {
      // Clicar no botão de inclusão
      await frame.click('#wtIncluirArquivo');
      console.log("      ✓ Clicado no botão #wtIncluirArquivo");
      debugInfo.visualSignals.push('wtIncluirArquivo_clicked');
    } catch (clickError) {
      console.log(`      ⚠ Erro ao clicar no botão: ${clickError.message}`);
      // Tentar via JavaScript se o clique normal falhar
      try {
        await frame.evaluate(() => {
          const button = document.querySelector('#wtIncluirArquivo');
          if (button) button.click();
        });
        console.log("      ✓ Clicado via JavaScript");
        debugInfo.visualSignals.push('wtIncluirArquivo_clicked_js');
      } catch (jsError) {
        console.log(`      ✗ Erro também no clique via JavaScript: ${jsError.message}`);
      }
    }

    // =========================================================================
    // PASSO 6: Verificar status após upload
    // =========================================================================
    console.log("\n[6/8] Aguardando processamento (detectando sinais)...");

    let processingDetected = false;
    let signalDetected = null;

    // Aguardar até 15 segundos por qualquer sinal de processamento
    try {
      await Promise.race([
        // Sinal 1: Overlay de wait
        frame.waitForSelector('#overlay_wait', { timeout: 15000, state: 'visible' })
          .then(() => {
            console.log("      ✓ Sinal: #overlay_wait visível");
            signalDetected = 'overlay_wait_visible';
            debugInfo.visualSignals.push('overlay_wait_visible');
          }),

        // Sinal 2: Input escondido
        frame.waitForSelector('#wtArquivo', { timeout: 15000, state: 'hidden' })
          .then(() => {
            console.log("      ✓ Sinal: #wtArquivo escondido");
            signalDetected = 'wtArquivo_hidden';
            debugInfo.visualSignals.push('wtArquivo_hidden');
          }),

        // Sinal 3: Network idle (com timeout maior)
        page.waitForLoadState('networkidle', { timeout: 15000 })
          .then(() => {
            console.log("      ✓ Sinal: Network idle");
            signalDetected = 'network_idle';
            debugInfo.visualSignals.push('network_idle');
          }),

        // Timeout geral
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Timeout detection')), 16000)
        ),
      ]);
      processingDetected = true;
    } catch (e) {
      console.log(`      ⚠ Timeout esperando sinais: ${e.message}`);
    }

    // Aguardar tempo adicional para processamento
    await page.waitForTimeout(5000);

    // SCREENSHOT 5: Após clique + processamento
    const screenshot5 = path.join(DOWNLOADS_DIR, `upload_5_after_click_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshot5, fullPage: true });
    debugInfo.screenshots.push(screenshot5);
    console.log(`      📸 Screenshot 5: ${screenshot5}`);

    // =========================================================================
    // PASSO 7: HTML dump APÓS upload
    // =========================================================================
    console.log("\n[7/8] Capturando HTML pós-upload...");

    try {
      const iframeHtmlAfter = await frame.content();
      const htmlDump2Path = path.join(DOWNLOADS_DIR, `upload_html_depois_${timestamp}_${cnpjFormatado}.html`);
      fs.writeFileSync(htmlDump2Path, iframeHtmlAfter, 'utf8');
      debugInfo.htmlDumps.push(htmlDump2Path);
      console.log(`      📄 HTML dump (depois): ${htmlDump2Path}`);
    } catch (e) {
      console.log(`      ⚠ Não foi possível capturar HTML pós-upload: ${e.message}`);
    }

    // =========================================================================
    // PASSO 8: DETECÇÃO DE BOTÕES DE ERRO
    // =========================================================================
    console.log("\n[8/8] Detectando botões de erro no iframe...");

    const errorSelectors = {
      'wtErroCaractereInvalido': 'Caractere inválido no nome do arquivo',
      'wtErroDeExtensao': 'Extensão inválida (deve ser CSV ou ZIP)',
      'wtErroTerminadorLinha': 'Terminador de linha inválido (deve ser CRLF)',
      'wtErroArquivo': 'Erro genérico de processamento/validação'
    };

    for (const [selector, description] of Object.entries(errorSelectors)) {
      try {
        const element = await frame.$(`#${selector}`);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            console.log(`      ❌ Botão de erro detectado: #${selector}`);
            console.log(`         Descrição: ${description}`);
            debugInfo.errorButtons.push({ selector, description });
          }
        }
      } catch (e) {
        // Continua
      }
    }

    if (debugInfo.errorButtons.length === 0) {
      console.log("      ✅ Nenhum botão de erro detectado");
    }

    // SCREENSHOT FINAL
    const screenshotFinal = path.join(DOWNLOADS_DIR, `upload_final_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: screenshotFinal, fullPage: true });
    debugInfo.screenshots.push(screenshotFinal);
    console.log(`      📸 Screenshot final: ${screenshotFinal}`);

    // =========================================================================
    // RELATÓRIO FINAL
    // =========================================================================
    console.log("\n" + "=".repeat(80));
    console.log("📊 RELATÓRIO FINAL DO UPLOAD");
    console.log("=".repeat(80));

    // Arquivo
    console.log(`\n📁 ARQUIVO:`);
    console.log(`   Nome: ${debugInfo.fileName}`);
    console.log(`   Extensão: ${debugInfo.fileExt}`);
    console.log(`   Caracteres proibidos: ${debugInfo.hasInvalidChars ? '❌ SIM' : '✅ NÃO'}`);
    console.log(`   Encoding: ${debugInfo.encodingInfo}`);

    // API
    console.log(`\n🌐 API DE UPLOAD:`);
    if (uploadApiResponses.length > 0) {
      const uploadResp = uploadApiResponses[uploadApiResponses.length - 1];
      debugInfo.endpointCalled = uploadResp.url.includes('uploadCsv') ? 'uploadCsv' : 'uploadZip';
      debugInfo.uploadHttpStatus = uploadResp.status;
      debugInfo.uploadResponseBody = uploadResp.body;

      console.log(`   Endpoint: ${debugInfo.endpointCalled}`);
      console.log(`   Status HTTP: ${uploadResp.status}`);
      console.log(`   Body: ${uploadResp.body.substring(0, 200)}...`);
    } else {
      console.log(`   ⚠ Nenhuma resposta de API capturada`);
      debugInfo.endpointCalled = 'N/A';
      debugInfo.uploadHttpStatus = 'N/A';
    }

    // Sinais visuais
    console.log(`\n👁️  SINAIS VISUAIS DETECTADOS:`);
    debugInfo.visualSignals.forEach(signal => {
      console.log(`   • ${signal}`);
    });
    if (signalDetected) {
      console.log(`   ✅ Sinal primário: ${signalDetected}`);
    }

    // Botões de erro
    console.log(`\n❌ BOTÕES DE ERRO:`);
    if (debugInfo.errorButtons.length > 0) {
      debugInfo.errorButtons.forEach(err => {
        console.log(`   • #${err.selector}: ${err.description}`);
      });
    } else {
      console.log(`   ✅ Nenhum botão de erro detectado`);
    }

    // Evidências
    console.log(`\n📸 EVIDÊNCIAS GERADAS:`);
    console.log(`   Screenshots (${debugInfo.screenshots.length}):`);
    debugInfo.screenshots.forEach(s => {
      console.log(`   • ${s}`);
    });
    console.log(`   HTML dumps (${debugInfo.htmlDumps.length}):`);
    debugInfo.htmlDumps.forEach(h => {
      console.log(`   • ${h}`);
    });

    // Logs
    debugInfo.consoleLogCount = consoleLogs.filter(l => l.type === 'error' || l.type === 'warning').length;
    debugInfo.networkLogCount = networkResponses.length;
    console.log(`\n📝 LOGS CAPTURADOS:`);
    console.log(`   Console (erros/avisos): ${debugInfo.consoleLogCount}`);
    console.log(`   Network (upload APIs): ${debugInfo.networkLogCount}`);

    // =========================================================================
    // DETERMINAÇÃO DO STATUS FINAL
    // =========================================================================
    console.log(`\n${"=".repeat(80)}`);
    let uploadStatus = 'desconhecido';
    let successStatus = false;

    // Verificar botões de erro
    if (debugInfo.errorButtons.length > 0) {
      uploadStatus = 'Erro detectado - ' + debugInfo.errorButtons[0].description;
      successStatus = false;
      console.log(`\n❌ STATUS: ${uploadStatus}`);
    }
    // Verificar API de upload com erro
    else if (uploadApiResponses.length > 0 && uploadApiResponses[uploadApiResponses.length - 1].status >= 400) {
      uploadStatus = 'Erro HTTP ' + uploadApiResponses[uploadApiResponses.length - 1].status;
      successStatus = false;
      console.log(`\n❌ STATUS: ${uploadStatus}`);
    }
    // Verificar sinais visuais de sucesso
    else if (signalDetected || debugInfo.visualSignals.includes('wtArquivo_hidden') || debugInfo.visualSignals.includes('overlay_wait_visible')) {
      // Verificar conteúdo da página final
      const finalContent = await page.textContent('body');
      if (finalContent.includes('Aguardando processamento') || finalContent.includes('Aguardando Processamento')) {
        uploadStatus = 'Aguardando processamento';
        successStatus = true;
      } else if (finalContent.includes('Aguardando Envio') || finalContent.includes('Aguardando envio')) {
        uploadStatus = 'Aguardando envio';
        successStatus = true;
      } else if (finalContent.includes('Aguardando')) {
        uploadStatus = 'Aguardando';
        successStatus = true;
      } else if (finalContent.includes('Processado com sucesso')) {
        uploadStatus = 'Processado com sucesso';
        successStatus = true;
      } else {
        uploadStatus = 'Processamento iniciado (sinal visual)';
        successStatus = true;
      }
      console.log(`\n✅ STATUS: ${uploadStatus}`);
    }
    else {
      uploadStatus = 'Status não identificado - sem sinais claros';
      console.log(`\n⚠️  STATUS: ${uploadStatus}`);
    }

    console.log(`   ${"=".repeat(80)}\n`);

    return {
      success: successStatus,
      status: uploadStatus,
      method: 'popup_dialog_iframe_instrumented',
      screenshot: screenshotFinal,
      debugInfo: debugInfo,
      consoleLogs: consoleLogs.slice(-100), // Últimos 100 logs
      networkResponses: uploadApiResponses
    };

  } catch (error) {
    console.error(`\n❌ ERRO NO UPLOAD: ${error.message}`);
    console.error(`   Stack: ${error.stack}`);

    // Screenshot de erro
    const errorScreenshot = path.join(DOWNLOADS_DIR, `upload_error_${timestamp}_${cnpjFormatado}.png`);
    await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
    debugInfo.screenshots.push(errorScreenshot);
    console.log(`   📸 Screenshot de erro: ${errorScreenshot}`);

    // HTML dump em caso de erro
    try {
      const iframeHtmlError = await targetFrame?.content() || '<no frame>';
      const htmlDumpErrorPath = path.join(DOWNLOADS_DIR, `upload_html_error_${timestamp}_${cnpjFormatado}.html`);
      fs.writeFileSync(htmlDumpErrorPath, iframeHtmlError, 'utf8');
      debugInfo.htmlDumps.push(htmlDumpErrorPath);
      console.log(`   📄 HTML dump (erro): ${htmlDumpErrorPath}`);
    } catch (e) {
      // Ignora
    }

    return {
      success: false,
      error: error.message,
      status: 'Erro: ' + error.message,
      screenshot: errorScreenshot,
      debugInfo: debugInfo,
      consoleLogs: consoleLogs.slice(-100),
      networkResponses: uploadApiResponses
    };
  }
}

// ============================================================================
// ROTAS DA API
// ============================================================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Anatel Coleta de Dados API",
  });
});

app.post("/api/coleta/:cnpj", upload.single("csv"), async (req, res) => {
  const { cnpj } = req.params;
  // Aceita whatsapp via query parameter ou via body
  const whatsappNumber = req.query.whatsapp || req.body?.whatsapp || null;

  // Aceita mes_destino (formato MM/AAAA) ou ano_destino (formato AAAA)
  let mesDestino = req.query.mes_destino || req.body?.mes_destino || null;
  let anoDestino = req.query.ano_destino || req.body?.ano_destino || null;

  // Se fornecido mes_destino, extrai o ano
  if (mesDestino && !anoDestino) {
    const [, ano] = mesDestino.split('/');
    anoDestino = ano;
  }

  // Fallback para 2026 se não especificado
  if (!anoDestino) {
    anoDestino = '2026';
  }

  // Arquivo CSV enviado
  const csvFilePath = req.file ? req.file.path : null;

  // Log de depuração
  console.log("\n=== DEBUG POST /api/coleta/:cnpj ===");
  console.log(`CNPJ: ${cnpj}`);
  console.log(`req.query:`, req.query);
  console.log(`req.body:`, req.body);
  console.log(`req.file:`, req.file ? {
    originalname: req.file.originalname,
    path: req.file.path,
    mimetype: req.file.mimetype,
    size: req.file.size
  } : null);
  console.log(`csvFilePath: ${csvFilePath}`);
  console.log(`whatsappNumber: ${whatsappNumber}`);
  console.log(`mesDestino (raw):`, mesDestino);
  console.log(`anoDestino (raw):`, anoDestino);
  console.log("====================================\n");

  if (!cnpj || cnpj.replace(/[^\d]/g, "").length !== 14) {
    return res.status(400).json({
      success: false,
      error: "CNPJ inválido. Deve conter 14 dígitos.",
    });
  }

  try {
    const result = await processarColetaDados(cnpj, csvFilePath, whatsappNumber, anoDestino);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/coleta/:cnpj", async (req, res) => {
  const { cnpj } = req.params;
  // Aceita whatsapp via query parameter
  const whatsappNumber = req.query.whatsapp || null;

  if (!cnpj || cnpj.replace(/[^\d]/g, "").length !== 14) {
    return res.status(400).json({
      success: false,
      error: "CNPJ inválido. Deve conter 14 dígitos.",
    });
  }

  try {
    const result = await processarColetaDados(cnpj, whatsappNumber);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/download/:filename", (req, res) => {
  const { filename } = req.params;
  const filePath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      error: "Arquivo não encontrado",
    });
  }

  res.download(filePath);
});

app.get("/api/downloads", (req, res) => {
  const files = fs.readdirSync(DOWNLOADS_DIR);
  res.json({
    success: true,
    files: files,
    path: DOWNLOADS_DIR,
  });
});

// ============================================================================
// ENDPOINT DE PROCESSAMENTO EM LOTE (BATCH)
// ============================================================================

/**
 * Processa múltiplos CNPJs em lote
 * POST /api/coleta/batch
 *
 * Body esperado:
 * [
 *   { "cnpj": "10682450000165", "whatsapp": "5517997695403" },
 *   { "cnpj": "12345678000190", "whatsapp": "5511999999999" }
 * ]
 */
app.post("/api/coleta/batch", async (req, res) => {
  const { batch } = req.body;

  // Validação
  if (!batch || !Array.isArray(batch)) {
    return res.status(400).json({
      success: false,
      error: "Body deve conter um array 'batch' com objetos {cnpj, whatsapp}",
    });
  }

  if (batch.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Array batch não pode estar vazio",
    });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROCESSAMENTO EM LOTE INICIADO`);
  console.log(`Total de itens: ${batch.length}`);
  console.log(`${"=".repeat(60)}\n`);

  const results = [];
  const errors = [];

  // Processar cada item sequencialmente (para sobrecarregar menos o navegador)
  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    const { cnpj, whatsapp } = item;

    console.log(`\n[${i + 1}/${batch.length}] Processando CNPJ: ${cnpj}`);

    // Validar CNPJ
    const cnpjLimpo = cnpj.replace(/[^\d]/g, "");
    if (cnpjLimpo.length !== 14) {
      const error = {
        cnpj,
        success: false,
        error: "CNPJ inválido. Deve conter 14 dígitos.",
      };
      results.push(error);
      errors.push(error);
      console.log(`   ✗ ERRO: CNPJ inválido`);
      continue;
    }

    // Validar WhatsApp
    if (!whatsapp || whatsapp.replace(/[^\d]/g, "").length < 10) {
      const error = {
        cnpj,
        success: false,
        error: "WhatsApp inválido. Deve conter pelo menos 10 dígitos.",
      };
      results.push(error);
      errors.push(error);
      console.log(`   ✗ ERRO: WhatsApp inválido`);
      continue;
    }

    try {
      const result = await processarColetaDados(cnpj, whatsapp);
      results.push(result);

      if (result.success) {
        console.log(`   ✓ SUCESSO: PDF gerado e enviado para ${whatsapp}`);
      } else {
        errors.push(result);
        console.log(`   ✗ ERRO: ${result.error}`);
      }
    } catch (error) {
      const errorResult = {
        cnpj,
        success: false,
        error: error.message,
      };
      results.push(errorResult);
      errors.push(errorResult);
      console.log(`   ✗ ERRO: ${error.message}`);
    }

    // Pequena pausa entre processamentos
    if (i < batch.length - 1) {
      console.log(`   Aguardando 5 segundos antes do próximo...`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  // Resumo final
  const successCount = results.filter((r) => r.success).length;
  const errorCount = errors.length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PROCESSAMENTO EM LOTE CONCLUÍDO`);
  console.log(`Total processados: ${batch.length}`);
  console.log(`Sucessos: ${successCount}`);
  console.log(`Erros: ${errorCount}`);
  console.log(`${"=".repeat(60)}\n`);

  res.json({
    success: errorCount === 0,
    total: batch.length,
    successCount,
    errorCount,
    results,
  });
});

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

app.listen(PORT, () => {
  console.log(`
================================================================================
  ANATEL COLETA DE DADOS API v2.0.0
================================================================================

  Servidor: http://localhost:${PORT}

  ENDPOINTS:
    POST /api/coleta/:cnpj    - Processar CNPJ (com ou sem CSV)
    GET  /api/coleta/:cnpj    - Processar CNPJ e baixar comprovante
    POST /api/coleta/batch    - Processar múltiplos CNPJs em lote
    GET  /api/health          - Status da API
    GET  /api/downloads       - Listar arquivos baixados
    GET  /api/download/:file  - Download de arquivo

  EXEMPLOS:
    # CNPJ único (sem CSV - baixa comprovante)
    curl http://localhost:${PORT}/api/coleta/10682450000165
    curl "http://localhost:${PORT}/api/coleta/10682450000165?whatsapp=5511999999999"

    # CNPJ com CSV (envia arquivo para a Anatel)
    curl -X POST http://localhost:${PORT}/api/coleta/10682450000165 \\
      -F "csv=@/caminho/arquivo.csv"

    # CNPJ com CSV e WhatsApp
    curl -X POST "http://localhost:${PORT}/api/coleta/10682450000165?whatsapp=5511999999999" \\
      -F "csv=@/caminho/arquivo.csv"

    # Lote (batch)
    curl -X POST http://localhost:${PORT}/api/coleta/batch \\
      -H "Content-Type: application/json" \\
      -d '{"batch": [
        {"cnpj": "10682450000165", "whatsapp": "5517997695403"},
        {"cnpj": "12345678000190", "whatsapp": "5511999999999"}
      ]}'

  Downloads: ${DOWNLOADS_DIR}

================================================================================
  `);
});
