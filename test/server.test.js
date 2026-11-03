const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { createApp, readConfig } = require("../server");

const config = {
  clientId: "sandbox-client-id",
  clientSecret: "sandbox-client-secret",
  amount: "10.00",
  currency: "USD",
  port: 3000,
};
const errors = [];
const logger = { error: (...args) => errors.push(args) };
let baseUrl;
let server;

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

before(async () => {
  server = createApp(config, async (url, options) => {
    if (url.endsWith("/v1/oauth2/token")) {
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from("sandbox-client-id:sandbox-client-secret").toString("base64")}`);
      return response({ access_token: "sandbox-access-token" });
    }
    assert.equal(options.headers.Authorization, "Bearer sandbox-access-token");
    if (url.endsWith("/v2/checkout/orders")) {
        const requestBody = JSON.parse(options.body);
        assert.equal(options.method, "POST");
        assert.equal(requestBody.intent, "CAPTURE");
        assert.deepEqual(requestBody.purchase_units[0].amount, {
          currency_code: "USD",
          value: "10.00",
        });
        return response({ id: "ORDER123", status: "CREATED" }, 201);
      }
      if (url.endsWith("/v2/checkout/orders/ORDER123/capture")) {
        assert.equal(options.method, "POST");
        return response({
        id: "ORDER123",
        status: "COMPLETED",
        purchase_units: [{
          payments: {
            captures: [{
              id: "CAPTURE123",
              status: "COMPLETED",
              amount: { value: "10.00", currency_code: "USD" },
            }],
          },
        }],
      });
    }
    if (url.endsWith("/v2/checkout/orders/WRONGAMOUNT/capture")) {
      return response({
        id: "WRONGAMOUNT",
        status: "COMPLETED",
        purchase_units: [{
          payments: {
            captures: [{
              id: "CAPTURE456",
              status: "COMPLETED",
              amount: { value: "999.00", currency_code: "USD" },
            }],
          },
        }],
      });
    }
    if (url.endsWith("/v2/checkout/orders/MISMATCH/capture")) {
      return response({
        id: "ORDER123",
        status: "COMPLETED",
        purchase_units: [{
          payments: {
            captures: [{
              id: "CAPTURE123",
              status: "COMPLETED",
              amount: { value: "10.00", currency_code: "USD" },
            }],
          },
        }],
      });
    }
    if (url.endsWith("/v2/checkout/orders/PROVIDERERROR/capture")) {
      return response({
        name: "UNPROCESSABLE_ENTITY",
        message: "provider detail must not reach the buyer",
        debug_id: "sandbox-debug-123",
        details: [{ issue: "INSTRUMENT_DECLINED" }],
      }, 422);
    }
    throw new Error(`Unexpected PayPal URL: ${url}`);
  }, logger).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

test("readConfig requires credentials and validates the fixed amount", () => {
  assert.throws(() => readConfig({}), /PAYPAL_CLIENT_ID/);
  assert.throws(() => readConfig({
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_AMOUNT: "10.001",
  }), /PAYPAL_AMOUNT/);
  assert.deepEqual(readConfig({
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
  }), {
    clientId: "id",
    clientSecret: "secret",
    amount: "10.00",
    currency: "USD",
    port: 3000,
  });
});

test("public config exposes only the client ID and fixed sample amount", async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    clientId: "sandbox-client-id",
    amount: "10.00",
    currency: "USD",
  });
});

test("the browser checkout page is served by Express", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /paypal-button-container/);
  assert.match(page, /api\/orders/);
});

test("create order uses the server-configured amount", async () => {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "ORDER123" });
});

test("create order rejects client-supplied prices", async () => {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: "0.01", currency: "USD" }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid order request." });
});

test("create order rejects malformed JSON", async () => {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request body must be valid JSON." });
});

test("capture rejects malformed order IDs before calling PayPal", async () => {
  const response = await fetch(`${baseUrl}/api/orders/not-a-valid-id!/capture`, { method: "POST" });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid order ID." });
});

test("capture confirms the completed amount and currency", async () => {
  const response = await fetch(`${baseUrl}/api/orders/ORDER123/capture`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "COMPLETED",
    orderID: "ORDER123",
    captureID: "CAPTURE123",
  });
});

test("capture refuses a completed response for a different amount", async () => {
  const response = await fetch(`${baseUrl}/api/orders/WRONGAMOUNT/capture`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /could not be confirmed/);
});

test("capture refuses a response for a different order ID", async () => {
  const response = await fetch(`${baseUrl}/api/orders/MISMATCH/capture`, { method: "POST" });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /could not be confirmed/);
});

test("provider errors return safe text and log the debug ID", async () => {
  const response = await fetch(`${baseUrl}/api/orders/PROVIDERERROR/capture`, { method: "POST" });
  const payload = await response.json();
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(payload), /provider detail|INSTRUMENT_DECLINED|sandbox-debug-123/);
  assert.match(errors.flat().join(" "), /sandbox-debug-123/);
});
