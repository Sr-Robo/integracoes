const axios = require('axios');

class CorreiosClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.CORREIOS_BASE_URL || 'https://apihom.correios.com.br';
    this.usuario = options.usuario || process.env.CORREIOS_USUARIO || '';
    this.codigoAcesso = options.codigoAcesso || process.env.CORREIOS_CODIGO_ACESSO || '';
    this.contrato = options.contrato || process.env.CORREIOS_CONTRATO || '';
    this.cartao = options.cartao || process.env.CORREIOS_CARTAO || '';
    this.originCep = options.originCep || process.env.SHIPPING_ORIGIN_CEP || '01001000';
    this.timeoutMs = options.timeoutMs || 3000;

    // Cache de token em memória
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Obtém token JWT válido com cache em memória (renovação nos 30 minutos finais).
   */
  async getToken() {
    const now = Date.now();
    const thirtyMinutesMs = 30 * 60 * 1000;

    if (this.cachedToken && this.tokenExpiresAt - now > thirtyMinutesMs) {
      return this.cachedToken;
    }

    if (!this.usuario || !this.codigoAcesso) {
      throw new Error('Credenciais dos Correios (CORREIOS_USUARIO / CORREIOS_CODIGO_ACESSO) não configuradas');
    }

    const authHeader = `Basic ${Buffer.from(`${this.usuario}:${this.codigoAcesso}`).toString('base64')}`;
    const url = `${this.baseUrl}/token/v1/autentica/cartaopostagem`;

    const body = this.cartao ? { numero: this.cartao } : {};

    const response = await axios.post(url, body, {
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'sr-robo-integracoes/1.0'
      },
      timeout: this.timeoutMs
    });

    const data = response.data;
    this.cachedToken = data.token;

    // Parse do campo expiraEm (ISO string ou data formatada)
    if (data.expiraEm) {
      const expDate = new Date(data.expiraEm);
      this.tokenExpiresAt = isNaN(expDate.getTime()) ? now + 24 * 60 * 60 * 1000 : expDate.getTime();
    } else {
      // Default 24 horas
      this.tokenExpiresAt = now + 24 * 60 * 60 * 1000;
    }

    return this.cachedToken;
  }

  /**
   * Formata data no padrão DD-MM-YYYY exigido pelos Correios
   */
  formatDateDDMMYYYY(date = new Date()) {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  }

  /**
   * Realiza cotação de PAC e SEDEX para um destino e peso
   */
  async getQuote({ destinationCep, weightG = 500, dimensions = {} }) {
    const token = await this.getToken();
    const cleanOrigin = String(this.originCep).replace(/\D/g, '');
    const cleanDest = String(destinationCep).replace(/\D/g, '');
    const weight = Math.max(10, Math.min(30000, Math.round(weightG)));
    const dateStr = this.formatDateDDMMYYYY();

    const services = [
      { code: 'pac', correiosCode: '03298', name: 'Correios PAC' },
      { code: 'sedex', correiosCode: '03220', name: 'Correios SEDEX' }
    ];

    const methods = [];

    // Chamadas paralelas para os serviços
    await Promise.all(
      services.map(async (svc) => {
        try {
          // 1. Cotação de Preço
          const pricePromise = axios.post(
            `${this.baseUrl}/preco/v1/nacional`,
            {
              idLote: '1',
              parametrosCliente: [
                {
                  coProduto: svc.correiosCode,
                  cepOrigem: cleanOrigin,
                  cepDestino: cleanDest,
                  psObjeto: String(weight),
                  tpObjeto: '1', // Pacote / Caixa
                  comprimento: String(dimensions.length || 20),
                  largura: String(dimensions.width || 15),
                  altura: String(dimensions.height || 10),
                  nuContrato: this.contrato || undefined,
                  nuCartaoPostagem: this.cartao || undefined
                }
              ]
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              timeout: this.timeoutMs
            }
          );

          // 2. Cotação de Prazo (serviço 38210 / prazo nacional)
          const deadlinePromise = axios.post(
            `${this.baseUrl}/prazo/v1/nacional`,
            {
              idLote: '1',
              parametrosPrazo: [
                {
                  coProduto: svc.correiosCode,
                  cepOrigem: cleanOrigin,
                  cepDestino: cleanDest,
                  dtEvento: dateStr
                }
              ]
            },
            {
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
              },
              timeout: this.timeoutMs
            }
          );

          const [priceRes, deadlineRes] = await Promise.all([pricePromise, deadlinePromise]);

          let price = 0;
          if (priceRes.data && Array.isArray(priceRes.data) && priceRes.data[0]) {
            const item = priceRes.data[0];
            price = parseFloat(String(item.pcFinal || item.vlPrecoFinal || item.pcProduto || '0').replace(',', '.'));
          } else if (priceRes.data && priceRes.data.pcFinal) {
            price = parseFloat(String(priceRes.data.pcFinal).replace(',', '.'));
          }

          let deliveryDays = svc.code === 'sedex' ? 2 : 7;
          if (deadlineRes.data && Array.isArray(deadlineRes.data) && deadlineRes.data[0]) {
            const item = deadlineRes.data[0];
            deliveryDays = parseInt(item.prazoEntrega || item.prazo || deliveryDays, 10);
          } else if (deadlineRes.data && deadlineRes.data.prazoEntrega) {
            deliveryDays = parseInt(deadlineRes.data.prazoEntrega, 10);
          }

          if (price > 0) {
            methods.push({
              code: svc.code,
              name: svc.name,
              price: parseFloat(price.toFixed(2)),
              delivery_days: deliveryDays,
              source: 'api'
            });
          }
        } catch (err) {
          // Erro individual em um serviço não derruba o outro se o outro responder
          console.warn(`[CorreiosClient] Falha ao cotar serviço ${svc.code}:`, err.message);
        }
      })
    );

    if (methods.length === 0) {
      throw new Error('Nenhum método de frete retornado pela API dos Correios');
    }

    // Ordena PAC primeiro, depois SEDEX
    return methods.sort((a, b) => (a.code === 'pac' ? -1 : 1));
  }

  /**
   * Emissão de pré-postagem / etiqueta nos Correios
   */
  async generateLabel({ orderNumber, recipient = {}, weightG = 500, serviceCode = 'sedex' }) {
    const cleanOrigin = String(this.originCep).replace(/\D/g, '');
    const cleanDest = String(recipient.postal_code || recipient.postcode || '01001000').replace(/\D/g, '');
    const correiosCode = serviceCode.toLowerCase() === 'pac' ? '03298' : '03220';

    try {
      const token = await this.getToken();
      const response = await axios.post(
        `${this.baseUrl}/prepostagem/v1/prepostagens`,
        {
          idLote: String(orderNumber),
          remetente: {
            nome: 'Sr. Robô E-commerce',
            logradouro: 'Rua Central',
            numero: '100',
            cep: cleanOrigin,
            cidade: 'São Paulo',
            uf: 'SP'
          },
          destinatario: {
            nome: recipient.full_name || recipient.name || 'Cliente Sr. Robô',
            logradouro: recipient.address1 || recipient.address || 'Rua Cliente',
            numero: recipient.address2 || 'S/N',
            cep: cleanDest,
            cidade: recipient.city || 'São Paulo',
            uf: recipient.province || recipient.state || 'SP'
          },
          objeto: {
            codigoServico: correiosCode,
            peso: String(Math.round(weightG)),
            formatoObjeto: '1',
            dimensoes: {
              comprimento: '20',
              largura: '15',
              altura: '10'
            }
          }
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          timeout: this.timeoutMs * 2
        }
      );

      return {
        tracking_code: response.data.codigoRastreio || response.data.numeroEtiqueta || `BR${Date.now()}SEDEX`,
        label_url: response.data.urlEtiqueta || null,
        status: 'generated',
        service: serviceCode
      };
    } catch (err) {
      console.warn('[CorreiosClient] Falha na emissão real de pré-postagem, gerando tracking homologação:', err.message);
      // Mock / fallback de homologação
      const mockTracking = `BR${String(orderNumber).replace(/\D/g, '').padStart(9, '0')}${serviceCode.toUpperCase() === 'PAC' ? 'PAC' : 'SED'}`;
      return {
        tracking_code: mockTracking,
        label_url: null,
        status: 'mock_homologation',
        service: serviceCode
      };
    }
  }
}

module.exports = {
  CorreiosClient
};
