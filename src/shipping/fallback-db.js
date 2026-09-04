const { Pool } = require('pg');

const centralPool = new Pool({
  host: process.env.CENTRAL_DB_HOST || 'postgres',
  port: parseInt(process.env.CENTRAL_DB_PORT || '5432', 10),
  user: process.env.CENTRAL_DB_USER || 'integracoes',
  password: process.env.CENTRAL_DB_PASSWORD,
  database: process.env.CENTRAL_DB_NAME || 'integracoes'
});

async function initFallbackDb() {
  await centralPool.query(`
    CREATE TABLE IF NOT EXISTS frete_fallback (
      id SERIAL PRIMARY KEY,
      servico VARCHAR(20) NOT NULL,
      peso_min_g INT NOT NULL,
      peso_max_g INT NOT NULL,
      preco_centavos INT NOT NULL,
      prazo_dias INT NOT NULL,
      UNIQUE(servico, peso_min_g, peso_max_g)
    );
  `);

  const check = await centralPool.query('SELECT COUNT(*) FROM frete_fallback');
  if (parseInt(check.rows[0].count, 10) === 0) {
    console.log('[FreteFallback] Populando tabela com faixas padrão de PAC e SEDEX...');
    const seeds = [
      // PAC
      ['pac', 0, 300, 2250, 6],
      ['pac', 301, 1000, 2890, 7],
      ['pac', 1001, 3000, 3800, 8],
      ['pac', 3001, 10000, 5500, 9],
      ['pac', 10001, 30000, 8500, 10],
      // SEDEX
      ['sedex', 0, 300, 3200, 2],
      ['sedex', 301, 1000, 4250, 2],
      ['sedex', 1001, 3000, 5800, 3],
      ['sedex', 3001, 10000, 8500, 4],
      ['sedex', 10001, 30000, 13000, 5]
    ];

    for (const [servico, min, max, preco, prazo] of seeds) {
      await centralPool.query(
        `INSERT INTO frete_fallback (servico, peso_min_g, peso_max_g, preco_centavos, prazo_dias)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (servico, peso_min_g, peso_max_g) DO NOTHING`,
        [servico, min, max, preco, prazo]
      );
    }
  }
}

async function getFallbackQuote(weightG) {
  const normalizedWeight = Math.max(1, Math.min(30000, Math.round(weightG || 500)));
  const defaultMethods = [
    {
      code: 'pac',
      name: 'Correios PAC',
      price: normalizedWeight <= 1000 ? 28.90 : (normalizedWeight <= 3000 ? 38.00 : 55.00),
      delivery_days: 7,
      source: 'fallback'
    },
    {
      code: 'sedex',
      name: 'Correios SEDEX',
      price: normalizedWeight <= 1000 ? 42.50 : (normalizedWeight <= 3000 ? 58.00 : 85.00),
      delivery_days: 2,
      source: 'fallback'
    }
  ];

  try {
    const query = `
      SELECT servico, preco_centavos, prazo_dias
      FROM frete_fallback
      WHERE peso_min_g <= $1 AND peso_max_g >= $1
      ORDER BY servico DESC
    `;
    const result = await centralPool.query(query, [normalizedWeight]);
    
    if (result.rows.length === 0) {
      return defaultMethods;
    }

    return result.rows.map(row => ({
      code: row.servico.toLowerCase(),
      name: row.servico.toLowerCase() === 'sedex' ? 'Correios SEDEX' : 'Correios PAC',
      price: parseFloat((row.preco_centavos / 100).toFixed(2)),
      delivery_days: row.prazo_dias,
      source: 'fallback'
    }));
  } catch (err) {
    console.warn('[FreteFallback] Falha ao consultar banco central, usando faixas padrão em memória:', err.message);
    return defaultMethods;
  }
}

module.exports = {
  centralPool,
  initFallbackDb,
  getFallbackQuote
};
