/**
 * ================================================================================
 * SESSION KEEPER - Keep-Alive Service for Anatel Sessions
 * ================================================================================
 *
 * @fileoverview Service that maintains a persistent browser session with automatic
 * refresh to keep Anatel sessions alive. Uses random intervals (1-3 minutes)
 * to avoid detection with ACTIVE session validation.
 *
 * @version 2.2.0
 * @date 2026-03-09
 *
 * Features:
 *   - Persistent browser instance (doesn't close after operations)
 *   - Automatic refresh with random intervals (1-3 min) - NUNCA > 3 minutos
 *   - ACTIVE session validation (HTTP status, DOM content, critical cookies)
 *   - REACTIVE cookie extraction (triggers on HTTP 302, login DOM, cookie expiry)
 *   - Cookie TS01f8c72f as PRIMARY validation criteria
 *   - Support for multiple Chrome profiles
 *   - Graceful shutdown handling
 *   - Status endpoint integration
 *   - Page pooling for efficient browser reuse
 *   - Retry mechanism for cookie extraction (max 3 retries)
 *   - Cookie expiration validation with 5min buffer
 *   - Improved error handling with degraded mode
 *   - Force refresh even without Chrome Remote Debugging
 *   - COOKIE CACHE with TTL (5 minutes) - avoids unnecessary Chrome extraction
 *   - Cache invalidation on authentication failures
 *   - HTTP VALIDATION before cache creation - only caches verified valid sessions
 *   - Auto-wait for valid Chrome session (up to 5 minutes) - no need to login before starting
 *
 * URLs Monitored (PRIMARY: apps.anatel.gov.br):
 *   - https://apps.anatel.gov.br/ (PRIMARY - Portal principal)
 *   - https://apps.anatel.gov.br/ColetaDados/ (Coleta de dados)
 *   - https://sistemas.anatel.gov.br/se/tlist?cfg=CadastroEstacaoExt&ctx=FISTELE
 *
 * Validation Strategy:
 *   1. HTTP Status: 302/301 = redirect to login = INVALID
 *   2. DOM Content: gov.br + login keywords = INVALID
 *   3. Forms: Login form detected = INVALID
 *   4. Cookie TS01f8c72f: Missing/Expired/Changed = INVALID
 *   5. Page Title: Contains Login/gov.br = INVALID
 *
 * Environment Variables:
 *   - KEEP_ALIVE_MIN: Minimum refresh interval (default: 1)
 *   - KEEP_ALIVE_MAX: Maximum refresh interval (default: 3)
 *   - COOKIE_REFRESH_MIN: Cookie re-extraction interval (default: 2)
 *   - COOKIE_CACHE_TTL: Cookie cache TTL in minutes (default: 5)
 *   - FORCE_REFRESH_NO_DEBUG: Refresh without Remote Debugging (default: true)
 *
 * ================================================================================
 */

const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

// Configurações de cache de cookies
const COOKIE_CACHE_CONFIG = {
  cacheFile: path.join(__dirname, "cookies_cache.json"),
  ttl: (parseInt(process.env.COOKIE_CACHE_TTL) || 5) * 60 * 1000,  // 5 minutos padrão, configurável via COOKIE_CACHE_TTL
  maxWaitForValidSession: 5 * 60 * 1000,  // Máximo de 5 minutos aguardando sessão válida
  checkInterval: 10000,  // Verificar a cada 10 segundos
};

// Configurações de retry para extração de cookies
const COOKIE_EXTRACTION_CONFIG = {
  maxRetries: 3,
  timeout: 30000,  // 30 segundos (aumentado de 10s)
  retryDelay: 2000,  // 2 segundos entre tentativas
  cookieExpiryBuffer: 300,  // 5 minutos de buffer antes da expiração
};

/**
 * SessionKeeper class - Manages persistent browser sessions
 */
class SessionKeeper {
  /**
   * Creates a new SessionKeeper instance
   * @param {Object} options - Configuration options
   * @param {string} options.profile - Chrome profile name (default: 'Default')
   * @param {boolean} options.headless - Run browser in headless mode (default: true)
   * @param {boolean} options.keepAlive - Enable keep-alive loop (default: true)
   * @param {number} options.minInterval - Minimum refresh interval in minutes (default: 1)
   * @param {number} options.maxInterval - Maximum refresh interval in minutes (default: 10)
   */
  constructor(options = {}) {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.keepAliveTimer = null;
    this.isRefreshing = false;
    this.isStarted = false;
    this.lastRefreshTime = null;
    this.refreshCount = 0;
    this.lastCookieExtraction = null;
    this.cookieRefreshCount = 0;

    // Estado de validação de cookie para corrigir race condition
    this.cookieValidationPending = false;
    this.pendingCookieRefresh = null;

    // Histórico de refreshes em memória (últimos 100)
    this.refreshHistory = [];
    this.maxHistorySize = options.maxHistorySize || 100;

    // Contador de falhas consecutivas para health check
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 5;

    // Configuration options
    this.options = {
      profile: options.profile || process.env.PROFILE_NAME || 'Default',
      headless: options.headless !== false && process.env.HEADLESS !== 'false',
      keepAlive: options.keepAlive !== false && process.env.KEEP_ALIVE !== 'false',
      // Intervalo de keep-alive: 1-3 minutos (NUNCA permitir > 3 minutos para Anatel)
      minInterval: parseInt(process.env.KEEP_ALIVE_MIN || '1', 10),
      maxInterval: parseInt(process.env.KEEP_ALIVE_MAX || '3', 10),
      // Intervalo em minutos para reextrair cookies do Chrome (default: 2 minutos - reextração reativa)
      cookieRefreshInterval: parseInt(process.env.COOKIE_REFRESH_MIN || '2', 10),
      // Se true, faz refresh mesmo sem Remote Debugging (default: true - evita expiração silenciosa)
      forceRefreshNoDebug: options.forceRefreshNoDebug !== false && process.env.FORCE_REFRESH_NO_DEBUG !== 'false',
    };

    // Anatel URLs for refresh (multiple pages to keep cache alive)
    // apps.anatel.gov.br é a URL PRIMÁRIA - deve ser tratada com prioridade máxima
    this.ANATEL_URLS = [
      "https://apps.anatel.gov.br/",              // URL PRIMÁRIA - Portal principal
      "https://apps.anatel.gov.br/ColetaDados/",  // Sistema de coleta de dados
      "https://sistemas.anatel.gov.br/se/tlist?cfg=CadastroEstacaoExt&ctx=FISTELE"  // Cadastro de estações
    ];
  }

  /**
   * Load cookies from cache file if valid
   * @returns {Array|null} Cached cookies or null if cache is invalid/missing
   */
  loadCookiesFromCache() {
    try {
      if (!fs.existsSync(COOKIE_CACHE_CONFIG.cacheFile)) {
        return null;
      }

      const cacheData = JSON.parse(fs.readFileSync(COOKIE_CACHE_CONFIG.cacheFile, "utf8"));
      const age = Date.now() - cacheData.timestamp;

      if (age > COOKIE_CACHE_CONFIG.ttl) {
        console.log(`[COOKIE CACHE] ✗ Cache expired (age: ${Math.floor(age / 1000)}s, TTL: ${COOKIE_CACHE_CONFIG.ttl / 1000}s)`);
        return null;
      }

      console.log(`[COOKIE CACHE] ✓ CACHE HIT (${cacheData.cookies.length} cookies, age: ${Math.floor(age / 1000)}s)`);
      return cacheData.cookies;
    } catch (error) {
      console.log(`[COOKIE CACHE] ✗ Error loading cache: ${error.message}`);
      return null;
    }
  }

  /**
   * Save cookies to cache file
   * @param {Array} cookies - Cookies to save
   */
  saveCookiesToCache(cookies) {
    try {
      const cacheData = {
        timestamp: Date.now(),
        cookies: cookies
      };

      fs.writeFileSync(
        COOKIE_CACHE_CONFIG.cacheFile,
        JSON.stringify(cacheData, null, 2)
      );

      const ttlMinutes = COOKIE_CACHE_CONFIG.ttl / (60 * 1000);
      console.log(`[COOKIE CACHE] ✓ CACHE STORE (${cookies.length} cookies, TTL: ${ttlMinutes}min)`);
    } catch (error) {
      console.log(`[COOKIE CACHE] ✗ Error saving cache: ${error.message}`);
    }
  }

  /**
   * Invalidate cookie cache (delete cache file)
   * Used when authentication fails or cookies are invalid
   */
  invalidateCookieCache() {
    try {
      if (fs.existsSync(COOKIE_CACHE_CONFIG.cacheFile)) {
        fs.unlinkSync(COOKIE_CACHE_CONFIG.cacheFile);
        console.log(`[COOKIE CACHE] ✗ Cache invalidated (file deleted)`);
      }
    } catch (error) {
      console.log(`[COOKIE CACHE] ✗ Error invalidating cache: ${error.message}`);
    }
  }

  /**
   * Wait for a valid Chrome session (cookies + HTTP validation)
   * @returns {Promise<Array>} Validated cookies
   */
  async waitForValidSession() {
    const startTime = Date.now();
    let attempt = 0;
    let wasFromCache = false;

    console.log(`[SESSION WAIT] ⏳ Aguardando sessão válida do Chrome...`);
    console.log(`[SESSION WAIT] 💡 Faça login no Chrome em: https://apps.anatel.gov.br/acesso/`);
    console.log(`[SESSION WAIT] ⏱️  Timeout máximo: ${COOKIE_CACHE_CONFIG.maxWaitForValidSession / 1000}s`);

    while (Date.now() - startTime < COOKIE_CACHE_CONFIG.maxWaitForValidSession) {
      attempt++;

      try {
        // Check cache first (without logging)
        const cachedCookies = this.loadCookiesFromCacheInternal();
        let cookies;
        let source = "";

        if (cachedCookies && cachedCookies.length > 0) {
          cookies = cachedCookies;
          source = "CACHE";
          wasFromCache = true;
        } else {
          // Extract from Chrome
          console.log(`[SESSION WAIT] 🔍 Tentativa ${attempt}: Extraindo cookies do Chrome...`);
          cookies = this.getChromeCookiesInternal();
          if (cookies.length === 0) {
            console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Nenhum cookie encontrado`);
            await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
            continue;
          }
          source = "Chrome";
        }

        // Validate critical cookies
        const validation = this.validateCriticalCookies(cookies);
        if (!validation.isValid) {
          if (wasFromCache) {
            // Cache was invalid, invalidate and try extracting from Chrome
            console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Cache inválido (cookies críticos faltando)`);
            this.invalidateCookieCache();
            wasFromCache = false;
            await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
            continue;
          }
          console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Cookies críticos faltando: ${validation.missing.join(', ')}`);
          await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
          continue;
        }

        // Quick HTTP validation to verify session is actually valid
        console.log(`[SESSION WAIT] 🔍 Tentativa ${attempt}: Validando sessão via HTTP (${source})...`);

        // Create temporary browser context for validation
        const tempBrowser = await chromium.launch({ headless: true });
        const tempContext = await tempBrowser.newContext();
        await tempContext.addCookies(cookies);
        const tempPage = await tempContext.newPage();

        try {
          const response = await tempPage.goto('https://apps.anatel.gov.br/', {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          });

          const status = response?.status() || 0;
          const currentUrl = tempPage.url();
          const title = await tempPage.title();

          await tempBrowser.close();

          // Check if session is valid
          const urlLower = currentUrl.toLowerCase();
          if (urlLower.includes('login.aspx') || urlLower.includes('/oauth') || urlLower.includes('/login')) {
            if (wasFromCache) {
              console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Cache expirado (URL indica login)`);
              this.invalidateCookieCache();
              wasFromCache = false;
              await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
              continue;
            }
            console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: URL indica login (${currentUrl})`);
            await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
            continue;
          }

          if (title.includes('Login')) {
            if (wasFromCache) {
              console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Cache expirado (título indica login)`);
              this.invalidateCookieCache();
              wasFromCache = false;
              await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
              continue;
            }
            console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Título indica login (${title})`);
            await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
            continue;
          }

          if (status === 302 || status === 301) {
            if (wasFromCache) {
              console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Cache expirado (HTTP ${status} redirect)`);
              this.invalidateCookieCache();
              wasFromCache = false;
              await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
              continue;
            }
            console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: HTTP ${status} - Redirect detectado`);
            await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
            continue;
          }

          // Session is valid!
          console.log(`[SESSION WAIT] ✅ SESSÃO VÁLIDA detectada! (HTTP ${status}, URL: ${currentUrl})`);

          if (!wasFromCache) {
            // Only save to cache if we extracted from Chrome and session is valid
            console.log(`[SESSION WAIT] 💾 Criando cache com cookies válidos...`);
            this.saveCookiesToCache(cookies);
          } else {
            console.log(`[SESSION WAIT] ✅ Cache válido, usando cookies em cache`);
          }

          return cookies;

        } catch (navError) {
          await tempBrowser.close();
          console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: Erro na navegação: ${navError.message}`);
          await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
          continue;
        }

      } catch (error) {
        console.log(`[SESSION WAIT] ⚠ Tentativa ${attempt}: ${error.message}`);
        await this.sleep(COOKIE_CACHE_CONFIG.checkInterval);
      }
    }

    // Timeout reached
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    throw new Error(`Timeout após ${elapsed}s aguardando sessão válida. Verifique se está logado no Chrome.`);
  }

  /**
   * Load cookies from cache WITHOUT logging (internal use)
   * @returns {Array|null} Cached cookies or null if cache is invalid/missing
   */
  loadCookiesFromCacheInternal() {
    try {
      if (!fs.existsSync(COOKIE_CACHE_CONFIG.cacheFile)) {
        return null;
      }

      const cacheData = JSON.parse(fs.readFileSync(COOKIE_CACHE_CONFIG.cacheFile, "utf8"));
      const age = Date.now() - cacheData.timestamp;

      if (age > COOKIE_CACHE_CONFIG.ttl) {
        return null;
      }

      return cacheData.cookies;
    } catch (error) {
      return null;
    }
  }

  /**
   * Extract cookies from Chrome WITHOUT checking cache (internal use)
   * @param {string} domain - Domain to extract cookies for
   * @returns {Array} Array of cookies
   */
  getChromeCookiesInternal(domain = ".anatel.gov.br") {
    let lastError = null;

    for (let attempt = 1; attempt <= COOKIE_EXTRACTION_CONFIG.maxRetries; attempt++) {
      try {
        const scriptPath = path.join(__dirname, "export_cookies.py");
        const result = execSync(`python3 "${scriptPath}" "${domain}"`, {
          encoding: "utf-8",
          timeout: COOKIE_EXTRACTION_CONFIG.timeout,
        });

        const cookies = JSON.parse(result);

        if (cookies.length > 0) {
          return cookies;
        }
      } catch (error) {
        lastError = error;
        if (attempt < COOKIE_EXTRACTION_CONFIG.maxRetries) {
          const delay = COOKIE_EXTRACTION_CONFIG.retryDelay * attempt;
          this.sleep(delay);
        }
      }
    }

    return [];
  }

  /**
   * Verifica se um cookie está válido ou próximo de expirar
   * @param {Object} cookie - Cookie object
   * @returns {boolean} True se o cookie é válido
   */
  isCookieValid(cookie) {
    if (!cookie.expires || cookie.expires <= 0) {
      // Cookie sem data de expiração (session cookie) é válido
      return true;
    }

    const expiresDate = new Date(cookie.expires * 1000);
    const now = new Date();
    const timeUntilExpiry = expiresDate - now;
    const bufferMs = COOKIE_EXTRACTION_CONFIG.cookieExpiryBuffer * 1000;

    // Log warning se estiver expirando em breve
    if (timeUntilExpiry < bufferMs && timeUntilExpiry > 0) {
      console.log(`[COOKIE VALIDATION] ⚠ Cookie '${cookie.name}' expira em breve: ${expiresDate.toLocaleTimeString()}`);
    }

    return timeUntilExpiry > 0;
  }

  /**
   * Filtra cookies válidos de uma lista
   * @param {Array} cookies - Array de cookies
   * @returns {Object} Objeto com validCookies, expiredCount, expiringSoonCount
   */
  filterValidCookies(cookies) {
    const validCookies = [];
    let expiredCount = 0;
    let expiringSoonCount = 0;

    for (const cookie of cookies) {
      if (!cookie.expires || cookie.expires <= 0) {
        validCookies.push(cookie);
        continue;
      }

      const expiresDate = new Date(cookie.expires * 1000);
      const now = new Date();
      const timeUntilExpiry = expiresDate - now;
      const bufferMs = COOKIE_EXTRACTION_CONFIG.cookieExpiryBuffer * 1000;

      if (timeUntilExpiry <= 0) {
        expiredCount++;
      } else if (timeUntilExpiry < bufferMs) {
        expiringSoonCount++;
        validCookies.push(cookie); // Ainda válido, mas expirando em breve
      } else {
        validCookies.push(cookie);
      }
    }

    return { validCookies, expiredCount, expiringSoonCount };
  }

  /**
   * Extract cookies from Chrome using Python script with retry mechanism
   * Checks cache first before extracting from Chrome
   * @param {string} domain - Domain to extract cookies for
   * @returns {Array} Array of cookies
   */
  getChromeCookies(domain = ".anatel.gov.br") {
    // TIRAR: Check cache first
    const cachedCookies = this.loadCookiesFromCache();
    if (cachedCookies && cachedCookies.length > 0) {
      return cachedCookies;
    }

    // CACHE MISS: Extract from Chrome
    console.log(`[COOKIE CACHE] ✗ CACHE MISS - extracting from Chrome`);
    let lastError = null;

    for (let attempt = 1; attempt <= COOKIE_EXTRACTION_CONFIG.maxRetries; attempt++) {
      try {
        console.log(`[COOKIE EXTRACTION] Tentativa ${attempt}/${COOKIE_EXTRACTION_CONFIG.maxRetries}...`);

        const scriptPath = path.join(__dirname, "export_cookies.py");
        const result = execSync(`python3 "${scriptPath}" "${domain}"`, {
          encoding: "utf-8",
          timeout: COOKIE_EXTRACTION_CONFIG.timeout,
        });

        const cookies = JSON.parse(result);

        if (cookies.length === 0) {
          console.warn(`[COOKIE EXTRACTION] ⚠ Nenhum cookie encontrado (tentativa ${attempt})`);
          if (attempt < COOKIE_EXTRACTION_CONFIG.maxRetries) {
            console.log(`[COOKIE EXTRACTION] Aguardando ${COOKIE_EXTRACTION_CONFIG.retryDelay}ms antes da próxima tentativa...`);
            this.sleep(COOKIE_EXTRACTION_CONFIG.retryDelay);
            continue;
          }
        } else {
          console.log(`[COOKIE EXTRACTION] ✓ ${cookies.length} cookies extraídos com sucesso`);
          // DON'T save to cache yet - cache is only saved after HTTP validation
          return cookies;
        }
      } catch (error) {
        lastError = error;
        console.error(`[COOKIE EXTRACTION] ✗ Erro na tentativa ${attempt}: ${error.message}`);

        if (attempt < COOKIE_EXTRACTION_CONFIG.maxRetries) {
          const delay = COOKIE_EXTRACTION_CONFIG.retryDelay * attempt; // Delay crescente
          console.log(`[COOKIE EXTRACTION] Aguardando ${delay}ms antes da próxima tentativa...`);
          this.sleep(delay);
        }
      }
    }

    console.error(`[COOKIE EXTRACTION] ✗ Max retries atingido. Último erro: ${lastError?.message || 'Desconhecido'}`);
    return [];
  }

  /**
   * Helper function for sleep/delay
   * @param {number} ms - Milliseconds to sleep
   */
  sleep(ms) {
    const startTime = Date.now();
    while (Date.now() - startTime < ms) {
      // Busy wait - equivalente sincronizado
    }
  }

  /**
   * Validate critical cookies for Anatel authentication
   * @param {Array} cookies - Array of cookies to validate
   * @returns {Object} Validation result with isValid, missing cookies, and expiry info
   */
  validateCriticalCookies(cookies) {
    const criticalCookieNames = [
      'ASP.NET_SessionId',
      'Users.sid',
      'TS01f8c72f'
    ];

    // Filtrar cookies válidos
    const { validCookies, expiredCount, expiringSoonCount } = this.filterValidCookies(cookies);

    const cookieMap = new Map();
    validCookies.forEach(c => cookieMap.set(c.name, c));

    const missing = [];
    for (const name of criticalCookieNames) {
      if (!cookieMap.has(name)) {
        missing.push(name);
      }
    }

    return {
      isValid: missing.length === 0,
      missing: missing,
      found: criticalCookieNames.filter(n => cookieMap.has(n)),
      expiredCount,
      expiringSoonCount,
      totalValid: validCookies.length,
    };
  }

  /**
   * Adiciona um refresh ao histórico com limpeza automática
   * @param {Object} data - Dados do refresh
   */
  addRefreshHistory(data) {
    const entry = {
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.refreshHistory.push(entry);

    // Manter apenas os últimos N registros
    if (this.refreshHistory.length > this.maxHistorySize) {
      this.refreshHistory.shift();
    }
  }

  /**
   * Check if cookies should be refreshed based on time interval
   * @returns {boolean} True if cookies should be refreshed
   */
  shouldRefreshCookies() {
    if (!this.lastCookieExtraction) {
      return true; // Never extracted before
    }
    const elapsedMs = Date.now() - this.lastCookieExtraction.getTime();
    const intervalMs = this.options.cookieRefreshInterval * 60 * 1000;
    return elapsedMs >= intervalMs;
  }

  /**
   * Refresh cookies from Chrome and update browser context
   * @param {boolean} validateAuthentication - If true, validates cookies work before marking as successful
   * @returns {Promise<boolean|string>} True if refreshed, 'pending_validation' if needs auth check, false if failed
   */
  async refreshBrowserCookies(validateAuthentication = false) {
    try {
      console.log("\n[COOKIE REFRESH] ================================================");
      console.log("[COOKIE REFRESH] Reextraindo cookies do Chrome...");

      const cookies = this.getChromeCookies();

      if (cookies.length === 0) {
        console.log("[COOKIE REFRESH] ⚠ Nenhum cookie encontrado - mantendo cookies atuais");
        this.consecutiveFailures++;
        return false;
      }

      // Validate critical cookies exist
      const validation = this.validateCriticalCookies(cookies);
      if (!validation.isValid) {
        console.log(`[COOKIE REFRESH] ⚠ Cookies críticos faltando: ${validation.missing.join(', ')}`);
        console.log(`[COOKIE REFRESH] ⚠ Cookies encontrados: ${validation.found.join(', ') || 'nenhum'}`);
        console.log("[COOKIE REFRESH] ⚠ A extração pode ter falhado ou a sessão expirou - mantendo cookies atuais");
        this.consecutiveFailures++;
        return false;
      }

      console.log(`[COOKIE REFRESH] ✓ Cookies críticos validados: ${validation.found.join(', ')}`);
      console.log(`[COOKIE REFRESH] ✓ Total de cookies válidos: ${validation.totalValid}`);

      if (validation.expiredCount > 0) {
        console.log(`[COOKIE REFRESH] ⚠ ${validation.expiredCount} cookies expirados foram filtrados`);
      }
      if (validation.expiringSoonCount > 0) {
        console.log(`[COOKIE REFRESH] ⚠ ${validation.expiringSoonCount} cookies expirando em breve`);
      }

      // Clear existing cookies and add new ones
      if (this.context) {
        await this.context.addCookies(cookies);
        this.cookieRefreshCount++;
        this.consecutiveFailures = 0; // Reset contador de falhas

        console.log(`[COOKIE REFRESH] ✓ Cookies atualizados (${cookies.length} cookies) - Refresh #${this.cookieRefreshCount}`);

        if (validateAuthentication) {
          console.log("[COOKIE REFRESH] ⏳ Aguardando validação de autenticação...");
          // Marcar que validação está pendente
          this.cookieValidationPending = true;
          this.pendingCookieRefresh = new Date();
          return 'pending_validation';
        } else {
          this.lastCookieExtraction = new Date();
          console.log(`[COOKIE REFRESH] ✓ Próxima reextração em: ${this.options.cookieRefreshInterval} minutos`);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error(`[COOKIE REFRESH] ✗ Erro ao atualizar cookies: ${error.message}`);
      this.consecutiveFailures++;
      return false;
    }
  }

  /**
   * Generate a random interval between min and max
   * @returns {number} Random interval in milliseconds
   */
  getRandomInterval() {
    const minMs = this.options.minInterval * 60 * 1000;
    const maxMs = this.options.maxInterval * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  }

  /**
   * Format milliseconds to readable time
   * @param {number} ms - Milliseconds to format
   * @returns {string} Formatted time string
   */
  formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    }
    return `${seconds}s`;
  }

  /**
   * Start the browser and initialize the session
   * @returns {Promise<void>}
   */
  async start() {
    if (this.isStarted) {
      console.log("   SessionKeeper já está iniciado");
      return;
    }

    console.log(`
================================================================================
  SESSION KEEPER - Iniciando
================================================================================
  Profile: ${this.options.profile}
  Headless: ${this.options.headless}
  Keep-Alive: ${this.options.keepAlive}
  Refresh Interval: ${this.options.minInterval}-${this.options.maxInterval} minutos
  Cookie Refresh: ${this.options.cookieRefreshInterval} minutos
  Max Retries (Cookie): ${COOKIE_EXTRACTION_CONFIG.maxRetries}
  Timeout (Cookie): ${COOKIE_EXTRACTION_CONFIG.timeout}ms
================================================================================
`);

    try {
      // Wait for valid Chrome session (cookies + HTTP validation)
      console.log("1. Aguardando sessão válida do Chrome...");
      const cookies = await this.waitForValidSession();
      console.log(`   ✅ Encontrados ${cookies.length} cookies com sessão válida`);

      // Register first cookie extraction time
      this.lastCookieExtraction = new Date();

      // Launch browser with profile-specific user data directory
      const userDataDir = path.join(__dirname, `.chrome-profile-${this.options.profile}`);

      console.log("2. Iniciando navegador persistente...");
      this.browser = await chromium.launch({
        headless: this.options.headless,
        slowMo: 50,
        args: [
          '--start-minimized',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-dev-shm-usage',
        ],
      });

      console.log("3. Criando contexto com cookies...");
      this.context = await this.browser.newContext({
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36",
        acceptDownloads: true,
      });

      await this.context.addCookies(cookies);

      console.log("4. Criando página inicial...");
      this.page = await this.context.newPage();

      // Minimizar janela do navegador via CDP
      if (!this.options.headless) {
        try {
          const cdpSession = await this.page.context().newCDPSession(this.page);
          const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
          await cdpSession.send('Browser.setWindowBounds', {
            windowId,
            bounds: { windowState: 'minimized' }
          });
          console.log("   Navegador minimizado");
        } catch (e) {
          console.log("   Aviso: não foi possível minimizar navegador");
        }
      }

      // Initial navigation to establish session
      await this.refreshSession();

      this.isStarted = true;
      console.log("   SessionKeeper iniciado com sucesso!");

      // Start keep-alive loop if enabled
      if (this.options.keepAlive) {
        this.startKeepAliveLoop();
      }
    } catch (error) {
      console.error(`   Erro ao iniciar SessionKeeper: ${error.message}`);
      throw error;
    }
  }

  /**
   * Validação ATIVA de sessão - faz requisição autenticada e verifica múltiplos indicadores
   * NÃO confia apenas em título de página
   *
   * @returns {Promise<Object>} Objeto com isValid, reason, details
   */
  async validateActiveSession() {
    const validation = {
      isValid: true,
      reason: null,
      details: {},
    };

    try {
      // 1. Verificar status HTTP e redirects
      const response = await this.page.goto('https://apps.anatel.gov.br/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // CAMADA 1: Verificar URL PRIMEIRO (mais confiável)
      const currentUrl = this.page.url();
      const urlLower = currentUrl.toLowerCase();

      if (urlLower.includes('login.aspx') || urlLower.includes('/oauth') || urlLower.includes('/login')) {
        validation.isValid = false;
        validation.reason = `URL indica login: ${currentUrl}`;
        console.log(`[VALIDAÇÃO ATIVA] ✗ URL indica login: ${currentUrl}`);
        return validation;
      }
      console.log(`[VALIDAÇÃO ATIVA] ✓ URL OK: ${currentUrl}`);

      const status = response?.status() || 0;
      validation.details.httpStatus = status;

      // HTTP 302 = redirect para login = sessão inválida
      if (status === 302 || status === 301) {
        validation.isValid = false;
        validation.reason = `HTTP ${status} - Redirect detectado`;
        console.log(`[VALIDAÇÃO ATIVA] ✗ HTTP ${status} - redirect para login`);
        return validation;
      }

      // Status diferente de 200 = problema
      if (status !== 200) {
        validation.isValid = false;
        validation.reason = `HTTP ${status} - Status inválido`;
        console.log(`[VALIDAÇÃO ATIVA] ✗ HTTP ${status} - status inesperado`);
        return validation;
      }

      // 2. Verificar conteúdo HTML
      const content = await this.page.content();
      const htmlLower = content.toLowerCase();

      // REMOVIDO: Causava falsos positivos - "gov.br" aparece em footer, links e branding
      // Apenas verificar presença informativa
      if (htmlLower.includes('gov.br')) {
        validation.details.govBrPresent = true;  // Apenas informativo
      }

      // 2.1 Verificar forms de login REAL (refinado - evita falsos positivos)
      // CRITÉRIO: Form com input[type="password"] OU action relacionada a login/gov.br/oauth
      const forms = await this.page.locator('form').all();
      let realLoginFormDetected = false;
      let formDetails = [];

      for (const form of forms) {
        try {
          // Verificar se form tem input[type="password"]
          const hasPasswordInput = await form.locator('input[type="password"]').count() > 0;

          // Verificar action do form
          const actionAttr = await form.getAttribute('action') || '';
          const methodAttr = await form.getAttribute('method') || '';
          const idAttr = await form.getAttribute('id') || '';
          const nameAttr = await form.getAttribute('name') || '';
          const classAttr = await form.getAttribute('class') || '';

          // Verificar se action/id/name contém login, gov.br ou oauth
          const actionLower = actionAttr.toLowerCase();
          const idLower = idAttr.toLowerCase();
          const nameLower = nameAttr.toLowerCase();
          const classLower = classAttr.toLowerCase();

          const hasLoginAction = /login|oauth|entrar|signin/i.test(actionLower + idLower + nameLower + classLower);

          // CRITÉRIO MELHORADO: Requer password E (action de login OU "login.aspx" no HTML)
          const hasLoginAspxInHtml = /login\.aspx/i.test(htmlLower);
          const isRealLoginForm = hasPasswordInput && (hasLoginAction || hasLoginAspxInHtml);

          if (isRealLoginForm) {
            realLoginFormDetected = true;
            formDetails.push({
              action: actionAttr,
              method: methodAttr,
              id: idAttr,
              name: nameAttr,
              class: classAttr,
              hasPassword: hasPasswordInput,
              hasLoginAction: hasLoginAction
            });
          }

          // LOG TEMPORÁRIO: Detalhes do form detectado (para debug)
          if (hasPasswordInput || hasLoginAction) {
            console.log(`[FORM DETECTED] action="${actionAttr}" method="${methodAttr}" id="${idAttr}" name="${nameAttr}" class="${classAttr}" password=${hasPasswordInput}`);
          }

        } catch (e) {
          // Ignorar erros ao ler atributos de form
        }
      }

      // Apenas invalidar se for um form de login REAL
      if (realLoginFormDetected) {
        validation.details.loginForm = formDetails;
        validation.isValid = false;
        validation.reason = `Form de login REAL detectado (${formDetails.length} forms)`;
        console.log(`[VALIDAÇÃO ATIVA] ✗ Form de login REAL detectado: ${formDetails.length} form(s) com password E (action login OU login.aspx no HTML)`);
        return validation;
      }

      // 3. Verificar cookie TS01f8c72f CRÍTICO
      const cookies = await this.context.cookies();
      const tsCookie = cookies.find(c => c.name === 'TS01f8c72f');

      if (!tsCookie) {
        validation.isValid = false;
        validation.reason = 'Cookie TS01f8c72f ausente';
        console.log(`[VALIDAÇÃO ATIVA] ✗ Cookie TS01f8c72f AUSENTE`);
        return validation;
      }

      // Verificar se cookie está expirado
      if (tsCookie.expires && tsCookie.expires > 0) {
        const expiresDate = new Date(tsCookie.expires * 1000);
        const now = new Date();
        if (expiresDate <= now) {
          validation.isValid = false;
          validation.reason = 'Cookie TS01f8c72f expirado';
          console.log(`[VALIDAÇÃO ATIVA] ✗ Cookie TS01f8c72f EXPIRADO: ${expiresDate.toLocaleString()}`);
          return validation;
        }
        validation.details.tsCookieExpiry = expiresDate.toISOString();
      }

      // 4. Verificar título da página (como confirmação adicional)
      const title = await this.page.title();
      validation.details.pageTitle = title;

      if (title.includes('Login')) {
        validation.isValid = false;
        validation.reason = `Título indica login: ${title}`;
        console.log(`[VALIDAÇÃO ATIVA] ✗ Título indica login: ${title}`);
        return validation;
      }

      console.log(`[VALIDAÇÃO ATIVA] ✓ Sessão VÁLIDA (HTTP ${status}, TS01f8c72f OK, título: ${title})`);

    } catch (error) {
      validation.isValid = false;
      validation.reason = `Erro na validação: ${error.message}`;
      console.log(`[VALIDAÇÃO ATIVA] ✗ Erro: ${error.message}`);
    }

    // Proteção contra loop: Se validação falhar, tentar recuperação antes de reportar
    if (!validation.isValid) {
      // Invalidar cache pois a sessão pode estar expirada/inválida
      this.invalidateCookieCache();

      console.log(`[VALIDAÇÃO ATIVA] Sessão inválida, tentando recuperação com refresh...`);
      await this.refreshBrowserCookies(true);
      await this.page.reload({ waitUntil: 'networkidle' });

      // Tentar validação novamente após refresh (apenas URL e título para evitar loop)
      const retryUrl = this.page.url();
      const retryUrlLower = retryUrl.toLowerCase();
      const retryTitle = await this.page.title();

      // Se retry ainda mostra URL de login, não insistir
      if (retryUrlLower.includes('login.aspx') || retryUrlLower.includes('/oauth') || retryUrlLower.includes('/login')) {
        console.log(`[VALIDAÇÃO ATIVA] ✗ Recovery falhou: URL ainda indica login`);
        return validation;
      }

      // Se retry ainda mostra título de login, não insistir
      if (retryTitle.includes('Login')) {
        console.log(`[VALIDAÇÃO ATIVA] ✗ Recovery falhou: Título ainda indica login`);
        return validation;
      }

      // Recovery bem-sucedido - atualizar validação
      validation.isValid = true;
      validation.reason = null;
      validation.details.recovered = true;
      console.log(`[VALIDAÇÃO ATIVA] ✓ Sessão recuperada após refresh!`);
    }

    return validation;
  }

  /**
   * Detect and handle gov.br login page
   * @returns {Promise<boolean>} True if login button was found
   */
  async detectAndHandleGovBrLogin() {
    try {
      // Check for gov.br login button with multiple selectors
      const govBrSelectors = [
        'button:has-text("Entrar gov.br")',
        'a:has-text("Entrar gov.br")',
        'button[id*="gov"]',
        'button[class*="login"]',
        'a[class*="login"]',
        'input[value="Entrar"]',
      ];

      for (const selector of govBrSelectors) {
        const element = await this.page.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          if (isVisible) {
            console.log(`[${new Date().toLocaleTimeString()}] ⚠ PÁGINA DE LOGIN gov.br DETECTADA`);
            console.log(`[${new Date().toLocaleTimeString()}]    Botão encontrado: ${selector}`);

            // Try to click the login button
            try {
              await element.click();
              console.log(`[${new Date().toLocaleTimeString()}]    ✓ Botão clicado, aguardando redirecionamento...`);
              await this.page.waitForTimeout(3000);
              return true;
            } catch (e) {
              console.log(`[${new Date().toLocaleTimeString()}]    ✗ Erro ao clicar: ${e.message}`);
            }
          }
        }
      }
      return false;
    } catch (error) {
      console.log(`[${new Date().toLocaleTimeString()}]    Erro ao detectar login gov.br: ${error.message}`);
      return false;
    }
  }

  /**
   * Refresh the session by navigating to all Anatel pages
   * IMPLEMENTAÇÃO MELHORADA: Validação ativa + reextração reativa de cookies
   *
   * @returns {Promise<void>}
   */
  async refreshSession() {
    if (this.isRefreshing) {
      console.log("   Refresh já em andamento, aguardando...");
      return;
    }

    this.isRefreshing = true;

    try {
      console.log(`\n[${new Date().toLocaleTimeString()}] ==================== REFRESH INICIADO ====================`);
      console.log(`[${new Date().toLocaleTimeString()}] Status: FAZENDO REFRESH das páginas Anatel (${this.ANATEL_URLS.length} URLs)`);
      console.log(`[${new Date().toLocaleTimeString()}] URLs: ${this.ANATEL_URLS.join(', ')}`);

      // VERIFICAÇÃO CRÍTICA: Cookie TS01f8c72f antes de qualquer operação
      const cookies = await this.context.cookies();
      const tsCookie = cookies.find(c => c.name === 'TS01f8c72f');

      if (!tsCookie) {
        console.log(`[${new Date().toLocaleTimeString()}] ⚠⚠⚠ Cookie TS01f8c72f AUSENTE - Sessão INVÁLIDA`);
        console.log(`[${new Date().toLocaleTimeString()}] Forçando reextração imediata de cookies...`);
        await this.refreshBrowserCookies(true);
        this.consecutiveFailures++;
      } else if (tsCookie.expires && tsCookie.expires > 0) {
        const expiresDate = new Date(tsCookie.expires * 1000);
        const now = new Date();
        const timeUntilExpiry = expiresDate - now;

        if (timeUntilExpiry <= 0) {
          console.log(`[${new Date().toLocaleTimeString()}] ⚠⚠⚠ Cookie TS01f8c72f EXPIRADO: ${expiresDate.toLocaleString()}`);
          console.log(`[${new Date().toLocaleTimeString()}] Sessão INVÁLIDA - Forçando reextração imediata...`);
          await this.refreshBrowserCookies(true);
          this.consecutiveFailures++;
        } else if (timeUntilExpiry < 60000) {
          console.log(`[${new Date().toLocaleTimeString()}] ⚠ Cookie TS01f8c72f expira em < 1 minuto: ${expiresDate.toLocaleTimeString()}`);
        }
      }

      // Check if cookies need refresh BEFORE navigation (timer-based)
      if (this.shouldRefreshCookies()) {
        console.log(`[${new Date().toLocaleTimeString()}] Cookies precisam ser atualizados (timer)`);
        const result = await this.refreshBrowserCookies(true);

        if (result === 'pending_validation') {
          console.log(`[${new Date().toLocaleTimeString()}] ⏳ Validação de autenticação pendente...`);
        } else if (result === false) {
          console.log(`[${new Date().toLocaleTimeString()}] ⚠ Falha ao atualizar cookies - continuando com cookies atuais`);
        }
      } else {
        const elapsedMs = Date.now() - this.lastCookieExtraction.getTime();
        const remainingMin = Math.round((this.options.cookieRefreshInterval * 60 * 1000 - elapsedMs) / 60000);
        console.log(`[${new Date().toLocaleTimeString()}] Cookies: OK (próxima atualização em ~${remainingMin} min)`);
      }

      // VALIDAÇÃO ATIVA de sessão ANTES de navegar nas URLs
      console.log(`\n[${new Date().toLocaleTimeString()}] ==================== VALIDAÇÃO ATIVA ====================`);
      const activeValidation = await this.validateActiveSession();

      if (!activeValidation.isValid) {
        console.log(`[${new Date().toLocaleTimeString()}] ⚠⚠⚠ VALIDAÇÃO ATIVA FALHOU: ${activeValidation.reason}`);
        console.log(`[${new Date().toLocaleTimeString()}] Iniciando REEXTRAÇÃO REATIVA de cookies...`);

        const reactiveResult = await this.refreshBrowserCookies(true);

        if (reactiveResult === 'pending_validation' || reactiveResult === true) {
          console.log(`[${new Date().toLocaleTimeString()}] 🔄 Revalidando após reextração...`);
          const revalidation = await this.validateActiveSession();

          if (!revalidation.isValid) {
            console.log(`[${new Date().toLocaleTimeString()}] ✗✗✗ REVALIDAÇÃO FALHOU: ${revalidation.reason}`);

            // NOVO CRITÉRIO DEGRADED: Exige pelo menos 2 de 3 sinais simultâneos
            // Sinais: 1) Cookie TS01f8c72f ausente, 2) Redirect HTTP, 3) Form de login REAL
            let failureSignals = 0;
            let signalDetails = [];

            // Sinal 1: Cookie TS01f8c72f ausente ou expirado
            if (revalidation.reason?.includes('TS01f8c72f')) {
              failureSignals++;
              signalDetails.push('Cookie TS01f8c72f');
            }

            // Sinal 2: Redirect HTTP ou status inválido
            if (revalidation.reason?.includes('HTTP') || revalidation.reason?.includes('Redirect')) {
              failureSignals++;
              signalDetails.push('HTTP/Redirect');
            }

            // Sinal 3: Form de login REAL detectado
            if (revalidation.reason?.includes('Form de login REAL')) {
              failureSignals++;
              signalDetails.push('Form login real');
            }

            console.log(`[${new Date().toLocaleTimeString()}] 📊 Sinais de falha: ${failureSignals}/3 (${signalDetails.join(', ') || 'Nenhum'})`);

            // Apenas entra em DEGRADED se houver pelo menos 2 sinais simultâneos
            if (failureSignals >= 2) {
              console.log(`[${new Date().toLocaleTimeString()}] ✗✗✗ Entrando em modo DEGRADED (${failureSignals} sinais confirmados)`);
              this.consecutiveFailures = this.maxConsecutiveFailures; // Forçar modo degraded
            } else {
              console.log(`[${new Date().toLocaleTimeString()}] ⚠ Apenas ${failureSignals} sinal(is) - Não entrando em DEGRADED, continuando tentativas...`);
              console.log(`[${new Date().toLocaleTimeString()}] ℹ Form genérico não derruba sessão - Sistema continua operacional`);
              this.consecutiveFailures = 0; // Não incrementar - falso positivo
            }
          } else {
            console.log(`[${new Date().toLocaleTimeString()}] ✓ Revalidação bem-sucedida!`);
            this.consecutiveFailures = 0;
          }
        }
      } else {
        console.log(`[${new Date().toLocaleTimeString()}] ✓ Validação ativa OK - Continuando refresh...`);
      }

      // Loop through all URLs (mantido para compatibilidade, mas validação ativa já foi feita)
      let anyAuthenticated = activeValidation.isValid;
      let allPageTitles = [{ url: 'https://apps.anatel.gov.br/', title: activeValidation.details.pageTitle || 'N/A' }];
      let anyLoginPageDetected = !activeValidation.isValid;

      // Se validação ativa passou, continuar navegando nas outras URLs para manter cache
      if (activeValidation.isValid) {
        for (let i = 1; i < this.ANATEL_URLS.length; i++) {
          const url = this.ANATEL_URLS[i];
          console.log(`\n[${new Date().toLocaleTimeString()}] --- URL ${i + 1}/${this.ANATEL_URLS.length} ---`);
          console.log(`[${new Date().toLocaleTimeString()}] Carregando: ${url}`);

          try {
            // Navigate to Anatel page
            const response = await this.page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 60000
            });

            // REEXTRAÇÃO REATIVA: verificar status HTTP
            const status = response?.status() || 0;
            if (status === 302 || status === 301) {
              console.log(`[${new Date().toLocaleTimeString()}] ⚠ HTTP ${status} - Redirect detectado em ${url}`);
              console.log(`[${new Date().toLocaleTimeString()}] ⚠ Sessão pode estar inválida - reextraindo cookies...`);
              await this.refreshBrowserCookies(true);
              anyLoginPageDetected = true;
            } else if (status !== 200) {
              console.log(`[${new Date().toLocaleTimeString()}] ⚠ HTTP ${status} - Status inesperado em ${url}`);
              anyLoginPageDetected = true;
            }

            // Wait for page to stabilize
            await this.page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {
              console.log("   networkidle timeout, continuando...");
            });
            await this.page.waitForTimeout(2000);

            // REMOVIDO: Causava falsos positivos - gov.br aparece em footer/links
            // A validação de URL e forms já cobre os casos reais de página de login

            // Check for gov.br login page
            const loginPageDetected = await this.detectAndHandleGovBrLogin();
            if (loginPageDetected) {
              anyLoginPageDetected = true;
            }

            // Check if session is still valid
            const pageTitle = await this.page.title();
            allPageTitles.push({ url, title: pageTitle });
            const isAuthenticated = !pageTitle.includes("Login");

            if (!isAuthenticated) {
              anyAuthenticated = false;
              anyLoginPageDetected = true;
            }

            // Log status for this URL
            if (isAuthenticated) {
              console.log(`[${new Date().toLocaleTimeString()}] Status: AUTENTICADA`);
              console.log(`[${new Date().toLocaleTimeString()}] Título: ${pageTitle}`);
            } else {
              console.log(`[${new Date().toLocaleTimeString()}] Status: NÃO AUTENTICADA`);
              console.log(`[${new Date().toLocaleTimeString()}] Título: ${pageTitle}`);
            }

          } catch (urlError) {
            console.log(`[${new Date().toLocaleTimeString()}] ✗ Erro ao carregar ${url}: ${urlError.message}`);
            anyLoginPageDetected = true;
          }
        }
      }

      // Summary after all URLs
      console.log(`\n[${new Date().toLocaleTimeString()}] --- RESUMO DO REFRESH ---`);
      console.log(`[${new Date().toLocaleTimeString()}] URLs processadas: ${this.ANATEL_URLS.length}`);
      console.log(`[${new Date().toLocaleTimeString()}] Validação ativa: ${activeValidation.isValid ? 'VÁLIDA' : 'INVÁLIDA'}`);
      console.log(`[${new Date().toLocaleTimeString()}] Autenticadas: ${anyAuthenticated ? 'SIM' : 'NÃO'}`);
      if (activeValidation.reason) {
        console.log(`[${new Date().toLocaleTimeString()}] Motivo: ${activeValidation.reason}`);
      }

      this.lastRefreshTime = new Date();
      this.refreshCount++;

      // Health check: reset consecutive failures on success
      if (anyAuthenticated) {
        this.consecutiveFailures = 0;
      }

      // Registrar no histórico (agrega info de todas as URLs)
      this.addRefreshHistory({
        refreshNumber: this.refreshCount,
        pageTitles: allPageTitles,
        isAuthenticated: anyAuthenticated,
        loginPageDetected: anyLoginPageDetected,
        urls: this.ANATEL_URLS,
        cookiesRefreshed: this.cookieValidationPending || false,
        consecutiveFailures: this.consecutiveFailures,
        activeValidation: activeValidation,
      });

      console.log(`[${new Date().toLocaleTimeString()}] Refresh #${this.refreshCount} CONCLUÍDO`);
      console.log(`[${new Date().toLocaleTimeString()}] ========================================================`);

    } catch (error) {
      console.error(`   Erro no refresh: ${error.message}`);
      this.consecutiveFailures++;

      // Reset validação pendente em caso de erro
      this.cookieValidationPending = false;
      this.pendingCookieRefresh = null;

      // Health check: alert se muitas falhas consecutivas
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        console.error(`[${new Date().toLocaleTimeString()}] ⚠⚠⚠ ALERTA: ${this.consecutiveFailures} falhas consecutivas detectadas!`);
        console.error(`[${new Date().toLocaleTimeString()}] ⚠⚠⚠ Considere reiniciar o serviço ou verificar a sessão manualmente.`);
      }

      // Try to recreate page if error occurs
      try {
        if (this.context) {
          this.page = await this.context.newPage();
        }
      } catch (recreateError) {
        console.error(`   Erro ao recriar página: ${recreateError.message}`);
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Check if Chrome has an active Anatel tab open via Remote Debugging
   * @returns {Promise<boolean>} True if an Anatel tab is active
   */
  async checkUserHasActiveAnatelTab() {
    const CHROME_DEBUG_PORT = 9222;

    try {
      // Try to fetch list of tabs from Chrome Remote Debugging
      // Chrome must be started with --remote-debugging-port=9222
      const axios = require('axios');
      const response = await axios.get(`http://localhost:${CHROME_DEBUG_PORT}/json`, {
        timeout: 5000
      });

      console.log(`   📋 Total de abas encontradas no Chrome: ${response.data.length}`);

      // Check if any tab has Anatel URL (multiple patterns)
      const anatelPatterns = [
        'anatel.gov.br',
        'apps.anatel.gov.br',
        'sistemas.anatel.gov.br',
        'ColetaDados',
        'CadastroEstacaoExt'
      ];

      const hasAnatelTab = response.data.some(tab => {
        if (!tab.url) return false;
        return anatelPatterns.some(pattern => tab.url.includes(pattern));
      });

      if (hasAnatelTab) {
        console.log(`   ✓ Detectada aba Anatel no Chrome (via Remote Debugging)`);
      } else {
        console.log(`   ⊗ Nenhuma aba Anatel encontrada no Chrome`);
      }

      return hasAnatelTab;

    } catch (error) {
      if (error.code === 'ECONNREFUSED') {
        console.log(`   ⚠ Chrome Remote Debugging não disponível (porta ${CHROME_DEBUG_PORT})`);
        if (this.options.forceRefreshNoDebug) {
          console.log(`   ✓ FORCE_REFRESH_NO_DEBUG está ATIVO - fazendo refresh mesmo sem Remote Debugging`);
          return true;
        } else {
          console.log(`     Para ativar: Inicie Chrome com --remote-debugging-port=${CHROME_DEBUG_PORT}`);
        }
      } else {
        console.log(`   ⚠ Erro ao verificar abas: ${error.message}`);
      }
      return this.options.forceRefreshNoDebug || false;
    }
  }

  /**
   * Start the keep-alive loop with user activity detection
   */
  startKeepAliveLoop() {
    const scheduleNextRefresh = () => {
      const interval = this.getRandomInterval();
      console.log(`\n⏰ Próximo refresh em: ${this.formatTime(interval)} (intervalo aleatório)`);

      this.keepAliveTimer = setTimeout(async () => {
        // Check if user has active Anatel tab before refreshing
        const hasActiveTab = await this.checkUserHasActiveAnatelTab();

        if (hasActiveTab) {
          console.log(`[${new Date().toLocaleTimeString()}] Status: PÁGINA ANATEL ABERTA no navegador - INICIANDO REFRESH`);
          await this.refreshSession();
        } else {
          console.log(`[${new Date().toLocaleTimeString()}] ========================================================`);
          console.log(`[${new Date().toLocaleTimeString()}] Status: PÁGINA ANATEL NÃO ESTÁ ABERTA no navegador`);
          console.log(`[${new Date().toLocaleTimeString()}] Status: AGUARDANDO sem fazer refresh`);
          console.log(`[${new Date().toLocaleTimeString()}] Dica: Abra uma das páginas Anatel no Chrome e inicie com --remote-debugging-port=9222:`);
          console.log(`[${new Date().toLocaleTimeString()}]       - ${this.ANATEL_URLS.join('\n       - ')}`);
          console.log(`[${new Date().toLocaleTimeString()}] ========================================================`);
        }

        scheduleNextRefresh();
      }, interval);
    };

    scheduleNextRefresh();
  }

  /**
   * Get a page for operations (reuse existing or create new)
   * @returns {Promise<Page>} Playwright page instance
   */
  async getPage() {
    if (!this.isStarted) {
      throw new Error("SessionKeeper não está iniciado. Chame start() primeiro.");
    }

    // Return the main page
    return this.page;
  }

  /**
   * Create a new page in the same context
   * @returns {Promise<Page>} New Playwright page instance
   */
  async newPage() {
    if (!this.isStarted) {
      throw new Error("SessionKeeper não está iniciado. Chame start() primeiro.");
    }

    if (!this.context) {
      throw new Error("Contexto não disponível");
    }

    return await this.context.newPage();
  }

  /**
   * Get status information
   * @returns {Object} Status object
   */
  getStatus() {
    return {
      isStarted: this.isStarted,
      isRefreshing: this.isRefreshing,
      keepAliveEnabled: this.options.keepAlive,
      lastRefreshTime: this.lastRefreshTime?.toISOString() || null,
      refreshCount: this.refreshCount,
      profile: this.options.profile,
      headless: this.options.headless,
      browserConnected: this.browser?.isConnected() || false,
      // URLs de keep-alive
      keepAliveUrls: this.ANATEL_URLS,
      // Configurações de intervalo
      intervals: {
        minKeepAliveMinutes: this.options.minInterval,
        maxKeepAliveMinutes: this.options.maxInterval,
        cookieRefreshMinutes: this.options.cookieRefreshInterval,
        forceRefreshNoDebug: this.options.forceRefreshNoDebug,
      },
      cookieRefresh: {
        lastExtraction: this.lastCookieExtraction?.toISOString() || null,
        cookieRefreshCount: this.cookieRefreshCount,
        refreshIntervalMinutes: this.options.cookieRefreshInterval,
        validationPending: this.cookieValidationPending,
      },
      health: {
        consecutiveFailures: this.consecutiveFailures,
        maxConsecutiveFailures: this.maxConsecutiveFailures,
        status: this.consecutiveFailures >= this.maxConsecutiveFailures ? 'degraded' : 'healthy',
      },
      history: this.refreshHistory,
    };
  }

  /**
   * Get refresh history only
   * @param {number} limit - Maximum number of entries to return (default: all)
   * @returns {Array} Array of refresh history entries
   */
  getRefreshHistory(limit = null) {
    if (limit && limit > 0) {
      return this.refreshHistory.slice(-limit);
    }
    return this.refreshHistory;
  }

  /**
   * Stop the SessionKeeper and close browser
   * @returns {Promise<void>}
   */
  async stop() {
    console.log("\nParando SessionKeeper...");

    // Clear keep-alive timer
    if (this.keepAliveTimer) {
      clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    // Close browser
    if (this.browser) {
      console.log("Fechando navegador...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }

    // Reset state
    this.cookieValidationPending = false;
    this.pendingCookieRefresh = null;
    this.isStarted = false;
    console.log("SessionKeeper parado.");
  }
}

// ============================================================================
// CLI STANDALONE EXECUTION
// ============================================================================

if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const profile = args.find(a => a.startsWith('--profile='))?.split('=')[1] || 'Default';
  const headless = !args.includes('--visible');

  const keeper = new SessionKeeper({
    profile,
    headless,
    keepAlive: true,
    minInterval: 1,
    maxInterval: 10,
  });

  // Handle graceful shutdown
  const shutdown = async () => {
    console.log("\n\nRecebido sinal de encerramento...");
    await keeper.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start and keep running
  keeper.start().catch(error => {
    console.error("Erro fatal:", error);
    process.exit(1);
  });

  // Keep process alive
  setInterval(() => {
    const status = keeper.getStatus();
    const healthStatus = status.health.status === 'degraded' ? ' [DEGRADADO]' : '';
    console.log(`\n[${new Date().toLocaleTimeString()}] Status: ${status.browserConnected ? 'Conectado' : 'Desconectado'} | Refreshes: ${status.refreshCount}${healthStatus}`);
  }, 60000); // Log status every minute
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { SessionKeeper };
