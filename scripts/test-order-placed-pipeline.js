const { Queue } = require('bullmq');
const { randomUUID } = require('crypto');

const connection = {
  host: process.env.VALKEY_HOST || 'valkey',
  port: parseInt(process.env.VALKEY_PORT || '6379', 10),
  maxRetriesPerRequest: null
};

async function testPipeline() {
  const queue = new Queue('orders', { connection });
  const eventId = randomUUID();
  const orderNumber = `OR-FASE3-${Math.floor(1000 + Math.random() * 9000)}`;

  const canonicalEvent = {
    event_id: eventId,
    event_type: 'order.placed',
    event_version: 1,
    occurred_at: new Date().toISOString(),
    producer: 'evershop',
    business_key: {
      order_number: orderNumber
    },
    payload: {
      order_id: String(Math.floor(10000 + Math.random() * 90000)),
      order_number: orderNumber,
      customer: {
        customer_id: 'cust_fase3_1',
        email: 'felipe.teste@robo.net.br',
        full_name: 'Felipe Teste Fase 3',
        tax_id: '52998224725', // CPF válido
        phone: '+5511999998888'
      },
      shipping_address: {
        full_name: 'Felipe Teste Fase 3',
        address1: 'Av. Paulista, 1000',
        city: 'São Paulo',
        province: 'SP',
        postal_code: '01310-100',
        country: 'BR'
      },
      items: [
        {
          product_id: '1',
          sku: 'ROBO-CAN-01',
          name: 'Caneca Hacker Sr. Robô',
          qty: 1,
          price: 49.90,
          total: 49.90
        }
      ],
      totals: {
        subtotal: 49.90,
        shipping_fee: 28.90,
        discount: 0.00,
        tax: 0.00,
        grand_total: 78.80
      },
      currency: 'BRL',
      created_at: new Date().toISOString()
    }
  };

  console.log(`Enfileirando order.placed (ID: ${eventId}, Order: ${orderNumber})...`);
  await queue.add('order.placed', canonicalEvent, {
    jobId: eventId,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 }
  });

  console.log('Evento enfileirado com sucesso!');
  await queue.close();
}

testPipeline().catch(err => {
  console.error('Erro ao testar pipeline:', err);
  process.exit(1);
});
