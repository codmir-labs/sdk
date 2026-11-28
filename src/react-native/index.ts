/**
 * @codmir/sdk/react-native - React Native Integration
 *
 * Error tracking and monitoring for React Native applications.
 *
 * @example
 * ```typescript
 * // App.tsx
 * import React from 'react';
 * import * as Codmir from '@codmir/sdk/react-native';
 *
 * Codmir.init({
 *   clientKey: process.env.EXPO_PUBLIC_CODMIR_CLIENT_KEY,
 * });
 *
 * // createErrorBoundary takes your React and returns the component class.
 * const ErrorBoundary = Codmir.createErrorBoundary(React);
 *
 * export default function App() {
 *   return (
 *     <ErrorBoundary fallback={<ErrorScreen />}>
 *       <YourApp />
 *     </ErrorBoundary>
 *   );
 * }
 * ```
 */

import {
  init as coreInit,
  captureException as coreCaptureException,
  captureMessage as coreCaptureMessage,
  setUser as coreSetUser,
  setTags as coreSetTags,
  addBreadcrumb as coreAddBreadcrumb,
  flush as coreFlush,
  close as coreClose,
  getClient,
  type OverseerConfig,
  type UserContext,
  type Breadcrumb,
  type SeverityLevel,
} from "../overseer/index";
import { setAppOs } from "../overseer/runtime-context";
import { Stops } from "../overseer/lifecycle";
import { withHint, crash } from "../overseer/capture-hint";

// =============================================================================
// Types
// =============================================================================

export interface ReactNativeConfig extends OverseerConfig {
  /** Automatically capture native crashes */
  captureNativeCrashes?: boolean;
  /** Automatically track screen views */
  trackScreenViews?: boolean;
  /** Automatically track app state changes */
  trackAppState?: boolean;
  /** Include device info in events */
  includeDeviceInfo?: boolean;
}

export interface DeviceInfo {
  platform: "ios" | "android";
  osVersion?: string;
  deviceModel?: string;
  appVersion?: string;
  buildNumber?: string;
  isEmulator?: boolean;
}

// =============================================================================
// React Native Specific Initialization
// =============================================================================

/** How long a fatal error waits for the queue to leave before React Native's handler ends the app. */
const FATAL_FLUSH_MS = 2000;

interface HermesInternalLike {
  hasPromise?: () => boolean;
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
    onHandled: (id: number) => void;
  }) => void;
}

let isInitialized = false;
let deviceInfo: DeviceInfo | null = null;
/** What `init` started, ended by `close`. */
const stops = new Stops();

export function init(config: ReactNativeConfig = {}): void {
  if (isInitialized) return;

  const {
    captureNativeCrashes = true,
    trackScreenViews = true,
    trackAppState = true,
    includeDeviceInfo = true,
    ...coreConfig
  } = config;

  // Initialize core
  coreInit(coreConfig);
  isInitialized = true;

  // Set up global error handler
  if (typeof ErrorUtils !== "undefined") {
    const originalHandler = ErrorUtils.getGlobalHandler();
    let working = true;
    // True while a fatal error's flush is pending; the next fatal error does not wait for it.
    let flushingFatal = false;
    const handler = (error: Error, isFatal?: boolean): void => {
      if (working) {
        coreCaptureException(
          error,
          withHint({ device: deviceInfo }, crash("global-error-handler", isFatal ? "fatal" : undefined)),
        );
      }

      // In a release build the original handler ends the app on a fatal error, and the queue with it: send first.
      if (working && isFatal && !flushingFatal) {
        flushingFatal = true;
        coreFlush(FATAL_FLUSH_MS)
          .catch(() => undefined)
          .finally(() => {
            flushingFatal = false;
            originalHandler?.(error, isFatal);
          });
        return;
      }

      // Call original handler
      if (originalHandler) {
        originalHandler(error, isFatal);
      }
    };
    ErrorUtils.setGlobalHandler(handler);
    // A handler set over this one by another copy of the SDK stays in place and passes the error on.
    stops.add(() => {
      working = false;
      if (ErrorUtils.getGlobalHandler() === handler && originalHandler) ErrorUtils.setGlobalHandler(originalHandler);
    });
  }

  // Unhandled promise rejections. React Native turns Hermes' tracker on only under __DEV__, to print warnings.
  const hermes = (globalThis as { HermesInternal?: HermesInternalLike }).HermesInternal;
  if (hermes?.hasPromise?.() && typeof hermes.enablePromiseRejectionTracker === "function") {
    // Hermes has no way to turn the tracker off: after `close` it stays installed and captures nothing.
    let tracking = true;
    stops.add(() => {
      tracking = false;
    });
    hermes.enablePromiseRejectionTracker({
      allRejections: true,
      onUnhandled: (id: number, rejection: unknown) => {
        if ((globalThis as { __DEV__?: unknown }).__DEV__ === true) {
          console.warn(`Possible unhandled promise rejection (id: ${id}):`, rejection);
        }
        if (tracking) coreCaptureException(rejection, withHint({}, crash("onunhandledrejection", undefined, "none")));
      },
      onHandled: () => {},
    });
  }
}

/**
 * Ends what `init` started: the global error handler (put back when it is still the SDK's, and otherwise passing errors
 * on) and the core client, which sends what it holds. A later `init` starts clean, with its own config. An error captured
 * after `close` and before the next `init` is sent once, without retries.
 */
export function close(): void {
  stops.run();
  isInitialized = false;
  deviceInfo = null;
  setAppOs(undefined);
  coreClose();
}

/**
 * Set device information (call this after getting device info from react-native-device-info)
 */
export function setDeviceInfo(info: DeviceInfo): void {
  deviceInfo = info;
  // The OS in `contexts.os`: React Native has no global that says it, so it is what the app passes here.
  setAppOs(info);
  coreSetTags({
    "device.platform": info.platform,
    "device.os_version": info.osVersion || "unknown",
    "device.model": info.deviceModel || "unknown",
    "app.version": info.appVersion || "unknown",
    "app.build": info.buildNumber || "unknown",
  });
}

// =============================================================================
// Navigation Tracking
// =============================================================================

/**
 * Track screen view (call this from your navigation listener)
 */
export function trackScreenView(screenName: string, params?: Record<string, unknown>): void {
  coreAddBreadcrumb({
    category: "navigation",
    message: `Screen: ${screenName}`,
    data: params,
  });
}

/**
 * Create a navigation listener for React Navigation
 */
export function createNavigationListener() {
  return (state: any) => {
    const currentRoute = getCurrentRouteName(state);
    if (currentRoute) {
      trackScreenView(currentRoute);
    }
  };
}

function getCurrentRouteName(state: any): string | null {
  if (!state) return null;
  const route = state.routes[state.index];
  if (route.state) {
    return getCurrentRouteName(route.state);
  }
  return route.name;
}

// =============================================================================
// App State Tracking
// =============================================================================

/**
 * Track app state change (foreground/background); going to the background also sends what is queued
 */
export function trackAppStateChange(state: "active" | "background" | "inactive"): void {
  coreAddBreadcrumb({
    category: "app.lifecycle",
    message: `App state: ${state}`,
    data: { state },
  });
  // A backgrounded app can be ended by the system at any time: send what is queued now.
  if (state === "background") coreFlush().catch(() => undefined);
}

// =============================================================================
// Error Boundary
// =============================================================================

/**
 * Error Boundary props
 */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: React.ReactNode | ((error: Error) => React.ReactNode);
  onError?: (error: Error, componentStack: string) => void;
}

/**
 * Builds the error boundary from the React you import: `const ErrorBoundary = createErrorBoundary(React);`. It is the class
 * component itself, so `<ErrorBoundary fallback={...}>` needs no cast.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createErrorBoundary(React: any): React.ComponentClass<ErrorBoundaryProps> {
  return class ErrorBoundary extends React.Component<
    ErrorBoundaryProps,
    { hasError: boolean; error: Error | null }
  > {
    constructor(props: ErrorBoundaryProps) {
      super(props);
      this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error) {
      return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: { componentStack: string }) {
      coreCaptureException(
        error,
        withHint({ componentStack: errorInfo.componentStack }, crash("react-error-boundary")),
      );

      this.props.onError?.(error, errorInfo.componentStack);
    }

    render() {
      if (this.state.hasError) {
        const { fallback } = this.props;
        if (typeof fallback === "function") {
          return fallback(this.state.error!);
        }
        return fallback;
      }
      return this.props.children;
    }
    // The class extends the caller's React, which is `any` here: the type says what it is.
  } as unknown as React.ComponentClass<ErrorBoundaryProps>;
}

// =============================================================================
// Re-exports
// =============================================================================

export {
  coreCaptureException as captureException,
  coreCaptureMessage as captureMessage,
  coreSetUser as setUser,
  coreSetTags as setTags,
  coreAddBreadcrumb as addBreadcrumb,
  coreFlush as flush,
  getClient,
};

export type {
  OverseerConfig,
  UserContext,
  Breadcrumb,
  SeverityLevel,
} from "../overseer/index";

/**
 * Check if Overseer is initialized
 */
export function isOverseerInitialized(): boolean {
  return isInitialized && getClient() !== null;
}

// Provide ErrorUtils type for React Native
declare const ErrorUtils: {
  getGlobalHandler(): (error: Error, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: Error, isFatal?: boolean) => void): void;
};
