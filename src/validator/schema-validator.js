const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({
  allErrors: true,
  strict: false
});
addFormats(ajv);

const CONTRACTS_DIR = path.resolve(__dirname, '../../contracts');
const ENVELOPE_SCHEMA_PATH = path.join(CONTRACTS_DIR, 'envelope.schema.json');
const EVENTS_DIR = path.join(CONTRACTS_DIR, 'events');

const envelopeSchema = JSON.parse(fs.readFileSync(ENVELOPE_SCHEMA_PATH, 'utf-8'));
const validateEnvelope = ajv.compile(envelopeSchema);

const eventValidators = {};
if (fs.existsSync(EVENTS_DIR)) {
  const files = fs.readdirSync(EVENTS_DIR);
  for (const file of files) {
    if (file.endsWith('.schema.json')) {
      const eventType = file.replace('.schema.json', '');
      const schemaContent = JSON.parse(fs.readFileSync(path.join(EVENTS_DIR, file), 'utf-8'));
      eventValidators[eventType] = ajv.compile(schemaContent);
    }
  }
}

function validateCanonicalEvent(event) {
  const isEnvelopeValid = validateEnvelope(event);
  if (!isEnvelopeValid) {
    const errorDetails = validateEnvelope.errors
      .map(e => `${e.instancePath || 'root'}: ${e.message}`)
      .join(', ');
    return {
      valid: false,
      stage: 'envelope',
      error: `Envelope inválido: ${errorDetails}`
    };
  }

  const payloadValidator = eventValidators[event.event_type];
  if (!payloadValidator) {
    return {
      valid: false,
      stage: 'payload_schema_missing',
      error: `Schema não registrado para o tipo de evento: ${event.event_type}`
    };
  }

  const isPayloadValid = payloadValidator(event.payload);
  if (!isPayloadValid) {
    const errorDetails = payloadValidator.errors
      .map(e => `${e.instancePath || 'root'}: ${e.message}`)
      .join(', ');
    return {
      valid: false,
      stage: 'payload',
      error: `Payload inválido para ${event.event_type}: ${errorDetails}`
    };
  }

  return { valid: true };
}

module.exports = {
  validateCanonicalEvent
};
