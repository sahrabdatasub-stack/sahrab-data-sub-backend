const express = require("express");

const MELE_DATA_BASE_URL = "https://api.meledata.ng/api/v1/developer";

class MeleDataError extends Error {
  constructor(message, code = "MELE_DATA_ERROR", status = 502) {
    super(message);
    this.name = "MeleDataError";
    this.code = code;
    this.status = status;
  }
}

function getApiKey() {
  const apiKey = process.env.MELE_DATA_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    throw new MeleDataError(
      "MELE_DATA_API_KEY is not configured.",
      "MELE_DATA_NOT_CONFIGURED",
      503
    );
  }
  return String(apiKey).trim();
}

async function meleRequest(path, options = {}) {
  const response = await fetch(`${MELE_DATA_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Token ${getApiKey()}`,
      Accept: "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  let body;
  try {
    body = await response.json();
  } catch {
    throw new MeleDataError(
      "MELE returned a malformed response.",
      "INVALID_MELE_RESPONSE",
      502
    );
  }

  if (!response.ok) {
    throw new MeleDataError(
      "MELE request failed.",
      "MELE_REQUEST_FAILED",
      502
    );
  }

  return body;
}

function unwrapArray(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.plans)) return body.plans;
  if (Array.isArray(body?.data?.plans)) return body.data.plans;
  throw new MeleDataError(
    "MELE catalog response is missing a plan array.",
    "INVALID_MELE_CATALOG",
    502
  );
}

function normalizeNairaPrice(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;

  const [whole, fraction = ""] = text.split(".");
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null;
}

function normalizeNetwork(value) {
  const network = String(value ?? "").trim().toLowerCase();
  const aliases = {
    mtn: "mtn",
    airtel: "airtel",
    glo: "glo",
    "9mobile": "9mobile",
    etisalat: "9mobile"
  };
  return aliases[network] || null;
}

async function getWalletBalance() {
  const body = await meleRequest("/wallet/balance", { method: "GET" });
  const balance = body?.data?.balance ?? body?.balance;
  const currency = body?.data?.currency ?? body?.currency;

  if (balance === undefined || balance === null) {
    throw new MeleDataError(
      "MELE wallet response is missing balance.",
      "INVALID_MELE_WALLET",
      502
    );
  }

  return {
    balance,
    currency: String(currency || "NGN")
  };
}

async function getDataPlans(network) {
  const normalizedNetwork = network ? normalizeNetwork(network) : null;
  if (network && !normalizedNetwork) {
    throw new MeleDataError(
      "Unsupported network.",
      "INVALID_NETWORK",
      400
    );
  }

  const path = normalizedNetwork
    ? `/data/plans?network=${encodeURIComponent(normalizedNetwork)}`
    : "/data/plans";

  const body = await meleRequest(path, { method: "GET" });
  const rawPlans = unwrapArray(body);

  return rawPlans.map((plan) => {
    const planId = plan.plan_id ?? plan.id;
    const planCode = plan.plan_code ?? plan.code;
    const planNetwork = normalizeNetwork(plan.network);
    const priceKobo = normalizeNairaPrice(plan.price ?? plan.amount);

    if (
      planId === undefined || planId === null ||
      !planCode || !planNetwork || !plan.plan_name ||
      priceKobo === null
    ) {
      throw new MeleDataError(
        "MELE catalog contains a malformed plan.",
        "INVALID_MELE_PLAN",
        502
      );
    }

    return {
      plan_id: String(planId),
      plan_code: String(planCode),
      network: planNetwork,
      plan_name: String(plan.plan_name),
      data_size: plan.data_size ?? null,
      validity: plan.validity ?? null,
      price: String(plan.price ?? (priceKobo / 100)),
      price_naira: priceKobo / 100,
      price_kobo: priceKobo
    };
  }).filter((plan) => !normalizedNetwork || plan.network === normalizedNetwork);
}

function createMeleRouter() {
  const router = express.Router();

  router.get("/wallet/balance", async (req, res) => {
    try {
      const wallet = await getWalletBalance();
      return res.json({ success: true, wallet });
    } catch (error) {
      console.error("MELE wallet balance error:", error.code || error.message);
      return res.status(error.status || 502).json({
        success: false,
        message: error.message
      });
    }
  });

  router.get("/data/plans", async (req, res) => {
    try {
      const plans = await getDataPlans(req.query.network);
      return res.json({ success: true, plans, count: plans.length });
    } catch (error) {
      console.error("MELE data plans error:", error.code || error.message);
      return res.status(error.status || 502).json({
        success: false,
        message: error.message
      });
    }
  });

  return router;
}

module.exports = {
  MeleDataError,
  getWalletBalance,
  getDataPlans,
  normalizeNetwork,
  normalizeNairaPrice,
  createMeleRouter
};
