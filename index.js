const http = require('http');
const { startRelay } = require('./src/relay/outbox-relay');
const { startWorkers } = require('./src/worker/event-worker');
const { initFallbackDb } = require('./src/shipping/fallback-db');
const { QuoteGateway } = require('./src/shipping/quote-gateway');

const SHIPPING_API_TOKEN = process.env.SHIPPING_API_TOKEN || '';
let quoteGateway = null;

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // Proteção de tamanho de payload (1MB)
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        if (!body) return resolve({});
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkAuth(req, res) {
  if (!SHIPPING_API_TOKEN) {
    return true;
  }
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token !== SHIPPING_API_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

async function handleRequest(req, res) {
  const { method, url } = req;

  // 1. Healthcheck / Liveness probe
  if (method === 'GET' && (url === '/' || url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // 2. Cotação de Frete (POST /shipping/quote)
  if (method === 'POST' && url === '/shipping/quote') {
    if (!checkAuth(req, res)) return;

    try {
      const data = await parseJsonBody(req);
      const postalCode = data.postal_code || data.destination_postal_code || (data.destination && data.destination.postcode) || '';
      const weightG = data.weight_g || data.total_weight_g || 500;
      const dimensions = data.dimensions || {};

      if (!postalCode) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'postal_code is required' }));
      }

      const quote = await quoteGateway.getQuote({
        postal_code: postalCode,
        weight_g: weightG,
        dimensions
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(quote));
    } catch (err) {
      console.error('[HTTP:quote] Erro ao processar cotação:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Internal server error', message: err.message }));
    }
  }

  // 3. Emissão de Etiqueta / Pré-postagem (POST /shipping/label)
  if (method === 'POST' && url === '/shipping/label') {
    if (!checkAuth(req, res)) return;

    try {
      const data = await parseJsonBody(req);
      const label = await quoteGateway.generateLabel({
        orderNumber: data.order_number || data.order_id,
        recipient: data.recipient || data.shipping_address || {},
        weightG: data.weight_g || 500,
        serviceCode: data.service || 'sedex'
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(label));
    } catch (err) {
      console.error('[HTTP:label] Erro ao gerar etiqueta:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to generate label', message: err.message }));
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

async function main() {
  console.log('=== Iniciando Serviço de Integrações Sr. Robô ===');
  try {
    await initFallbackDb();
    console.log('[Init] Tabela frete_fallback inicializada no Postgres Central.');

    quoteGateway = new QuoteGateway();

    await startRelay();
    await startWorkers();

    const server = http.createServer(handleRequest);
    server.listen(9999, '0.0.0.0', () => {
      console.log('=== Serviço de Integrações em execução e pronto na porta 9999 (0.0.0.0) ===');
    });
  } catch (err) {
    console.error('Falha fatal ao inicializar barramento de integracoes:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  handleRequest
};
