# Melhorias no Cache de Cookies - Session Keeper

## Data: 2026-03-10

## Problemas Solucionados

### 1. Cache Expirado Após Reinicialização
**Problema:** Ao reiniciar o servidor, o cache podia conter cookies que já não eram mais válidos no servidor da Anatel.

**Solução Implementada:**
- Invalidação automática do cache ao iniciar o Session Keeper
- Nova variável de ambiente: `INVALIDATE_CACHE_ON_STARTUP` (default: `true`)
- Ao iniciar, o sistema verifica e remove cache antigo antes de tentar usá-lo

### 2. Validação Agressiva de Cache
**Problema:** O cache tinha TTL de 5 minutos, mas os cookies podiam expirar no servidor antes disso.

**Solução Implementada:**
- Novo campo `validatedAt` no cache para rastrear quando foi validado pela última vez
- Validação exige que o cache tenha sido validado nos últimos 60 segundos
- Nova configuração: `COOKIE_CACHE_MAX_VALIDATION_AGE` (default: 60 segundos)

### 3. Sessão Manual do Usuário
**Problema:** Quando o usuário acessa o Chrome manualmente, pode criar uma nova sessão que difere da cacheada.

**Solução Implementada:**
- Ao validar cache com sucesso, o timestamp `validatedAt` é atualizado
- Se o cache falhar na validação HTTP, é automaticamente invalidado
- O sistema volta ao Chrome para extrair cookies frescos

## Configurações

### Variáveis de Ambiente

```bash
# Invalidar cache ao iniciar (default: true)
INVALIDATE_CACHE_ON_STARTUP=true

# TTL do cache em minutos (default: 5)
COOKIE_CACHE_TTL=5

# Idade máxima da validação em segundos (default: 60)
# O cache precisa ter sido validado neste período para ser usado
COOKIE_CACHE_MAX_VALIDATION_AGE=60
```

### Estrutura do Cache

```json
{
  "timestamp": 1773137871416,        // Quando os cookies foram extraídos
  "validatedAt": 1773138130000,      // Quando foi validado pela última vez
  "cookies": [...]
}
```

## Comportamento Esperado

### Ao Iniciar o Session Keeper

```
[STARTUP] 🔍 Verificando cache de cookies...
[STARTUP] 🗑️  Cache antigo encontrado - invalidando para garantir cookies frescos
[STARTUP] ✓ Nenhum cache antigo encontrado
```

### Durante Operação Normal

```
[COOKIE CACHE] ✓ CACHE HIT (19 cookies, age: 120s, validated: 30s ago)
[SESSION WAIT] ✅ Cache válido, atualizando timestamp de validação
[COOKIE CACHE] ✓ Cache validation timestamp updated
```

### Quando Cache Expira

```
[COOKIE CACHE] ⚠ Cache validation too old (validated: 90s ago, max: 60s)
[COOKIE CACHE] ✗ CACHE MISS - extracting from Chrome
[COOKIE EXTRACTION] ✓ 19 cookies extraídos com sucesso
```

## Fluxo de Decisão do Cache

```
┌─────────────────────────────────────────────────────────────┐
│  SessionKeeper inicia                                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
        ┌──────────────────────────────┐
        │ Existe cache arquivo?        │
        └────────────┬─────────────────┘
                     │
          ┌──────────┴──────────┐
          │ NÃO                 │ SIM
          ▼                     ▼
    ┌──────────┐      ┌──────────────────────┐
    │ Usa      │      │ INVALIDATE_ON_STARTUP?│
    │ Chrome   │      └──────────┬───────────┘
    └──────────┘                 │
                        ┌────────┴────────┐
                        │ SIM             │ NÃO
                        ▼                 ▼
                  ┌──────────┐      ┌──────────────────┐
                  │ Deleta   │      │ Verifica idade   │
                  │ cache    │      │ e validação      │
                  └─────┬────┘      └────────┬─────────┘
                        │                    │
                        └──────────┬─────────┘
                                   ▼
                        ┌──────────────────────┐
                        │ Tenta usar cache     │
                        └──────────┬───────────┘
                                   │
                        ┌──────────┴────────┐
                        │ Válido?           │
                        ▼                   ▼
                  ┌──────────┐        ┌──────────┐
                  │ Usa      │        │ Deleta   │
                  │ cache    │        │ cache    │
                  └──────────┘        │ e usa    │
                                     │ Chrome   │
                                     └──────────┘
```

## Benefícios

1. **Confiabilidade**: Sempre usa cookies frescos após reinicialização
2. **Segurança**: Validação HTTP garante que cookies funcionam
3. **Eficiência**: Cache ainda é usado quando válido (evita extração desnecessária)
4. **Transparência**: Logs detalhados mostram exatamente o que está acontecendo

## Troubleshooting

### Cache sempre invalidado ao iniciar

**Causa:** `INVALIDATE_CACHE_ON_STARTUP=true`

**Solução:** Se você quer preservar cache entre reinícios:
```bash
INVALIDATE_CACHE_ON_STARTUP=false
```

### Erro "Cache validation too old"

**Causa:** O cache foi validado há mais de 60 segundos

**Solução:** Aumente o tempo máximo:
```bash
COOKIE_CACHE_MAX_VALIDATION_AGE=120  # 2 minutos
```

### Cookies extraídos do Chrome toda vez

**Causa:** Cache sendo invalidado ou não passando na validação

**Solução:** Verifique logs para ver o motivo da invalidação:
```bash
pm2 logs session-keeper | grep "COOKIE CACHE"
```

## Monitoramento

Use os endpoints da API para monitorar o cache:

```bash
# Ver status da sessão
curl http://localhost:7012/api/session/status

# Ver histórico de refreshes
curl http://localhost:7012/api/session/history

# Ver estatísticas
curl http://localhost:7012/api/session/stats
```

## Migração

Não é necessário nenhuma ação. As melhorias são compatíveis com cache existente.

O cache antigo (sem campo `validatedAt`) será tratado como `validatedAt = timestamp`.
