#!/usr/bin/env python3
"""
================================================================================
ANATEL SCRAPER - Acesso Automatizado ao Portal de Sistemas da Anatel
================================================================================

DESCRIÇÃO:
    Script para acessar o portal https://apps.anatel.gov.br/acesso/ de forma
    automatizada, utilizando a sessão existente do Google Chrome. O script
    extrai os cookies de autenticação do navegador e os utiliza em um
    navegador headless (Playwright) para acessar o portal sem necessidade
    de login manual.

FUNCIONALIDADES:
    1. Extração de Cookies do Chrome
       - Utiliza a biblioteca browser_cookie3 para extrair cookies
       - Filtra apenas cookies do domínio .anatel.gov.br
       - Converte cookies para formato compatível com Playwright

    2. Navegação Headless
       - Usa Playwright com Chromium em modo headless (sem interface gráfica)
       - Simula User-Agent do Chrome real para evitar bloqueios
       - Aguarda carregamento completo da página (networkidle)

    3. Verificação de Autenticação
       - Detecta se a página está na tela de login ou autenticada
       - Busca por palavras-chave que indicam página de login
       - Retorna status de sucesso ou falha

    4. Extração de Conteúdo
       - Captura título da página
       - Extrai texto visível do corpo da página
       - Lista todos os sistemas disponíveis para o usuário

    5. Captura de Screenshot
       - Salva imagem PNG da página para debug/verificação
       - Útil para confirmar visualmente o estado da página

DEPENDÊNCIAS:
    - playwright: Automação de navegador
    - browser-cookie3: Extração de cookies do Chrome

    Instalação:
        pip install playwright browser-cookie3
        playwright install chromium

REQUISITOS:
    - Google Chrome instalado com perfil "Default"
    - Sessão ativa (logada) no site da Anatel no Chrome
    - O Chrome pode estar fechado, desde que a sessão não tenha expirado

USO:
    python3 anatel_scraper.py

SAÍDA:
    - Exibe URL atual, título e conteúdo da página no terminal
    - Salva screenshot em: /home/paulo/Área de Trabalho/scrap/anatel_screenshot.png
    - Indica se a autenticação foi bem-sucedida ou não

AUTOR: Gerado por Claude Code
DATA: Janeiro 2026
================================================================================
"""

import os
import shutil
import tempfile
from playwright.sync_api import sync_playwright
import time

# =============================================================================
# CONFIGURAÇÕES
# =============================================================================

# URL do portal Anatel
ANATEL_URL = "https://apps.anatel.gov.br/acesso/"

# Caminho para salvar o screenshot
SCREENSHOT_PATH = "/home/paulo/Área de Trabalho/scrap/anatel_screenshot.png"

# Domínio para filtrar cookies
COOKIE_DOMAIN = ".anatel.gov.br"

# Timeout para carregamento da página (em milissegundos)
PAGE_TIMEOUT = 30000

# User-Agent para simular Chrome real
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"

# Palavras que indicam página de login (não autenticada)
# Se qualquer uma dessas palavras for encontrada, a página NÃO está autenticada
# NOTA: Removidos falsos positivos ("Coleta de Dados", "gov.br")
LOGIN_WORDS = [
    "Entrar com gov.br",
    "Faça login para acessar",
    "Área de Login",
    "Identifique-se",
]


# =============================================================================
# FUNÇÕES
# =============================================================================

def check_authenticated(page_url: str, page_content: str) -> tuple[bool, str | None]:
    """
    Verifica se a página está autenticada usando validação em 4 camadas.

    CAMADA 1: URL (mais confiável) - Detecta Login.aspx, /oauth, /login
    CAMADA 2: HTML básico - Valida tamanho mínimo e presença de <body>
    CAMADA 3: Elementos positivos - Botões "Sair", info de usuário
    CAMADA 4: Palavras de login - Último recurso, sem falsos positivos

    Args:
        page_url: URL atual da página
        page_content: Conteúdo HTML completo da página

    Returns:
        tuple: (is_authenticated, reason)
            - is_authenticated: True se autenticado, False caso contrário
            - reason: Razão do resultado (para logging)

    Exemplo:
        >>> is_auth, reason = check_authenticated("https://apps.anatel.gov.br/", "<html>...</html>")
        >>> print(is_auth)  # True/False
        >>> print(reason)   # "URL indica login" ou "Elementos positivos..."
    """
    # CAMADA 1: URL (mais confiável)
    url_lower = page_url.lower()
    if "login.aspx" in url_lower or "/oauth" in url_lower or "/login" in url_lower:
        return False, f"URL indica login: {page_url}"

    # CAMADA 0: Validar HTML básico (evitar falso positivo com conteúdo vazio)
    if len(page_content) < 1000:
        return False, "Conteúdo muito pequeno, possível redirecionamento"
    if "<body" not in page_content.lower():
        return False, "HTML inválido (sem body)"

    # CAMADA 2: Elementos positivos (indicadores mais confiáveis)
    positive_indicators = [
        "encerrar sessão",
        "alterar senha",
        "menu principal",
        "bem vindo",
        "bem-vindo",
    ]
    content_lower = page_content.lower()
    for indicator in positive_indicators:
        if indicator in content_lower:
            return True, "Elementos positivos de autenticação encontrados"

    # CAMADA 3: Palavras de login
    for word in LOGIN_WORDS:
        if word.lower() in content_lower:
            return False, f"Conteúdo contém: '{word}'"

    # CAMADA 4: Padrão seguro (ausência de evidência de não autenticação)
    return True, "Sem evidência de não autenticação"


def extract_chrome_cookies(domain: str = COOKIE_DOMAIN) -> list:
    """
    Extrai cookies do Google Chrome para um domínio específico.

    Utiliza a biblioteca browser_cookie3 para acessar o banco de dados
    de cookies do Chrome e filtrar pelos cookies do domínio especificado.

    Args:
        domain: Domínio para filtrar cookies (ex: ".anatel.gov.br")

    Returns:
        list: Lista de objetos Cookie do http.cookiejar

    Raises:
        Exception: Se não conseguir acessar os cookies do Chrome

    Nota:
        - O Chrome deve estar instalado com perfil Default
        - Os cookies são criptografados, mas browser_cookie3 os descriptografa
    """
    try:
        import browser_cookie3
        cookies = browser_cookie3.chrome(domain_name=domain)
        cookie_list = list(cookies)
        print(f"Encontrados {len(cookie_list)} cookies para {domain}")
        return cookie_list
    except Exception as e:
        print(f"Aviso: Não foi possível extrair cookies: {e}")
        return []


def convert_cookies_to_playwright(cookie_list: list) -> list[dict]:
    """
    Converte cookies do formato http.cookiejar para formato Playwright.

    O Playwright requer cookies em formato de dicionário com campos específicos.
    Esta função faz a conversão e tratamento de tipos.

    Args:
        cookie_list: Lista de cookies do browser_cookie3

    Returns:
        list[dict]: Lista de cookies no formato Playwright

    Formato do cookie Playwright:
        {
            "name": str,      # Nome do cookie
            "value": str,     # Valor do cookie
            "domain": str,    # Domínio (deve começar com ".")
            "path": str,      # Caminho (default: "/")
            "secure": bool,   # Se requer HTTPS
            "httpOnly": bool, # Se é HttpOnly
            "expires": float  # Timestamp de expiração (opcional)
        }
    """
    playwright_cookies = []

    for c in cookie_list:
        cookie_dict = {
            "name": c.name,
            "value": c.value,
            "domain": c.domain if c.domain.startswith(".") else "." + c.domain,
            "path": c.path or "/",
            "secure": bool(c.secure),
            "httpOnly": bool(
                getattr(c, 'httpOnly', False) or
                getattr(c, '_rest', {}).get('HttpOnly', False)
            ),
        }

        # Adicionar expires apenas se existir e for válido
        if c.expires and c.expires > 0:
            cookie_dict["expires"] = float(c.expires)

        playwright_cookies.append(cookie_dict)

    return playwright_cookies


def add_cookies_to_context(context, playwright_cookies: list[dict]) -> int:
    """
    Adiciona cookies ao contexto do Playwright.

    Tenta adicionar todos os cookies de uma vez. Se falhar, tenta
    adicionar um por um para identificar cookies problemáticos.

    Args:
        context: BrowserContext do Playwright
        playwright_cookies: Lista de cookies no formato Playwright

    Returns:
        int: Número de cookies adicionados com sucesso
    """
    if not playwright_cookies:
        return 0

    try:
        context.add_cookies(playwright_cookies)
        print(f"Adicionados {len(playwright_cookies)} cookies ao contexto")
        return len(playwright_cookies)
    except Exception as e:
        print(f"Erro ao adicionar cookies em lote: {e}")
        print("Tentando adicionar cookies individualmente...")

        success_count = 0
        for i, cookie in enumerate(playwright_cookies):
            try:
                context.add_cookies([cookie])
                success_count += 1
            except Exception as ce:
                print(f"  Cookie {i} ({cookie['name']}): {ce}")

        print(f"Adicionados {success_count}/{len(playwright_cookies)} cookies")
        return success_count


def scrape_anatel_page(url: str = ANATEL_URL) -> dict:
    """
    Realiza o scraping da página do portal Anatel.

    Função principal que orquestra todo o processo:
    1. Extrai cookies do Chrome
    2. Inicia navegador headless
    3. Adiciona cookies ao contexto
    4. Acessa a URL
    5. Verifica autenticação
    6. Extrai conteúdo
    7. Salva screenshot

    Args:
        url: URL do portal Anatel

    Returns:
        dict: Resultado do scraping contendo:
            - success: bool - Se a autenticação foi bem-sucedida
            - url: str - URL atual após navegação
            - title: str - Título da página
            - content: str - Texto visível da página
            - html: str - HTML completo da página
            - screenshot: str - Caminho do screenshot salvo
            - error: str | None - Mensagem de erro, se houver
    """
    result = {
        "success": False,
        "url": None,
        "title": None,
        "content": None,
        "html": None,
        "screenshot": None,
        "error": None
    }

    # Extrair cookies do Chrome
    print("Tentando extrair cookies do Chrome...")
    cookie_list = extract_chrome_cookies()

    with sync_playwright() as p:
        # Criar diretório temporário para o contexto
        temp_dir = tempfile.mkdtemp()

        try:
            print("Iniciando navegador headless...")
            browser = p.chromium.launch(headless=True)

            # Criar contexto com User-Agent personalizado
            context = browser.new_context(user_agent=USER_AGENT)

            # Converter e adicionar cookies
            if cookie_list:
                playwright_cookies = convert_cookies_to_playwright(cookie_list)
                add_cookies_to_context(context, playwright_cookies)

            # Criar página e navegar
            page = context.new_page()
            print(f"Acessando: {url}")

            try:
                page.goto(url, wait_until="networkidle", timeout=PAGE_TIMEOUT)
            except Exception as e:
                print(f"Timeout ou erro ao carregar: {e}")
                result["error"] = str(e)

            # Loop para verificar se está na página de login e continuar tentando se não estiver
            max_attempts = 10
            attempt = 0

            while attempt < max_attempts:
                attempt += 1

                # Aguardar carregamento completo
                time.sleep(2)

                # Extrair informações da página
                result["url"] = page.url
                result["title"] = page.title()
                result["html"] = page.content()
                result["content"] = page.inner_text("body")

                print(f"\n--- Verificação {attempt}/{max_attempts} ---")
                print(f"URL atual: {result['url']}")
                print(f"Título: {result['title']}")

                # Verificar se está na página de login
                is_auth, found_word = check_authenticated(result["url"], result["html"])

                if not is_auth:
                    # PÁGINA DE LOGIN DETECTADA - PARAR
                    result["success"] = False
                    print(f"\n⚠ PÁGINA DE LOGIN DETECTADA - PARANDO")
                    print(f"  Palavra encontrada: '{found_word}'")
                    print("  Não será feita nova tentativa de acesso.")
                    result["error"] = f"Página de login detectada - palavra: '{found_word}'"
                    break
                else:
                    # NÃO está na página de login - continuar fazendo refresh
                    print(f"  ✓ Página OK (não é página de login)")
                    if attempt < max_attempts:
                        print(f"  Fazendo refresh...")
                        page.reload(wait_until="networkidle", timeout=PAGE_TIMEOUT)

            # Se completou todas as tentativas sem detectar página de login
            if attempt >= max_attempts and not result.get("error"):
                result["success"] = True
                print("\n✓ SUCESSO: Página autenticada após verificações!")
                print("\nConteúdo da página:")
                print("-" * 50)
                content_preview = result["content"][:2000] if len(result["content"]) > 2000 else result["content"]
                print(content_preview)

            # Salvar screenshot
            page.screenshot(path=SCREENSHOT_PATH)
            result["screenshot"] = SCREENSHOT_PATH
            print(f"\nScreenshot salvo em: {SCREENSHOT_PATH}")

            browser.close()

        finally:
            # Limpar diretório temporário
            shutil.rmtree(temp_dir, ignore_errors=True)

    return result


def list_available_systems(content: str) -> list[str]:
    """
    Extrai lista de sistemas disponíveis do conteúdo da página.

    Analisa o texto da página para identificar os nomes dos sistemas
    da Anatel que o usuário tem acesso.

    Args:
        content: Texto visível da página

    Returns:
        list[str]: Lista de nomes de sistemas encontrados

    Nota:
        Esta função usa heurística simples e pode precisar de ajustes
        se o layout da página mudar.
    """
    # Sistemas conhecidos da Anatel
    known_systems = [
        "Acervo Documental", "Busca Ofertas", "Coleta de Dados",
        "Comparador Operadora", "EnviaOfertas", "Mala Direta",
        "Mosaico - UTE", "Participa Anatel", "SARH", "SCPX",
        "SFUST", "SGIQ", "SICAP", "SATVA", "SIACCO", "BOLETO",
        "SMMDS", "STVC", "SCRA", "SDTA", "SEC", "SGMU", "SGPS",
        "STEL", "SIGEC", "Mosaico", "SRD", "SRT", "AreaArea",
        "Arco", "Arco Boleto", "Atende+ CallCenter", "AvalIA",
        "Certifica", "e-Fiscaliza"
    ]

    found_systems = []
    for system in known_systems:
        if system in content:
            found_systems.append(system)

    return found_systems


# =============================================================================
# PONTO DE ENTRADA
# =============================================================================

def main():
    """
    Função principal - ponto de entrada do script.

    Executa o scraping e exibe os resultados no terminal.
    """
    result = scrape_anatel_page()

    if result["success"]:
        # Listar sistemas disponíveis
        systems = list_available_systems(result["content"])
        if systems:
            print("\n" + "=" * 50)
            print("SISTEMAS DISPONÍVEIS:")
            print("=" * 50)
            for i, system in enumerate(systems, 1):
                print(f"  {i:2}. {system}")

    return result


if __name__ == "__main__":
    main()
