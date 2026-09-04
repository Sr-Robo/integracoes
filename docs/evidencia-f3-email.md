# Evidência — F3: e-mail transacional real (forwardemail.net)

Data: 2026-09-04 · Sessão Opus (complemento da Fase 3 executada pela frente
plataforma em 04/09).

Critério de pronto do §9 do doc mestre: *"e-mail de confirmação entregue na
caixa (não no spam)"*.

## Resultado

✅ **CONFIRMADO pelo fxlip às 2026-09-04** — smoke `[Fase 3] Smoke 3 — com
Message-ID 1788526358` entregue **na caixa de entrada** do Gmail
(`felip42@gmail.com`), não no spam.

## Linha do tempo (o que travava e quando destravou)

1. **DNS publicado** (fxlip, Cloudflare): SPF
   `v=spf1 include:spf.forwardemail.net ~all` · DKIM
   `fe-6f542eb225._domainkey` (RSA 2048) · DMARC `p=none` (deliberado,
   monitoração) · MX `mx1/mx2.forwardemail.net` · Return-Path CNAME
   `fe-bounces → forwardemail.net` · verificação de domínio TXT.
2. **Smoke 1/2 barrados no DATA**: `535 5.7.8 Domain is not configured for
   outbound SMTP` — auth (`235`) e RCPT (`250`) passavam. Causa: faltava o
   **Verify** por domínio + aprovação admin do forwardemail.
3. **Verify clicado** (fxlip) → resposta: *"successfully verified and now
   pending admin approval"*.
4. **Aprovação admin chegou** (~1h) — monitor automático detectou no primeiro
   envio aceito (`250 2.6.0 OK: message queued`).
5. **Smokes 1/2 não chegaram** à caixa (janela de aprovação — a fila deles
   não entregou o que entrou antes da liberação).
6. **Smoke 3** (com `Message-ID` e headers completos) → **entregue na caixa
   de entrada**. Smoke 4 (circuito completo via alias `sr@robo.net.br`)
   enviado na sequência.

## Como ficou armado

- Credential **`SMTP forwardemail (noreply)`** no n8n (cifrada pela
  `N8N_ENCRYPTION_KEY` no banco do n8n; senha gerada no dashboard deles —
  nunca em repo/env, `grep` de sanidade = 0 ocorrências).
- Node **`Enviar E-mail (SMTP)`** (`n8n-nodes-base.emailSend`) encadeado
  após o template `E-mail Transacional` no workflow `plataforma-eco-eventos`,
  `reply-to: sr@robo.net.br` (alias de recebimento criado pelo fxlip).
- Workflow ativo; webhook `/webhook/events` responde `200 Workflow was
  started` pós-restart.
- Export fonte da verdade: `workflows/workflow-eco-eventos-2026-09-04-smtp-ativo.json`.

## Pendências abertas por esta evidência

- **Endurecer DMARC** (`p=none → quarantine → reject`) ~2026-09-18 com
  alignment 100% no dashboard DMARC deles — registrado em `docs/n8n.md`.

## Recebimento (circuito `sr@`) e bounce webhook (B3) — fechados 2026-09-04

- **Circuito de recebimento validado em duas camadas**: MX deles aceita
  `RCPT sr@robo.net.br` (`250 2.1.5`, teste direto sem relay) e o alias
  encaminha — os smokes 4/4B **foram entregues**, noutro endereço que o
  fxlip tinha configurado sem perceber ("erro meu, era um outro email").
  Nada quebrado; destino conferido pelo dono.
- **B3 (bounce webhook) no ar e testado ponta-a-ponta pela URL pública**:
  `https://hooks.robo.net.br/bounce/<segredo>` → Cloudflare → túnel
  `homelab` → Traefik (rule de path exato) → worker → ntfy
  `plataforma-events`. HTTP 200 na URL pública + notificação recebida pelo
  fxlip no ntfy (incluindo disparo de fora). Segredo no `.env` do stack
  (`BOUNCE_WEBHOOK_SECRET`); segredo errado = 404 igual rota inexistente.
  Commits: `b8fe396` (integracoes) e `2c50242` (~/server).
