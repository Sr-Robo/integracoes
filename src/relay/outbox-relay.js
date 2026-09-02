const { Pool } = require('pg');
const { Queue } = require('bullmq');

// Conexão com o Postgres do EverShop (leitura da tabela event_outbox)
const evershopPool = new Pool({
  host: process.env.EVERSHOP_DB_HOST || 'ecommerce_database',
  port: parseInt(process.env.EVERSHOP_DB_PORT || '5432', 10),
  user: process.env.EVERSHOP_DB_USER || 'evershop',
  password: process.env.EVERSHOP_DB_PASSWORD,
  database: process.env.EVERSHOP_DB_NAME || 'evershop'
});

// Conexão de LEITURA com o Postgres Central (reconciliação: processed_events).
// A verdade final de "evento entregue" é o registro de consumo no central,
// não o simples enfileiramento no Valkey (transporte descartável — §2).
const centralPool = new Pool({
  host: process.env.CENTRAL_DB_HOST || 'postgres',
  port: parseInt(process.env.CENTRAL_DB_PORT || '5432', 10),
  user: process.env.CENTRAL_DB_USER || 'integracoes',
  password: process.env.CENTRAL_DB_PASSWORD,
  database: process.env.CENTRAL_DB_NAME || 'integracoes'
});

// Configuração do Valkey para o BullMQ
const valkeyConnection = {
  host: process.env.VALKEY_HOST || 'valkey',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  maxRetriesPerRequest: null
};

// Filas BullMQ por domínio
const queues = {
  orders: new Queue('orders', { connection: valkeyConnection }),
  catalog: new Queue('catalog', { connection: valkeyConnection }),
  stock: new Queue('stock', { connection: valkeyConnection }),
  notifications: new Queue('notifications', { connection: valkeyConnection })
};

// Reconciliação: a cada RECONCILE_INTERVAL_MS, re-publica eventos marcados
// 'published' há mais de RECONCILE_GRACE_MS que ainda não têm registro em
// processed_events. É o que cobre a janela "publicado no Valkey, Valkey morreu
// antes do worker consumir": o jobId=event_id deduplica no BullMQ (add em job
// existente é no-op), então re-publicar é sempre seguro.
const RECONCILE_INTERVAL_MS = parseInt(process.env.RECONCILE_INTERVAL_MS || '30000', 10);
const RECONCILE_GRACE_MS = parseInt(process.env.RECONCILE_GRACE_MS || '120000', 10);

function getQueueForEventType(eventType) {
  if (eventType.startsWith('order.') || eventType.startsWith('return.')) {
    return queues.orders;
  }
  if (eventType.startsWith('stock.')) {
    return queues.stock;
  }
  if (eventType.startsWith('product.') || eventType.startsWith('catalog.')) {
    return queues.catalog;
  }
  return queues.notifications;
}

const OUTBOX_COLUMNS = 'outbox_id, event_id, event_type, event_version, occurred_at, producer, business_key, payload';

function toCanonicalEvent(row) {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    event_version: row.event_version,
    occurred_at: typeof row.occurred_at === 'string' ? row.occurred_at : row.occurred_at.toISOString(),
    producer: row.producer,
    business_key: typeof row.business_key === 'string' ? JSON.parse(row.business_key) : row.business_key,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  };
}

async function publishEvent(row, { reconciled = false } = {}) {
  const canonicalEvent = toCanonicalEvent(row);
  const targetQueue = getQueueForEventType(canonicalEvent.event_type);

  // Publicar no BullMQ com deduplicação por jobId = event_id
  await targetQueue.add(canonicalEvent.event_type, canonicalEvent, {
    jobId: canonicalEvent.event_id,
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000
    },
    removeOnComplete: 1000,
    removeOnFail: false
  });

  // Marcar como publicado no Postgres. Em reconciliação NÃO atualizamos
  // published_at (COALESCE preserva o original, que continua contando
  // pra janela de graça) e limpa error_message de tentativas anteriores.
  await evershopPool.query(
    `UPDATE event_outbox
     SET status = 'published', published_at = COALESCE(published_at, NOW()), error_message = NULL
     WHERE outbox_id = $1`,
    [row.outbox_id]
  );

  console.log(`[Relay${reconciled ? ':reconcile' : ''}] Evento publicado no BullMQ: ${canonicalEvent.event_type} (${canonicalEvent.event_id})`);
}

let isRunning = false;

async function pollAndPublish() {
  if (isRunning) return;
  isRunning = true;

  try {
    // Pending E error: erro transitório (ex.: Valkey fora durante o publish)
    // volta pro ciclo em vez de ficar enterrado no outbox sem alerta.
    const result = await evershopPool.query(
      `SELECT ${OUTBOX_COLUMNS}
       FROM event_outbox
       WHERE status IN ('pending', 'error')
       ORDER BY outbox_id ASC
       LIMIT 50`
    );

    for (const row of result.rows) {
      try {
        await publishEvent(row);
      } catch (pubErr) {
        console.error(`[Relay] Erro ao enfileirar evento ${row.event_id}:`, pubErr.message);
        await evershopPool.query(
          `UPDATE event_outbox
           SET status = 'error', error_message = $1
           WHERE outbox_id = $2`,
          [pubErr.message, row.outbox_id]
        );
        // Broker provavelmente fora: não adianta martelar o resto do lote
        // neste ciclo (e evita 50 writes de erro por segundo no PG).
        break;
      }
    }
  } catch (err) {
    console.error('[Relay] Erro no ciclo de polling do outbox:', err.message);
  } finally {
    isRunning = false;
  }
}

let isReconciling = false;

async function reconcilePublished() {
  if (isReconciling) return;
  isReconciling = true;

  try {
    // Candidatos: publicados há mais da janela de graça.
    const candidates = await evershopPool.query(
      `SELECT ${OUTBOX_COLUMNS}
       FROM event_outbox
       WHERE status = 'published'
         AND published_at < NOW() - make_interval(secs => $1::float8)
       ORDER BY outbox_id ASC
       LIMIT 100`,
      [RECONCILE_GRACE_MS / 1000]
    );
    if (candidates.rows.length === 0) return;

    // Quais já foram consumidos com sucesso (verdade final no central)?
    const ids = candidates.rows.map((r) => r.event_id);
    const processed = await centralPool.query(
      'SELECT event_id FROM processed_events WHERE event_id = ANY($1::uuid[])',
      [ids]
    );
    const processedSet = new Set(processed.rows.map((r) => r.event_id));

    for (const row of candidates.rows) {
      if (processedSet.has(row.event_id)) continue;

      // Job em estado failed = já esgotou retries e está na rota da DLQ
      // (tratada com ntfy + replay manual). Re-publicar não teria efeito
      // (jobId existente é no-op no BullMQ), então nem tenta.
      const canonicalEvent = toCanonicalEvent(row);
      const queue = getQueueForEventType(canonicalEvent.event_type);
      const existing = await queue.getJob(canonicalEvent.event_id);
      if (existing) {
        const state = await existing.getState();
        if (state === 'failed') {
          console.log(`[Relay:reconcile] Evento ${canonicalEvent.event_id} está failed (rota DLQ) — aguardando replay manual`);
          continue;
        }
        // Demais estados (wait/active/delayed/completed): o add com jobId
        // duplicado é no-op e inofensivo; segue pro add normal.
      }

      try {
        await publishEvent(row, { reconciled: true });
      } catch (pubErr) {
        console.error(`[Relay:reconcile] Erro ao re-publicar evento ${row.event_id}:`, pubErr.message);
        break;
      }
    }
  } catch (err) {
    console.error('[Relay:reconcile] Erro no ciclo de reconciliação:', err.message);
  } finally {
    isReconciling = false;
  }
}

async function startRelay() {
  console.log('[Relay] Iniciando Transactional Outbox Relay...');
  setInterval(pollAndPublish, 1000);
  setInterval(
    reconcilePublished,
    RECONCILE_INTERVAL_MS
  );
  console.log(`[Relay] Reconciliação ativa: ciclo ${RECONCILE_INTERVAL_MS}ms, janela de graça ${RECONCILE_GRACE_MS}ms`);
}

module.exports = {
  startRelay,
  pollAndPublish,
  reconcilePublished
};
