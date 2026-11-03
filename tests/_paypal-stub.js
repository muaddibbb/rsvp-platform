"use strict";
// Offline stand-in for PayPal and Brevo, shared by the release-two payment tests. Not a test file.
// Installs global.fetch: nothing leaves the process. Every request is logged in stub.calls.
//   stub.order    : what GET /v2/checkout/orders/{id} returns (a function of the id, or a value)
//   stub.capture  : what POST .../capture returns
//   stub.onCapture: optional hook run when a capture happens (to simulate a race)
//   stub.mails    : the parsed JSON bodies sent to Brevo
const { makeCustomId } = require("../api/_pay");

function approvedOrder(customId, over = {}) {
  return {
    id: "ORDER-FAKE-0001",
    status: "APPROVED",
    purchase_units: [{ amount: { currency_code: "ILS", value: "99.00" }, custom_id: customId }],
    ...over,
  };
}

function completedCapture(over = {}) {
  return {
    id: "ORDER-FAKE-0001",
    status: "COMPLETED",
    purchase_units: [{ payments: { captures: [{ id: "CAP-FAKE-1", status: "COMPLETED", amount: { currency_code: "ILS", value: "99.00" } }] } }],
    ...over,
  };
}

function installFetchStub() {
  const stub = {
    calls: [],
    mails: [],
    order: null,
    capture: null,
    onCapture: null,
    orderHttpOk: true,
    byKind(kind) { return stub.calls.filter((c) => c.kind === kind); },
    reset() {
      stub.calls.length = 0;
      stub.mails.length = 0;
      stub.order = null; stub.capture = null; stub.onCapture = null; stub.orderHttpOk = true;
      stub.createdOrders = [];
    },
    createdOrders: [],
  };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  global.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const u = String(url);
    let kind = "other";
    if (u.endsWith("/v1/oauth2/token")) kind = "token";
    else if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(u) && method === "POST") kind = "capture";
    else if (/\/v2\/checkout\/orders\/[^/]+$/.test(u) && method === "GET") kind = "getOrder";
    else if (u.endsWith("/v2/checkout/orders") && method === "POST") kind = "createOrder";
    else if (u.startsWith("https://api.brevo.com/")) kind = "brevo";
    stub.calls.push({ kind, url: u, method, body: init.body });
    if (kind === "token") return json(200, { access_token: "stub" });
    if (kind === "getOrder") {
      const id = decodeURIComponent(u.split("/").pop());
      const o = typeof stub.order === "function" ? stub.order(id) : stub.order;
      return stub.orderHttpOk ? json(200, o) : json(404, { name: "RESOURCE_NOT_FOUND" });
    }
    if (kind === "capture") {
      if (stub.onCapture) stub.onCapture();
      return json(201, stub.capture);
    }
    if (kind === "createOrder") {
      const body = JSON.parse(init.body);
      stub.createdOrders.push(body);
      return json(201, { id: "ORDER-FAKE-0001", status: "CREATED" });
    }
    if (kind === "brevo") {
      stub.mails.push(JSON.parse(init.body));
      return json(201, {});
    }
    throw new Error("unexpected network call in a test: " + method + " " + u);
  };
  return stub;
}

module.exports = { installFetchStub, approvedOrder, completedCapture, makeCustomId };
