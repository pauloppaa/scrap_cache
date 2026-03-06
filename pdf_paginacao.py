#!/usr/bin/env python3
"""
Aplicativo para adicionar paginação no rodapé de arquivos PDF.
A paginação é adicionada no canto inferior direito no formato "página/total".
"""

import sys
import argparse
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    print("Erro: A biblioteca PyMuPDF não está instalada.")
    print("Instale com: pip install PyMuPDF")
    sys.exit(1)


def adicionar_paginacao(arquivo_entrada, arquivo_saida=None, margem_direita=20, margem_inferior=20, tamanho_fonte=10):
    """
    Adiciona paginação no rodapé direito inferior de cada página do PDF.

    Args:
        arquivo_entrada: Caminho do arquivo PDF de entrada
        arquivo_saida: Caminho do arquivo PDF de saída (se None, sobrescreve o original)
        margem_direita: Margem da direita em pontos (padrão: 20)
        margem_inferior: Margem inferior em pontos (padrão: 20)
        tamanho_fonte: Tamanho da fonte em pontos (padrão: 10)
    """
    caminho_entrada = Path(arquivo_entrada)

    if not caminho_entrada.exists():
        raise FileNotFoundError(f"Arquivo não encontrado: {arquivo_entrada}")

    if caminho_entrada.suffix.lower() != '.pdf':
        raise ValueError("O arquivo deve ser um PDF")

    # Define o arquivo de saída
    if arquivo_saida is None:
        caminho_saida = caminho_entrada.parent / f"{caminho_entrada.stem}_paginado.pdf"
    else:
        caminho_saida = Path(arquivo_saida)

    print(f"Processando: {caminho_entrada.name}")
    print(f"Saída: {caminho_saida.name}")

    # Abre o PDF
    doc = fitz.open(caminho_entrada)
    total_paginas = len(doc)

    print(f"Total de páginas: {total_paginas}")
    print("Adicionando paginação...")

    # Processa cada página
    for num_pagina, pagina in enumerate(doc, start=1):
        # Obtém as dimensões da página
        rect = pagina.rect
        largura = rect.width
        altura = rect.height

        # Posição do texto (canto inferior direito)
        x_pos = largura - margem_direita
        y_pos = altura - margem_inferior

        # Cria o texto da paginação
        texto_paginacao = f"{num_pagina}/{total_paginas}"

        # Adiciona o texto à página
        # Usamos a fonte padrão helvética
        # Para alinhar à direita, calculamos a largura do texto e ajustamos a posição
        text_length = len(texto_paginacao) * tamanho_fonte * 0.5  # Estimativa da largura do texto
        x_pos_ajustado = x_pos - text_length

        pagina.insert_text(
            point=(x_pos_ajustado, y_pos),
            text=texto_paginacao,
            fontsize=tamanho_fonte,
            fontname="helv",
            color=(0, 0, 0)  # Preto
        )

    # Salva o novo PDF
    doc.save(caminho_saida, garbage=4, deflate=True)
    doc.close()

    print(f"\n✓ PDF com paginação criado com sucesso!")
    print(f"  Arquivo: {caminho_saida.absolute()}")
    print(f"  Tamanho: {caminho_saida.stat().st_size:,} bytes")

    return caminho_saida.absolute()


def main():
    parser = argparse.ArgumentParser(
        description='Adiciona paginação no rodapé direito inferior de um PDF.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemplos de uso:
  %(prog)s documento.pdf                    # Cria documento_paginado.pdf
  %(prog)s documento.pdf -o saida.pdf      # Especifica arquivo de saída
  %(prog)s documento.pdf -m 30 -s 12       # Margem 30pt, fonte 12pt
        """
    )

    parser.add_argument(
        'arquivo',
        help='Arquivo PDF de entrada'
    )

    parser.add_argument(
        '-o', '--output',
        help='Arquivo PDF de saída (padrão: nome_paginado.pdf)'
    )

    parser.add_argument(
        '-m', '--margem',
        type=int,
        default=20,
        help='Margem direita e inferior em pontos (padrão: 20)'
    )

    parser.add_argument(
        '-s', '--size',
        type=int,
        default=10,
        help='Tamanho da fonte em pontos (padrão: 10)'
    )

    args = parser.parse_args()

    try:
        adicionar_paginacao(
            args.arquivo,
            args.output,
            margem_direita=args.margem,
            margem_inferior=args.margem,
            tamanho_fonte=args.size
        )
    except Exception as e:
        print(f"\n✗ Erro: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
