const express = require("express");
const crypto = require("node:crypto");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// VALIDATE NIGERIAN PHONE NUMBER
function isValidNigerianPhone(phone) {
  return /^(?:\+234|234|0)[789][01]\d{8}$/.test(phone);
}

// GENERATE UNIQUE TRANSACTION REFERENCE
function generateReference() {
  return `SD${crypto.randomUUID().replace(/-/g, "")}`;
}

// CONVERT NAIRA TO KOBO SAFELY
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
// GET AVAILABLE DATA PLANS FROM VTU AGENT
router.get("/plans", authenticateToken, async (req, res) => {
  try {
    if (
      process.env.VTUAGENT_ENABLED !== "true" ||
      !process.env.VTUAGENT_API_KEY
    ) {
      return res.status(503).json({
        success: false,
        message: "Data supplier is not configured."
      });
    }

    const baseUrl = (
      process.env.VTUAGENT_BASE_URL || "https://api.vtuagent.com/v1"
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/data/plans`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.VTUAGENT_API_KEY}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("VTU Agent plans request failed:", response.status);

      return res.status(502).json({
        success: false,
        message: "Unable to retrieve data plans from supplier."
      });
    }

    return res.json({
      success: true,
      message: "Data plans retrieved successfully.",
      plans: result
    });

  } catch (error) {
    console.error("Data plans error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Data supplier is temporarily unavailable."
    });
  }
});

// DATA PURCHASE QUOTE WITH COMPANY PROFIT
router.get("/quote/:plan_id", authenticateToken, async (req, res) => {
  try {
    if (
      process.env.VTUAGENT_ENABLED !== "true" ||
      !process.env.VTUAGENT_API_KEY
    ) {
      return res.status(503).json({
        success: false,
        message: "Data supplier is not configured."
      });
    }

    const planId = String(req.params.plan_id || "").trim();

    if (!planId || planId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Valid plan ID is required."
      });
    }

    const baseUrl = (
      process.env.VTUAGENT_BASE_URL ||
      "https://api.vtuagent.com/v1"
    ).replace(/\/+$/, "");

    const response = await fetch(`${baseUrl}/data/plans`, {
      headers: {
        Authorization: `Bearer ${process.env.VTUAGENT_API_KEY}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(20000)
    });

    const result = await response.json();

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Unable to retrieve supplier plans."
      });
    }

    const plans = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.data?.data)
        ? result.data.data
        : [];

    const plan = plans.find(item =>
      String(item.plan_id || item.id) === planId
    );

    if (!plan || plan.is_active === false) {
      return res.status(404).json({
        success: false,
        message: "Data plan unavailable."
      });
    }

    const network = String(plan.network || "").toLowerCase();

    const rates = {
      mtn: 5,
      airtel: 5,
      glo: 7
    };

    const profitPercent = rates[network];

    if (profitPercent === undefined) {
      return res.status(422).json({
        success: false,
        message: "This network is not enabled for purchase."
      });
    }

    const supplierPrice = String(plan.price ?? "");

    if (!/^\d+(?:\.\d{1,2})?$/.test(supplierPrice)) {
      return res.status(502).json({
        success: false,
        message: "Invalid supplier price."
      });
    }

    const [whole, fraction = ""] = supplierPrice.split(".");
    const supplierKobo =
      Number(whole) * 100 +
      Number(fraction.padEnd(2, "0"));

    if (!Number.isSafeInteger(supplierKobo) || supplierKobo <= 0) {
      return res.status(502).json({
        success: false,
        message: "Invalid supplier price."
      });
    }

    const sellingKobo = Math.ceil(
      supplierKobo * (100 + profitPercent) / 100
    );

    const profitKobo = sellingKobo - supplierKobo;

    return res.json({
      success: true,
      quote: {
        plan_id: String(plan.plan_id || plan.id),
        plan_name: plan.plan_name || plan.name || "Data plan",
        network,
        supplier_price_naira: supplierKobo / 100,
        profit_percent: profitPercent,
        company_profit_naira: profitKobo / 100,
        selling_price_naira: sellingKobo / 100,
        currency: "NGN"
      }
    });

  } catch (error) {
    console.error("Data quote error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Unable to calculate data quote."
    });
  }
});

// DATA PURCHASE API — SAFE INITIAL VERSION
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

    // REAL PURCHASES REMAIN DISABLED DURING DEVELOPMENT
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

