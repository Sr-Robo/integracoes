const { Client } = require('pg');
const axios = require('axios');

async function createShopShipment({ orderNumber, trackingCode, carrier = 'custom' }) {
  if (!process.env.EVERSHOP_ADMIN_EMAIL || !process.env.EVERSHOP_ADMIN_PASSWORD) {
    throw new Error('EVERSHOP_ADMIN_EMAIL and EVERSHOP_ADMIN_PASSWORD environment variables are required');
  }

  const evershopDb = new Client({
    host: process.env.EVERSHOP_DB_HOST || 'ecommerce_database',
    port: parseInt(process.env.EVERSHOP_DB_PORT || '5432', 10),
    database: process.env.EVERSHOP_DB_NAME || 'evershop',
    user: process.env.EVERSHOP_DB_USER || 'evershop',
    password: process.env.EVERSHOP_DB_PASSWORD,
  });

  await evershopDb.connect();
  try {
    const orderRes = await evershopDb.query(
      'SELECT order_id, uuid, order_number, shipment_status FROM "order" WHERE order_number = $1',
      [String(orderNumber)]
    );

    if (orderRes.rows.length === 0) {
      throw new Error(`Order #${orderNumber} not found in EverShop`);
    }

    const order = orderRes.rows[0];

    // Verificar se já foi enviado (idempotência)
    if (order.shipment_status === 'shipped' || order.shipment_status === 'delivered') {
      console.log(`[ShipmentService] Pedido #${orderNumber} já está com status '${order.shipment_status}'. Replay ignorado.`);
      return {
        success: true,
        already_shipped: true,
        order_number: orderNumber,
        order_uuid: order.uuid
      };
    }

    const itemsRes = await evershopDb.query(
      'SELECT order_item_id, qty FROM order_item WHERE order_item_order_id = $1',
      [order.order_id]
    );

    const items = itemsRes.rows.map(r => ({
      order_item_id: r.order_item_id,
      qty: r.qty
    }));

    // Login no EverShop
    const loginRes = await axios.post('http://ecommerce_evershop:3000/api/user/tokens', {
      email: process.env.EVERSHOP_ADMIN_EMAIL,
      password: process.env.EVERSHOP_ADMIN_PASSWORD
    });
    const token = loginRes.data.data.accessToken;

    // Criar Shipment na loja via API
    const shipRes = await axios.post(
      `http://ecommerce_evershop:3000/api/orders/${order.uuid}/shipments`,
      {
        carrier,
        tracking_number: trackingCode || 'SEM-RASTREIO',
        items
      },
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    return {
      success: true,
      order_number: orderNumber,
      order_uuid: order.uuid,
      shipment: shipRes.data.data ? shipRes.data.data.shipment : shipRes.data
    };
  } finally {
    await evershopDb.end();
  }
}

module.exports = {
  createShopShipment
};
