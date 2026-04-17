import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../src/index.ts";

function captureConsole(method: "log" | "warn" | "error") {
  const original = console[method];
  const calls: string[] = [];

  console[method] = ((message: string) => {
    calls.push(message);
  }) as (typeof console)[typeof method];

  return {
    calls,
    restore() {
      console[method] = original;
    },
  };
}

test("createLogger writes scoped info logs with object data", () => {
  const capture = captureConsole("log");

  try {
    createLogger("root").info("hello", { answer: 42 });
    assert.equal(capture.calls.length, 1);
    assert.match(capture.calls[0], /\[root\] \[INFO\] hello/);
    assert.match(capture.calls[0], /answer: 42/);
  } finally {
    capture.restore();
  }
});

test("child loggers append their scope", () => {
  const capture = captureConsole("log");

  try {
    createLogger("root").child("worker").success("ready");
    assert.equal(capture.calls.length, 1);
    assert.match(capture.calls[0], /\[root\/worker\] \[SUCCESS\] ready/);
  } finally {
    capture.restore();
  }
});

test("warnings and errors use the matching console methods", () => {
  const warnCapture = captureConsole("warn");
  const errorCapture = captureConsole("error");

  try {
    createLogger("root").warn("careful");
    createLogger("root").error("failed", new Error("boom"));

    assert.match(warnCapture.calls[0], /\[root\] \[WARN\] careful/);
    assert.match(errorCapture.calls[0], /\[root\] \[ERROR\] failed/);
    assert.match(errorCapture.calls[0], /Error: boom/);
  } finally {
    warnCapture.restore();
    errorCapture.restore();
  }
});
