import test from "node:test";
import assert from "node:assert/strict";

import { parseLine, isResponse } from "../dist/protocol.js";

test("parseLine accepts requests and notifications", () => {
  const req = parseLine('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}');
  assert.equal(req.method, "initialize");

  const notification = parseLine('{"jsonrpc":"2.0","method":"initialized","params":{}}');
  assert.equal(notification.method, "initialized");
});

test("parseLine accepts responses to server-initiated requests", () => {
  const result = parseLine('{"jsonrpc":"2.0","id":"aiur-tool-1","result":{"success":true}}');
  assert.ok(result);
  assert.equal(result.id, "aiur-tool-1");
  assert.ok(isResponse(result));

  const error = parseLine('{"jsonrpc":"2.0","id":"aiur-tool-2","error":{"code":-32000,"message":"nope"}}');
  assert.ok(error);
  assert.ok(isResponse(error));
});

test("parseLine rejects garbage and id-only frames", () => {
  assert.equal(parseLine("not json"), null);
  assert.equal(parseLine(""), null);
  assert.equal(parseLine('{"id":5}'), null);
  assert.equal(parseLine('{"jsonrpc":"1.0","method":"x"}'), null);
});

test("isResponse is false for requests carrying an id", () => {
  const req = parseLine('{"jsonrpc":"2.0","id":7,"method":"thread/start","params":{}}');
  assert.equal(isResponse(req), false);
});
