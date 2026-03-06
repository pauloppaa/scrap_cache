# Git & GitHub CLI - Guia Completo

Guia prático para usar Git e GitHub CLI (gh) no desenvolvimento de projetos.

---

## 📋 Índice

1. [Comandos Básicos do Git](#comandos-básicos-do-git)
2. [GitHub CLI - Instalação e Configuração](#github-cli---instalação-e-configuração)
3. [Fluxo de Trabalho com Git](#fluxo-de-trabalho-com-git)
4. [Criando Repositórios](#criando-repositórios)
5. [Comandos Úteis](#comandos-úteis)
6. [Boas Práticas](#boas-práticas)
7. [Solução de Problemas](#solução-de-problemas)

---

## 🚀 Comandos Básicos do Git

### Inicializar Repositório

```bash
# Iniciar novo repositório
git init

# Clonar repositório existente
git clone <url-do-repositório>

# Ver status do repositório
git status
```

### Configuração

```bash
# Configurar nome global
git config --global user.name "Seu Nome"

# Configurar email global
git config --global user.email "seu@email.com"

# Configurar nome local (apenas este repo)
git config user.name "Seu Nome"

# Ver configuração
git config --list
```

### Trabalhando com Arquivos

```bash
# Adicionar arquivo específico
git add arquivo.py

# Adicionar todos os arquivos
git add .

# Adicionar todos os arquivos modificados
git add -u

# Commitar mudanças
git commit -m "Mensagem do commit"

# Adicionar e commitar em um comando
git commit -am "Mensagem do commit"
```

### Histórico e Logs

```bash
# Ver histórico de commits
git log

# Ver histórico resumido (uma linha)
git log --oneline

# Ver últimos N commits
git log --oneline -5

# Ver gráfico de commits
git log --graph --oneline --all
```

### Branches

```bash
# Listar branches
git branch

# Criar nova branch
git branch nome-da-branch

# Trocar de branch
git checkout nome-da-branch

# Criar e trocar para nova branch
git checkout -b nome-da-branch

# Renomear branch atual
git branch -m novo-nome

# Deletar branch
git branch -d nome-da-branch

# Deletar branch remotamente
git push origin --delete nome-da-branch
```

---

## 🔧 GitHub CLI - Instalação e Configuração

### Instalação

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install gh
```

**Via Snap:**
```bash
sudo snap install gh
```

### Autenticação

```bash
# Fazer login no GitHub
gh auth login
```

Durante o login, escolha:
1. **GitHub.com** (ou GitHub Enterprise se usar)
2. **HTTPS** (ou SSH se preferir)
3. **Login with a web browser** (recomendado)

### Verificar Autenticação

```bash
# Ver status da autenticação
gh auth status

# Ver informações do usuário
gh auth status
```

---

## 📦 Criando Repositórios

### Método 1: Via GitHub CLI (Recomendado)

```bash
# Criar repositório público e fazer push
gh repo create nome-do-repo --public --source=. --remote=origin --push

# Criar repositório privado e fazer push
gh repo create nome-do-repo --private --source=. --remote=origin --push

# Criar repositório com descrição
gh repo create nome-do-repo --public --description "Descrição do projeto" --source=. --push

# Criar sem fazer push automaticamente
gh repo create nome-do-repo --public
git remote add origin https://github.com/usuario/nome-do-repo.git
git push -u origin main
```

### Método 2: Manual (Site do GitHub)

1. Acesse https://github.com/new
2. Preencha:
   - **Nome do repositório:** `nome-do-projeto`
   - **Descrição:** Descrição breve
   - **Visibilidade:** Público ou Privado
3. Clique em "Create repository"
4. Siga as instruções para conectar e fazer push

### Método 3: Converter Repo Local em Remoto

```bash
# Inicializar repositório
git init

# Adicionar arquivos
git add .
git commit -m "Primeiro commit"

# Criar repositório no GitHub (via site ou CLI)

# Adicionar remote
git remote add origin https://github.com/usuario/nome-do-repo.git

# Renomear branch principal para main (se necessário)
git branch -M main

# Fazer push
git push -u origin main
```

---

## 🔄 Fluxo de Trabalho com Git

### Fluxo Básico

```bash
# 1. Fazer mudanças nos arquivos
vim arquivo.py

# 2. Ver status
git status

# 3. Adicionar arquivos
git add arquivo.py

# 4. Commitar
git commit -m "Adiciona nova funcionalidade"

# 5. Fazer push (se tiver remote)
git push
```

### Fluxo com Branchs

```bash
# 1. Criar branch para nova feature
git checkout -b feature/nova-funcionalidade

# 2. Fazer mudanças e commitar
git add .
git commit -m "Adiciona nova funcionalidade"

# 3. Fazer push da branch
git push -u origin feature/nova-funcionalidade

# 4. Criar Pull Request (via web ou CLI)
gh pr create --title "Nova Funcionalidade" --body "Descrição da PR"

# 5. Após merge, voltar para main
git checkout main
git pull

# 6. Deletar branch local
git branch -d feature/nova-funcionalidade
```

---

## 🛠️ Comandos Úteis

### Desfazer Mudanças

```bash
# Desfazer mudanças em arquivo (não commitado)
git restore arquivo.py

# Desfazer todas as mudanças
git restore .

# Remover arquivo do staging (mas manter mudanças)
git restore --staged arquivo.py

# Resetar para commit anterior (cuidado!)
git reset --hard HEAD~1

# Reverter commit específico
git revert <hash-do-commit>
```

### Ver Diferenças

```bash
# Ver diferenças não commitadas
git diff

# Ver diferenças de arquivo específico
git diff arquivo.py

# Ver diferenças entre commits
git diff commit1..commit2

# Ver diferenças entre branches
git diff main..feature-branch
```

### Trabalhando com Remotos

```bash
# Ver remotos configurados
git remote -v

# Adicionar remote
git remote add origin <url>

# Remover remote
git remote remove origin

# Alterar URL do remote
git remote set-url origin <nova-url>

# Buscar mudanças do remote
git fetch

# Buscar e merge (pull)
git pull

# Fazer push de branch
git push origin nome-da-branch

# Fazer push de todas as branches
git push --all origin
```

### GitHub CLI - Comandos Adicionais

```bash
# Criar issue
gh issue create --title "Título" --body "Descrição"

# Listar issues
gh issue list

# Ver issue específica
gh issue view 123

# Criar Pull Request
gh pr create --title "Título" --body "Descrição"

# Listar Pull Requests
gh pr list

# Ver Pull Request
gh pr view 456

# Fazer merge de PR
gh pr merge 456 --merge

# Abrir repositório no navegador
gh repo view --web

# Clonar repositório
gh repo clone usuario/repo

# Listar repositórios do usuário
gh repo list

# Ver informações do repositório
gh repo view
```

### Stash (Guardar Mudanças Temporariamente)

```bash
# Guardar mudanças atuais
git stash

# Guardar com mensagem
git stash save "Trabalho em progresso"

# Listar stashes
git stash list

# Aplicar stash mais recente
git stash pop

# Aplicar stash específico
git stash apply stash@{1}

# Remover stash
git stash drop stash@{1}
```

---

## 📚 Boas Práticas

### Mensagens de Commit

```bash
# ✅ Bom - Descritivo e no imperativo
git commit -m "Adiciona validação de email no formulário"

# ✅ Bom - Com corpo da mensagem
git commit -m "Corrige bug de autenticação

- Corrige validação de token
- Adiciona teste unitário
- Atualiza documentação"

# ❌ Ruim - Vago
git commit -m "Atualização"
git commit -m "Mudanças"
```

### Estrutura de Mensagens

```
<Tipo>(<escopo>): <assunto>

<body>

<footer>
```

**Tipos comuns:**
- `feat`: Nova funcionalidade
- `fix`: Correção de bug
- `docs`: Mudanças na documentação
- `style`: Formatação, ponto-e-vírgula, etc
- `refactor`: Refatoração de código
- `test`: Adicionar ou atualizar testes
- `chore`: Atualização de tasks, build, configs

### Nomes de Branches

```bash
# Feature
feature/nova-funcionalidade
feature/user-authentication

# Bugfix
bugfix/login-error
fix/payment-issue

# Hotfix
hotfix/security-patch

# Release
release/v1.0.0
```

### .gitignore

Crie sempre um `.gitignore` no início do projeto:

```bash
# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
venv/
env/
.venv

# Node
node_modules/
npm-debug.log
yarn-error.log

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Environment
.env
.env.local
```

---

## 🔍 Solução de Problemas

### Erro Comum: "not a git repository"

```bash
# Solução: Navegue para o diretório do projeto ou inicialize
cd /caminho/do/projeto
# ou
git init
```

### Erro Comum: "Author identity unknown"

```bash
# Solução: Configure seu usuário
git config --global user.name "Seu Nome"
git config --global user.email "seu@email.com"
```

### Erro Comum: "failed to push some refs"

```bash
# Solução: Pull antes de push
git pull origin main
git push origin main

# Ou force push (cuidado!)
git push --force origin main
```

### Ver Configurações

```bash
# Ver todas as configurações
git config --list

# Ver configurações globais
git config --global --list

# Ver configurações locais
git config --local --list
```

### Limpar Histórico

```bash
# Limpar commits locais (cuidado!)
git reset --hard HEAD

# Limpar arquivo do histórico completo
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch arquivo.txt" \
  --prune-empty --tag-name-filter cat -- --all
```

---

## 📖 Recursos Adicionais

### Documentação Oficial
- Git: https://git-scm.com/doc
- GitHub CLI: https://cli.github.com/manual/

### Tutoriais
- Git Interactive Tutorial: https://learngitbranching.js.org/
- GitHub Skills: https://skills.github.com/

### Comandos de Ajuda

```bash
# Ajuda do git
git help
git help commit

# Ajuda do GitHub CLI
gh help
gh help repo create
```

---

## 🎯 Exemplos Práticos

### Exemplo 1: Novo Projeto Python

```bash
# 1. Criar diretório
mkdir meu-projeto
cd meu-projeto

# 2. Inicializar git
git init

# 3. Criar .gitignore
echo "__pycache__/\nvenv/" > .gitignore

# 4. Criar arquivo principal
echo "# Meu Projeto" > README.md
echo "print('Olá Mundo')" > main.py

# 5. Commitar
git add .
git commit -m "Initial commit"

# 6. Criar repo no GitHub
gh repo create meu-projeto --public --source=. --push
```

### Exemplo 2: Clonar e Contribuir

```bash
# 1. Clonar repositório
gh repo clone usuario/projeto
cd projeto

# 2. Criar branch
git checkout -b feature/minha-contribuicao

# 3. Fazer mudanças e commitar
vim arquivo.py
git add arquivo.py
git commit -m "Adiciona nova funcionalidade"

# 4. Fazer push
git push -u origin feature/minha-contribuicao

# 5. Criar Pull Request
gh pr create --title "Minha Contribuição" --body "Descrição das mudanças"
```

### Exemplo 3: Deploy Automatizado

```bash
# Deploy para GitHub Pages
git checkout -b gh-pages
echo "Site deployado" > index.html
git add index.html
git commit -m "Deploy para GitHub Pages"
git push origin gh-pages

# Ativar GitHub Pages nas configurações do repo
gh repo view --web
```

---

**Criado em:** 2026-03-06
**Atualizado em:** 2026-03-06
**Versão:** 1.0
