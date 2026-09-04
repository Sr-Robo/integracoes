const Redis = require('ioredis');
const axios = require('axios');
const { CorreiosClient } = require('./correios');
const { getFallbackQuote } = require('./fallback-db');

const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.robo.net.br/plataforma-events';
const NTFY_TOKEN = process.env.NTFY_TOKEN || '';

async function sendNtfyAlert(title, message, tags = ['package', 'warning']) {
  try {
    const headers = {
      'X-Title': title,
      'X-Priority': 'default',
      'X-Tags': tags.join(','),
      'User-Agent': 'sr-robo-integracoes/1.0'
    };
    if (NTFY_TOKEN) {
      headers['Authorization'] = `Bearer ${NTFY_TOKEN}`;
    }
    await axios.post(NTFY_URL, message, { headers, timeout: 5000 });
  } catch (err) {
    console.error('[QuoteGateway] Falha ao enviar alerta ntfy:', err.message);
  }
}

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 3;
    this.cooldownMs = options.cooldownMs || 120000; // 2 minutos
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failureCount = 0;
    this.nextAttemptAt = 0;
  }

  canAttempt() {
    const now = Date.now();
    if (this.state === 'CLOSED') {
      return true;
    }
    if (this.state === 'OPEN') {
      if (now >= this.nextAttemptAt) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    // HALF_OPEN
    return true;
  }

  recordSuccess() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.nextAttemptAt = 0;
  }

  recordFailure(reason) {
    this.failureCount++;
    const now = Date.now();
    if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttemptAt = now + this.cooldownMs;
      console.warn(`[CircuitBreaker] Circuito de frete ABERTO por ${this.cooldownMs / 1000}s devido a ${this.failureCount} falhas. Motivo: ${reason}`);
    }
  }
}

class QuoteGateway {
  constructor(options = {}) {
    this.correios = options.correiosClient || new CorreiosClient(options.correiosOptions);
    this.circuitBreaker = new CircuitBreaker(options.circuitBreakerOptions);
    
    // Conexão Valkey / Redis
    this.valkey = options.valkeyClient || new Redis({
      host: process.env.VALKEY_HOST || 'valkey',
      port: parseInt(process.env.VALKEY_PORT || '6379', 10),
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 2000)
    });
    
    if (this.valkey && typeof this.valkey.connect === 'function') {
      this.valkey.connect().catch(err => {
        console.warn('[QuoteGateway] Valkey cache não conectado imediatamente:', err.message);
      });
    }

    this.cacheTtlSeconds = options.cacheTtlSeconds || 86400; // 24h
  }

  /**
   * Resolve a cotação seguindo a hierarquia: Cache -> API CWS -> Fallback DB
   */
  async getQuote({ postal_code, weight_g = 500, dimensions = {} }) {
    const cleanPostalCode = String(postal_code || '').replace(/\D/g, '');
    const cleanOrigin = String(this.correios.originCep || '01001000').replace(/\D/g, '');
    const rawWeight = Number(weight_g) || 500;
    // Arredonda peso para faixas de 100g para maximizar hits de cache
    const roundedWeight = Math.max(100, Math.ceil(rawWeight / 100) * 100);

    const cacheKey = `shipping:quote:${cleanOrigin}:${cleanPostalCode}:${roundedWeight}`;

    // 1. Consulta Cache no Valkey
    try {
      if (this.valkey.status === 'ready' || this.valkey.status === 'connect') {
        const cached = await this.valkey.get(cacheKey);
        if (cached) {
          const methods = JSON.parse(cached);
          return {
            methods: methods.map(m => ({ ...m, source: 'cache' })),
            source: 'cache'
          };
        }
      }
    } catch (cacheErr) {
      console.warn('[QuoteGateway] Falha ao consultar cache Valkey:', cacheErr.message);
    }

    // 2. Consulta API dos Correios se o circuito estiver fechado
    if (this.circuitBreaker.canAttempt()) {
      try {
        const methods = await this.correios.getQuote({
          destinationCep: cleanPostalCode,
          weightG: roundedWeight,
          dimensions
        });

        this.circuitBreaker.recordSuccess();

        // Grava no Valkey Cache
        try {
          if (this.valkey.status === 'ready' || this.valkey.status === 'connect') {
            await this.valkey.set(cacheKey, JSON.stringify(methods), 'EX', this.cacheTtlSeconds);
          }
        } catch (setCacheErr) {
          console.warn('[QuoteGateway] Falha ao gravar cache Valkey:', setCacheErr.message);
        }

        return {
          methods,
          source: 'api'
        };
      } catch (apiErr) {
        this.circuitBreaker.recordFailure(apiErr.message);
        console.warn('[QuoteGateway] API Correios indisponível ou com erro, ativando fallback:', apiErr.message);
        
        // Envia alerta leve no ntfy em background (sem travar o tempo de resposta do checkout)
        sendNtfyAlert(
          'Alerta de Frete: Fallback Ativado',
          `Cotação para CEP ${cleanPostalCode} (${roundedWeight}g) caiu no fallback. Erro API: ${apiErr.message}`,
          ['package', 'warning']
        ).catch(() => {});
      }
    } else {
      console.log(`[QuoteGateway] Circuito aberto, pulando API dos Correios direto para o fallback.`);
    }

    // 3. Fallback no Postgres Central
    const fallbackMethods = await getFallbackQuote(roundedWeight);
    return {
      methods: fallbackMethods,
      source: 'fallback'
    };
  }

  async generateLabel(data) {
    return this.correios.generateLabel(data);
  }
}

module.exports = {
  QuoteGateway,
  CircuitBreaker,
  sendNtfyAlert
};
