const PERIODS = Object.freeze({
  daily: "day",
  weekly: "week",
  monthly: "month"
});

// Revenue is derived from completed source transactions and their recorded
// accounting data. Wallet principal is deliberately never included.
const EARNINGS_CTE = `
  WITH earnings AS (
    SELECT
      t.id AS transaction_id,
      t.reference,
      'DATA_PROFIT'::text AS category,
      t.created_at,
      (t.metadata->>'company_profit_kobo')::bigint AS amount_kobo
    FROM transactions t
    WHERE t.type = 'DATA_PURCHASE'
      AND t.status = 'SUCCESSFUL'
      AND t.refund_of_transaction_id IS NULL
      AND COALESCE(t.metadata->>'company_profit_kobo', '') ~ '^[0-9]+$'

    UNION ALL

    SELECT
      t.id AS transaction_id,
      t.reference,
      'SERVICE_FEE'::text AS category,
      t.created_at,
      MAX(le.amount_kobo)::bigint AS amount_kobo
    FROM transactions t
    JOIN ledger_entries le ON le.transaction_id = t.id
    WHERE t.type = 'WALLET_FUNDING'
      AND t.status = 'SUCCESSFUL'
      AND t.refund_of_transaction_id IS NULL
      AND le.account_code = 'DEPOSIT_SERVICE_REVENUE'
      AND le.entry_type = 'CREDIT'
    GROUP BY t.id, t.reference, t.created_at
  )`;

function asKobo(value) {
  const parsed = Number(value || 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function mapTotals(rows) {
  const totals = {
    total_company_revenue_kobo: 0,
    total_company_revenue_naira: 0,
    data_profit_kobo: 0,
    data_profit_naira: 0,
    airtime_profit_kobo: null,
    airtime_profit_naira: null,
    service_fee_revenue_kobo: 0,
    service_fee_revenue_naira: 0,
    other_service_fee_revenue_kobo: null,
    net_profit_kobo: null,
    net_profit_naira: null
  };

  for (const row of rows) {
    const amount = asKobo(row.amount_kobo);
    if (row.category === "DATA_PROFIT") totals.data_profit_kobo += amount;
    if (row.category === "SERVICE_FEE") totals.service_fee_revenue_kobo += amount;
  }

  totals.total_company_revenue_kobo =
    totals.data_profit_kobo + totals.service_fee_revenue_kobo;
  totals.data_profit_naira = totals.data_profit_kobo / 100;
  totals.service_fee_revenue_naira = totals.service_fee_revenue_kobo / 100;
  totals.total_company_revenue_naira = totals.total_company_revenue_kobo / 100;
  return totals;
}

function formatBreakdowns(rows) {
  const byPeriod = new Map();
  for (const row of rows) {
    const period = new Date(row.period).toISOString();
    if (!byPeriod.has(period)) {
      byPeriod.set(period, {
        period,
        data_profit_kobo: 0,
        service_fee_revenue_kobo: 0
      });
    }

    const entry = byPeriod.get(period);
    if (row.category === "DATA_PROFIT") entry.data_profit_kobo = asKobo(row.amount_kobo);
    if (row.category === "SERVICE_FEE") entry.service_fee_revenue_kobo = asKobo(row.amount_kobo);
  }

  return [...byPeriod.values()].map((entry) => {
    const total = entry.data_profit_kobo + entry.service_fee_revenue_kobo;
    return {
      ...entry,
      data_profit_naira: entry.data_profit_kobo / 100,
      service_fee_revenue_naira: entry.service_fee_revenue_kobo / 100,
      total_company_revenue_kobo: total,
      total_company_revenue_naira: total / 100,
      net_profit_kobo: null,
      net_profit_naira: null
    };
  });
}

async function getCeoRevenueReport(pool) {
  const summaryResult = await pool.query(
    `${EARNINGS_CTE}
     SELECT category, SUM(amount_kobo)::text AS amount_kobo
     FROM earnings
     GROUP BY category`
  );
  const summary = mapTotals(summaryResult.rows);

  const breakdowns = {};
  for (const [label, unit] of Object.entries(PERIODS)) {
    const result = await pool.query(
      `${EARNINGS_CTE}
       SELECT date_trunc('${unit}', created_at) AS period,
              category,
              SUM(amount_kobo)::text AS amount_kobo
       FROM earnings
       GROUP BY period, category
       ORDER BY period DESC`
    );
    breakdowns[label] = formatBreakdowns(result.rows);
  }

  const historyResult = await pool.query(
    `${EARNINGS_CTE}
     SELECT transaction_id, reference, category, created_at,
            amount_kobo::text AS amount_kobo
     FROM earnings
     ORDER BY created_at DESC, reference DESC
     LIMIT 100`
  );

  return {
    currency: "NGN",
    summary,
    breakdowns,
    revenue_history: historyResult.rows.map((row) => ({
      transaction_id: row.transaction_id,
      reference: row.reference,
      category: row.category,
      created_at: row.created_at,
      amount_kobo: asKobo(row.amount_kobo),
      amount_naira: asKobo(row.amount_kobo) / 100
    })),
    limitations: {
      net_profit: "Unavailable: the current backend does not record company expenses/costs, so net profit cannot be calculated safely.",
      airtime_profit: "Unavailable: no airtime revenue or completed airtime transaction accounting exists in the current backend.",
      other_service_fees: "Unavailable: no other approved service-fee revenue ledger accounts were found in the current accounting code."
    }
  };
}

module.exports = { getCeoRevenueReport, mapTotals, formatBreakdowns, PERIODS };
