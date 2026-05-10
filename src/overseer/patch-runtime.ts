import { captureException } from "./index";

// =============================================================================
// Types
// =============================================================================

export type PatchOp =
  | "text-replace"
  | "css-inject"
  | "attr-modify"
  | "html-replace"
  | "script-inject";

export interface PatchEntry {
  id: string;
  op: PatchOp;
  selector: string;
  value?: string;
  attributes?: Record<string, string>;
  scriptUrl?: string;
  pages?: string[];
  priority: number;
  expiresAt?: string;
  meta: {
    patchId: string;
    ticketId?: string;
    confidence: number;
    reasoning: string;
  };
}

export interface PatchManifest {
  version: number;
  projectId: string;
  environment: string;
  signature: string;
  patches: PatchEntry[];
  updatedAt: string;
}

export interface SelfHealingConfig {
  enabled: boolean;
  autoApplyDataFix?: boolean;
  autoApplyEdgeFix?: boolean;
  manifestPollInterval?: number;
  manifestSecret?: string;
}

// =============================================================================
// Patch Runtime (CRP)
// =============================================================================

export class PatchRuntime {
  private manifest: PatchManifest | null = null;
  private applied = new Set<string>();
  private observer: MutationObserver | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private dsn: string;
  private environment: string;
  private overseerKey: string;
  private signingSecret: string;
  private config: SelfHealingConfig;

  constructor(opts: {
    dsn: string;
    environment: string;
    overseerKey: string;
    config: SelfHealingConfig;
  }) {
    this.dsn = opts.dsn;
    this.environment = opts.environment;
    this.overseerKey = opts.overseerKey;
    this.signingSecret = opts.config.manifestSecret || opts.overseerKey;
    this.config = opts.config;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    if (typeof window === "undefined") return;

    await this.loadManifest();

    if (!this.manifest?.patches.length) return;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => this.applyAll());
    } else {
      this.applyAll();
    }

    this.startObserver();

    const interval = (this.config.manifestPollInterval ?? 30) * 1000;
    if (interval > 0) {
      this.pollTimer = setInterval(() => this.refresh(), interval);
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getAppliedPatches(): string[] {
    return Array.from(this.applied);
  }

  // ---------------------------------------------------------------------------
  // Manifest loading
  // ---------------------------------------------------------------------------

  private async loadManifest(): Promise<void> {
    try {
      const baseUrl = this.dsn.replace(/\/ingest$/, "");
      const res = await fetch(`${baseUrl}/patches/manifest`, {
        headers: {
          "x-overseer-key": this.overseerKey,
          "x-environment": this.environment,
        },
      });

      if (!res.ok) return;

      const data = await res.json();
      if (!(await this.verifySignature(data))) return;

      this.manifest = data;
    } catch {
      // Manifest fetch failure is non-fatal
    }
  }

  private async refresh(): Promise<void> {
    const prevVersion = this.manifest?.version ?? 0;
    await this.loadManifest();

    if (this.manifest && this.manifest.version > prevVersion) {
      this.applyAll();
    }
  }

  private async verifySignature(manifest: PatchManifest): Promise<boolean> {
    if (!manifest.signature || !this.overseerKey) return false;

    try {
      const secret = this.signingSecret || this.overseerKey;
      const encoder = new TextEncoder();

      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );

      const { signature: _sig, ...payload } = manifest;
      const data = encoder.encode(JSON.stringify(payload));
      const signatureBytes = await crypto.subtle.sign("HMAC", key, data);

      const computed = Array.from(new Uint8Array(signatureBytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (computed.length !== manifest.signature.length) return false;

      let mismatch = 0;
      for (let i = 0; i < computed.length; i++) {
        mismatch |= computed.charCodeAt(i) ^ manifest.signature.charCodeAt(i);
      }
      return mismatch === 0;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Patch application
  // ---------------------------------------------------------------------------

  private applyAll(): void {
    if (!this.manifest) return;

    const now = new Date().toISOString();
    const patches = this.manifest.patches
      .filter((p) => !p.expiresAt || p.expiresAt > now)
      .filter((p) => this.matchesCurrentPage(p))
      .sort((a, b) => a.priority - b.priority);

    for (const patch of patches) {
      this.applyOne(patch);
    }
  }

  private applyOne(patch: PatchEntry): void {
    try {
      switch (patch.op) {
        case "text-replace":
          this.opTextReplace(patch);
          break;
        case "css-inject":
          this.opCSSInject(patch);
          break;
        case "attr-modify":
          this.opAttrModify(patch);
          break;
        case "html-replace":
          this.opHTMLReplace(patch);
          break;
        case "script-inject":
          this.opScriptInject(patch);
          break;
      }
      this.applied.add(patch.id);
    } catch (err) {
      captureException(err, {
        source: "patch-runtime",
        patchId: patch.id,
        op: patch.op,
        selector: patch.selector,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Operations
  // ---------------------------------------------------------------------------

  private opTextReplace(patch: PatchEntry): void {
    if (!patch.value) return;
    const els = document.querySelectorAll(patch.selector);
    els.forEach((el) => {
      el.textContent = patch.value!;
    });
  }

  private opCSSInject(patch: PatchEntry): void {
    if (!patch.value) return;
    const id = `codmir-patch-${patch.id}`;
    if (document.getElementById(id)) return;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = patch.value;
    document.head.appendChild(style);
  }

  private opAttrModify(patch: PatchEntry): void {
    if (!patch.attributes) return;
    const els = document.querySelectorAll(patch.selector);
    els.forEach((el) => {
      for (const [key, val] of Object.entries(patch.attributes!)) {
        el.setAttribute(key, val);
      }
    });
  }

  private opHTMLReplace(patch: PatchEntry): void {
    if (!patch.value) return;
    const els = document.querySelectorAll(patch.selector);
    els.forEach((el) => {
      el.innerHTML = patch.value!;
    });
  }

  private opScriptInject(patch: PatchEntry): void {
    if (!patch.scriptUrl) return;
    const id = `codmir-script-${patch.id}`;
    if (document.getElementById(id)) return;

    if (!this.isAllowedScriptOrigin(patch.scriptUrl)) return;

    const script = document.createElement("script");
    script.id = id;
    script.src = patch.scriptUrl;
    script.async = true;
    document.head.appendChild(script);
  }

  // ---------------------------------------------------------------------------
  // Observer — re-apply patches when React re-renders
  // ---------------------------------------------------------------------------

  private startObserver(): void {
    if (typeof MutationObserver === "undefined") return;

    this.observer = new MutationObserver(() => {
      this.applyAll();
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private matchesCurrentPage(patch: PatchEntry): boolean {
    if (!patch.pages?.length) return true;
    const path = window.location.pathname;
    return patch.pages.some((pattern) => this.globMatch(pattern, path));
  }

  private globMatch(pattern: string, path: string): boolean {
    const regex = pattern
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regex}$`).test(path);
  }

  private isAllowedScriptOrigin(url: string): boolean {
    try {
      const parsed = new URL(url);
      const dsnOrigin = new URL(this.dsn).origin;
      return parsed.origin === dsnOrigin;
    } catch {
      return false;
    }
  }
}
