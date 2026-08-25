import { GlobalRegistrator } from "@happy-dom/global-registrator";

type HappyDomRegistrationOptions = NonNullable<
  Parameters<typeof GlobalRegistrator.register>[0]
>;

interface HappyDomWindowControl {
  abort: () => Promise<void>;
  close: () => Promise<void>;
}

interface HappyDomRegisteredGlobal {
  document?: Document;
  happyDOM?: HappyDomWindowControl;
  localStorage?: Storage;
  sessionStorage?: Storage;
}

type GlobalPropertyKey = string | symbol;

interface GlobalDescriptorSnapshot {
  descriptors: Map<GlobalPropertyKey, PropertyDescriptor>;
  keys: Set<GlobalPropertyKey>;
}

interface ProcessWithActiveHandles extends NodeJS.Process {
  _getActiveHandles?: () => unknown[];
}

/** Configures the URL, viewport, browser settings, and deliberate global values for one Happy DOM test environment. */
export interface HappyDomTestEnvironmentOptions {
  globalValues?: Readonly<Record<string, unknown>>;
  height?: number;
  reactActEnvironment?: boolean;
  settings?: HappyDomRegistrationOptions["settings"];
  url?: string;
  width?: number;
}

/** Owns one registered Happy DOM global scope and its idempotent asynchronous cleanup. */
export interface HappyDomTestEnvironment {
  cleanup: () => Promise<void>;
  document: Document;
  window: Window & typeof globalThis;
}

function captureGlobalDescriptorSnapshot(): GlobalDescriptorSnapshot {
  const keys = Reflect.ownKeys(globalThis);
  const descriptors = new Map<GlobalPropertyKey, PropertyDescriptor>();

  for (const key of keys) {
    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    if (descriptor) {
      descriptors.set(key, descriptor);
    }
  }

  return { descriptors, keys: new Set(keys) };
}

function descriptorsAreEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.get === right.get &&
    left.set === right.set &&
    Object.is(left.value, right.value) &&
    left.writable === right.writable
  );
}

function formatGlobalPropertyKey(key: GlobalPropertyKey): string {
  return typeof key === "symbol" ? key.toString() : JSON.stringify(key);
}

function readActiveProcessHandles(): unknown[] {
  return (
    (process as ProcessWithActiveHandles)._getActiveHandles?.().slice() ?? []
  );
}

const happyDomHelperGlobalBaseline = captureGlobalDescriptorSnapshot();
const happyDomHelperActiveHandleBaseline = readActiveProcessHandles();

async function stopRegisteredHappyDomWindow(
  registeredGlobal: HappyDomRegisteredGlobal,
  cleanupErrors: unknown[]
): Promise<void> {
  const happyDOM = registeredGlobal.happyDOM;

  if (happyDOM) {
    try {
      await happyDOM.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  for (const storageName of ["localStorage", "sessionStorage"] as const) {
    try {
      registeredGlobal[storageName]?.clear();
    } catch {
      // Storage access can be deliberately blocked in tests. Window close still
      // releases the backing browser context without masking the test result.
    }
  }

  try {
    registeredGlobal.document?.replaceChildren();
  } catch {
    // A test can replace or detach document. Happy DOM close remains authoritative.
  }

  if (happyDOM) {
    try {
      // close() destroys window/document listeners and finishes timer cleanup;
      // unregister() calls it again safely after removing the global bindings.
      await happyDOM.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
}

function deleteAddedConfigurableGlobalKeys(
  baseline: GlobalDescriptorSnapshot,
  cleanupErrors: unknown[]
): void {
  for (const key of Reflect.ownKeys(globalThis)) {
    if (baseline.keys.has(key)) {
      continue;
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    if (!descriptor?.configurable) {
      // Bun and other runtimes expose non-configurable host globals. They cannot
      // be removed, and teardown must never turn that limitation into a crash.
      continue;
    }

    if (!Reflect.deleteProperty(globalThis, key)) {
      cleanupErrors.push(
        new Error(
          `Happy DOM global cleanup could not delete ${formatGlobalPropertyKey(key)}`
        )
      );
    }
  }
}

function restoreExistingGlobalDescriptors(
  baseline: GlobalDescriptorSnapshot,
  cleanupErrors: unknown[]
): void {
  for (const [key, baselineDescriptor] of baseline.descriptors) {
    const currentDescriptor = Reflect.getOwnPropertyDescriptor(globalThis, key);
    if (descriptorsAreEqual(currentDescriptor, baselineDescriptor)) {
      // Values are compared by identity, not traversed. In particular, this
      // leaves Bun's mock.module registry untouched when its global is unchanged.
      continue;
    }

    if (Reflect.defineProperty(globalThis, key, baselineDescriptor)) {
      continue;
    }

    if (currentDescriptor && !currentDescriptor.configurable) {
      // A host can tighten a non-configurable descriptor while tests run. There
      // is no legal restoration operation, so preserve the host global safely.
      continue;
    }

    cleanupErrors.push(
      new Error(
        `Happy DOM global cleanup could not restore ${formatGlobalPropertyKey(key)}`
      )
    );
  }
}

async function cleanupHappyDomTestEnvironment(
  baseline: GlobalDescriptorSnapshot,
  registeredGlobal: HappyDomRegisteredGlobal
): Promise<void> {
  const cleanupErrors: unknown[] = [];

  await stopRegisteredHappyDomWindow(registeredGlobal, cleanupErrors);

  if (GlobalRegistrator.isRegistered) {
    try {
      await GlobalRegistrator.unregister();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  deleteAddedConfigurableGlobalKeys(baseline, cleanupErrors);
  restoreExistingGlobalDescriptors(baseline, cleanupErrors);

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Happy DOM test environment cleanup failed"
    );
  }
}

/** Registers Happy DOM after snapshotting every own global key and descriptor, then returns leak-proof cleanup. */
export function registerHappyDomTestEnvironment(
  options: HappyDomTestEnvironmentOptions = {}
): HappyDomTestEnvironment {
  const baseline = captureGlobalDescriptorSnapshot();
  const {
    globalValues,
    reactActEnvironment = false,
    ...registrationOptions
  } = options;

  GlobalRegistrator.register(registrationOptions);

  if (reactActEnvironment) {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      enumerable: true,
      value: true,
      writable: true,
    });
  }

  for (const [key, value] of Object.entries(globalValues ?? {})) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }

  const registeredGlobal = globalThis as unknown as HappyDomRegisteredGlobal;
  const registeredWindow = globalThis as unknown as Window & typeof globalThis;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= cleanupHappyDomTestEnvironment(
      baseline,
      registeredGlobal
    );
    return cleanupPromise;
  };

  return {
    cleanup,
    document: registeredWindow.document,
    window: registeredWindow,
  };
}

/** Throws when Happy DOM teardown leaves global keys, descriptors, or active handles different from the helper baseline. */
export function assertHappyDomGlobalEnvironmentRestored(): void {
  const currentKeys = new Set(Reflect.ownKeys(globalThis));
  const mismatches: string[] = [];

  for (const key of happyDomHelperGlobalBaseline.keys) {
    if (!currentKeys.has(key)) {
      mismatches.push(`missing ${formatGlobalPropertyKey(key)}`);
      continue;
    }

    if (
      !descriptorsAreEqual(
        Reflect.getOwnPropertyDescriptor(globalThis, key),
        happyDomHelperGlobalBaseline.descriptors.get(key)
      )
    ) {
      mismatches.push(`changed ${formatGlobalPropertyKey(key)}`);
    }
  }

  for (const key of currentKeys) {
    if (!happyDomHelperGlobalBaseline.keys.has(key)) {
      mismatches.push(`added ${formatGlobalPropertyKey(key)}`);
    }
  }

  const currentHandles = readActiveProcessHandles();
  if (
    currentHandles.length !== happyDomHelperActiveHandleBaseline.length ||
    currentHandles.some(
      (handle) => !happyDomHelperActiveHandleBaseline.includes(handle)
    )
  ) {
    mismatches.push(
      `active handles ${happyDomHelperActiveHandleBaseline.length} -> ${currentHandles.length}`
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Happy DOM global environment leak detected: ${mismatches.join(", ")}`
    );
  }
}
