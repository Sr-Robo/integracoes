const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { EventValidator } = require('../src/validator');

const validator = new EventValidator();
let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log('=== Executando Suite de Testes de Contratos JSON Schema v1 ===\n');

// 1. Validar fixtures válidas
console.log('1. Testando Fixtures Válidas (Envelope + Payload):');
const validDir = path.join(__dirname, 'fixtures/valid');
const validFiles = fs.readdirSync(validDir).filter(f => f.endsWith('.json'));

for (const file of validFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(validDir, file), 'utf8'));
  runTest(`Fixture válida deve passar: ${file}`, () => {
    const result = validator.validateEvent(data);
    assert.strictEqual(result.valid, true, `Erros encontrados: ${JSON.stringify(result.errors)}`);
  });
}

// 2. Validar fixtures inválidas
console.log('\n2. Testando Fixtures Inválidas (Devem falhar na validação):');
const invalidDir = path.join(__dirname, 'fixtures/invalid');
const invalidFiles = fs.readdirSync(invalidDir).filter(f => f.endsWith('.json'));

for (const file of invalidFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(invalidDir, file), 'utf8'));
  runTest(`Fixture inválida deve ser rejeitada: ${file}`, () => {
    const result = validator.validateEvent(data);
    assert.strictEqual(result.valid, false, `Esperava rejeição para ${file}, mas passou!`);
  });
}

// 3. Verificação explícita do critério F0.2 (envelope sem event_id)
console.log('\n3. Critério F0.2 - Verificação específica de envelope sem event_id:');
runTest('Envelope sem event_id deve ser rejeitado', () => {
  const eventWithoutId = {
    event_type: 'order.placed',
    event_version: 1,
    occurred_at: new Date().toISOString(),
    producer: 'evershop',
    business_key: { order_number: 'OR-9999' },
    payload: {}
  };
  const result = validator.validateEnvelope(eventWithoutId);
  assert.strictEqual(result.valid, false, 'Deveria falhar na validação de envelope');
  const hasMissingEventId = result.errors.some(e => e.params && e.params.missingProperty === 'event_id');
  assert.strictEqual(hasMissingEventId, true, 'Deveria apontar especificamente a falta de event_id');
});

console.log('\n=============================================================');
console.log(`Resultado dos testes: ${passed} passaram, ${failed} falharam.`);
console.log('=============================================================');

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
