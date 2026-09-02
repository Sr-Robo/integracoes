> ⚠️ **COORDENAÇÃO OBRIGATÓRIA**: este roteiro derruba serviços de
> produção (n8n, Valkey). Executar SOMENTE em janela acordada com o fxlip
> na sessão — NÃO é tarefa pendente de agente autônomo. (2026-09-01: uma
> sessão em background o executou sozinha 15 min antes da execução oficial
> e quase colidiu.)

# Roteiro de Caos — F1.9 (espinha dorsal da plataforma)

Data: 2026-09-01 (noite) · Executor: fxlip + assistente
Fonte do critério: plano `plataforma-ecommerce-execucao` v2, tarefa F1.9:

> matar n8n no meio → retry → DLQ → ntfy → replay repõe; apagar o Valkey
> inteiro → relay refaz do outbox, zero evento perdido

## Pré-condições (todas devem estar ✔ antes de começar)

- [ ] Patches no ar: relay com retry de `error` + reconciliação, `NTFY_TOKEN` no `.env`, healthcheck do compose
- [ ] `docker ps` mostra `integracoes` e `valkey` **healthy**
- [ ] Celular assina o tópico `plataforma-events` no ntfy (senão não vê o alerta chegar)
- [ ] Tudo commitado (código do `integracoes`, stack, este roteiro) — caos não roda sobre untracked
- [ ] Captura de evidências: `mkdir -p ~/server/repos/integracoes/docs/caos-f1.9-evidencias` e rodar cada bloco com `2>&1 | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/<nome>.txt`

Helper (usado em vários cenários) — último pedido real conhecido:

```bash
LAST_EVENT=$(docker exec ecommerce_database psql -U evershop -d evershop -tAc \
  "SELECT event_id FROM event_outbox ORDER BY outbox_id DESC LIMIT 1")
echo "$LAST_EVENT"
```

---

## Cenário 0a — duplicado = ack silencioso (critério F1.6)

Reentrega de `event_id` já processado não pode gerar efeito colateral nem erro.

```bash
# injeta um job NOVO (jobId próprio) carregando um envelope JÁ processado
docker exec integracoes node -e '
const {Queue}=require("bullmq"); const {Pool}=require("pg");
(async()=>{
  const pg=new Pool({user:process.env.EVERSHOP_DB_USER,password:process.env.EVERSHOP_DB_PASSWORD,
    host:process.env.EVERSHOP_DB_HOST,database:process.env.EVERSHOP_DB_NAME,port:parseInt(process.env.EVERSHOP_DB_PORT||"5432",10)});
  const r=await pg.query("SELECT * FROM event_outbox ORDER BY outbox_id DESC LIMIT 1");
  const row=r.rows[0];
  const ev={event_id:row.event_id,event_type:row.event_type,event_version:row.event_version,
    occurred_at:row.occurred_at.toISOString(),producer:row.producer,business_key:row.business_key,payload:row.payload};
  const q=new Queue("orders",{connection:{host:process.env.VALKEY_HOST,port:parseInt(process.env.VALKEY_PORT||"6379",10),maxRetriesPerRequest:null}});
  await q.add(ev.event_type,ev,{jobId:"dup-teste-"+Date.now(),attempts:1});
  console.log("job duplicado injetado:",ev.event_id); process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1)});'
sleep 3
docker logs integracoes --since 1m 2>&1 | grep -E "já processado|Ignorando" | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/0a-duplicado.txt
```

**PASS:** log `já processado anteriormente. Ignorando silenciosamente (ACK)` · n8n NÃO recebe nova execução · nenhuma linha nova em `processed_events`.

---

## Cenário 0b — schema inválido = DLQ imediata + ntfy (critério F1.6)

```bash
docker exec ecommerce_database psql -U evershop -d evershop -c \
"INSERT INTO event_outbox (event_id, event_type, event_version, occurred_at, producer, business_key, payload, status)
 VALUES (gen_random_uuid(), 'order.placed', 1, NOW(), 'chaos-test', '{\"order_number\":\"CAOS-0001\"}', '{\"order_id\":\"x\"}', 'pending');"
# aguardar relay (1s) + worker
sleep 5
docker exec valkey valkey-cli ZCARD bull:orders-dlq:wait
docker exec postgres psql -U integracoes -d integracoes -tAc \
  "SELECT count(*) FROM processed_events WHERE event_type='order.placed' AND producer='chaos-test';"
docker logs integracoes --since 2m 2>&1 | grep -iE "contrato|schema|DLQ" | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/0b-schema.txt
```

**PASS:** `orders-dlq` = 1 job novo · log `ERRO DE CONTRATO` + `rejected_schema` · **celular recebe "Erro de Contrato de Evento" no `plataforma-events`** · `processed_events` ganha linha com status **rejected** (decisão terminal; sem webhook, sem efeito — fix pós-caos 2026-09-01).
**FAIL típico:** ntfy não chega → `NTFY_TOKEN` ausente/inválido (roda de novo a validação do setup).

---

## Cenário A — matar o n8n no meio → retry → DLQ → ntfy → replay repõe (F1.9)

```bash
# A1. derruba o n8n
docker stop n8n | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/a1-n8n-down.txt

# A2. gera um evento REAL: checkout de teste em sr.robo.net.br (anota o número do pedido)

# A3. acompanha os retries (backoff exponencial 1,2,4,8,16s — ~31s no total)
docker logs integracoes -f 2>&1 | grep -E "falhou na tentativa|esgotou|DLQ" | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/a3-retries.txt
# (Ctrl+C quando aparecer "esgotou todas as tentativas")

# A4. estado pós-esgotamento
docker exec valkey valkey-cli ZCARD bull:orders:failed
docker exec valkey valkey-cli ZCARD bull:orders-dlq:wait
docker exec postgres psql -U integracoes -d integracoes -c \
  "SELECT count(*) FROM processed_events WHERE event_id=(SELECT event_id FROM event_outbox WHERE business_key->>'order_number'='<NUMERO_DO_PEDIDO>' LIMIT 1);"

# A5. ntfy: celular deve ter recebido "Evento Movido para DLQ" — conferir e anotar horário

# A6. sobe o n8n de volta
docker start n8n && sleep 5

# A7. REPLAY da DLQ pra fila de origem
docker exec integracoes node scripts/replay-dlq.js orders | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/a7-replay.txt

# A8. confirmação da reposição
sleep 5
docker logs integracoes --since 2m 2>&1 | grep -E "processado com sucesso" | tee -a ~/server/repos/integracoes/docs/caos-f1.9-evidencias/a7-replay.txt
docker exec postgres psql -U integracoes -d integracoes -c \
  "SELECT count(*) FROM processed_events WHERE event_id=(SELECT event_id FROM event_outbox WHERE business_key->>'order_number'='<NUMERO_DO_PEDIDO>' LIMIT 1);"
```

**PASS:** A3 mostra `1/5…5/5` → A4 `orders:failed` = 1 e `orders-dlq:wait` = 2 (o do 0b + este) → A5 notificação recebida → A7 `re-enfileirado` → A8 `processed_events` = **1** e log `n8n HTTP 200`.
**FAIL típico:** job não chega a `failed` → conferir `removeOnFail: false` e o `worker.on('failed')`.

---

## Cenário B1 — Valkey inteiro fora → nada se perde (F1.9)

```bash
# B1.1 derruba o broker
docker compose -f ~/server/stacks/valkey/docker-compose.yml stop valkey | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/b1-valkey-down.txt

# B1.2 checkout REAL enquanto o Valkey está fora (anota o número do pedido)
#      o pedido precisa CONCLUIR com sucesso — a loja não pode depender do broker

# B1.3 o evento tem que estar seguro no outbox (com erro de publish, não perdido)
docker exec ecommerce_database psql -U evershop -d evershop -c \
  "SELECT outbox_id, status, error_message FROM event_outbox ORDER BY outbox_id DESC LIMIT 2;" | tee -a ~/server/repos/integracoes/docs/caos-f1.9-evidencias/b1-valkey-down.txt

# B1.4 broker volta
docker compose -f ~/server/stacks/valkey/docker-compose.yml up -d && sleep 5

# B1.5 o relay re-tenta o 'error' sozinho e tudo flui
docker logs integracoes --since 2m 2>&1 | grep -E "Relay|Worker" | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/b1-recuperacao.txt
docker exec ecommerce_database psql -U evershop -d evershop -tAc \
  "SELECT status, count(*) FROM event_outbox GROUP BY status;"
```

**PASS:** checkout da B1.2 concluiu sem erro (loja de pé sem broker) · B1.3 mostra `status='error'` com mensagem de conexão · B1.5: tudo `published`, nenhum `error`/`pending` antigo, log mostra publish → `n8n HTTP 200`.
**FAIL típico:** evento preso em `error` após o broker voltar → o ciclo de re-tentativa não está pegando (confere o `WHERE status IN ('pending','error')`).

## Cenário B2 — variação extrema: FLUSHALL (Valkey amnésico total)

```bash
docker exec valkey valkey-cli FLUSHALL
# aguardar 1 ciclo de reconciliação (30s) + conferir que nada quebra
sleep 35
docker exec valkey valkey-cli ZCARD bull:orders:completed   # 0 — limpo
# checkout REAL → tem que fluir normalmente (published + 200 + processed_events)
```

**PASS:** pós-flush o sistema segue operacional; evento novo flui; eventos JÁ processados **não** são re-disparados pro n8n (estão em `processed_events` — reconciliador pula).
**Nota:** eventos `published` não consumidos no momento do flush são repostos pelo reconciliador (janela de graça 2 min) — é o cenário B3, determinístico, abaixo.

## Cenário B3 — reposição por reconciliação (perda entre publish e consumo)

Simula o estado exato "saiu do relay, sumiu do Valkey antes do worker consumir", sem corrida de timing:

```bash
# evento válido completo, já marcado 'published' há 5 min (fora da janela de graça),
# que NUNCA esteve no Valkey e NÃO está em processed_events
docker exec ecommerce_database psql -U evershop -d evershop -c \
"INSERT INTO event_outbox (event_id, event_type, event_version, occurred_at, producer, business_key, payload, status, published_at)
 VALUES (gen_random_uuid(), 'order.placed', 1, NOW() - interval '6 minutes', 'chaos-test', '{\"order_number\":\"CAOS-0002\"}',
 '{\"order_id\":\"caos-2\",\"order_number\":\"CAOS-0002\",\"customer\":{\"email\":\"caos@robo.net.br\",\"full_name\":\"Caos F1.9\"},\"shipping_address\":{\"full_name\":\"Caos\",\"address1\":\"Rua Teste 1\",\"city\":\"Sao Paulo\",\"province\":\"SP\",\"postal_code\":\"01001-000\",\"country\":\"BR\"},\"items\":[{\"product_id\":\"1\",\"sku\":\"CAOS\",\"name\":\"Evento de teste\",\"qty\":1,\"price\":1,\"total\":1}],\"totals\":{\"subtotal\":1,\"shipping_fee\":0,\"grand_total\":1},\"currency\":\"BRL\",\"created_at\":\"2026-09-01T23:00:00Z\"}',
 'published', NOW() - interval '5 minutes');"

# aguardar o reconciliador (ciclo 30s; published_at já passou da janela)
sleep 40
docker logs integracoes --since 2m 2>&1 | grep -E "reconcile" | tee ~/server/repos/integracoes/docs/caos-f1.9-evidencias/b3-reconcile.txt
docker exec postgres psql -U integracoes -d integracoes -tAc \
  "SELECT count(*) FROM processed_events WHERE producer='chaos-test' AND event_id IN (SELECT event_id FROM event_outbox WHERE business_key->>'order_number'='CAOS-0002');"
```

**PASS:** log `[Relay:reconcile] Evento publicado` · `processed_events` = 1 · `n8n HTTP 200`.
**FAIL típico:** nada no log → confere `RECONCILE_GRACE_MS` vs `published_at` do insert.

---

## Pós-condições e limpeza

- [ ] `docker ps`: `integracoes`, `valkey`, `postgres`, `n8n`, `ecommerce_evershop` todos de pé (e os 3 primeiros healthy)
- [ ] `SELECT status, count(*) FROM event_outbox GROUP BY status;` → só `published`
- [ ] DLQ vazia (ou apenas o registro de estudo do 0b anotado nas evidências)
- [ ] Pedidos de teste cancelados/anotados no admin da loja se fizer sentido
- [ ] Evidências commitadas em `docs/caos-f1.9-evidencias/` junto com este roteiro
- [ ] Atualizar `docs/ecommerce-plataforma.md` (§9, Fase 1) e o plano: F1.9 ✔

## Parada de emergência

Qualquer cenário degringola → `docker compose -f ~/server/stacks/{valkey,postgres,n8n,integracoes}/docker-compose.yml up -d`
não resolve → o estado de verdade é o Postgres (outbox + processed_events): nada que está lá se perdeu. Restaurar containers é só recriar transporte.
