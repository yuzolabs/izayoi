import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  assertHappyDomGlobalEnvironmentRestored,
  registerHappyDomTestEnvironment,
} from "./happy-dom-test-environment";

const ADDED_STRING_GLOBAL_KEY = "__happy_dom_added_string_fixture__";
const ADDED_SYMBOL_GLOBAL_KEY = Symbol("happy-dom-added-symbol-fixture");
const CHANGED_DESCRIPTOR_GLOBAL_KEY =
  "__happy_dom_changed_descriptor_fixture__";

interface BunModuleMockControl {
  module: (
    modulePath: string,
    factory: () => Record<string, unknown>
  ) => void;
  restore: () => void;
}

describe("Happy DOM test environment global restoration", () => {
  test("removes configurable string and Symbol globals added after registration", async () => {
    const environment = registerHappyDomTestEnvironment({
      url: "http://localhost/helper-string-symbol-test",
    });

    try {
      Object.defineProperty(globalThis, ADDED_STRING_GLOBAL_KEY, {
        configurable: true,
        enumerable: true,
        value: "added string",
        writable: true,
      });
      Object.defineProperty(globalThis, ADDED_SYMBOL_GLOBAL_KEY, {
        configurable: true,
        enumerable: false,
        value: "added symbol",
        writable: false,
      });

      assert.equal(Reflect.has(globalThis, ADDED_STRING_GLOBAL_KEY), true);
      assert.equal(Reflect.has(globalThis, ADDED_SYMBOL_GLOBAL_KEY), true);
    } finally {
      await environment.cleanup();
    }

    assert.equal(
      Reflect.getOwnPropertyDescriptor(globalThis, ADDED_STRING_GLOBAL_KEY),
      undefined
    );
    assert.equal(
      Reflect.getOwnPropertyDescriptor(globalThis, ADDED_SYMBOL_GLOBAL_KEY),
      undefined
    );
  });

  test("restores the complete descriptor of a global that existed before registration", async () => {
    const baselineDescriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: false,
      value: "baseline value",
      writable: false,
    };
    Object.defineProperty(
      globalThis,
      CHANGED_DESCRIPTOR_GLOBAL_KEY,
      baselineDescriptor
    );
    const environment = registerHappyDomTestEnvironment({
      url: "http://localhost/helper-descriptor-test",
    });

    try {
      Object.defineProperty(globalThis, CHANGED_DESCRIPTOR_GLOBAL_KEY, {
        configurable: true,
        enumerable: true,
        get: () => "changed value",
      });
      assert.equal(
        Reflect.getOwnPropertyDescriptor(
          globalThis,
          CHANGED_DESCRIPTOR_GLOBAL_KEY
        )?.get?.(),
        "changed value"
      );

      await environment.cleanup();
      assert.deepEqual(
        Reflect.getOwnPropertyDescriptor(
          globalThis,
          CHANGED_DESCRIPTOR_GLOBAL_KEY
        ),
        baselineDescriptor
      );
    } finally {
      await environment.cleanup();
      Reflect.deleteProperty(globalThis, CHANGED_DESCRIPTOR_GLOBAL_KEY);
    }
  });

  test("leaves an active Bun mock.module replacement intact", async () => {
    const bunTestModuleName = "bun:test";
    const { mock } = (await import(bunTestModuleName)) as unknown as {
      mock: BunModuleMockControl;
    };
    const fixtureModulePath = new URL(
      "./happy-dom-mock-module-fixture.ts",
      import.meta.url
    ).pathname;
    const mockedValue = "mocked before Happy DOM registration";
    mock.module(fixtureModulePath, () => ({
      HAPPY_DOM_MOCK_MODULE_FIXTURE_VALUE: mockedValue,
    }));

    try {
      const environment = registerHappyDomTestEnvironment({
        url: "http://localhost/helper-module-mock-test",
      });
      await environment.cleanup();

      const fixtureModule = (await import(fixtureModulePath)) as {
        HAPPY_DOM_MOCK_MODULE_FIXTURE_VALUE: string;
      };
      assert.equal(
        fixtureModule.HAPPY_DOM_MOCK_MODULE_FIXTURE_VALUE,
        mockedValue
      );
    } finally {
      mock.restore();
    }
  });

  test("returns one cleanup promise and stops DOM, storage, timers, RAF, listeners, and EventSource globals", async () => {
    class HelperEventSource {
      close(): void {}
    }

    const environment = registerHappyDomTestEnvironment({
      globalValues: { EventSource: HelperEventSource },
      height: 480,
      reactActEnvironment: true,
      url: "http://localhost/helper-idempotence-test",
      width: 640,
    });
    let timerOrFrameRan = false;

    environment.document.body.innerHTML = "<main>temporary DOM</main>";
    environment.window.localStorage.setItem("temporary", "local");
    environment.window.sessionStorage.setItem("temporary", "session");
    environment.window.addEventListener("temporary-window-event", () => {});
    environment.document.addEventListener("temporary-document-event", () => {});
    environment.window.setInterval(() => {
      timerOrFrameRan = true;
    }, 60_000);
    environment.window.requestAnimationFrame(() => {
      timerOrFrameRan = true;
    });
    new (globalThis.EventSource as unknown as typeof HelperEventSource)();

    const firstCleanup = environment.cleanup();
    const secondCleanup = environment.cleanup();
    assert.equal(secondCleanup, firstCleanup);
    await Promise.all([firstCleanup, secondCleanup]);
    assert.equal(environment.cleanup(), firstCleanup);

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(timerOrFrameRan, false);
    assertHappyDomGlobalEnvironmentRestored();
  });
});
