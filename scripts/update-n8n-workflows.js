const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const exportPath = path.join(__dirname, '../workflows/workflows-export-2026-09-04.json');
const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));

const eco = data.find(w => w.name === 'plataforma-eco-eventos');
if (!eco) {
  throw new Error('Workflow plataforma-eco-eventos não encontrado');
}

// 1. Atualizar Prepara Dados do Pedido
const prepNode = eco.nodes.find(n => n.id === 'code-prepare-order-data');
prepNode.parameters.jsCode = `const webhookData = $('Webhook Eventos').first().json;
const event = webhookData.body ? webhookData.body : webhookData;
const payload = event.payload || event;
const customer = payload.customer || {};
const customerKey = customer.customer_id ? String(customer.customer_id) : (customer.email || 'cliente@robo.net.br');
const customerTaxId = customer.tax_id ? String(customer.tax_id).replace(/\\D/g, '') : '';
const customerName = customer.full_name || customer.email || 'Cliente Sr. Robô';
const orderNumber = payload.order_number || String(payload.order_id || '0');
const occurredAt = event.occurred_at ? event.occurred_at.split('T')[0] : new Date().toISOString().split('T')[0];

const items = (payload.items || []).map(i => ({
  item_code: i.sku,
  item_name: i.name,
  qty: i.qty,
  rate: i.price,
  amount: i.total || (i.price * i.qty)
}));

const totals = payload.totals || {
  subtotal: 0,
  shipping_fee: 0,
  discount: 0,
  grand_total: 0
};

return [{
  json: {
    event,
    customerKey,
    customerName,
    customerEmail: customer.email || '',
    customerTaxId,
    orderNumber,
    occurredAt,
    items,
    totals,
    shippingAddress: payload.shipping_address || {}
  }
}];`;

// 2. Corrigir If customer-missing para loose / Number
const ifCustNode = eco.nodes.find(n => n.id === 'if-customer-missing');
ifCustNode.parameters = {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [
      {
        id: 'customer-missing-check',
        leftValue: '={{ Number(($json.data || []).length) }}',
        rightValue: 0,
        operator: { type: 'number', operation: 'equals' }
      }
    ],
    combinator: 'and'
  },
  options: {}
};

// 3. POST Customer no ERP
const postCustNode = eco.nodes.find(n => n.id === 'http-create-customer');
postCustNode.parameters.jsonBody = `{\n  "customer_name": "{{ $('Prepara Dados do Pedido').first().json.customerName }}",\n  "customer_type": "Individual",\n  "customer_group": "Individual",\n  "territory": "Brazil",\n  "tax_id": "{{ $('Prepara Dados do Pedido').first().json.customerTaxId }}",\n  "custom_external_id": "{{ $('Prepara Dados do Pedido').first().json.customerKey }}"\n}`;

// 4. Nó PUT para garantir tax_id no Customer recém-criado
const putCustTaxIdNode = {
  parameters: {
    method: 'PUT',
    url: '=http://erpnext-backend:8000/api/resource/Customer/{{ $json.data.name }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Authorization', value: 'token cfed787415906be:14c92a149e624db' },
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `{\n  "tax_id": "{{ $('Prepara Dados do Pedido').first().json.customerTaxId }}"\n}`,
    options: {}
  },
  id: 'http-put-customer-tax-id',
  name: 'PUT Customer Tax ID',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [1420, 100]
};

// 5. Atualizar Resolve Customer Name e Sales Order
const resolveCustNode = eco.nodes.find(n => n.id === 'code-resolve-customer');
resolveCustNode.position = [1620, 180];
resolveCustNode.parameters.jsCode = `const prep = $('Prepara Dados do Pedido').first().json;
let customerName = prep.customerName;

const getCust = $('GET Customer no ERP').first().json;
if (getCust.data && getCust.data.length > 0) {
  customerName = getCust.data[0].name;
} else {
  const postCust = $('POST Customer no ERP').first().json;
  if (postCust.data && postCust.data.name) {
    customerName = postCust.data.name;
  }
}

return [{
  json: {
    ...prep,
    resolvedCustomerName: customerName
  }
}];`;

const ifSoNode = eco.nodes.find(n => n.id === 'if-so-missing');
ifSoNode.parameters = {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
    conditions: [
      {
        id: 'so-missing-check',
        leftValue: '={{ Number(($json.data || []).length) }}',
        rightValue: 0,
        operator: { type: 'number', operation: 'equals' }
      }
    ],
    combinator: 'and'
  },
  options: {}
};

const postSoNode = eco.nodes.find(n => n.id === 'http-create-sales-order');
postSoNode.parameters.jsonBody = `{\n  "customer": "{{ $('Resolve Customer Name').first().json.resolvedCustomerName }}",\n  "transaction_date": "{{ $('Resolve Customer Name').first().json.occurredAt }}",\n  "delivery_date": "{{ $('Resolve Customer Name').first().json.occurredAt }}",\n  "currency": "BRL",\n  "company": "Sr Robo",\n  "custom_external_order_id": "{{ $('Resolve Customer Name').first().json.orderNumber }}",\n  "items": {{ JSON.stringify($('Resolve Customer Name').first().json.items) }}\n}`;

// 6. Adiciona nós de E-mail de Confirmação de Pedido (Workstream B)
const formatEmailNode = {
  parameters: {
    jsCode: `const order = $('Prepara Dados do Pedido').first().json;
const itemsHtml = order.items.map(i => \`
  <tr>
    <td style="padding: 8px; border-bottom: 1px solid #333;">\${i.item_name || i.item_code}</td>
    <td style="padding: 8px; border-bottom: 1px solid #333; text-align: center;">\${i.qty}</td>
    <td style="padding: 8px; border-bottom: 1px solid #333; text-align: right;">R$ \${Number(i.rate).toFixed(2)}</td>
    <td style="padding: 8px; border-bottom: 1px solid #333; text-align: right;">R$ \${Number(i.amount).toFixed(2)}</td>
  </tr>
\`).join('');

const html = \`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Confirmação de Pedido #\${order.orderNumber}</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d0f12; color: #e2e8f0; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #161a22; border: 1px solid #00f0ff; border-radius: 8px; padding: 24px;">
    <div style="text-align: center; border-bottom: 1px solid #2d3748; padding-bottom: 16px; margin-bottom: 20px;">
      <h1 style="color: #00f0ff; margin: 0; font-size: 24px; letter-spacing: 1px;">SR. ROBÔ</h1>
      <p style="color: #a0aec0; margin: 4px 0 0 0;">Confirmação de Pedido #\${order.orderNumber}</p>
    </div>
    
    <p>Olá, <strong>\${order.customerName}</strong>!</p>
    <p>Recebemos o seu pedido com sucesso. Ele já está sendo preparado pelo nosso sistema.</p>
    
    <h3 style="color: #00f0ff; margin-top: 24px; margin-bottom: 8px;">Itens do Pedido</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <thead>
        <tr style="background-color: #1f242e; color: #a0aec0;">
          <th style="padding: 8px; text-align: left;">Item</th>
          <th style="padding: 8px; text-align: center;">Qtd</th>
          <th style="padding: 8px; text-align: right;">Preço</th>
          <th style="padding: 8px; text-align: right;">Total</th>
        </tr>
      </thead>
      <tbody>
        \${itemsHtml}
      </tbody>
    </table>
    
    <div style="background-color: #1f242e; padding: 12px 16px; border-radius: 4px; margin-bottom: 20px;">
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span>Subtotal:</span>
        <span>R$ \${Number(order.totals.subtotal || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span>Frete:</span>
        <span>R$ \${Number(order.totals.shipping_fee || 0).toFixed(2)}</span>
      </div>
      <div style="display: flex; justify-content: space-between; font-size: 18px; font-weight: bold; color: #00f0ff; border-top: 1px solid #333; padding-top: 8px; margin-top: 8px;">
        <span>Total:</span>
        <span>R$ \${Number(order.totals.grand_total || 0).toFixed(2)}</span>
      </div>
    </div>
    
    <h3 style="color: #00f0ff; margin-top: 20px; margin-bottom: 8px;">Endereço de Entrega</h3>
    <p style="color: #cbd5e1; margin: 0; line-height: 1.5;">
      \${order.shippingAddress.address1 || ''} \${order.shippingAddress.address2 || ''}<br>
      \${order.shippingAddress.city || ''} - \${order.shippingAddress.province || ''}, CEP \${order.shippingAddress.postal_code || ''}
    </p>
    
    <div style="margin-top: 32px; border-top: 1px solid #2d3748; padding-top: 16px; font-size: 12px; color: #718096; text-align: center;">
      <p>Sr. Robô E-commerce &bull; https://sr.robo.net.br</p>
      <p>Este é um e-mail transacional automático.</p>
    </div>
  </div>
</body>
</html>\`;

return [{
  json: {
    to: order.customerEmail,
    subject: \`[Sr. Robô] Pedido #\${order.orderNumber} confirmado!\`,
    html,
    orderNumber: order.orderNumber
  }
}];`
  },
  id: 'code-format-email',
  name: 'Formata E-mail Transacional',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2500, 100]
};

const sendEmailNode = {
  parameters: {
    fromEmail: 'noreply@robo.net.br',
    toEmail: '={{ $json.to }}',
    subject: '={{ $json.subject }}',
    html: '={{ $json.html }}',
    options: {
      replyTo: 'contato@robo.net.br'
    }
  },
  id: 'send-confirmation-email',
  name: 'Send Confirmation Email',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [2720, 100]
};

// 7. Adiciona suporte a order.paid -> Etiqueta Correios (Workstream A4)
const switchNode = eco.nodes.find(n => n.id === 'switch-event-type');
const existingPaidRule = switchNode.parameters.rules.values.find(v => 
  JSON.stringify(v).includes('order.paid')
);

if (!existingPaidRule) {
  switchNode.parameters.rules.values.push({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [
        {
          id: 'switch-order-paid',
          leftValue: '={{ $json.headers["x-event-type"] || $json.body.event_type }}',
          rightValue: 'order.paid',
          operator: { type: 'string', operation: 'equals' }
        }
      ],
      combinator: 'and'
    }
  });
}

const prepLabelNode = {
  parameters: {
    jsCode: `const webhookData = $('Webhook Eventos').first().json;
const event = webhookData.body ? webhookData.body : webhookData;
const payload = event.payload || event;
return [{
  json: {
    order_id: payload.order_id,
    order_number: payload.order_number,
    service: 'sedex',
    recipient: payload.shipping_address || {},
    weight_g: 500
  }
}];`
  },
  id: 'code-prep-label',
  name: 'Prepara Dados Etiqueta',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [640, 600]
};

const httpGenLabelNode = {
  parameters: {
    method: 'POST',
    url: 'http://integracoes:9999/shipping/label',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: {}
  },
  id: 'http-gen-label',
  name: 'Worker Gera Etiqueta CWS',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [860, 600]
};

const logLabelNode = {
  parameters: {
    jsCode: `console.log('[Etiqueta Correios] Etiqueta gerada para pedido:', JSON.stringify($json, null, 2));
return $input.all();`
  },
  id: 'code-log-label',
  name: 'Log Etiqueta Emitida',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1080, 600]
};

// Reconstruir lista de nós
const existingIds = new Set(['http-put-customer-tax-id', 'code-format-email', 'send-confirmation-email', 'code-prep-label', 'http-gen-label', 'code-log-label']);
eco.nodes = [
  ...eco.nodes.filter(n => !existingIds.has(n.id)),
  putCustTaxIdNode,
  formatEmailNode,
  sendEmailNode,
  prepLabelNode,
  httpGenLabelNode,
  logLabelNode
];

// Reconstruir conexões
eco.connections['POST Customer no ERP'] = {
  main: [
    [
      { node: 'PUT Customer Tax ID', type: 'main', index: 0 }
    ]
  ]
};

eco.connections['PUT Customer Tax ID'] = {
  main: [
    [
      { node: 'Resolve Customer Name', type: 'main', index: 0 }
    ]
  ]
};

eco.connections['POST Sales Order no ERP'] = {
  main: [
    [
      { node: 'Formata E-mail Transacional', type: 'main', index: 0 }
    ]
  ]
};

eco.connections['Formata E-mail Transacional'] = {
  main: [
    [
      { node: 'Send Confirmation Email', type: 'main', index: 0 }
    ]
  ]
};

if (!eco.connections['Switch Event Type'].main[2]) {
  eco.connections['Switch Event Type'].main[2] = [];
}
eco.connections['Switch Event Type'].main[2] = [
  { node: 'Prepara Dados Etiqueta', type: 'main', index: 0 }
];

eco.connections['Prepara Dados Etiqueta'] = {
  main: [
    [
      { node: 'Worker Gera Etiqueta CWS', type: 'main', index: 0 }
    ]
  ]
};

eco.connections['Worker Gera Etiqueta CWS'] = {
  main: [
    [
      { node: 'Log Etiqueta Emitida', type: 'main', index: 0 }
    ]
  ]
};

fs.writeFileSync(exportPath, JSON.stringify(data, null, 2));
console.log('Workflows exportados atualizados com sucesso em:', exportPath);

// Atualizar banco do n8n
const nodesJson = JSON.stringify(eco.nodes);
const connJson = JSON.stringify(eco.connections);

const sql = `
UPDATE workflow_entity 
SET nodes = $$${nodesJson}$$::json,
    connections = $$${connJson}$$::json,
    "updatedAt" = NOW()
WHERE id = '${eco.id}';
`;

const res = spawnSync('docker', ['exec', '-i', 'postgres', 'psql', '-U', 'postgres', '-d', 'n8n'], {
  input: sql,
  encoding: 'utf8'
});

console.log('[n8n DB] Resultado do update:', res.stdout, res.stderr);
