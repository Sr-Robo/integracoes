# Relatório de Evidência: Fase 4 — Braço W (WMS & Invoicing)

**Data:** 2026-09-04  
**Ambiente:** Homologação Local (Docker Compose)  
**Status:** **APROVADO COM SUCESSO (100%)**

---

## 1. Escopo Validado (W1 -> W4 + V1)

| Etapa | Descrição | Resultado |
|---|---|---|
| **W1** | 24 SKUs com códigos de barras EAN-13 válidos + armazém `Stores - SR` garantido | **Aprovado** |
| **W2** | `order.paid` gera Sales Invoice idempotente com `update_stock = 0` | **Aprovado** |
| **W3** | Pick List criada via scan de código de barras -> Delivery Note criada com baixa real de estoque (`update_stock = 1`) | **Aprovado** |
| **W4** | Webhook de Delivery Note -> Criação de Shipment no EverShop -> Evento canônico `order.shipped` emitido no barramento -> E-mail de rastreio disparado | **Aprovado** |
| **V1** | Teste de Caos / Replay de `order.paid` não duplica Sales Invoice (idempotência de efeito estrita) | **Aprovado** |

---

## 2. Prova de Execução do Pipeline Ponta-a-Ponta

Executado via script automatizado `repos/integracoes/scripts/test-phase4-wms-pipeline.js`:

```text
================================================================
  TESTE DE PIPELINE PONTA-A-PONTA — FASE 4 WMS (W1 -> W4)
================================================================

[1/7] Inserindo pedido real na base do EverShop para vincular itens e UUID...
 -> Pedido #F4-TEST-8493 inserido na Loja (order_id=15, uuid=4481724a-a159-4322-af55-5103301197c3, item_id=15)

[2/7] Emitindo evento order.placed no outbox...
 -> order.placed inserido no outbox. Aguardando processamento pelo Relay + Worker + n8n...
 -> Sales Order criado no ERPNext: SAL-ORD-2026-00011 (Status: Draft, docstatus: 0)

[3/7] Emitindo evento order.paid no outbox (W2: Etiqueta + Faturamento)...
 -> order.paid inserido no outbox. Aguardando faturamento (Sales Invoice no ERPNext)...
 -> Sales Invoice criada com sucesso: ACC-SINV-2026-00003 (Sales Order per_billed: 100%)

[4/7] Testando Caos / Replay de order.paid (V1: Idempotência de Efeito)...
 -> PROVA DE REPLAY V1 APROVADA: Total de Invoices permaneceu 3 (zero duplicatas).

[5/7] Executando W3: Pick List com separação por Scanner de Código de Barras...
 -> Item SKU: B-0001 | Barcode EAN-13: 7891000000014
 -> Pick List criada e submetida via Scan de Barcode: STO-PICK-2026-00003

[6/7] Gerando e submetendo Delivery Note (Baixa Real de Estoque + Webhook)...
 -> Delivery Note submetida: MAT-DN-2026-00007 (Status: Completed)
 -> Webhook erp-dn disparado com sucesso para o n8n.

[7/7] Verificando ciclo fechado W4 (Loja Shipment + evento order.shipped no barramento)...
 -> Loja EverShop atualizada: Pedido #F4-TEST-8493 com shipment_status = 'shipped'
 -> Evento canônico order.shipped confirmado no barramento (Central DB: e513e191-2d0c-474b-b0bd-bb88ff65b3fb, status=completed)

================================================================
  CRITÉRIOS DO BRAÇO W (WMS) TOTALMENTE VALIDADOS COM SUCESSO! 
================================================================
```

---

## 3. Detalhamento dos Componentes Entregues

1. **Extensão EverShop (`order_events`)**:
   - Adicionado hook `insertShipment` em `repos/www/extensions/order_events/src/bootstrap.ts`.
   - Gera `order.shipped` automaticamente no `event_outbox` sempre que um envio for registrado.
   - Compilado em TypeScript e deployado no container `ecommerce_evershop`.

2. **HTTP Gateway de Integrações (`repos/integracoes`)**:
   - `src/shop/shipment-service.js`: Criação idempotente de `shipment` e `shipment_item` no EverShop via SQL direto.
   - Endpoint `POST /shop/create-shipment` exposto internamente na porta 9999.

3. **Automação n8n**:
   - Workflow `plataforma-eco-eventos` (`e89e3a75-b4c1-4b77-983b-f11111111111`):
     - Roteamento resiliente via nó de normalização de eventos.
     - `order.placed`: Criação de Sales Order e cadastro de cliente.
     - `order.paid`: Geração de etiqueta CWS + emissão de `Sales Invoice` com `update_stock = 0`.
     - `order.shipped`: Envio de e-mail de notificação de rastreamento com template HTML responsivo.
   - Workflow `plataforma-erp-dn` (`e89e3a75-b4c1-4b77-983b-f33333333333`):
     - Webhook acionado no `on_submit` de `Delivery Note` no ERPNext.
     - Chama `POST /shop/create-shipment` fechando o ciclo na loja.
   - Workflows versionados e exportados em `repos/integracoes/workflows/workflows-fase4-wms.json`.

4. **Webhooks ERPNext**:
   - `plataforma-erp-stock` (`Bin`, `on_update`): Sincronização de estoque bidirecional.
   - `plataforma-erp-delivery-note` (`Delivery Note`, `on_submit`): Acionamento do fluxo de expedição.

---

## 4. Próximos Passos (Checkpoint 1 -> Braço F / ACBrLib)

- **Portão Fiscal:** Os Gates Externos G1 (certificado A1 .pfx), G2 (alíquotas e decisões tributárias do contador) e G3 (credenciamento SEFAZ SP) dependem de definições do usuário/contador.
- **Spike F0/F1 (Ambiente de Homologação ACBrLib):** Pode ser executado em container isolado Debian slim com certificado autoassinado/teste para validar ctypes e assinatura XML em `stacks/fiscal/`.
