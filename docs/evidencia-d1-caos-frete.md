# Evidência de Caos D1 — API dos Correios Caída / Indisponível

- **Data**: 2026-09-04T01:14:23-03:00
- **Cenário**: Simulação de indisponibilidade externa da API dos Correios CWS (sem credenciais ou host inacessível).
- **Objetivo**: Garantir que o Gateway de Frete nunca trave o checkout e responda com a tabela de fallback em <100ms.

## 1. Requisição de Teste

```json
POST /shipping/quote
{
  "postal_code": "01001-000",
  "weight_g": 500
}
```

## 2. Resposta do Gateway

- **HTTP Status**: 200
- **Tempo Total**: 67ms
- **Origem dos Dados**: `fallback`

```json
{
  "methods": [
    {
      "code": "sedex",
      "name": "Correios SEDEX",
      "price": 42.5,
      "delivery_days": 2,
      "source": "fallback"
    },
    {
      "code": "pac",
      "name": "Correios PAC",
      "price": 28.9,
      "delivery_days": 7,
      "source": "fallback"
    }
  ],
  "source": "fallback"
}
```

## 3. Comportamento Observado

1. A API externa não esteve disponível / falhou.
2. O Circuit Breaker acionou a tabela `frete_fallback` persistida no Postgres Central (`database integracoes`).
3. A rota síncrona `/shipping/quote` respondeu em **67ms** (<100ms), devolvendo métodos PAC e SEDEX válidos para que o checkout do EverShop feche a compra normalmente.
4. Alerta leve foi despachado via ntfy em background sem bloquear o fluxo do comprador.

**Resultado**: APROVADO.
