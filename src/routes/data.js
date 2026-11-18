
const express = require("express");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// Nigerian phone validation
function isValidNigerianPhone(phone) {
  return /^(?:\+234|234|0)[789][01]\d{8}$/.test(phone);
}

// Safe Naira to Kobo conversion
function nairaToKobo(value) {
  const price = String(value ?? "");

  if (!/^\d+(?:\.\d{1,2})?$/.test(price)) {
    return null;
  }

  const [whole, fraction = ""] = price.split(".");
  const kobo =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(kobo) && kobo > 0
    ? kobo
    : null;
}

// VTU AGENT CONFIGURATION
function getSupplierConfig() {
  if (
    process.env.VTUAGENT_ENABLED !== "true" ||
    !process.env.VTUAGENT_API_KEY
  ) {
    return null;
  }

  return {
    baseUrl: (
      process.env.VTUAGENT_BASE_URL ||
      "https://api.vtuagent.com/v1"
    ).replace(/\/+$/, ""),
    apiKey: process.env.VTUAGENT_API_KEY
  };
}

// FETCH LIVE SUPPLIER DATA PLANS
async function fetchSupplierPlans() {
  const config = getSupplierConfig();

  if (!config) {
    throw new Error("SUPPLIER_NOT_CONFIGURED");
  }

  const response = await fetch(
    `${config.baseUrl}/data/plans`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error("SUPPLIER_PLANS_FAILED");
  }

  const plans = Array.isArray(result?.data)
    ? result.data
    : Array.isArray(result?.data?.data)
      ? result.data.data
      : [];

  return plans;
}

// COMPANY PROFIT RATES
function getProfitRate(network) {
  const rates = {
    mtn: 5,
    airtel: 5,
    glo: 7
  };

  return rates[String(network).toLowerCase()];
}

// CALCULATE CUSTOMER PRICE
function calculateQuote(plan) {
  const network = String(plan.network || "").toLowerCase();
  const profitPercent = getProfitRate(network);

  if (profitPercent === undefined) {
    return null;
  }

  const supplierKobo = nairaToKobo(plan.price);

  if (!supplierKobo) {
    return null;
  }

  const sellingKobo = Math.ceil(
    supplierKobo * (100 + profitPercent) / 100
  );

  return {
    plan_id: String(plan.plan_id || plan.id),
    plan_name: plan.plan_name || plan.name || "Data plan",
    network,
    supplier_price_naira: supplierKobo / 100,
    profit_percent: profitPercent,
    company_profit_naira:
      (sellingKobo - supplierKobo) / 100,
    selling_price_naira: sellingKobo / 100,
    selling_price_kobo: sellingKobo,
    currency: "NGN"
  };
}

// GET DATA PLANS
router.get("/plans", authenticateToken, async (req, res) => {
  try {
    const plans = await fetchSupplierPlans();

    return res.json({
      success: true,
      message: "Data plans retrieved successfully.",
      plans
    });
  } catch (error) {
    console.error("Data plans error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Data supplier is temporarily unavailable."
    });
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

    const plans = await fetchSupplierPlans();

    const plan = plans.find(item =>
      String(item.plan_id || item.id) === planId
    );

    if (!plan || plan.is_active === false) {
      return res.status(404).json({
        success: false,
        message: "Data plan unavailable."
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
      quote
    });
  } catch (error) {
    console.error("Data quote error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Unable to calculate data quote."
    });
  }
});

// DATA PURCHASE
// REAL PURCHASES MUST REMAIN DISABLED UNTIL
// WALLET, LEDGER, REFUND AND STATUS PROCESSING ARE VERIFIED.
router.post("/purchase", authenticateToken, async (req, res) => {
  try {
    const planId = String(req.body.plan_id || "").trim();
    const phone = String(req.body.phone || "").trim();
    const idempotencyKey = String(
      req.headers["idempotency-key"] || ""
    ).trim();

    if (!planId || planId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Valid data plan ID is required."
      });
    }

    if (!isValidNigerianPhone(phone)) {
      return res.status(400).json({
        success: false,
        message: "Valid Nigerian phone number is required."
      });
    }

    if (
      idempotencyKey.length < 8 ||
      idempotencyKey.length > 120
    ) {
      return res.status(400).json({
        success: false,
        message: "A valid Idempotency-Key header is required."
      });
    }

    if (process.env.DATA_PURCHASES_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        message: "Data purchases are temporarily disabled."
      });
    }

    return res.status(501).json({
      success: false,
      message: "Purchase processing is not yet activated."
    });
  } catch (error) {
    console.error("Data purchase error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to process data purchase."
    });
  }
});

module.exports = router;
