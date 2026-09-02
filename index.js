const http = require('http');
const { startRelay } = require('./src/relay/outbox-relay');
const { startWorkers } = require('./src/worker/event-worker');

async function main() {
  console.log('=== Iniciando Serviço de Integrações Sr. Robô ===');
  try {
    await startRelay();
    await startWorkers();

    // Liveness puro: o Docker consulta via healthcheck do compose (wget
    // interno). Sem o event loop atendendo, o probe falha e o restart age —
    // detecta Node travado de pé, que status de processo não pega.
    http
      .createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      })
      .listen(9999, '127.0.0.1');

    console.log('=== Serviço de Integrações em execução e pronto ===');
  } catch (err) {
    console.error('Falha fatal ao inicializar barramento de integracoes:', err);
    process.exit(1);
  }
}

main();
