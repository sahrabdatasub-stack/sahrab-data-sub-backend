
const express = require("express");
const crypto = require("node:crypto");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const router = express.Router();

// NIGERIAN PHONE VALIDATION
function isValidNigerianPhone(phone) {
  return /^(?:\+234|234|0)[789][01]\d{8}$/.test(phone);
}

// SAFE NAIRA TO KOBO CONVERSION
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

// GENERATE UNIQUE REFERENCE
function generateReference(prefix = "SD") {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

// SUPPLIER CONFIGURATION
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

// SUPPLIER REQUEST
async function supplierRequest(path, body) {
  const config = getSupplierConfig();

  if (!config) {
    throw new Error("SUPPLIER_NOT_CONFIGURED");
  }

  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  let data = {};

  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return {
    httpStatus: response.status,
    data
  };
}

// FETCH LIVE DATA PLANS
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

  let result = {};

  try {
    result = await response.json();
  } catch {
    throw new Error("INVALID_SUPPLIER_RESPONSE");
  }

  if (!response.ok) {
    throw new Error("SUPPLIER_PLANS_FAILED");
  }

  if (Array.isArray(result?.data)) {
    return result.data;
  }

  if (Array.isArray(result?.data?.data)) {
    return result.data.data;
  }

  throw new Error("INVALID_SUPPLIER_PLANS");
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

// SERVER-SIDE PRICE CALCULATION
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
    supplier_price_kobo: supplierKobo,
    profit_percent: profitPercent,
    selling_price_kobo: sellingKobo,
    company_profit_kobo: sellingKobo - supplierKobo
  };
}

// MARK PURCHASE SUCCESSFUL
async function markPurchaseSuccessful(transactionId) {
  await pool.query(
    `UPDATE transactions
     SET status = 'SUCCESSFUL',
         updated_at = NOW(),
         metadata = metadata || $2::jsonb
     WHERE id = $1
       AND status = 'PENDING'`,
    [
      transactionId,
      JSON.stringify({
        supplier_confirmed: true,
        settled_at: new Date().toISOString()
      })
    ]
  );
}

// REFUND ONLY AFTER CONFIRMED FAILURE
async function refundDataPurchase(transactionId, reason) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const originalResult = await client.query(
      `SELECT *
       FROM transactions
       WHERE id = $1
       FOR UPDATE`,
      [transactionId]
    );

    if (originalResult.rows.length === 0) {
      throw new Error("ORIGINAL_TRANSACTION_NOT_FOUND");
    }

    const original = originalResult.rows[0];

    // Never refund a successful or already failed transaction.
    if (original.status !== "PENDING") {
      await client.query("COMMIT");

      return {
        refunded: false,
        status: original.status
      };
    }

    // Prevent duplicate refunds.
    const existingRefund = await client.query(
      `SELECT id
       FROM transactions
       WHERE refund_of_transaction_id = $1`,
      [original.id]
    );

    if (existingRefund.rows.length > 0) {
      await client.query("COMMIT");

      return {
        refunded: false,
        status: "FAILED"
      };
    }

    const walletResult = await client.query(
      `SELECT id, balance_kobo
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [original.user_id]
    );

    if (walletResult.rows.length === 0) {
      throw new Error("REFUND_WALLET_NOT_FOUND");
    }

    const wallet = walletResult.rows[0];
    const amount = Number(original.amount_kobo);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("INVALID_REFUND_AMOUNT");
    }

    // Return money to customer wallet.
    await client.query(
      `UPDATE wallets
       SET balance_kobo = balance_kobo + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [amount, wallet.id]
    );

    const refundReference = generateReference("SDR");

    // Create separate refund transaction.
    const refundResult = await client.query(
      `INSERT INTO transactions
       (
         user_id,
         reference,
         type,
         amount_kobo,
         status,
         provider,
         description,
         refund_of_transaction_id,
         metadata
       )
       VALUES (
         $1, $2, 'DATA_PURCHASE_REFUND', $3,
         'SUCCESSFUL', 'VTUAGENT', $4, $5, $6::jsonb
       )
       RETURNING id`,
      [
        original.user_id,
        refundReference,
        amount,
        "Refund for failed data purchase",
        original.id,
        JSON.stringify({
          original_reference: original.reference,
          reason
        })
      ]
    );

    const refundId = refundResult.rows[0].id;

    // Reverse the original ledger entries.
    await client.query(
      `INSERT INTO ledger_entries
       (transaction_id, account_code, entry_type, amount_kobo)
       VALUES
       ($1, 'DATA_SALES_CLEARING', 'DEBIT', $2),
       ($1, 'CUSTOMER_WALLET_LIABILITY', 'CREDIT', $2)`,
      [refundId, amount]
    );

    await client.query(
      `UPDATE transactions
       SET status = 'FAILED',
           updated_at = NOW(),
           metadata = metadata || $2::jsonb
       WHERE id = $1`,
      [
        original.id,
        JSON.stringify({
          refund_reference: refundReference,
          failure_reason: reason,
          refunded: true
        })
      ]
    );

    await client.query("COMMIT");

    return {
      refunded: true,
      status: "FAILED",
      refund_reference: refundReference
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
      quote: {
        plan_id: quote.plan_id,
        plan_name: quote.plan_name,
        network: quote.network,
        supplier_price_naira: quote.supplier_price_kobo / 100,
        profit_percent: quote.profit_percent,
        company_profit_naira: quote.company_profit_kobo / 100,
        selling_price_naira: quote.selling_price_kobo / 100,
        selling_price_kobo: quote.selling_price_kobo,
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

// DATA PURCHASE
router.post("/purchase", authenticateToken, async (req, res) => {
  let transactionId;
  let transactionReference;

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

    // Keep real purchases disabled until final testing.
    if (process.env.DATA_PURCHASES_ENABLED !== "true") {
      return res.status(503).json({
        success: false,
        message: "Data purchases are temporarily disabled."
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

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Check whether this request was already submitted.
      const existingResult = await client.query(
        `SELECT id, reference, status, amount_kobo, metadata
         FROM transactions
         WHERE user_id = $1
           AND idempotency_key = $2
         FOR UPDATE`,
        [req.user.id, idempotencyKey]
      );

      if (existingResult.rows.length > 0) {
        const existing = existingResult.rows[0];
        const metadata = existing.metadata || {};

        if (
          metadata.plan_id !== planId ||
          metadata.phone !== phone
        ) {
          await client.query("ROLLBACK");

          return res.status(409).json({
            success: false,
            message: "This idempotency key was used for another purchase."
          });
        }

        await client.query("COMMIT");

        return res.json({
          success: true,
          duplicate: true,
          reference: existing.reference,
          status: existing.status,
          amount_naira: Number(existing.amount_kobo) / 100,
          message: "Existing purchase request retrieved."
        });
      }

      // Lock wallet to prevent simultaneous overspending.
      const walletResult = await client.query(
        `SELECT id, balance_kobo
         FROM wallets
         WHERE user_id = $1
         FOR UPDATE`,
        [req.user.id]
      );

      if (walletResult.rows.length === 0) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          message: "Wallet not found."
        });
      }

      const wallet = walletResult.rows[0];
      const balance = Number(wallet.balance_kobo);
      const amount = quote.selling_price_kobo;

      if (!Number.isSafeInteger(balance) || balance < amount) {
        await client.query("ROLLBACK");

        return res.status(400).json({
          success: false,
          message: "Insufficient wallet balance."
        });
      }

      transactionReference = generateReference("SD");

      const metadata = {
        plan_id: planId,
        plan_name: quote.plan_name,
        network: quote.network,
        phone,
        supplier_price_kobo: quote.supplier_price_kobo,
        profit_percent: quote.profit_percent,
        company_profit_kobo: quote.company_profit_kobo,
        supplier_request_ref: transactionReference
      };

      const transactionResult = await client.query(
        `INSERT INTO transactions
         (
           user_id,
           reference,
           type,
           amount_kobo,
           status,
           provider,
           description,
           idempotency_key,
           metadata
         )
         VALUES
         ($1, $2, 'DATA_PURCHASE', $3, 'PENDING',
          'VTUAGENT', $4, $5, $6::jsonb)
         RETURNING id`,
        [
          req.user.id,
          transactionReference,
          amount,
          `Data purchase for ${phone}`,
          idempotencyKey,
          JSON.stringify(metadata)
        ]
      );

      transactionId = transactionResult.rows[0].id;

      // Debit customer wallet.
      await client.query(
        `UPDATE wallets
         SET balance_kobo = balance_kobo - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount, wallet.id]
      );

      // Balanced purchase ledger.
      await client.query(
        `INSERT INTO ledger_entries
         (transaction_id, account_code, entry_type, amount_kobo)
         VALUES
         ($1, 'CUSTOMER_WALLET_LIABILITY', 'DEBIT', $2),
         ($1, 'DATA_SALES_CLEARING', 'CREDIT', $2)`,
        [transactionId, amount]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");

      if (error.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "This purchase request has already been submitted."
        });
      }

      throw error;
    } finally {
      client.release();
    }

    // Supplier call happens only after database commit.
    let supplierResult;

    try {
      supplierResult = await supplierRequest(
        "/data/purchase",
        {
          plan_id: planId,
          phone,
          request_ref: transactionReference
        }
      );
    } catch (error) {
      // Uncertain outcome: do not refund automatically.
      console.error(
        "Supplier purchase outcome uncertain:",
        error.message
      );

      return res.status(202).json({
        success: true,
        status: "PENDING",
        reference: transactionReference,
        message: "Purchase is being verified. Do not submit it again."
      });
    }

    const supplierStatus = String(
      supplierResult.data.status || ""
    ).toLowerCase();

    // Confirmed success.
    if (
      supplierResult.httpStatus === 200 &&
      supplierStatus === "successful"
    ) {
      await markPurchaseSuccessful(transactionId);

      return res.json({
        success: true,
        status: "SUCCESSFUL",
        reference: transactionReference,
        message: "Data purchase successful."
      });
    }

    // Supplier is still processing.
    if (
      supplierResult.httpStatus === 202 ||
      supplierStatus === "pending"
    ) {
      return res.status(202).json({
        success: true,
        status: "PENDING",
        reference: transactionReference,
        message: "Data purchase is still processing."
      });
    }

    // Refund only when supplier explicitly confirms failure.
    if (
      supplierResult.httpStatus === 424 ||
      supplierStatus === "failed"
    ) {
      const refund = await refundDataPurchase(
        transactionId,
        supplierResult.data.message || "Supplier confirmed purchase failure"
      );

      return res.status(502).json({
        success: false,
        status: "FAILED",
        reference: transactionReference,
        refunded: refund.refunded,
        message: refund.refunded
          ? "Data purchase failed. Wallet refund has been processed."
          : "Data purchase failed. Please check your transaction history."
      });
    }

    // Unknown responses, including HTTP 400/401/500:
    // keep the transaction pending until status is confirmed.
    console.error(
      "Unconfirmed supplier response:",
      supplierResult.httpStatus,
      supplierStatus
    );

    return res.status(202).json({
      success: true,
      status: "PENDING",
      reference: transactionReference,
      message: "Purchase outcome is being verified. Do not submit it again."
    });

  } catch (error) {
    console.error("Data purchase error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to process data purchase."
    });
  }
});

// CHECK PENDING PURCHASE STATUS
router.get("/status/:reference", authenticateToken, async (req, res) => {
  try {
    const reference = String(req.params.reference || "").trim();

    if (!reference || reference.length > 120) {
      return res.status(400).json({
        success: false,
        message: "Valid transaction reference is required."
      });
    }

    const result = await pool.query(
      `SELECT id, reference, type, amount_kobo, status
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

    if (transaction.status !== "PENDING") {
      return res.json({
        success: true,
        reference: transaction.reference,
        status: transaction.status,
        amount_naira: Number(transaction.amount_kobo) / 100
      });
    }

    // Query supplier using our own transaction reference.
    const supplierResult = await supplierRequest(
      "/transaction/status",
      { request_ref: transaction.reference }
    );

    const supplierStatus = String(
      supplierResult.data.status || ""
    ).toLowerCase();

    if (
      supplierResult.httpStatus === 200 &&
      supplierStatus === "successful"
    ) {
      await markPurchaseSuccessful(transaction.id);
    } else if (
      supplierResult.httpStatus === 424 ||
      supplierStatus === "failed"
    ) {
      await refundDataPurchase(
        transaction.id,
        supplierResult.data.message || "Supplier confirmed failure"
      );
    }

    // Read the latest saved transaction state.
    const latest = await pool.query(
      `SELECT reference, status, amount_kobo
       FROM transactions
       WHERE id = $1`,
      [transaction.id]
    );

    return res.json({
      success: true,
      reference: latest.rows[0].reference,
      status: latest.rows[0].status,
      amount_naira: Number(latest.rows[0].amount_kobo) / 100,
      supplier_status: supplierStatus || "unknown"
    });

  } catch (error) {
    console.error("Data status error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Unable to verify data purchase status. Please try again."
    });
  }
});

module.exports = router;
