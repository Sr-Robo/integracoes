const axios = require('axios');

function calcEan13(code12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(code12[i], 10);
    sum += (i % 2 === 0) ? digit : digit * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return code12 + check;
}

async function run() {
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

  const res = await erpApi.get('/api/resource/Item?limit_page_length=0&fields=["name","item_code","item_name","disabled"]');
  const items = res.data.data.filter(i => i.disabled === 0).sort((a, b) => a.name.localeCompare(b.name));

  console.log(`[barcodes] Encontrados ${items.length} itens ativos.`);

  let index = 1;
  const results = [];

  for (const item of items) {
    const code12 = `7891000000${String(index).padStart(2, '0')}`;
    const ean13 = calcEan13(code12);

    const updatePayload = {
      barcodes: [
        {
          barcode: ean13,
          barcode_type: 'EAN',
          uom: 'Unit'
        }
      ]
    };

    const putRes = await erpApi.put(`/api/resource/Item/${encodeURIComponent(item.name)}`, updatePayload);
    const savedBarcodes = putRes.data.data.barcodes || [];
    results.push({
      item_code: item.name,
      item_name: item.item_name,
      barcode: savedBarcodes.length > 0 ? savedBarcodes[0].barcode : null,
      barcode_type: savedBarcodes.length > 0 ? savedBarcodes[0].barcode_type : null,
    });
    index++;
  }

  console.log('[barcodes] Atualização concluída com sucesso.');
  console.table(results);

  // Validação do critério W1:
  console.log('\n[barcodes] Verificando todos os 24 itens...');
  let allValid = true;
  for (const r of results) {
    if (!r.barcode) {
      allValid = false;
      console.error(`Item ${r.item_code} não possui barcode!`);
    }
  }

  if (allValid && results.length === 24) {
    console.log(`[barcodes] CRITÉRIO W1 ATENDIDO: 24/24 itens ativos com barcode EAN-13 válido.`);
  } else {
    console.error(`[barcodes] CRITÉRIO W1 NÃO ATENDIDO: total=${results.length}, allValid=${allValid}`);
    process.exit(1);
  }
}

run().catch(err => {
  console.error('[barcodes] Erro fatal:', err.message, err.response ? err.response.data : '');
  process.exit(1);
});
