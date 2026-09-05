const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.env.ERPNEXT_API_KEY || !process.env.ERPNEXT_API_SECRET) {
  throw new Error('ERPNEXT_API_KEY and ERPNEXT_API_SECRET environment variables are required');
}
if (!process.env.ERP_STOCK_WEBHOOK_SECRET) {
  throw new Error('ERP_STOCK_WEBHOOK_SECRET environment variable is required');
}

const erpnextCredential = {
  httpHeaderAuth: {
    id: '5c84d711-e401-447a-8f19-38b8fa111111',
    name: 'ERPNext API (integracoes)'
  }
};

const ecoId = 'e89e3a75-b4c1-4b77-983b-f11111111111';
const dnId = 'e89e3a75-b4c1-4b77-983b-f33333333333';

// Carregar JSON do eco-eventos atual do n8n
const getEcoSql = `SELECT json_agg(w) FROM workflow_entity w WHERE id = '${ecoId}';`;
const ecoRes = spawnSync('docker', ['exec', '-i', 'postgres', 'psql', '-U', 'postgres', '-d', 'n8n', '-t', '-A', '-c', getEcoSql], { encoding: 'utf8' });
let ecoWorkflow;
try {
  ecoWorkflow = JSON.parse(ecoRes.stdout.trim())[0];
} catch (e) {
  throw new Error('Falha ao ler workflow eco-eventos do DB n8n: ' + e.message);
}

// -------------------------------------------------------------
// A. Normalizar Evento e Atualizar Switch do eco-eventos
// -------------------------------------------------------------
const codeNormalizeEvent = {
  parameters: {
    jsCode: `const raw = $input.first().json;
let body = raw.body;
if (!body && raw.binary && raw.binary.data) {
  try {
    const buf = Buffer.from(raw.binary.data.data, 'base64');
    body = JSON.parse(buf.toString('utf-8'));
  } catch (e) {}
} else if (typeof body === 'string') {
  try {
    body = JSON.parse(body);
  } catch (e) {}
}
body = body || {};

const headers = raw.headers || {};
const event_type = headers['x-event-type'] || headers['ce-type'] || body.event_type || body.type || raw.event_type || raw.type || '';

return [{
  json: {
    ...raw,
    body,
    headers,
    event_type
  }
}];`
  },
  id: 'code-normalize-event',
  name: 'Normaliza Evento',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [420, 450]
};

const switchNode = ecoWorkflow.nodes.find(n => n.id === 'switch-event-type');
switchNode.parameters.rules.values = [
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          id: 'switch-order-placed',
          leftValue: '={{ $json.event_type }}',
          rightValue: 'order.placed',
          operator: { type: 'string', operation: 'equals' }
        }
      ],
      combinator: 'and'
    }
  },
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          id: 'switch-order-paid',
          leftValue: '={{ $json.event_type }}',
          rightValue: 'order.paid',
          operator: { type: 'string', operation: 'equals' }
        }
      ],
      combinator: 'and'
    }
  },
  {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          id: 'switch-order-shipped',
          leftValue: '={{ $json.event_type }}',
          rightValue: 'order.shipped',
          operator: { type: 'string', operation: 'equals' }
        }
      ],
      combinator: 'and'
    }
  }
];

// -------------------------------------------------------------
// B. Nós de Faturamento para order.paid (W2)
// -------------------------------------------------------------
const httpGetSoInvoicing = {
  parameters: {
    method: 'GET',
    url: '=http://erpnext-backend:8000/api/resource/Sales%20Order?filters=[["custom_external_order_id","=","{{ $(\'Prepara Dados Etiqueta\').first().json.order_number }}"]]&fields=["name","docstatus","per_billed","status"]',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    options: {}
  },
  credentials: erpnextCredential,
  id: 'http-get-so-invoicing',
  name: 'GET Sales Order p/ Faturar',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [1300, 600]
};

const ifSoNeedsInvoice = {
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          id: 'check-so-exists',
          leftValue: '={{ Number(($json.data || []).length) }}',
          rightValue: 1,
          operator: { type: 'number', operation: 'gte' }
        },
        {
          id: 'check-per-billed',
          leftValue: '={{ Number(($json.data && $json.data[0] ? $json.data[0].per_billed : 0) || 0) }}',
          rightValue: 100,
          operator: { type: 'number', operation: 'lt' }
        }
      ],
      combinator: 'and'
    },
    options: {}
  },
  id: 'if-so-needs-invoice',
  name: 'SO Existe e Não Faturado?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.1,
  position: [1520, 600]
};

const codePrepInvoiceCall = {
  parameters: {
    jsCode: `const getSoData = $('GET Sales Order p/ Faturar').first().json.data[0];
return [{
  json: {
    so_name: getSoData.name,
    docstatus: getSoData.docstatus,
    order_number: $('Prepara Dados Etiqueta').first().json.order_number
  }
}];`
  },
  id: 'code-prep-invoice-call',
  name: 'Prepara Chamada Faturamento',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1740, 500]
};

const ifSoDraft = {
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
      conditions: [
        {
          id: 'check-so-draft',
          leftValue: '={{ Number($json.docstatus) }}',
          rightValue: 0,
          operator: { type: 'number', operation: 'equals' }
        }
      ],
      combinator: 'and'
    },
    options: {}
  },
  id: 'if-so-draft',
  name: 'SO em Rascunho?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.1,
  position: [1960, 500]
};

const httpSubmitSo = {
  parameters: {
    method: 'PUT',
    url: '=http://erpnext-backend:8000/api/resource/Sales%20Order/{{ encodeURIComponent($json.so_name) }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '{\n  "docstatus": 1\n}',
    options: {}
  },
  credentials: erpnextCredential,
  id: 'http-submit-so',
  name: 'Submit Sales Order',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [2180, 420]
};

const httpMakeSalesInvoice = {
  parameters: {
    method: 'POST',
    url: 'http://erpnext-backend:8000/api/method/erpnext.selling.doctype.sales_order.sales_order.make_sales_invoice',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={\n  "source_name": "{{ $json.so_name || $json.data?.name || $(\'Prepara Chamada Faturamento\').first().json.so_name }}"\n}',
    options: {}
  },
  credentials: erpnextCredential,
  id: 'http-make-sales-invoice',
  name: 'Method make_sales_invoice',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [2400, 500]
};

const codePrepInvoiceDoc = {
  parameters: {
    jsCode: `const invDoc = $input.first().json.message;
// Regra de ouro da Fase 4: update_stock=0 SEMPRE na Sales Invoice (a baixa real nasce na Delivery Note)
invDoc.update_stock = 0;
return [{
  json: invDoc
}];`
  },
  id: 'code-prep-invoice-doc',
  name: 'Garante update_stock=0',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [2620, 500]
};

const httpCreateSalesInvoice = {
  parameters: {
    method: 'POST',
    url: 'http://erpnext-backend:8000/api/resource/Sales%20Invoice',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify($json) }}',
    options: {}
  },
  credentials: erpnextCredential,
  id: 'http-create-sales-invoice',
  name: 'POST Sales Invoice',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [2840, 500]
};

const httpSubmitSalesInvoice = {
  parameters: {
    method: 'PUT',
    url: '=http://erpnext-backend:8000/api/resource/Sales%20Invoice/{{ encodeURIComponent($json.data.name) }}',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Host', value: 'erp.robo.net.br' }
      ]
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '{\n  "docstatus": 1\n}',
    options: {}
  },
  credentials: erpnextCredential,
  id: 'http-submit-sales-invoice',
  name: 'Submit Sales Invoice',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 3,
  position: [3060, 500]
};

const codeLogInvoiceSuccess = {
  parameters: {
    jsCode: `console.log(\`[Faturamento] Sales Invoice \${$json.data.name} criada e submetida com sucesso para o pedido #\${$('Prepara Chamada Faturamento').first().json.order_number}.\`);
return $input.all();`
  },
  id: 'code-log-invoice-success',
  name: 'Log Faturamento Concluído',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [3280, 500]
};

const codeLogInvoiceSkip = {
  parameters: {
    jsCode: `console.log('[Faturamento] Pedido já faturado ou Sales Order inexistente. Replay ignorado com sucesso (idempotente).');
return $input.all();`
  },
  id: 'code-log-invoice-skip',
  name: 'Log Faturamento Já Feito (No-op)',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1740, 700]
};

// -------------------------------------------------------------
// C. Nós de E-mail de Rastreio para order.shipped (W4)
// -------------------------------------------------------------
const codePrepTrackingEmail = {
  parameters: {
    jsCode: `const webhookData = $('Webhook Eventos').first().json;
const event = webhookData.body ? webhookData.body : webhookData;
const payload = event.data || event.payload || event;

const orderNumber = payload.order_number || '0';
const trackingCode = payload.tracking_code || 'SEM-RASTREIO';
const carrier = payload.carrier || 'Correios';

const html = \`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Pedido #\${orderNumber} Despachado</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0d0f12; color: #e2e8f0; margin: 0; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background-color: #161a22; border: 1px solid #00f0ff; border-radius: 8px; padding: 24px;">
    <div style="text-align: center; border-bottom: 1px solid #2d3748; padding-bottom: 16px; margin-bottom: 20px;">
      <h1 style="color: #00f0ff; margin: 0; font-size: 24px; letter-spacing: 1px;">SR. ROBÔ</h1>
      <p style="color: #a0aec0; margin: 4px 0 0 0;">Pedido #\${orderNumber} a caminho!</p>
    </div>
    
    <p>Olá!</p>
    <p>O seu pedido <strong>#\${orderNumber}</strong> foi separado, embalado e despachado para entrega com sucesso.</p>
    
    <div style="background-color: #1f242e; border: 1px solid #00f0ff; padding: 16px; border-radius: 6px; margin: 20px 0; text-align: center;">
      <p style="color: #a0aec0; margin: 0 0 8px 0; font-size: 14px;">CÓDIGO DE RASTREAMENTO</p>
      <p style="font-family: monospace; font-size: 22px; font-weight: bold; color: #00f0ff; letter-spacing: 2px; margin: 0 0 8px 0;">\${trackingCode}</p>
      <p style="color: #718096; margin: 0; font-size: 13px;">Transportadora: <strong>\${carrier}</strong></p>
    </div>
    
    <p style="color: #a0aec0; font-size: 14px;">Você pode acompanhar o rastreio diretamente no site da transportadora.</p>
    
    <div style="margin-top: 32px; border-top: 1px solid #2d3748; padding-top: 16px; font-size: 12px; color: #718096; text-align: center;">
      <p>Sr. Robô E-commerce &bull; https://sr.robo.net.br</p>
      <p>Este é um e-mail transacional automático via ForwardEmail.</p>
    </div>
  </div>
</body>
</html>\`;

console.log(\`[Email Rastreio] E-mail de rastreio para pedido #\${orderNumber} montado com tracking \${trackingCode}.\`);
return [{
  json: {
    to: 'cliente@robo.net.br',
    subject: \`[Sr. Robô] Seu pedido #\${orderNumber} foi enviado! (Rastreio \${trackingCode})\`,
    html,
    orderNumber,
    trackingCode
  }
}];`
  },
  id: 'code-prep-tracking-email',
  name: 'Prepara E-mail de Rastreio',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [640, 900]
};

const sendTrackingEmail = {
  parameters: {
    fromEmail: 'noreply@robo.net.br',
    toEmail: '={{ $json.to }}',
    subject: '={{ $json.subject }}',
    emailFormat: 'html',
    html: '={{ $json.html }}',
    options: {
      replyTo: 'sr@robo.net.br'
    }
  },
  id: 'send-tracking-email',
  name: 'Enviar E-mail Rastreio (SMTP)',
  type: 'n8n-nodes-base.emailSend',
  typeVersion: 2.1,
  position: [860, 900],
  onError: 'continueRegularOutput',
  credentials: {
    smtp: {
      id: '0c8aa506-4e90-4c1d-ba58-8d6b22a97fb1',
      name: 'SMTP forwardemail (noreply)'
    }
  }
};

// Reconstruir lista de nós do eco-eventos
const ecoNewNodeIds = new Set([
  'code-normalize-event',
  'http-get-so-invoicing',
  'if-so-needs-invoice',
  'code-prep-invoice-call',
  'if-so-draft',
  'http-submit-so',
  'http-make-sales-invoice',
  'code-prep-invoice-doc',
  'http-create-sales-invoice',
  'http-submit-sales-invoice',
  'code-log-invoice-success',
  'code-log-invoice-skip',
  'code-prep-tracking-email',
  'send-tracking-email'
]);

// Resiliência em nós legados de e-mail
ecoWorkflow.nodes.forEach(n => {
  if (n.type === 'n8n-nodes-base.emailSend') {
    n.onError = 'continueRegularOutput';
  }
});

ecoWorkflow.nodes = [
  ...ecoWorkflow.nodes.filter(n => !ecoNewNodeIds.has(n.id)),
  codeNormalizeEvent,
  httpGetSoInvoicing,
  ifSoNeedsInvoice,
  codePrepInvoiceCall,
  ifSoDraft,
  httpSubmitSo,
  httpMakeSalesInvoice,
  codePrepInvoiceDoc,
  httpCreateSalesInvoice,
  httpSubmitSalesInvoice,
  codeLogInvoiceSuccess,
  codeLogInvoiceSkip,
  codePrepTrackingEmail,
  sendTrackingEmail
];

ecoWorkflow.nodes.forEach(n => {
  if (n.parameters?.headerParameters?.parameters) {
    n.parameters.headerParameters.parameters = n.parameters.headerParameters.parameters.filter(
      p => p.name !== 'Authorization'
    );
  }
  if (n.type === 'n8n-nodes-base.httpRequest' && (n.parameters?.url || '').includes('erpnext-backend')) {
    n.parameters.authentication = 'genericCredentialType';
    n.parameters.genericAuthType = 'httpHeaderAuth';
    n.credentials = erpnextCredential;
  }
});

// Conexões do eco-eventos
ecoWorkflow.connections['Webhook Eventos'] = {
  main: [[{ node: 'Normaliza Evento', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Normaliza Evento'] = {
  main: [[{ node: 'Switch Event Type', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Log Etiqueta Emitida'] = {
  main: [[{ node: 'GET Sales Order p/ Faturar', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['GET Sales Order p/ Faturar'] = {
  main: [[{ node: 'SO Existe e Não Faturado?', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['SO Existe e Não Faturado?'] = {
  main: [
    [{ node: 'Prepara Chamada Faturamento', type: 'main', index: 0 }],
    [{ node: 'Log Faturamento Já Feito (No-op)', type: 'main', index: 0 }]
  ]
};

ecoWorkflow.connections['Prepara Chamada Faturamento'] = {
  main: [[{ node: 'SO em Rascunho?', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['SO em Rascunho?'] = {
  main: [
    [{ node: 'Submit Sales Order', type: 'main', index: 0 }],
    [{ node: 'Method make_sales_invoice', type: 'main', index: 0 }]
  ]
};

ecoWorkflow.connections['Submit Sales Order'] = {
  main: [[{ node: 'Method make_sales_invoice', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Method make_sales_invoice'] = {
  main: [[{ node: 'Garante update_stock=0', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Garante update_stock=0'] = {
  main: [[{ node: 'POST Sales Invoice', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['POST Sales Invoice'] = {
  main: [[{ node: 'Submit Sales Invoice', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Submit Sales Invoice'] = {
  main: [[{ node: 'Log Faturamento Concluído', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Switch Event Type'] = {
  main: [
    // Output 0: order.placed
    [{ node: 'Prepara Dados do Pedido', type: 'main', index: 0 }],
    // Output 1: order.paid
    [{ node: 'Prepara Dados Etiqueta', type: 'main', index: 0 }],
    // Output 2: order.shipped
    [{ node: 'Prepara E-mail de Rastreio', type: 'main', index: 0 }],
    // Fallback: outros eventos
    [{ node: 'Log Outros Eventos', type: 'main', index: 0 }]
  ]
};

ecoWorkflow.connections['Prepara Dados Etiqueta'] = {
  main: [[{ node: 'Worker Gera Etiqueta CWS', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Worker Gera Etiqueta CWS'] = {
  main: [[{ node: 'Log Etiqueta Emitida', type: 'main', index: 0 }]]
};

ecoWorkflow.connections['Prepara E-mail de Rastreio'] = {
  main: [[{ node: 'Enviar E-mail Rastreio (SMTP)', type: 'main', index: 0 }]]
};

// -------------------------------------------------------------
// D. Workflow plataforma-erp-dn (W4: DN -> Loja Shipment)
// -------------------------------------------------------------
const dnWorkflow = {
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  id: dnId,
  name: 'plataforma-erp-dn',
  description: 'Gera Shipment no EverShop a partir da Delivery Note do ERPNext (Fase 4 - W4)',
  active: true,
  isArchived: false,
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'erp-dn',
        responseMode: 'onReceived',
        options: {}
      },
      id: 'webhook-erp-dn',
      name: 'Webhook ERP Delivery Note',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [200, 300],
      webhookId: 'plataforma-erp-dn'
    },
    {
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
          conditions: [
            {
              id: 'check-token',
              leftValue: '={{ $json.headers["x-erp-token"] }}',
              rightValue: '={{ $env.ERP_STOCK_WEBHOOK_SECRET }}',
              operator: { type: 'string', operation: 'equals' }
            }
          ],
          combinator: 'and'
        },
        options: {}
      },
      id: 'if-valid-token-dn',
      name: 'Valida X-Erp-Token',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.1,
      position: [420, 300]
    },
    {
      parameters: {
        jsCode: `const webhookItem = $('Webhook ERP Delivery Note').first();
let rawPayload = webhookItem.json.body;

if (!rawPayload && webhookItem.binary && webhookItem.binary.data) {
  const buf = Buffer.from(webhookItem.binary.data.data, 'base64');
  rawPayload = JSON.parse(buf.toString('utf-8'));
} else if (typeof rawPayload === 'string') {
  rawPayload = JSON.parse(rawPayload);
}

const items = rawPayload.items || [];
let soName = '';
for (const item of items) {
  if (item.against_sales_order) {
    soName = item.against_sales_order;
    break;
  }
}

return [{
  json: {
    delivery_note: rawPayload.delivery_note,
    customer: rawPayload.customer,
    tracking_no: rawPayload.tracking_no || 'BR-RASTREIO-PADRAO',
    so_name: soName,
    items
  }
}];`
      },
      id: 'code-prep-dn-data',
      name: 'Prepara Dados DN',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [640, 300]
    },
    {
      parameters: {
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        method: 'GET',
        url: '=http://erpnext-backend:8000/api/resource/Sales%20Order/{{ encodeURIComponent($json.so_name) }}',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Host', value: 'erp.robo.net.br' }
          ]
        },
        options: {}
      },
      credentials: erpnextCredential,
      id: 'http-get-so-for-dn',
      name: 'GET Sales Order no ERP',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 3,
      position: [860, 300]
    },
    {
      parameters: {
        method: 'POST',
        url: 'http://integracoes:9999/shop/create-shipment',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={\n  "order_number": "{{ $json.data.custom_external_order_id }}",\n  "tracking_code": "{{ $(\'Prepara Dados DN\').first().json.tracking_no }}",\n  "carrier": "custom"\n}',
        options: {}
      },
      id: 'http-call-create-shipment',
      name: 'Worker Cria Shipment na Loja',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 3,
      position: [1080, 300]
    },
    {
      parameters: {
        jsCode: `console.log('[Shipment Loja] Shipment criado com sucesso via Worker:', JSON.stringify($json, null, 2));
return $input.all();`
      },
      id: 'code-log-shipment-created',
      name: 'Log Shipment Criado',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [1300, 300]
    }
  ],
  connections: {
    'Webhook ERP Delivery Note': {
      main: [[{ node: 'Valida X-Erp-Token', type: 'main', index: 0 }]]
    },
    'Valida X-Erp-Token': {
      main: [[{ node: 'Prepara Dados DN', type: 'main', index: 0 }]]
    },
    'Prepara Dados DN': {
      main: [[{ node: 'GET Sales Order no ERP', type: 'main', index: 0 }]]
    },
    'GET Sales Order no ERP': {
      main: [[{ node: 'Worker Cria Shipment na Loja', type: 'main', index: 0 }]]
    },
    'Worker Cria Shipment na Loja': {
      main: [[{ node: 'Log Shipment Criado', type: 'main', index: 0 }]]
    }
  },
  settings: {
    executionOrder: 'v1',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveExecutionProgress: true,
    saveManualExecutions: true
  }
};

// -------------------------------------------------------------
// E. Salvar no Postgres do n8n e Exportar Arquivos
// -------------------------------------------------------------
const updateEcoSql = `
UPDATE workflow_entity 
SET nodes = $$${JSON.stringify(ecoWorkflow.nodes)}$$::json,
    connections = $$${JSON.stringify(ecoWorkflow.connections)}$$::json,
    "updatedAt" = NOW()
WHERE id = '${ecoId}';

UPDATE workflow_history
SET nodes = $$${JSON.stringify(ecoWorkflow.nodes)}$$::json,
    connections = $$${JSON.stringify(ecoWorkflow.connections)}$$::json,
    "updatedAt" = NOW()
WHERE "workflowId" = '${ecoId}';
`;

spawnSync('docker', ['exec', '-i', 'postgres', 'psql', '-U', 'postgres', '-d', 'n8n'], {
  input: updateEcoSql,
  encoding: 'utf8'
});

const updateDnSql = `
UPDATE workflow_entity 
SET nodes = $$${JSON.stringify(dnWorkflow.nodes)}$$::json,
    connections = $$${JSON.stringify(dnWorkflow.connections)}$$::json,
    settings = $$${JSON.stringify(dnWorkflow.settings)}$$::json,
    active = true,
    "updatedAt" = NOW()
WHERE id = '${dnId}';

UPDATE workflow_history
SET nodes = $$${JSON.stringify(dnWorkflow.nodes)}$$::json,
    connections = $$${JSON.stringify(dnWorkflow.connections)}$$::json,
    "updatedAt" = NOW()
WHERE "workflowId" = '${dnId}';
`;

const dnRes = spawnSync('docker', ['exec', '-i', 'postgres', 'psql', '-U', 'postgres', '-d', 'n8n'], {
  input: updateDnSql,
  encoding: 'utf8'
});
if (dnRes.stderr) console.error('DN DB update error:', dnRes.stderr);

// Exportar workflows
const exportPath = path.join(__dirname, '../workflows/workflows-fase4-wms.json');
fs.writeFileSync(exportPath, JSON.stringify([ecoWorkflow, dnWorkflow], null, 2));
console.log('Workflows Fase 4 salvos no DB do n8n e exportados para:', exportPath);
