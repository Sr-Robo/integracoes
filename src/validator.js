const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

class EventValidator {
  constructor(contractsDir = path.resolve(__dirname, '../contracts')) {
    this.contractsDir = contractsDir;
    this.ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(this.ajv);

    this.envelopeSchema = JSON.parse(
      fs.readFileSync(path.join(this.contractsDir, 'envelope.schema.json'), 'utf8')
    );
    this.envelopeValidate = this.ajv.compile(this.envelopeSchema);

    this.eventValidators = {};
    this.loadEventSchemas();
  }

  loadEventSchemas() {
    const eventsDir = path.join(this.contractsDir, 'events');
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.schema.json'));

    for (const file of files) {
      const eventType = file.replace('.schema.json', '');
      const schema = JSON.parse(fs.readFileSync(path.join(eventsDir, file), 'utf8'));
      this.eventValidators[eventType] = this.ajv.compile(schema);
    }
  }

  validateEnvelope(envelope) {
    const valid = this.envelopeValidate(envelope);
    return {
      valid: !!valid,
      errors: this.envelopeValidate.errors || []
    };
  }

  validatePayload(eventType, payload) {
    const validator = this.eventValidators[eventType];
    if (!validator) {
      return {
        valid: false,
        errors: [{ message: `Schema não registrado para o evento: ${eventType}` }]
      };
    }
    const valid = validator(payload);
    return {
      valid: !!valid,
      errors: validator.errors || []
    };
  }

  validateEvent(event) {
    const envResult = this.validateEnvelope(event);
    if (!envResult.valid) {
      return {
        valid: false,
        stage: 'envelope',
        errors: envResult.errors
      };
    }

    const payloadResult = this.validatePayload(event.event_type, event.payload);
    if (!payloadResult.valid) {
      return {
        valid: false,
        stage: 'payload',
        errors: payloadResult.errors
      };
    }

    return {
      valid: true,
      errors: []
    };
  }
}

module.exports = { EventValidator };
