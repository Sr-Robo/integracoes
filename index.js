const http = require('http');
const axios = require('axios');
const { startRelay } = require('./src/relay/outbox-relay');
const { startWorkers } = require('./src/worker/event-worker');
const { initFallbackDb } = require('./src/shipping/fallback-db');
const { QuoteGateway } = require('./src/shipping/quote-gateway');

const SHIPPING_API_TOKEN = process.env.SHIPPING_API_TOKEN || '';
const BOUNCE_WEBHOOK_SECRET = process.env.BOUNCE_WEBHOOK_SECRET || '';
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

  // 4. Webhook de bounce do forwardemail (POST /bounce/<segredo>) — B3
  // O forwardemail não assina nem autentica o POST: o segredo mora no path
  // (mesma técnica do deploy.robo.net.br). Publicado só via Traefik com rule
  // de path exato em hooks.robo.net.br — ver stacks/integracoes/docker-compose.
  if (method === 'POST' && url.startsWith('/bounce/')) {
    const secret = decodeURIComponent(url.slice('/bounce/'.length).split('?')[0]);
    if (!BOUNCE_WEBHOOK_SECRET || secret !== BOUNCE_WEBHOOK_SECRET) {
      // Segredo errado responde igual a rota inexistente — não confirma existência
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not Found' }));
    }

    let note = 'payload não-JSON (ignorado)';
    try {
      const data = await parseJsonBody(req);
      const to = data.to || data.recipient || data.email || 'destinatário desconhecido';
      const reason = data.error || data.message || data.response || data.reason || JSON.stringify(data);
      const type = data.type ? ` (${data.type})` : '';
      note = `Para: ${to} — motivo: ${String(reason).slice(0, 400)}`;
    } catch (err) {
      // Body inválido: loga e segue — bounce não tem replay útil no lado deles
      console.error('[HTTP:bounce] payload não-JSON:', err.message);
    }

    // 200 sempre (efeito notificado em melhor esforço, erro não gera retry deles)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ received: true }));

    setImmediate(async () => {
      try {
        // Mesmos env/convenção do sendNtfyAlert do worker: headers X-, UA
        // custom (Cloudflare barra UA de lib em *.robo.net.br), token Bearer.
        const ntfyUrl = process.env.NTFY_URL || 'https://ntfy.robo.net.br/plataforma-events';
        const headers = {
          'X-Title': 'E-mail quicou — plataforma',
          'X-Priority': 'high',
          'X-Tags': 'email,bounce',
          'User-Agent': 'sr-robo-integracoes/1.0'
        };
        if (process.env.NTFY_TOKEN) {
          headers['Authorization'] = `Bearer ${process.env.NTFY_TOKEN}`;
        }
        await axios.post(ntfyUrl, `E-mail de saída quicou no relay.\n${note}`, { headers, timeout: 10000 });
        console.log('[HTTP:bounce] alerta ntfy enviado');
      } catch (err) {
        console.error('[HTTP:bounce] falha ao notificar ntfy:', err.message);
      }
    });
    return;
  }

  // 5. Criação de Shipment no EverShop a partir do DN/WMS (POST /shop/create-shipment) — W4
  if (method === 'POST' && url === '/shop/create-shipment') {
    if (!checkAuth(req, res)) return;

    try {
      const data = await parseJsonBody(req);
      const { createShopShipment } = require('./src/shop/shipment-service');
      const result = await createShopShipment({
        orderNumber: data.order_number,
        trackingCode: data.tracking_code || data.tracking_no,
        carrier: data.carrier || 'custom'
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      console.error('[HTTP:create-shipment] Erro ao criar shipment na loja:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Failed to create shipment', message: err.message }));
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
