
const express = require("express");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");
const {
  getDataPlans,
  MeleDataError
} = require("../services/meleData");

const router = express.Router();

// MELE purchase/status API contracts are not yet verified.
// Never enable purchases until those contracts are confirmed.
const MELE_PURCHASES_ENABLED = false;

// COMPANY PROFIT RATES
function getProfitRate(network) {
  const rates = {
    mtn: 10,
    airtel: 10,
    glo: 12,
    "9mobile": 12
  };

  return rates[String(network || "").toLowerCase()];
}

// SERVER-SIDE PRICE CALCULATION
function calculateQuote(plan) {
  const network = String(plan.network || "").toLowerCase();
  const profitPercent = getProfitRate(network);
  const supplierKobo = Number(plan.supplier_price_kobo);

  if (
    profitPercent === undefined ||
    !Number.isSafeInteger(supplierKobo) ||
    supplierKobo <= 0
  ) {
    return null;
  }

  const sellingKobo = Math.ceil(
    supplierKobo * (100 + profitPercent) / 100
  );

  return {
    plan_id: String(plan.plan_id),
    plan_name: plan.plan_name,
    network,
    supplier_price_kobo: supplierKobo,
    profit_percent: profitPercent,
    selling_price_kobo: sellingKobo,
    company_profit_kobo: sellingKobo - supplierKobo
  };
}

// SAFE SUPPLIER ERROR RESPONSE
function supplierError(res, error, operation) {
  console.error(`MELE ${operation} error:`, error.message);

  const status =
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
      ? error.status
      : 502;

  return res.status(status).json({
    success: false,
    code: error.code || "MELE_DATA_ERROR",
    message: `Unable to retrieve MELE ${operation} at this time.`
  });
}

// GET DATA PLANS FROM MELE
router.get("/plans", authenticateToken, async (req, res) => {
  try {
    const plans = await getDataPlans();

    return res.json({
      success: true,
      message: "MELE data plans retrieved successfully.",
      plans
    });
  } catch (error) {
    return supplierError(res, error, "data plans");
  }
});

// GET PRICE QUOTE
router.get("/quote/:plan_id", authenticateToken, async (req, res) => {
  try {
    const planId = String(req.params.plan_id || "").trim();

    if (!planId || planId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Valid plan ID is required."
      });
    }

    const plans = await getDataPlans();

    const plan = plans.find(
      item => String(item.plan_id) === planId
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "MELE data plan unavailable."
      });
    }

    const quote = calculateQuote(plan);

    if (!quote) {
      return res.status(422).json({
        success: false,
        message: "This network or plan is not enabled."
      });
    }

    return res.json({
      success: true,
      quote: {
        plan_id: quote.plan_id,
        plan_name: quote.plan_name,
        network: quote.network,
        supplier_price_naira:
          quote.supplier_price_kobo / 100,
        profit_percent: quote.profit_percent,
        company_profit_naira:
          quote.company_profit_kobo / 100,
        selling_price_naira:
          quote.selling_price_kobo / 100,
        selling_price_kobo: quote.selling_price_kobo,
        currency: "NGN"
      }
    });
  } catch (error) {
    return supplierError(res, error, "price quote");
  }
});

// DATA PURCHASE - DISABLED
router.post("/purchase", authenticateToken, async (req, res) => {
  if (!MELE_PURCHASES_ENABLED) {
    return res.status(503).json({
      success: false,
      code: "PURCHASES_DISABLED",
      message:
        "Data purchases are disabled until MELE purchase and transaction-status API contracts are verified."
    });
  }

  return res.status(503).json({
    success: false,
    code: "PURCHASES_UNAVAILABLE",
    message: "Data purchases are currently unavailable."
  });
});

// READ CUSTOMER'S OWN TRANSACTION STATUS
// No supplier status request is made here.
router.get(
  "/status/:reference",
  authenticateToken,
  async (req, res) => {
    try {
      const reference = String(
        req.params.reference || ""
      ).trim();

      if (!reference || reference.length > 120) {
        return res.status(400).json({
          success: false,
          message: "Valid transaction reference is required."
        });
      }

      const result = await pool.query(
        `SELECT reference, type, amount_kobo, status
         FROM transactions
         WHERE reference = $1
           AND user_id = $2
           AND type = 'DATA_PURCHASE'`,
        [reference, req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Data purchase not found."
        });
      }

      const transaction = result.rows[0];

      return res.json({
        success: true,
        reference: transaction.reference,
        status: transaction.status,
        amount_naira:
          Number(transaction.amount_kobo) / 100,
        message:
          transaction.status === "PENDING"
            ? "Transaction is awaiting verified supplier status."
            : "Transaction status retrieved from your account."
      });
    } catch (error) {
      console.error("Data status error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to retrieve transaction status."
      });
    }
  }
);

module.exports = router;
