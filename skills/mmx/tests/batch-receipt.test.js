"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyWrapperReceipt } = require("../scripts/batch-receipt.js");
const good = () => ({status:"ok",exit_code:0,complete:true,truncated:false,text:"synthetic reply"});

test("confirmed wrapper success passes unchanged", () => {
  const receipt=good();
  assert.equal(verifyWrapperReceipt(receipt,0,null),receipt);
});
test("actual nonzero exit defeats self-declared success", () => {
  assert.equal(verifyWrapperReceipt(good(),7,null).status,"child_error");
});
test("signal exit defeats self-declared success", () => {
  assert.equal(verifyWrapperReceipt(good(),null,"SIGTERM").status,"child_error");
});
test("missing truncation, text, or exit receipt cannot pass", () => {
  for (const key of ["truncated","text","exit_code","complete"]) {
    const r=good(); delete r[key];
    assert.equal(verifyWrapperReceipt(r,0,null).status,"child_error",key);
  }
});
test("failure receipt status is preserved for existing retry contract", () => {
  const quota={status:"quota_error",exit_code:4,error:"synthetic quota"};
  assert.equal(verifyWrapperReceipt(quota,1,null),quota);
});
test("invalid envelopes fail closed", () => {
  for (const r of [null, [], "ok", {}, {status:5}]) {
    assert.equal(verifyWrapperReceipt(r,0,null).status,"child_error");
  }
});
test("helper never reflects synthetic sensitive stderr content", () => {
  const secret="SYNTHETIC_SECRET_987654";
  const r=verifyWrapperReceipt(good(),7,null);
  assert.equal(JSON.stringify(r).includes(secret),false);
});

test("legitimate max_tokens truncation stays eligible for existing budget retry", () => {
  const partial={...good(),complete:false,truncated:true,stop_reason:"max_tokens"};
  assert.equal(verifyWrapperReceipt(partial,0,null),partial);
  assert.equal(verifyWrapperReceipt(partial,7,null).status,"child_error");
});
