# Sr. Robô — Integrações & Barramento de Eventos

Repositório central de contratos, barramento de eventos (BullMQ × Valkey), relays e workers da plataforma de e-commerce da **Sr. Robô**.

## Estrutura do Repositório

- `contracts/`: JSON Schemas v1 do envelope canônico e eventos de negócio.
- `tests/`: Suite de validação dos schemas e testes de conformidade.
- `smoke-tests/`: Scripts de validação de infraestrutura e dependências (ex.: BullMQ × Valkey).
- `workflows/`: Exportações versionadas dos workflows do n8n (fonte de verdade).

## Versões Pinadas de Referência

- **Valkey**: `valkey/valkey:8.0.2-alpine`
- **Node.js**: `20.x`
- **BullMQ**: `5.x`
- **ioredis**: `5.x`

## Validação de Contratos

```bash
npm install
npm test
```

## Histórico de Evoluções de Contrato (Aditivas / Compatíveis)

- **Fase 3 (2026-09-04)**: Adicionado campo opcional `customer.tax_id` no schema `order.placed.schema.json` v1 (pattern `^(\\d{11}|\\d{14})$` para CPF/CNPJ sem pontuação). Evolução estritamente aditiva sem alteração de `event_version`.
