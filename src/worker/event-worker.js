const { Worker, Queue } = require('bullmq');
const { Pool } = require('pg');
const axios = require('axios');
const { validateCanonicalEvent } = require('../validator/schema-validator');

// Conexão com o Postgres Central da Plataforma (banco integracoes para processed_events)
const centralPool = new Pool({
  host: process.env.CENTRAL_DB_HOST || 'postgres',
  port: parseInt(process.env.CENTRAL_DB_PORT || '5432', 10),
  user: process.env.CENTRAL_DB_USER || 'integracoes',
  password: process.env.CENTRAL_DB_PASSWORD,
  database: process.env.CENTRAL_DB_NAME || 'integracoes'
});

const valkeyConnection = {
  host: process.env.VALKEY_HOST || 'valkey',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  maxRetriesPerRequest: null
};

// URL do n8n Webhook e NTFY
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/events';
// Tópico dedicado da plataforma (não o 'server-events' genérico do host).
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.robo.net.br/plataforma-events';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

// Inicializar tabela de idempotência processed_events
async function initDb() {
  await centralPool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id UUID PRIMARY KEY,
      event_type VARCHAR(100) NOT NULL,
      producer VARCHAR(50) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function sendNtfyAlert(title, message, tags = ['warning']) {
  try {
    const headers = {
      // ntfy espera headers com prefixo X- (X-Title/X-Priority/X-Tags);
      // sem ele a mensagem chega como corpo cru, sem título/prioridade.
      'X-Title': title,
      'X-Priority': 'high',
      'X-Tags': tags.join(','),
      // Cloudflare barra UA padrão de biblioteca em *.robo.net.br (gotcha do host)
      'User-Agent': 'sr-robo-integracoes/1.0'
    };
    if (NTFY_TOKEN) {
      headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    }
    await axios.post(NTFY_URL, message, { headers, timeout: 5000 });
  } catch (err) {
    const status = err.response ? ` (HTTP ${err.response.status})` : '';
    console.error(`[Worker] Falha ao enviar alerta para o ntfy${status}:`, err.message);
  }
}

function createWorkerForQueue(queueName) {
  const dlqQueue = new Queue(`${queueName}-dlq`, { connection: valkeyConnection });

  const worker = new Worker(
    queueName,
    async (job) => {
      const canonicalEvent = job.data;
      console.log(`[Worker:${queueName}] Recebido evento ${canonicalEvent.event_type} (job ${job.id}, event_id ${canonicalEvent.event_id})`);

      // 1. Validação estrita de contrato (Envelope + Payload)
      const validation = validateCanonicalEvent(canonicalEvent);
      if (!validation.valid) {
        console.error(`[Worker:${queueName}] ERRO DE CONTRATO no evento ${canonicalEvent.event_id}: ${validation.error}`);
        // Erro de contrato vai direto pra DLQ sem retries inúteis
        await dlqQueue.add('contract-validation-error', {
          original_job_id: job.id,
          event: canonicalEvent,
          reason: validation.error,
          failed_at: new Date().toISOString()
        });
        await sendNtfyAlert(
          'Erro de Contrato de Evento',
          `Evento ${canonicalEvent.event_type} (${canonicalEvent.event_id}) rejeitado por violação de schema: ${validation.error}`,
          ['x', 'warning']
        );
        return { status: 'rejected_schema', error: validation.error };
      }

      // 2. Idempotência: verificar se o event_id já foi processado com sucesso
      const checkProcessed = await centralPool.query(
        'SELECT event_id FROM processed_events WHERE event_id = $1',
        [canonicalEvent.event_id]
      );

      if (checkProcessed.rows.length > 0) {
        console.log(`[Worker:${queueName}] Evento ${canonicalEvent.event_id} já processado anteriormente. Ignorando silenciosamente (ACK).`);
        return { status: 'already_processed', event_id: canonicalEvent.event_id };
      }

      // 3. Encaminhar para o n8n via webhook autenticado
      console.log(`[Worker:${queueName}] Disparando webhook n8n para evento ${canonicalEvent.event_type}...`);
      const response = await axios.post(N8N_WEBHOOK_URL, canonicalEvent, {
        headers: {
          'Content-Type': 'application/json',
          'X-Event-Type': canonicalEvent.event_type,
          'X-Event-ID': canonicalEvent.event_id
        },
        timeout: 10000
      });

      // 4. Gravar idempotência no Postgres Central
      await centralPool.query(
        `INSERT INTO processed_events (event_id, event_type, producer, status, processed_at)
         VALUES ($1, $2, $3, 'completed', NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [canonicalEvent.event_id, canonicalEvent.event_type, canonicalEvent.producer]
      );

      console.log(`[Worker:${queueName}] Evento ${canonicalEvent.event_id} processado com sucesso (n8n HTTP ${response.status}).`);
      return { status: 'success', event_id: canonicalEvent.event_id };
    },
    {
      connection: valkeyConnection,
      concurrency: 5
    }
  );

  // Monitorar falhas após esgotar tentativas
  worker.on('failed', async (job, err) => {
    if (job) {
      console.error(`[Worker:${queueName}] Job ${job.id} falhou na tentativa ${job.attemptsMade}/${job.opts.attempts}: ${err.message}`);
      if (job.attemptsMade >= (job.opts.attempts || 5)) {
        console.error(`[Worker:${queueName}] Job ${job.id} esgotou todas as tentativas! Movendo para DLQ...`);
        await dlqQueue.add('dead-letter', {
          original_job_id: job.id,
          event: job.data,
          failed_reason: err.message,
          attempts: job.attemptsMade,
          failed_at: new Date().toISOString()
        });

        await sendNtfyAlert(
          'Evento Movido para DLQ',
          `Fila ${queueName}: Job ${job.id} (${job.data?.event_type}) falhou definitivamente após ${job.attemptsMade} tentativas. Erro: ${err.message}`,
          ['skull', 'rotating_light']
        );
      }
    }
  });

  return worker;
}

async function startWorkers() {
  await initDb();
  console.log('[Worker] Processed_events inicializado no Postgres Central.');
  // Sem token o ntfy deny-all rejeita com 403 e o alerta some em silêncio —
  // avisar no boot é o mínimo pra não descobrir isso no meio do caos.
  if (!NTFY_TOKEN) {
    console.warn('[Worker] NTFY_TOKEN nao definido — alertas de DLQ NAO serao entregues!');
  }
  const queues = ['orders', 'catalog', 'stock', 'notifications'];
  const workers = queues.map(q => createWorkerForQueue(q));
  console.log(`[Worker] Workers ativos para as filas: ${queues.join(', ')}`);
  return workers;
}

module.exports = {
  startWorkers
};
