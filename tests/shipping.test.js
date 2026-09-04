const assert = require('assert');
const { CorreiosClient } = require('../src/shipping/correios');
const { CircuitBreaker, QuoteGateway } = require('../src/shipping/quote-gateway');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log('=== Executando Suite de Testes de Frete (Correios CWS + Gateway + Circuit Breaker) ===\n');

  // 1. Testes de Circuit Breaker
  console.log('1. Testando Circuit Breaker:');
  
  await runTest('Circuit Breaker inicia em CLOSED e permite requisições', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    assert.strictEqual(cb.state, 'CLOSED');
    assert.strictEqual(cb.canAttempt(), true);
  });

  await runTest('Circuit Breaker abre após atingir limite de falhas', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5000 });
    cb.recordFailure('timeout 1');
    assert.strictEqual(cb.state, 'CLOSED');
    cb.recordFailure('timeout 2');
    assert.strictEqual(cb.state, 'CLOSED');
    cb.recordFailure('timeout 3');
    assert.strictEqual(cb.state, 'OPEN');
    assert.strictEqual(cb.canAttempt(), false);
  });

  await runTest('Circuit Breaker transiciona para HALF_OPEN após cooldown', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
    cb.recordFailure('falha 1');
    cb.recordFailure('falha 2');
    assert.strictEqual(cb.state, 'OPEN');
    assert.strictEqual(cb.canAttempt(), false);

    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(cb.canAttempt(), true);
    assert.strictEqual(cb.state, 'HALF_OPEN');

    cb.recordSuccess();
    assert.strictEqual(cb.state, 'CLOSED');
    assert.strictEqual(cb.failureCount, 0);
  });

  // 2. Testes de CorreiosClient Token Cache
  console.log('\n2. Testando CorreiosClient (Token Cache & Formatação):');

  await runTest('CorreiosClient formata data DD-MM-YYYY corretamente', () => {
    const client = new CorreiosClient();
    const testDate = new Date(2026, 8, 4); // 4 de Setembro de 2026
    const formatted = client.formatDateDDMMYYYY(testDate);
    assert.strictEqual(formatted, '04-09-2026');
  });

  await runTest('CorreiosClient reutiliza token em cache se válido', async () => {
    const client = new CorreiosClient();
    client.cachedToken = 'mock_jwt_token_valid';
    client.tokenExpiresAt = Date.now() + 2 * 60 * 60 * 1000; // 2 horas restantes

    const token = await client.getToken();
    assert.strictEqual(token, 'mock_jwt_token_valid');
  });

  // 3. Testes de QuoteGateway (Cache, Fallback e Performance)
  console.log('\n3. Testando QuoteGateway (Hierarquia Cache -> API -> Fallback):');

  await runTest('QuoteGateway retorna do cache Valkey se disponível', async () => {
    const mockValkey = {
      status: 'ready',
      async get(key) {
        return JSON.stringify([
          { code: 'pac', name: 'Correios PAC', price: 25.50, delivery_days: 6 },
          { code: 'sedex', name: 'Correios SEDEX', price: 35.00, delivery_days: 2 }
        ]);
      },
      async set() {}
    };

    const gateway = new QuoteGateway({
      valkeyClient: mockValkey
    });

    const res = await gateway.getQuote({ postal_code: '01001-000', weight_g: 300 });
    assert.strictEqual(res.source, 'cache');
    assert.strictEqual(res.methods.length, 2);
    assert.strictEqual(res.methods[0].price, 25.50);
  });

  await runTest('QuoteGateway cai no fallback em <100ms quando API falha', async () => {
    const mockCorreios = {
      originCep: '01001000',
      async getQuote() {
        throw new Error('Connection timeout to Correios API');
      },
      async generateLabel() {
        return { tracking_code: 'BR123456789SED', status: 'mock' };
      }
    };

    const mockValkey = {
      status: 'ready',
      async get() { return null; },
      async set() {}
    };

    const gateway = new QuoteGateway({
      correiosClient: mockCorreios,
      valkeyClient: mockValkey
    });

    const start = Date.now();
    const res = await gateway.getQuote({ postal_code: '01310-100', weight_g: 500 });
    const elapsed = Date.now() - start;

    assert.strictEqual(res.source, 'fallback');
    assert.strictEqual(res.methods.length, 2);
    assert.strictEqual(res.methods.some(m => m.code === 'pac'), true);
    assert.strictEqual(res.methods.some(m => m.code === 'sedex'), true);
    assert(elapsed < 100, `Tempo de fallback foi ${elapsed}ms, esperado <100ms`);
  });

  console.log('\n=============================================================');
  console.log(`Resultado dos testes de frete: ${passed} passaram, ${failed} falharam.`);
  console.log('=============================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Falha nos testes:', err);
  process.exit(1);
});
