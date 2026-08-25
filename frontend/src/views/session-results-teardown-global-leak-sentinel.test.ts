import { test } from "node:test";

import { assertHappyDomGlobalEnvironmentRestored } from "@/test-support/happy-dom-test-environment";

test("Happy DOM leak sentinel matches keys, descriptors, DOM, storage, RAF, EventSource, and active handles", () => {
  assertHappyDomGlobalEnvironmentRestored();
});
