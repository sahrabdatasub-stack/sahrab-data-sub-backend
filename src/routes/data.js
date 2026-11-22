
const express = require("express");
const crypto = require("node:crypto");
const pool = require("../config/database");
const authenticateToken = require("../middleware/auth");

const {
  getDataPlans,
  purchaseData,
  getDataStatus,
  normalizeNetwork,
  MeleDataError
} = require("../meleData");

const router = express.Router();

function generateReference(prefix = "SD") {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

function normalizePhone(value) {
  const phone = String(value ?? "").trim();

  if (/^0[789][01]\d{8}$/.test(phone)) return phone;
  if (/^234[789][01]\d{8}$/.test(phone)) return `0${phone.slice(3)}`;
  if (/^\+234[789][01]\d{8}$/.test(phone)) return `0${phone.slice(4)}`;

  return null;
}

function calculateQuote(plan) {
  const rates = {
    mtn: 10,
    airtel: 10,
    glo: 12,
    "9mobile": 12
  };

  const network = normalizeNetwork(plan.network);
  const rate = rates[network];

  const supplierKobo = Number(plan.supplier_price_kobo);

  if (
    !network ||
    rate === undefined ||
    !Number.isSafeInteger(supplierKobo) ||
    supplierKobo <= 0
  ) {
    return null;
  }

  const sellingKobo = Math.ceil(
    supplierKobo * (100 + rate) / 100
  );

  return {
    plan_id: String(plan.plan_id),
    plan_name: plan.plan_name,
    network,
    supplier_price_kobo: supplierKobo,
    profit_percent: rate,
    selling_price_kobo: sellingKobo,
    company_profit_kobo: sellingKobo - supplierKobo
  };
}

function getSupplierStatus(body) {
  const value =
    body?.data?.status ??
    body?.data?.data?.status ??
    body?.transaction?.status ??
    body?.status;

  if (value === true) return "success";

  const status = String(value ?? "").trim().toLowerCase();

  if (["success", "successful", "completed"].includes(status)) {
    return "success";
  }

  if (["failed", "failure", "unsuccessful", "rejected"].includes(status)) {
    return "failed";
  }

  if (["pending", "processing", "initiated"].includes(status)) {
    return "pending";
  }

  return "unknown";
}

async function markPurchaseSuccessful(transactionId, supplierResponse) {
  await pool.query(
    `UPDATE transactions
     SET status = 'SUCCESSFUL',
         updated_at = NOW(),
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
     WHERE id = $1
       AND status = 'PENDING'`,
    [
      transactionId,
      JSON.stringify({
        supplier_confirmed: true,
        supplier_reference:
          supplierResponse?.data?.reference ??
          supplierResponse?.reference ??
          null,
        supplier_status: "success",
        settled_at: new Date().toISOString()
      })
    ]
  );
}

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

    if (!originalResult.rows.length) {
      throw new Error("ORIGINAL_TRANSACTION_NOT_FOUND");
    }

    const original = originalResult.rows[0];

    if (original.status !== "PENDING") {
      await client.query("COMMIT");

      return {
        refunded: false,
        status: original.status
      };
    }

    const existingRefund = await client.query(
      `SELECT id
       FROM transactions
       WHERE refund_of_transaction_id = $1`,
      [original.id]
    );

    if (existingRefund.rows.length) {
      await client.query("COMMIT");

      return {
        refunded: false,
        status: "FAILED"
      };
    }

    const amount = Number(original.amount_kobo);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error("INVALID_REFUND_AMOUNT");
    }

    const walletResult = await client.query(
      `SELECT id
       FROM wallets
       WHERE user_id = $1
       FOR UPDATE`,
      [original.user_id]
    );

    if (!walletResult.rows.length) {
      throw new Error("REFUND_WALLET_NOT_FOUND");
    }

    await client.query(
      `UPDATE wallets
       SET balance_kobo = balance_kobo + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [amount, walletResult.rows[0].id]
    );

    const refundReference = generateReference("SDR");

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
       VALUES
       ($1, $2, 'DATA_PURCHASE_REFUND', $3,
        'SUCCESSFUL', 'MELE', $4, $5, $6::jsonb)
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
           metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
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
    const network = req.query.network
      ? normalizeNetwork(req.query.network)
      : null;

    if (req.query.network && !network) {
      return res.status(400).json({
        success: false,
        message: "Unsupported network."
      });
    }

    const plans = await getDataPlans(network || undefined);

    const availablePlans = plans
      .filter(plan => plan.is_active !== false)
      .map(plan => {
        const quote = calculateQuote(plan);

        if (!quote) return null;

        return {
          plan_id: quote.plan_id,
          plan_name: quote.plan_name,
          network: quote.network,
          supplier_price_naira: quote.supplier_price_kobo / 100,
          selling_price_naira: quote.selling_price_kobo / 100,
          profit_percent: quote.profit_percent,
          currency: "NGN"
        };
      })
      .filter(Boolean);

    return res.json({
      success: true,
      plans: availablePlans
    });
  } catch (error) {
    console.error("MELE plans error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Unable to retrieve data plans."
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

    const plans = await getDataPlans();

    const plan = plans.find(
      item => String(item.plan_id) === planId
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Data plan unavailable."
      });
    }

    const quote = calculateQuote(plan);

    if (!quote) {
      return res.status(422).json({
        success: false,
        message: "This plan is not enabled."
      });
    }

    return res.json({
      success: true,
      quote: {
        ...quote,
        supplier_price_naira: quote.supplier_price_kobo / 100,
        selling_price_naira: quote.selling_price_kobo / 100,
        company_profit_naira: quote.company_profit_kobo / 100,
        currency: "NGN"
      }
    });
  } catch (error) {
    console.error("MELE quote error:", error.message);

    return res.status(502).json({
      success: false,
      message: "Unable to calculate data quote."
    });
  }
});

// PURCHASE DATA
router.post("/purchase", authenticateToken, async (req, res) => {
  let transactionId;
  let transactionReference;

  try {
    const planId = String(req.body?.plan_id ?? "").trim();
    const phone = normalizePhone(req.body?.phone);
    const idempotencyKey = String(
      req.headers["idempotency-key"] || ""
    ).trim();

    if (!planId || planId.length > 100) {
      return res.status(400).json({
        success: false,
        message: "Valid data plan ID is required."
      });
    }

    if (!phone) {
      return res.status(400).json({
        success: false,
        message: "Valid Nigerian phone number is required."
      });
    }

    if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
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

    const plans = await getDataPlans();

    const plan = plans.find(
      item => String(item.plan_id) === planId
    );

    if (!plan) {
      return res.status(404).json({
        success: false,
        message: "Data plan unavailable."
      });
    }

    const quote = calculateQuote(plan);

    if (!quote) {
      return res.status(422).json({
        success: false,
        message: "This data plan is not enabled."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const existingResult = await client.query(
        `SELECT id, reference, status, amount_kobo, metadata
         FROM transactions
         WHERE user_id = $1
           AND idempotency_key = $2
         FOR UPDATE`,
        [req.user.id, idempotencyKey]
      );

      if (existingResult.rows.length) {
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

      const walletResult = await client.query(
        `SELECT id, balance_kobo
         FROM wallets
         WHERE user_id = $1
         FOR UPDATE`,
        [req.user.id]
      );

      if (!walletResult.rows.length) {
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
          'MELE', $4, $5, $6::jsonb)
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

      await client.query(
        `UPDATE wallets
         SET balance_kobo = balance_kobo - $1,
             updated_at = NOW()
         WHERE id = $2`,
        [amount, wallet.id]
      );

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

    // Send the purchase to MELE only after the local transaction commits.
    let supplierResponse;

    try {
      supplierResponse = await purchaseData({
        phone,
        plan: planId,
        network: quote.network,
        requestId: transactionReference
      });
    } catch (error) {
      console.error("MELE purchase outcome uncertain:", error.message);

      return res.status(202).json({
        success: true,
        status: "PENDING",
        reference: transactionReference,
        message: "Purchase is being verified. Do not submit it again."
      });
    }

    const supplierStatus = getSupplierStatus(supplierResponse);

    if (supplierStatus === "success") {
      await markPurchaseSuccessful(transactionId, supplierResponse);

      return res.json({
        success: true,
        status: "SUCCESSFUL",
        reference: transactionReference,
        message: "Data purchase successful."
      });
    }

    if (supplierStatus === "failed") {
      const refund = await refundDataPurchase(
        transactionId,
        supplierResponse?.message || "MELE confirmed purchase failure"
      );

      return res.status(502).json({
        success: false,
        status: "FAILED",
        reference: transactionReference,
        refunded: refund.refunded,
        message: refund.refunded
          ? "Purchase failed. Wallet refund processed."
          : "Purchase failed. Check your transaction history."
      });
    }

    return res.status(202).json({
      success: true,
      status: "PENDING",
      reference: transactionReference,
      message: "Purchase is still being verified. Do not submit it again."
    });
  } catch (error) {
    console.error("Data purchase error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to process data purchase."
    });
  }
});

// CHECK PURCHASE STATUS
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
      `SELECT id, reference, type, amount_kobo, status, metadata
       FROM transactions
       WHERE reference = $1
         AND user_id = $2
         AND type = 'DATA_PURCHASE'`,
      [reference, req.user.id]
    );

    if (!result.rows.length) {
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

    const metadata = transaction.metadata || {};

    const supplierReference =
      metadata.supplier_reference ||
      metadata.supplier_request_ref ||
      transaction.reference;

    let supplierResponse;

    try {
      supplierResponse = await getDataStatus(supplierReference);
    } catch (error) {
      console.error("MELE status check error:", error.message);

      return res.status(202).json({
        success: true,
        reference,
        status: "PENDING",
        message: "Unable to confirm the result yet. Please try again."
      });
    }

    const supplierStatus = getSupplierStatus(supplierResponse);

    if (supplierStatus === "success") {
      await markPurchaseSuccessful(
        transaction.id,
        supplierResponse
      );
    } else if (supplierStatus === "failed") {
      await refundDataPurchase(
        transaction.id,
        supplierResponse?.message || "MELE confirmed purchase failure"
      );
    }

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
      supplier_status: supplierStatus
    });
  } catch (error) {
    console.error("Data status error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to verify data purchase status."
    });
  }
});

module.exports = router;
