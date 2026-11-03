const express = require("express");
const path = require("node:path");

const PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
const ORDER_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;

class PayPalApiError extends Error {
  constructor(operation, status, debugId, issue) {
    super(`${operation} failed`);
    this.operation = operation;
    this.status = status;
    this.debugId = debugId;
    this.issue = issue;
  }
}

function readConfig(environment) {
  const clientId = environment.PAYPAL_CLIENT_ID;
  const clientSecret = environment.PAYPAL_CLIENT_SECRET;
  const amount = environment.PAYPAL_AMOUNT || "10.00";
  const currency = environment.PAYPAL_CURRENCY || "USD";
  const port = Number(environment.PORT || 3000);

  if (!clientId || !clientSecret) {
    throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.");
  }
  if (!/^(0|[1-9]\d*)\.\d{2}$/.test(amount) || Number(amount) <= 0) {
    throw new Error("PAYPAL_AMOUNT must be a positive amount with two decimal places.");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("PAYPAL_CURRENCY must be a three-letter uppercase currency code.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port.");
  }

  return { clientId, clientSecret, amount, currency, port };
}

async function getAccessToken(config, fetchImpl) {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const response = await fetchImpl(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const payload = await readResponse(response);

  if (!response.ok || typeof payload.access_token !== "string") {
    throw new PayPalApiError(
      "OAuth token request",
      response.status,
      payload.debug_id || response.headers.get("paypal-debug-id"),
      payload.name,
    );
  }
  return payload.access_token;
}

async function paypalRequest(config, fetchImpl, operation, endpoint, body) {
  const accessToken = await getAccessToken(config, fetchImpl);
  const response = await fetchImpl(`${PAYPAL_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await readResponse(response);

  if (!response.ok) {
    const issue = Array.isArray(payload.details) ? payload.details[0]?.issue : payload.name;
    throw new PayPalApiError(
      operation,
      response.status,
      payload.debug_id || response.headers.get("paypal-debug-id"),
      issue,
    );
  }
  return payload;
}

async function readResponse(response) {
  try {
    const payload = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  } catch {
    return {};
  }
}

function createApp(config, fetchImpl = fetch, logger = console) {
  const app = express();
  app.use(express.json({ limit: "10kb" }));
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/config", (request, response) => {
    response.json({
      clientId: config.clientId,
      amount: config.amount,
      currency: config.currency,
    });
  });

  app.post("/api/orders", async (request, response) => {
    if (
      !request.body ||
      typeof request.body !== "object" ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    ) {
      return response.status(400).json({ error: "Invalid order request." });
    }

    try {
      const order = await paypalRequest(config, fetchImpl, "Create order", "/v2/checkout/orders", {
        intent: "CAPTURE",
        purchase_units: [
          {
            amount: {
              currency_code: config.currency,
              value: config.amount,
            },
            description: "PayPal Sandbox sample checkout",
          },
        ],
      });

      if (
        order.status !== "CREATED" ||
        typeof order.id !== "string" ||
        !ORDER_ID_PATTERN.test(order.id)
      ) {
        logger.error("[checkout] PayPal returned an invalid order ID.");
        return response.status(502).json({ error: "Checkout could not be started. Please try again." });
      }
      return response.status(201).json({ id: order.id });
    } catch (error) {
      logCheckoutError(logger, error, "create order");
      return response.status(502).json({ error: "Checkout could not be started. Please try again." });
    }
  });

  app.post("/api/orders/:orderId/capture", async (request, response) => {
    if (!ORDER_ID_PATTERN.test(request.params.orderId)) {
      return response.status(400).json({ error: "Invalid order ID." });
    }

    try {
      const order = await paypalRequest(
        config,
        fetchImpl,
        "Capture order",
        `/v2/checkout/orders/${encodeURIComponent(request.params.orderId)}/capture`,
      );
      const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
      const amount = capture?.amount;
      const isConfirmed =
        order.id === request.params.orderId &&
        order.status === "COMPLETED" &&
        capture?.status === "COMPLETED" &&
        amount?.value === config.amount &&
        amount?.currency_code === config.currency &&
        typeof capture.id === "string";

      if (!isConfirmed) {
        logger.error("[checkout] PayPal capture response was not a completed matching payment.");
        return response.status(502).json({
          error: "Payment could not be confirmed. Please check with the seller before trying again.",
        });
      }
      return response.json({ status: "COMPLETED", orderID: order.id, captureID: capture.id });
    } catch (error) {
      logCheckoutError(logger, error, "capture order");
      return response.status(502).json({
        error: "Payment could not be confirmed. Please check with the seller before trying again.",
      });
    }
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) {
      return next(error);
    }
    if (error instanceof SyntaxError && Object.hasOwn(error, "body")) {
      return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    if (error.type === "entity.too.large") {
      return response.status(413).json({ error: "Request body is too large." });
    }
    logger.error("[checkout] Request failed.", error);
    return response.status(500).json({ error: "The request could not be completed. Please try again." });
  });

  return app;
}

function logCheckoutError(logger, error, action) {
  if (error instanceof PayPalApiError) {
    logger.error(
      `[checkout] ${action} failed (HTTP ${error.status}, issue: ${error.issue || "unknown"}, debug_id: ${error.debugId || "unavailable"}).`,
    );
    return;
  }
  logger.error(`[checkout] ${action} failed because the PayPal service could not be reached.`, error);
}

if (require.main === module) {
  try {
    const config = readConfig(process.env);
    createApp(config).listen(config.port, () => {
      console.log(`PayPal Sandbox sample listening at http://localhost:${config.port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createApp, readConfig };
