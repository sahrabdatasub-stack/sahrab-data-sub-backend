const PERIODS = Object.freeze({
  daily: "day",
  weekly: "week",
  monthly: "month"
});

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
      AND COALESCE(t.metadata->>'company_profit_kobo', '') ~ '^[0-9]+$'

    UNION ALL

    SELECT
      t.id AS transaction_id,
      t.reference,
      'SERVICE_FEE'::text AS category,
      t.created_at,
      SUM(le.amount_kobo)::bigint AS amount_kobo
    FROM transactions t
    JOIN ledger_entries le ON le.transaction_id = t.id
    WHERE t.type = 'WALLET_FUNDING'
      AND t.status = 'SUCCESSFUL'
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
    data_profit_kobo: 0,
    airtime_profit_kobo: null,
    service_fee_revenue_kobo: 0,
    other_service_fee_revenue_kobo: null,
    net_profit_kobo: null
  };

  for (const row of rows) {
    const amount = asKobo(row.amount_kobo);
    if (row.category === "DATA_PROFIT") totals.data_profit_kobo += amount;
    if (row.category === "SERVICE_FEE") totals.service_fee_revenue_kobo += amount;
  }

  totals.total_company_revenue_kobo =
    totals.data_profit_kobo + totals.service_fee_revenue_kobo;
  return totals;
}

async function getCeoRevenueReport(pool) {
  const summaryResult = await pool.query(
    `${EARNINGS_CTE}
     SELECT category, SUM(amount_kobo)::text AS amount_kobo
     FROM earnings
     GROUP BY category`
  );

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
    const byPeriod = new Map();
    for (const row of result.rows) {
      const period = new Date(row.period).toISOString();
      if (!byPeriod.has(period)) byPeriod.set(period, { period });
      const entry = byPeriod.get(period);
      if (row.category === "DATA_PROFIT") entry.data_profit_kobo = asKobo(row.amount_kobo);
      if (row.category === "SERVICE_FEE") entry.service_fee_revenue_kobo = asKobo(row.amount_kobo);
    }
    breakdowns[label] = [...byPeriod.values()].map((entry) => ({
      data_profit_kobo: 0,
      service_fee_revenue_kobo: 0,
      ...entry,
      total_company_revenue_kobo:
        (entry.data_profit_kobo || 0) + (entry.service_fee_revenue_kobo || 0),
      net_profit_kobo: null
    }));
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
    summary: mapTotals(summaryResult.rows),
    breakdowns,
    revenue_history: historyResult.rows.map((row) => ({
      transaction_id: row.transaction_id,
      reference: row.reference,
      category: row.category,
      created_at: row.created_at,
      amount_kobo: asKobo(row.amount_kobo)
    })),
    limitations: {
      net_profit: "Unavailable: the existing schema does not record company expenses/costs needed to calculate net profit.",
      airtime_profit: "Unavailable: airtime purchase and revenue accounting are not implemented in the inspected backend.",
      other_service_fees: "Unavailable: no other approved service-fee revenue ledger account was found in the inspected backend."
    }
  };
}

module.exports = { getCeoRevenueReport, mapTotals, PERIODS };
