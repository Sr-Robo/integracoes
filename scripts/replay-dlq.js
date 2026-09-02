#!/usr/bin/env node
// Replay de eventos da DLQ de volta pra fila de origem (critério F1.9).
// O job da DLQ carrega { original_job_id, event, ... } — o envelope canônico
// completo — então o replay re-enfileira o evento com as MESMAS opções do
// relay (jobId=event_id, attempts 5, backoff exponencial).
//
// Uso: docker exec integracoes node scripts/replay-dlq.js <fila> [event_id]
// Ex.: docker exec integracoes node scripts/replay-dlq.js orders
//      docker exec integracoes node scripts/replay-dlq.js orders <uuid>
const { Queue } = require('bullmq');

const queueName = process.argv[2];
if (!queueName) {
  console.error('Uso: node scripts/replay-dlq.js <fila> [event_id]');
  process.exit(1);
}
const onlyEventId = process.argv[3] || null;

const connection = {
  host: process.env.VALKEY_HOST || 'valkey',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  maxRetriesPerRequest: null
};

(async () => {
  const dlq = new Queue(`${queueName}-dlq`, { connection });
  const queue = new Queue(queueName, { connection });

  const jobs = await dlq.getJobs(['wait', 'active', 'delayed', 'failed'], 0, 100);
  let replayed = 0;
  for (const job of jobs) {
    const ev = job.data && job.data.event;
    if (!ev || !ev.event_id) continue;
    if (onlyEventId && ev.event_id !== onlyEventId) continue;

    // O job original (jobId=event_id) pode ainda existir como 'failed' no
    // Valkey (removeOnFail: false). add com jobId ocupado é no-op no BullMQ,
    // então removemos o antigo antes de re-enfileirar.
    const original = await queue.getJob(ev.event_id);
    if (original) {
      const state = await original.getState();
      if (state === 'failed') {
        await original.remove();
        console.log(`[replay] job failed original ${ev.event_id} removido`);
      } else {
        console.log(`[replay] ${ev.event_id}: job original em estado '${state}' — pulando`);
        continue;
      }
    }

    await queue.add(ev.event_type, ev, {
      jobId: ev.event_id,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false
    });
    await dlq.remove(job.id);
    replayed += 1;
    console.log(`[replay] ${ev.event_type} ${ev.event_id} re-enfileirado em '${queueName}'`);
  }
  console.log(`[replay] concluído: ${replayed} evento(s)`);
  process.exit(0);
})().catch((e) => {
  console.error('[replay] erro:', e.message);
  process.exit(1);
});
