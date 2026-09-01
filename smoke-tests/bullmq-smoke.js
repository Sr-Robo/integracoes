const { Queue, Worker, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '16379', 10);

const connection = {
  host: REDIS_HOST,
  port: REDIS_PORT,
  maxRetriesPerRequest: null
};

async function runSmokeTest() {
  console.log(`=== Iniciando Smoke Test BullMQ × Valkey (${REDIS_HOST}:${REDIS_PORT}) ===\n`);

  const redisClient = new IORedis(connection);
  const ping = await redisClient.ping();
  console.log(`1. Conexão Redis/Valkey PING: ${ping}`);
  if (ping !== 'PONG') {
    throw new Error('Falha no PING do Valkey');
  }

  const queueName = 'smoke-orders';
  const queue = new Queue(queueName, { connection });
  const queueEvents = new QueueEvents(queueName, { connection });
  await queueEvents.waitUntilReady();

  // ----------------------------------------------------
  // Teste 1: Job que produz -> consome -> ack com sucesso
  // ----------------------------------------------------
  console.log('\n2. Testando fluxo com sucesso: produce -> consume -> ACK');
  const successWorker = new Worker(queueName, async (job) => {
    if (job.name === 'success-job') {
      console.log(`   [Worker] Processando job ${job.id} com sucesso...`);
      return { status: 'processed', order_number: job.data.order_number };
    }
  }, { connection });

  const job1 = await queue.add('success-job', { order_number: 'OR-SMOKE-01' });
  console.log(`   [Producer] Job de sucesso enfileirado ID: ${job1.id}`);

  await job1.waitUntilFinished(queueEvents, 10000);
  console.log('   ✓ Job de sucesso concluído e confirmado (ACK)');
  await successWorker.close();

  // ----------------------------------------------------
  // Teste 2: Job que falha 5x e cai na DLQ (Dead Letter)
  // ----------------------------------------------------
  console.log('\n3. Testando resiliência: job falha 5x -> cai na lista de failed / DLQ');
  let attemptsCount = 0;
  const dlqQueue = new Queue('smoke-orders-dlq', { connection });

  const failWorker = new Worker(queueName, async (job) => {
    if (job.name === 'fail-job') {
      attemptsCount++;
      console.log(`   [Worker] Tentativa ${attemptsCount}/5 para job ${job.id} (simulando falha)...`);
      throw new Error(`Erro simulado na tentativa ${attemptsCount}`);
    }
  }, { connection });

  failWorker.on('failed', async (job, err) => {
    if (job && job.name === 'fail-job' && job.attemptsMade >= 5) {
      console.log(`   [Worker Event] Job ${job.id} esgotou 5 tentativas. Movendo para DLQ dedicada...`);
      await dlqQueue.add('dead-letter', {
        original_job_id: job.id,
        original_data: job.data,
        failed_reason: err.message,
        attempts: job.attemptsMade,
        failed_at: new Date().toISOString()
      });
    }
  });

  const job2 = await queue.add('fail-job', { order_number: 'OR-FAIL-01' }, {
    attempts: 5,
    backoff: {
      type: 'fixed',
      delay: 150
    }
  });
  console.log(`   [Producer] Job que falha enfileirado ID: ${job2.id} com 5 tentativas configuradas`);

  // Aguardar até que todas as 5 tentativas falhem
  let done = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 400));
    const dlqJobs = await dlqQueue.getJobs(['waiting', 'completed']);
    const failedJobs = await queue.getFailed();
    if (failedJobs.some(j => j.id === job2.id) && dlqJobs.length > 0) {
      console.log(`   ✓ Job confirmado como FAILED no BullMQ após ${attemptsCount} tentativas`);
      console.log(`   ✓ Job registrado na DLQ dedicada (${dlqJobs.length} item na fila smoke-orders-dlq)`);
      done = true;
      break;
    }
  }

  await failWorker.close();
  await queue.close();
  await dlqQueue.close();
  await queueEvents.close();
  await redisClient.quit();

  if (!done) {
    throw new Error('Timeout esperando o job falhar 5 vezes e entrar na DLQ');
  }

  console.log('\n=============================================================');
  console.log('✓ Smoke Test BullMQ × Valkey CONCLUÍDO COM SUCESSO (100% OK)');
  console.log('=============================================================');
}

runSmokeTest().catch(err => {
  console.error('Erro no Smoke Test:', err);
  process.exit(1);
});
