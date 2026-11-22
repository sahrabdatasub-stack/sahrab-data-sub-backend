
const MELE_DATA_BASE_URL = "https://api.meledata.ng/api/v1/developer";
const REQUEST_TIMEOUT_MS = 20000;

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

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new MeleDataError(
      "MELE_DATA_API_KEY is not configured.",
      "MELE_DATA_NOT_CONFIGURED",
      503
    );
  }

  return apiKey.trim();
}

async function meleRequest(path, options = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") {
    throw new MeleDataError(
      "HTTP fetch is unavailable.",
      "FETCH_UNAVAILABLE",
      503
    );
  }

  let response;

  try {
    response = await fetchImpl(`${MELE_DATA_BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: `Token ${getApiKey()}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch {
    throw new MeleDataError(
      "MELE service is temporarily unavailable.",
      "MELE_NETWORK_ERROR",
      502
    );
  }

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

function normalizeNetwork(value) {
  const aliases = {
    mtn: "mtn",
    airtel: "airtel",
    glo: "glo",
    "9mobile": "9mobile",
    etisalat: "9mobile"
  };

  return aliases[String(value ?? "").trim().toLowerCase()] || null;
}

function validateNetwork(value) {
  const network = normalizeNetwork(value);

  if (!network) {
    throw new MeleDataError(
      "Unsupported network.",
      "INVALID_NETWORK",
      400
    );
  }

  return network;
}

function normalizeNairaPrice(value) {
  const text = String(value ?? "").trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    return null;
  }

  const [whole, fraction = ""] = text.split(".");
  const kobo =
    Number(whole) * 100 +
    Number(fraction.padEnd(2, "0"));

  return Number.isSafeInteger(kobo) && kobo > 0
    ? kobo
    : null;
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

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new MeleDataError(
      "MELE catalog contains a malformed plan.",
      "INVALID_MELE_PLAN",
      502
    );
  }

  const planId = plan.plan_id ?? plan.id;
  const network = normalizeNetwork(plan.network);
  const priceKobo = normalizeNairaPrice(
    plan.price ?? plan.amount
  );
  const planName = String(
    plan.plan_name ?? plan.name ?? ""
  ).trim();

  if (
    planId === undefined ||
    planId === null ||
    String(planId).trim() === "" ||
    !network ||
    !planName ||
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
    plan_name: planName,
    network,
    data_size: plan.data_size ?? plan.size ?? null,
    validity: plan.validity ?? null,
    supplier_price_naira: priceKobo / 100,
    supplier_price_kobo: priceKobo
  };
}

async function getWalletBalance(fetchImpl) {
  const body = await meleRequest(
    "/user",
    { method: "GET" },
    fetchImpl
  );

  const candidate = body?.data ?? body?.user ?? body;

  const balance =
    candidate?.balance ??
    candidate?.wallet_balance;

  if (
    balance === undefined ||
    balance === null ||
    !Number.isFinite(Number(balance))
  ) {
    throw new MeleDataError(
      "MELE wallet response is missing a valid balance.",
      "INVALID_MELE_WALLET",
      502
    );
  }

  return {
    balance: Number(balance),
    currency: String(candidate.currency || "NGN")
  };
}

async function getDataPlans(network, fetchImpl) {
  const normalizedNetwork = network
    ? validateNetwork(network)
    : null;

  const path = normalizedNetwork
    ? `/data/plans?network=${encodeURIComponent(normalizedNetwork)}`
    : "/data/plans";

  const body = await meleRequest(
    path,
    { method: "GET" },
    fetchImpl
  );

  return unwrapArray(body)
    .map(normalizePlan)
    .filter(
      plan => !normalizedNetwork ||
      plan.network === normalizedNetwork
    );
}

async function purchaseData({
  phone,
  plan,
  network,
  requestId
}, fetchImpl) {
  const normalizedNetwork = validateNetwork(network);

  if (!/^0[789][01]\d{8}$/.test(String(phone))) {
    throw new MeleDataError(
      "Invalid Nigerian phone number.",
      "INVALID_PHONE",
      400
    );
  }

  if (
    !/^\d+$/.test(String(plan)) ||
    !String(requestId || "").trim()
  ) {
    throw new MeleDataError(
      "Invalid plan or transaction reference.",
      "INVALID_PURCHASE_REQUEST",
      400
    );
  }

  return meleRequest(
    "/data",
    {
      method: "POST",
      body: JSON.stringify({
        phone: String(phone),
        plan: Number(plan),
        network: normalizedNetwork.toUpperCase(),
        "request-id": String(requestId)
      })
    },
    fetchImpl
  );
}

async function getDataStatus(reference, fetchImpl) {
  if (!String(reference || "").trim()) {
    throw new MeleDataError(
      "Transaction reference is required.",
      "INVALID_REFERENCE",
      400
    );
  }

  return meleRequest(
    `/data/status?ref=${encodeURIComponent(reference)}`,
    { method: "GET" },
    fetchImpl
  );
}

module.exports = {
  MELE_DATA_BASE_URL,
  REQUEST_TIMEOUT_MS,
  MeleDataError,
  getApiKey,
  meleRequest,
  normalizeNetwork,
  validateNetwork,
  normalizeNairaPrice,
  normalizePlan,
  getWalletBalance,
  getDataPlans,
  purchaseData,
  getDataStatus
};
