/**
 * @codmir/sdk/react-native - React Native Integration
 *
 * Error tracking and monitoring for React Native applications.
 *
 * @example
 * ```typescript
 * // App.tsx
 * import * as Codmir from '@codmir/sdk/react-native';
 *
 * Codmir.init({
 *   dsn: 'https://www.codmir.com/api/v1/overseer',
 * });
 *
 * export default function App() {
 *   return (
 *     <Codmir.ErrorBoundary fallback={<ErrorScreen />}>
 *       <YourApp />
 *     </Codmir.ErrorBoundary>
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
import { Stops } from "../overseer/lifecycle";

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
    const handler = (error: Error, isFatal?: boolean): void => {
      if (working) {
        coreCaptureException(error, {
          handled: false,
          mechanism: "global-error-handler",
          fatal: isFatal,
          device: deviceInfo,
        });
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
  coreClose();
}

/**
 * Set device information (call this after getting device info from react-native-device-info)
 */
export function setDeviceInfo(info: DeviceInfo): void {
  deviceInfo = info;
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
 * Track app state change (foreground/background)
 */
export function trackAppStateChange(state: "active" | "background" | "inactive"): void {
  coreAddBreadcrumb({
    category: "app.lifecycle",
    message: `App state: ${state}`,
    data: { state },
  });
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
 * Note: ErrorBoundary is a class component placeholder.
 * In actual usage, import React and implement properly.
 */
export function createErrorBoundary(React: any) {
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
      coreCaptureException(error, {
        mechanism: "react-error-boundary",
        componentStack: errorInfo.componentStack,
      });

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
  };
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
