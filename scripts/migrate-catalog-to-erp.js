const { Client } = require('pg');
const axios = require('axios');

async function migrate() {
  const evershopDb = new Client({
    host: process.env.EVERSHOP_DB_HOST || 'ecommerce_database',
    port: parseInt(process.env.EVERSHOP_DB_PORT || '5432', 10),
    database: process.env.EVERSHOP_DB_NAME || 'evershop',
    user: process.env.EVERSHOP_DB_USER || 'evershop',
    password: process.env.EVERSHOP_DB_PASSWORD,
  });

  await evershopDb.connect();
  console.log('[migrate] Conectado ao banco do EverShop.');

  const erpBaseUrl = process.env.ERPNEXT_URL || 'http://erpnext-backend:8000';
  const apiKey = process.env.ERPNEXT_API_KEY;
  const apiSecret = process.env.ERPNEXT_API_SECRET;

  const erpApi = axios.create({
    baseURL: erpBaseUrl,
    headers: {
      Authorization: `token ${apiKey}:${apiSecret}`,
      Host: 'erp.robo.net.br',
      'Content-Type': 'application/json',
    },
  });

  const query = `
    SELECT 
      p.uuid,
      p.sku,
      p.price,
      p.weight,
      p.status,
      pd.name,
      COALESCE(pi.qty, 0) AS qty 
    FROM product p 
    JOIN product_description pd ON pd.product_description_product_id = p.product_id 
    LEFT JOIN product_inventory pi ON pi.product_inventory_product_id = p.product_id 
    WHERE p.status = true;
  `;

  const res = await evershopDb.query(query);
  console.log(`[migrate] Encontrados ${res.rows.length} produtos ativos no EverShop.`);

  let createdCount = 0;
  let updatedCount = 0;
  const shopSkus = new Set();

  for (const row of res.rows) {
    const sku = row.sku.trim();
    shopSkus.add(sku);

    const price = parseFloat(row.price);
    const weight = row.weight ? parseFloat(row.weight) : null;
    const qty = parseInt(row.qty, 10);
    const name = row.name.trim();

    // Checar se já existe no ERPNext
    let exists = false;
    try {
      const checkRes = await erpApi.get(`/api/resource/Item/${encodeURIComponent(sku)}`);
      if (checkRes.data && checkRes.data.data) {
        exists = true;
      }
    } catch (err) {
      if (err.response && err.response.status === 404) {
        exists = false;
      } else {
        throw err;
      }
    }

    if (exists) {
      // PUT update
      const payload = {
        item_name: name,
        standard_rate: price,
        custom_external_sku: sku,
      };
      if (weight !== null) {
        payload.weight_per_unit = weight;
      }
      await erpApi.put(`/api/resource/Item/${encodeURIComponent(sku)}`, payload);
      updatedCount++;
    } else {
      // POST create
      const payload = {
        item_code: sku,
        item_name: name,
        standard_rate: price,
        item_group: 'Products',
        stock_uom: 'Unit',
        is_stock_item: 1,
        custom_external_sku: sku,
      };
      if (weight !== null) {
        payload.weight_per_unit = weight;
      }
      if (qty > 0) {
        payload.opening_stock = qty;
        payload.valuation_rate = price;
      }
      await erpApi.post('/api/resource/Item', payload);
      createdCount++;
    }
  }

  console.log(`[migrate] Sincronização concluída: ${createdCount} criados, ${updatedCount} atualizados.`);

  // Auditoria zero-órfão
  const erpItemsRes = await erpApi.get('/api/resource/Item?limit_page_length=0&fields=["name","item_code"]');
  const erpItemCodes = new Set(erpItemsRes.data.data.map(i => i.item_code));

  console.log(`[auditoria] Total SKUs Loja: ${shopSkus.size} | Total Itens ERP: ${erpItemCodes.size}`);

  const diffShopMinusErp = [...shopSkus].filter(x => !erpItemCodes.has(x));
  const diffErpMinusShop = [...erpItemCodes].filter(x => !shopSkus.has(x));

  if (diffShopMinusErp.length === 0 && diffErpMinusShop.length === 0) {
    console.log('[auditoria] AUDITORIA ZERO-ÓRFÃO: PERFEITO! 1:1 exato entre Loja e ERPNext.');
  } else {
    console.error('[auditoria] DIFERENÇA DETECTADA:');
    console.error('  Loja - ERP:', diffShopMinusErp);
    console.error('  ERP - Loja:', diffErpMinusShop);
  }

  await evershopDb.end();
}

migrate().catch(err => {
  console.error('[migrate] Erro fatal:', err.message, err.response ? err.response.data : '');
  process.exit(1);
});
