"use strict";
// M-1: handlers under test print a lot (PayPal order JSON, receipts, errors). On the node:test runner that
// output shares the pipe with the runner's own serialized results and, under load, corrupts it (a whole
// test file is then lost). A test file calls quietConsole(test) before requiring any handler; the real
// console comes back in an after() hook. Not a test file (no .test.js suffix).
module.exports = function quietConsole(test) {
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const noop = () => {};
  console.log = console.error = console.warn = console.info = noop;
  test.after(() => { Object.assign(console, saved); });
};
